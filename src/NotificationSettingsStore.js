/**
 * NotificationSettingsStore.js — Persistente nicht-geheime Notification-Settings (S-183, AC1).
 *
 * Kapselt das Lesen und atomare Schreiben der nicht-geheimen Notification-Konfiguration
 * als Plaintext-JSON-Datei auf dem persistenten Credential-Volume.
 *
 * Datei: ${CRED_STORE_DIR}/notification-settings.json
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Gespeicherte Felder: enabled, server, topic, priority, events
 * NICHT gespeichert: ntfy_token (bleibt im verschlüsselten CredentialStore unter
 *   Integration "notifications", Name "ntfy_token").
 *
 * Security (AC10 / security/R01):
 *   - Keine Secrets in dieser Datei.
 *   - CRED_STORE_DIR wird als Pfad-Basis genutzt (analog BackupConfigStore).
 *
 * @module NotificationSettingsStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Erlaubte ntfy-Prioritätswerte (1=min … 5=max; ntfy-Referenz: https://docs.ntfy.sh/publish/#message-priority). */
export const NTFY_PRIORITY_MIN = 1;
export const NTFY_PRIORITY_MAX = 5;

/** Erlaubte Ereignis-Schlüssel (AC2 push-notifications; AC7 vps-tunnel-drift-notify). */
export const ALLOWED_EVENTS = ['story_done', 'story_blocked', 'feature_done', 'tunnel_missing'];

/**
 * Erlaubtes ntfy-Topic-Format: nur Buchstaben, Ziffern, `-` und `_`, 1–64 Zeichen.
 * ntfy lehnt Leerzeichen/Sonderzeichen (z.B. `:`) ab → POST an `<server>/<topic>`
 * liefert sonst HTTP 404. Diese Validierung fängt das mit klarer Feldmeldung beim
 * Speichern ab, statt den Nutzer in die rohe ntfy-404 laufen zu lassen.
 */
export const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @typedef {object} NotificationSettings
 * @property {boolean}  enabled  - Benachrichtigungen global aktiviert
 * @property {string}   server   - ntfy-Server-URL (http(s))
 * @property {string}   topic    - ntfy-Topic
 * @property {number|null} priority - ntfy-Priorität (1–5) oder null für ntfy-Default
 * @property {string[]} events   - Teilmenge von ALLOWED_EVENTS
 */

/** Default-Konfiguration (überschrieben durch gespeicherte JSON). */
const DEFAULT_SETTINGS = {
  enabled: false,
  server: 'https://ntfy.sh',
  topic: '',
  priority: null,
  events: [],
};

/**
 * Liest den Pfad zur Settings-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/notification-settings.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveSettingsFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'notification-settings.json');
}

/**
 * Liest die persistierten Notification-Settings.
 * Fällt auf Defaults zurück wenn keine JSON-Datei existiert.
 *
 * @returns {Promise<NotificationSettings>}
 */
export async function read() {
  const filePath = resolveSettingsFilePath();

  if (filePath) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge mit Defaults (future-proof: neue Felder bekommen sicheren Default)
      return _mergeWithDefaults(parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Parse-Fehler oder Zugriffsrechte-Fehler → loggen, Default-Fallback
        console.error('[NotificationSettingsStore] Lesen fehlgeschlagen:', err.message);
      }
      // ENOENT = noch keine Datei → Defaults
    }
  }

  return { ...DEFAULT_SETTINGS };
}

/**
 * Schreibt die Notification-Settings atomar auf das Credential-Volume.
 * Nur nicht-geheime Felder: enabled, server, topic, priority, events.
 *
 * @param {Partial<NotificationSettings>} settings - Neue Settings (werden mit aktuellem Stand gemergt)
 * @returns {Promise<NotificationSettings>} Die vollständig gespeicherte Konfiguration.
 * @throws {Error} Wenn CRED_STORE_DIR nicht gesetzt oder Schreiben fehlschlägt.
 */
