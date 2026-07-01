/**
 * TickerSettingsStore.js — Persistente nicht-geheime Nachtwächter-Settings (taktgeber-nachtwaechter, AC15).
 *
 * Kapselt das Lesen und atomare Schreiben der Nachtwächter-Konfiguration (Nachtfenster,
 * Polling-Intervall, Parallelität, Eskalation, Projekt-Auswahl) als Plaintext-JSON-Datei
 * auf dem persistenten Credential-Volume. Muster: `NotificationSettingsStore.js` (S-183).
 *
 * Datei: ${CRED_STORE_DIR}/ticker-settings.json
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Gespeicherte Felder (Settings-Schema-Tabelle, Spec-Vertrag, verbindlich):
 *   enabled, window.{start,end,timezone}, intervalMinutes, maxParallel,
 *   staleInProgressHours, escalationAttempts, projects.
 * NICHT gespeichert: keine Secrets (AC15).
 *
 * Security (Floor):
 *   - Keine Secrets in dieser Datei.
 *   - CRED_STORE_DIR wird als Pfad-Basis genutzt (analog NotificationSettingsStore).
 *
 * @module TickerSettingsStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 24h-Zeitformat "HH:MM" (00:00–23:59). */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Erlaubter Projekt-Slug: nur Buchstaben, Ziffern, `-` und `_` (analog ntfy-Topic-Härtung). */
export const PROJECT_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {object} TickerWindow
 * @property {string} start    - "HH:MM" (24h)
 * @property {string} end      - "HH:MM" (24h)
 * @property {string} timezone - gültige IANA-Zeitzone
 *
 * @typedef {object} TickerSettings
 * @property {boolean}  enabled
 * @property {TickerWindow} window
 * @property {number}   intervalMinutes
 * @property {number}   maxParallel
 * @property {number}   staleInProgressHours
 * @property {number}   escalationAttempts
 * @property {"all"|string[]} projects
 */

/** Default-Konfiguration (Settings-Schema-Tabelle, Spec-Vertrag). */
const DEFAULT_SETTINGS = {
  enabled: false,
  window: {
    start: '23:00',
    end: '07:00',
    timezone: 'Europe/Zurich',
  },
  intervalMinutes: 15,
  maxParallel: 3,
  staleInProgressHours: 4,
  escalationAttempts: 3,
  projects: 'all',
};

/**
 * Liest den Pfad zur Settings-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/ticker-settings.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveSettingsFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'ticker-settings.json');
}

/**
 * Liest die persistierten Ticker-Settings.
 * Fällt auf Defaults zurück wenn keine JSON-Datei existiert.
 *
 * @returns {Promise<TickerSettings>}
 */
export async function read() {
  const filePath = resolveSettingsFilePath();

  if (filePath) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return _mergeWithDefaults(parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[TickerSettingsStore] Lesen fehlgeschlagen:', err.message);
      }
      // ENOENT = noch keine Datei → Defaults
    }
  }

  return _mergeWithDefaults({});
}

/**
 * Schreibt die Ticker-Settings atomar auf das Credential-Volume.
 * Merged mit dem aktuellen Stand (Partial-Updates möglich).
 *
 * @param {Partial<TickerSettings>} settings - Neue Settings (werden mit aktuellem Stand gemergt)
 * @returns {Promise<TickerSettings>} Die vollständig gespeicherte Konfiguration.
 * @throws {Error} Wenn CRED_STORE_DIR nicht gesetzt oder Schreiben fehlschlägt.
 */
