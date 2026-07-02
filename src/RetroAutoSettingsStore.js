/**
 * RetroAutoSettingsStore.js — Persistenter nicht-geheimer Ein/Aus-Schalter für den
 * automatischen Retro-Trigger nach Board-Läufen (retro-auto-trigger, AC1).
 *
 * Kapselt das Lesen und atomare Schreiben der globalen Auto-Retro-Konfiguration als
 * Plaintext-JSON-Datei auf dem persistenten Credential-Volume. Muster: `TickerSettingsStore.js`
 * / `NotificationSettingsStore.js` (resolveSettingsFilePath/read/write/validate, atomar,
 * 0600, Merge-mit-Defaults).
 *
 * Datei: ${CRED_STORE_DIR}/retro-auto-settings.json
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Gespeicherte Felder (Settings-Schema-Tabelle, Spec-Vertrag, verbindlich):
 *   enabled (bool, Default false — heutiges Verhalten bleibt Default).
 * NICHT gespeichert: keine Secrets (AC1).
 *
 * Security (Floor):
 *   - Keine Secrets in dieser Datei.
 *   - CRED_STORE_DIR wird als Pfad-Basis genutzt (analog TickerSettingsStore).
 *
 * @module RetroAutoSettingsStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {object} RetroAutoSettings
 * @property {boolean} enabled - Globaler Ein/Aus-Schalter "Danach automatisch Retro durchführen".
 */

/** Default-Konfiguration (Settings-Schema-Tabelle, Spec-Vertrag). Default `enabled:false`. */
const DEFAULT_SETTINGS = {
  enabled: false,
};

/**
 * Liest den Pfad zur Settings-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/retro-auto-settings.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveSettingsFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'retro-auto-settings.json');
}

/**
 * Liest die persistierten Auto-Retro-Settings.
 * Fällt auf Defaults zurück wenn keine JSON-Datei existiert oder die Datei korrupt ist
 * (Edge-Case: "Settings-Datei korrupt/ungültig → read fällt auf Default zurück, kein Crash").
 *
 * @returns {Promise<RetroAutoSettings>}
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
        console.error('[RetroAutoSettingsStore] Lesen fehlgeschlagen:', err.message);
      }
      // ENOENT = noch keine Datei → Defaults; JSON-Parse-Fehler → Defaults (kein Crash)
    }
  }

  return _mergeWithDefaults({});
}

/**
 * Schreibt die Auto-Retro-Settings atomar auf das Credential-Volume.
 * Merged mit dem aktuellen Stand (Partial-Updates möglich).
 *
 * @param {Partial<RetroAutoSettings>} settings - Neue Settings (werden mit aktuellem Stand gemergt)
 * @returns {Promise<RetroAutoSettings>} Die vollständig gespeicherte Konfiguration.
 * @throws {Error} Wenn CRED_STORE_DIR nicht gesetzt oder Schreiben fehlschlägt.
 */
export async function write(settings) {
  const filePath = resolveSettingsFilePath();
  if (!filePath) {
    throw new Error(
      '[RetroAutoSettingsStore] CRED_STORE_DIR nicht gesetzt — Settings können nicht gespeichert werden.',
    );
  }

  const current = await read();
  const merged = _mergeWithDefaults({ ...current, ...settings });

  const json = JSON.stringify(merged, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  await mkdir(dirname(filePath), { recursive: true });

  try {
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const e = new Error(`[RetroAutoSettingsStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
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
 * Validiert die Auto-Retro-Settings-Felder für PUT (Settings-Schema-Tabelle, Spec-Vertrag).
 * Gibt bei Fehler `{ ok: false, field, message }` zurück, sonst `{ ok: true }`.
 *
 * @param {object} body - Request-Body
 * @returns {{ ok: boolean, field?: string, message?: string }}
 */
export function validate(body) {
  const { enabled } = body ?? {};

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { ok: false, field: 'enabled', message: 'enabled muss ein Boolean sein.' };
  }

  return { ok: true };
}

// ── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Merged geparste Settings mit Defaults. Normalisiert `enabled` auf einen Boolean
 * (nicht-boolesche Werte fallen auf den Default `false` zurück).
 *
 * @param {object} parsed
 * @returns {RetroAutoSettings}
 * @private
 */
function _mergeWithDefaults(parsed) {
  const p = typeof parsed === 'object' && parsed !== null ? parsed : {};
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_SETTINGS.enabled,
  };
}