export async function write(settings) {
  const filePath = resolveSettingsFilePath();
  if (!filePath) {
    throw new Error(
      '[NotificationSettingsStore] CRED_STORE_DIR nicht gesetzt — Settings können nicht gespeichert werden.',
    );
  }

  // Aktuellen Stand lesen (als Merge-Basis)
  const current = await read();
  const merged = _mergeWithDefaults({ ...current, ...settings });

  const json = JSON.stringify(merged, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  // Sicherstellen dass das Verzeichnis existiert
  await mkdir(dirname(filePath), { recursive: true });

  try {
    // Atomar schreiben: tmp → chmod → rename
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (err) {
    // Aufräumen des tmp-Files bei Fehler (best-effort)
    await unlink(tmpPath).catch(() => {});
    const e = new Error(`[NotificationSettingsStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
    e.code = err.code;
    throw e;
  }

  // Rechte auf der finalen Datei sicherstellen (rename behält Rechte der tmp-Datei)
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Non-fatal
  }

  return merged;
}

/**
 * Validiert die nicht-geheimen Settings-Felder für PUT.
 * Gibt bei Fehler `{ ok: false, field, message }` zurück.
 * Gibt bei Erfolg `{ ok: true }` zurück.
 *
 * Security (AC2/AC10 / security/R05):
 *   server-URL muss http(s) verwenden und keine offensichtlich internen
 *   Ziele enthalten (SSRF-Härtung, da URL serverseitig als Fetch-Ziel dient).
 *
 * @param {object} body - Request-Body
 * @returns {{ ok: boolean, field?: string, message?: string }}
 */
export function validate(body) {
  const { enabled, server, topic, events, priority } = body;

  // server: muss eine http(s)-URL sein (SSRF-Allowlist: nur http + https)
  if (server !== undefined) {
    let parsed;
    try {
      parsed = new URL(String(server));
    } catch {
      return { ok: false, field: 'server', message: 'Ungültige URL — erwartet http(s)-Format.' };
    }

    // Scheme-Allowlist: nur http und https (security/R05)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, field: 'server', message: 'server-URL muss http:// oder https:// verwenden.' };
    }

    // SSRF: offensichtlich interne Ziele ablehnen (Cloud-Metadaten + private IP-Blöcke + localhost)
    const host = parsed.hostname.toLowerCase();
    if (_isInternalHost(host)) {
      return {
        ok: false,
        field: 'server',
        message: 'server-URL zeigt auf ein internes/nicht-erreichbares Ziel (SSRF-Schutz).',
      };
    }
  }

  // topic: bei enabled=true darf topic nicht leer sein
  if (enabled === true) {
    const topicVal = (topic ?? '').trim();
    if (!topicVal) {
      return { ok: false, field: 'topic', message: 'topic darf nicht leer sein wenn enabled=true.' };
    }
  }

  // topic: muss ntfy-konform sein (nur A-Z a-z 0-9 _ -, 1–64 Zeichen, keine
  // Leerzeichen/Sonderzeichen). Sonst liefert der ntfy-POST HTTP 404.
  if (topic !== undefined && topic !== null && String(topic) !== '') {
    if (!NTFY_TOPIC_RE.test(String(topic))) {
      return {
        ok: false,
        field: 'topic',
        message:
          'topic darf nur Buchstaben, Ziffern, - und _ enthalten (1–64 Zeichen, keine Leerzeichen/Sonderzeichen).',
      };
    }
  }

  // events: muss Teilmenge der erlaubten Schlüssel sein
  if (events !== undefined) {
    if (!Array.isArray(events)) {
      return { ok: false, field: 'events', message: 'events muss ein Array sein.' };
    }
    const invalid = events.filter((e) => !ALLOWED_EVENTS.includes(e));
    if (invalid.length > 0) {
      return {
        ok: false,
        field: 'events',
        message: `Ungültige Ereignis-Schlüssel: ${invalid.join(', ')}. Erlaubt: ${ALLOWED_EVENTS.join(', ')}.`,
      };
    }
  }

  // priority: muss im ntfy-Bereich 1–5 liegen (oder null/undefined für Default)
  if (priority !== undefined && priority !== null) {
    const p = Number(priority);
    if (!Number.isInteger(p) || p < NTFY_PRIORITY_MIN || p > NTFY_PRIORITY_MAX) {
      return {
        ok: false,
        field: 'priority',
        message: `priority muss eine ganze Zahl zwischen ${NTFY_PRIORITY_MIN} und ${NTFY_PRIORITY_MAX} sein (oder null für ntfy-Default).`,
      };
    }
  }

  return { ok: true };
}

// ── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Prüft ob ein Hostname ein internes/nicht-routbares Ziel ist (SSRF-Schutz).
 * Prüft: localhost, 127.x, 10.x, 192.168.x, 169.254.x (Cloud-Metadaten), ::1,
 * fd00:ec2::254 (AWS EC2 IPv6 IMDS), und IPv4-mapped IPv6-Adressen (::ffff:<ipv4>).
 *
 * WHATWG URL liefert IPv6-Hosts IMMER in eckigen Klammern:
 *   new URL('http://[fd00:ec2::254]').hostname === '[fd00:ec2::254]'
 * Deshalb werden Klammern generisch am Anfang gestripped; alle IPv6-Prüfungen
 * laufen gegen den nackten Wert `bare`.
 *
 * @param {string} host - Normalisierter (lower-case) Hostname oder IP (ggf. mit []-Klammern)
 * @returns {boolean}
 * @private
 */
function _isInternalHost(host) {
  if (!host) return true;

  // Klammern von IPv6-Literalen generisch strippen (WHATWG-URL liefert z.B. '[::1]', '[fd00:ec2::254]')
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // Localhost-Varianten (IPv4 + IPv6)
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return true;

  // IPv4-mapped IPv6 (::ffff:<ipv4>) — new URL() normalisiert NICHT auf IPv4.
  // Alle ::ffff:…-Adressen generisch blocken: sie sind ausschließlich IPv4-Mappings.
  if (/^::ffff:/i.test(bare)) return true;

  // AWS EC2 IPv6 IMDS
  if (bare === 'fd00:ec2::254') return true;

  // IPv4 Private-Ranges + Link-Local (Cloud-Metadaten-Adresse 169.254.x.x eingeschlossen)
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8
  if (
    /^10\./.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
    /^192\.168\./.test(bare) ||
    /^169\.254\./.test(bare) ||
    /^127\./.test(bare)
  ) {
    return true;
  }

  // AWS/GCP/Azure Cloud-Metadaten-Hostnames
  if (
    bare === 'metadata.google.internal' ||
    bare === 'metadata.internal' ||
    bare.endsWith('.internal')
  ) {
    return true;
  }

  return false;
}

/**
 * Merged geparste Settings mit Defaults.
 * Normalisiert Felder auf bekannte Typen.
 *
 * @param {object} parsed
 * @returns {NotificationSettings}
 * @private
 */
function _mergeWithDefaults(parsed) {
  return {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
    server: typeof parsed.server === 'string' && parsed.server.trim()
      ? parsed.server.trim()
      : DEFAULT_SETTINGS.server,
    topic: typeof parsed.topic === 'string' ? parsed.topic : DEFAULT_SETTINGS.topic,
    priority: (parsed.priority !== null && parsed.priority !== undefined && Number.isFinite(Number(parsed.priority)))
      ? Number(parsed.priority)
      : null,
    events: Array.isArray(parsed.events)
      ? parsed.events.filter((e) => ALLOWED_EVENTS.includes(e))
      : DEFAULT_SETTINGS.events,
  };
}