export async function write(settings) {
  const filePath = resolveSettingsFilePath();
  if (!filePath) {
    throw new Error(
      '[TickerSettingsStore] CRED_STORE_DIR nicht gesetzt — Settings können nicht gespeichert werden.',
    );
  }

  const current = await read();
  const merged = _mergeWithDefaults({
    ...current,
    ...settings,
    window: { ...current.window, ...(settings.window ?? {}) },
  });

  const json = JSON.stringify(merged, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  await mkdir(dirname(filePath), { recursive: true });

  try {
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const e = new Error(`[TickerSettingsStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
    e.code = err.code;
    throw e;
  }

  try {
    await chmod(filePath, 0o600);
  } catch {
    // Non-fatal
  }

  return merged;
}

/**
 * Validiert die Ticker-Settings-Felder für PUT (Settings-Schema-Tabelle, Spec-Vertrag).
 * Gibt bei Fehler `{ ok: false, field, message }` zurück, sonst `{ ok: true }`.
 *
 * `maxParallel` wird NICHT abgelehnt, sondern auf 1–3 geklemmt (Edge-Case:
 * "maxParallel außerhalb 1–3 → auf gültigen Bereich klemmen", Account-Überlast-Schutz) —
 * das Klemmen passiert in `_mergeWithDefaults`, hier wird nur der Zahl-Typ geprüft.
 *
 * @param {object} body - Request-Body
 * @param {{ knownSlugs?: string[] }} [context] - Optionale bekannte Projekt-Slugs
 *   (aus `BoardAggregator.getIndex()`) zur Existenz-Prüfung von `projects`. Fehlt der
 *   Kontext (BoardAggregator nicht verfügbar), wird die Existenz-Prüfung übersprungen
 *   (graceful degradation) — Format-Prüfung bleibt bestehen.
 * @returns {{ ok: boolean, field?: string, message?: string }}
 */
export function validate(body, context = {}) {
  const { enabled, window, intervalMinutes, maxParallel, staleInProgressHours, escalationAttempts, projects } = body ?? {};
  const { knownSlugs } = context;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { ok: false, field: 'enabled', message: 'enabled muss ein Boolean sein.' };
  }

  if (window !== undefined) {
    if (typeof window !== 'object' || window === null || Array.isArray(window)) {
      return { ok: false, field: 'window', message: 'window muss ein Objekt sein.' };
    }
    if (window.start !== undefined && !TIME_RE.test(String(window.start))) {
      return { ok: false, field: 'window.start', message: 'window.start muss im 24h-Format "HH:MM" sein.' };
    }
    if (window.end !== undefined && !TIME_RE.test(String(window.end))) {
      return { ok: false, field: 'window.end', message: 'window.end muss im 24h-Format "HH:MM" sein.' };
    }
    if (window.timezone !== undefined) {
      if (!_isValidTimezone(String(window.timezone))) {
        return { ok: false, field: 'window.timezone', message: 'window.timezone muss eine gültige IANA-Zeitzone sein.' };
      }
    }
  }

  if (intervalMinutes !== undefined) {
    const n = Number(intervalMinutes);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, field: 'intervalMinutes', message: 'intervalMinutes muss eine ganze Zahl ≥ 1 sein.' };
    }
  }

  if (maxParallel !== undefined) {
    const n = Number(maxParallel);
    if (!Number.isInteger(n)) {
      return { ok: false, field: 'maxParallel', message: 'maxParallel muss eine ganze Zahl sein (wird auf 1–3 geklemmt).' };
    }
  }

  if (staleInProgressHours !== undefined) {
    const n = Number(staleInProgressHours);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, field: 'staleInProgressHours', message: 'staleInProgressHours muss eine ganze Zahl ≥ 1 sein.' };
    }
  }

  if (escalationAttempts !== undefined) {
    const n = Number(escalationAttempts);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, field: 'escalationAttempts', message: 'escalationAttempts muss eine ganze Zahl ≥ 1 sein.' };
    }
  }

  if (projects !== undefined) {
    if (projects !== 'all') {
      if (!Array.isArray(projects)) {
        return { ok: false, field: 'projects', message: 'projects muss "all" oder ein Array von Projekt-Slugs sein.' };
      }
      for (const slug of projects) {
        if (typeof slug !== 'string' || !PROJECT_SLUG_RE.test(slug)) {
          return {
            ok: false,
            field: 'projects',
            message: `Ungültiger Projekt-Slug: ${JSON.stringify(slug)}. Erlaubt: Buchstaben, Ziffern, - und _.`,
          };
        }
      }
      if (Array.isArray(knownSlugs)) {
        const unknown = projects.filter((slug) => !knownSlugs.includes(slug));
        if (unknown.length > 0) {
          return {
            ok: false,
            field: 'projects',
            message: `Unbekannte Projekt-Slugs (nicht im Board-Index): ${unknown.join(', ')}.`,
          };
        }
      }
    }
  }

  return { ok: true };
}

// ── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Prüft ob `tz` eine von der Runtime unterstützte IANA-Zeitzone ist.
 *
 * @param {string} tz
 * @returns {boolean}
 * @private
 */
function _isValidTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merged geparste Settings mit Defaults. Normalisiert Felder auf bekannte Typen
 * und klemmt `maxParallel` auf den gültigen Bereich 1–3 (Edge-Case: Account-Überlast-Schutz).
 *
 * @param {object} parsed
 * @returns {TickerSettings}
 * @private
 */
function _mergeWithDefaults(parsed) {
  const win = typeof parsed.window === 'object' && parsed.window !== null ? parsed.window : {};

  const intervalMinutes = Number(parsed.intervalMinutes);
  const staleInProgressHours = Number(parsed.staleInProgressHours);
  const escalationAttempts = Number(parsed.escalationAttempts);
  const maxParallelRaw = Number(parsed.maxParallel);

  return {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
    window: {
      start: typeof win.start === 'string' && TIME_RE.test(win.start) ? win.start : DEFAULT_SETTINGS.window.start,
      end: typeof win.end === 'string' && TIME_RE.test(win.end) ? win.end : DEFAULT_SETTINGS.window.end,
      timezone: typeof win.timezone === 'string' && _isValidTimezone(win.timezone)
        ? win.timezone
        : DEFAULT_SETTINGS.window.timezone,
    },
    intervalMinutes: Number.isInteger(intervalMinutes) && intervalMinutes >= 1
      ? intervalMinutes
      : DEFAULT_SETTINGS.intervalMinutes,
    maxParallel: Number.isInteger(maxParallelRaw)
      ? Math.min(3, Math.max(1, maxParallelRaw))
      : DEFAULT_SETTINGS.maxParallel,
    staleInProgressHours: Number.isInteger(staleInProgressHours) && staleInProgressHours >= 1
      ? staleInProgressHours
      : DEFAULT_SETTINGS.staleInProgressHours,
    escalationAttempts: Number.isInteger(escalationAttempts) && escalationAttempts >= 1
      ? escalationAttempts
      : DEFAULT_SETTINGS.escalationAttempts,
    projects: parsed.projects === 'all'
      ? 'all'
      : Array.isArray(parsed.projects)
        ? parsed.projects.filter((s) => typeof s === 'string' && PROJECT_SLUG_RE.test(s))
        : DEFAULT_SETTINGS.projects,
  };
}
