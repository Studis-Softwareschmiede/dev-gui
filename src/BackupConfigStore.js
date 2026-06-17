/**
 * BackupConfigStore.js — Persistente nicht-geheime Backup-Konfiguration (S-143, Architekt-Entscheid Variante B).
 *
 * Kapselt das Lesen und atomare Schreiben der nicht-geheimen Backup-Konfiguration
 * als JSON-Datei auf dem persistenten Credential-Volume.
 *
 * Datei: ${CRED_STORE_DIR}/backup-config.json
 * Rechte: 0600 (konsistent restriktiv, obwohl nicht-geheim)
 * Schreiben: atomar (tmp + rename)
 *
 * Verhalten (Architekt-Entscheid):
 *   - Existiert die JSON-Datei → ist sie die Quelle der Wahrheit.
 *   - Existiert sie NICHT → gelten BACKUP_OFFHOST_... und CRED_BACKUP_RETENTION-Env-Vars
 *     als Initial-Default (Migration und Erstkonfig, kompatibel mit Iteration 1).
 *   - Die UI schreibt über PUT /api/settings/backup-config → JSON-Datei wird erstellt/aktualisiert.
 *
 * Security-Floor:
 *   - Nur nicht-geheime Felder (Typ, Pfad/URL/Bucket/Host/Präfix/Region, Retention, An/Aus).
 *   - KEINE Remote-Secrets (die bleiben im CredentialStore).
 *   - Schreib-Operationen auditiert + CRED_ADMIN_EMAILS-gesichert (im Router, nicht hier).
 *
 * @module BackupConfigStore
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {object} BackupConfig
 * @property {boolean}              offHostEnabled - Off-Host-Backup aktiv
 * @property {'local'|'s3'|'sftp'}  targetType     - Ziel-Typ
 * @property {string}               endpoint       - S3-Endpoint-URL (leer = AWS S3)
 * @property {string}               bucket         - S3-Bucket-Name
 * @property {string}               prefix         - Pfad-Präfix (S3/SFTP)
 * @property {string}               region         - S3-Region
 * @property {string}               host           - SFTP-Hostname
 * @property {string}               port           - SFTP-Port
 * @property {string}               user           - SFTP-Benutzer
 * @property {number}               retentionCount - Max. Anzahl lokaler Kopien
 */

/** Default-Konfiguration (überschrieben durch Env-Vars oder gespeicherte JSON). */
const DEFAULT_CONFIG = {
  offHostEnabled: false,
  targetType: 'local',
  endpoint: '',
  bucket: '',
  // S3-Präfix-Default ist 'dev-gui/' (AC19, S-147).
  // SFTP nutzt ein absolutes Pfad-Format ('/backups') und wird in _readFromEnv()
  // kontextabhängig vom targetType gesetzt; das gemeinsame prefix-Feld enthält
  // im Default den S3-Wert, weil 'local' (kein Off-Host) der häufigste Erst-Zustand ist.
  prefix: 'dev-gui/',
  region: 'us-east-1',
  host: '',
  port: '22',
  user: '',
  retentionCount: 10,
};

/**
 * Liest den Pfad zur Backup-Konfig-Datei aus der Umgebung.
 * Pfad: ${CRED_STORE_DIR}/backup-config.json
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveConfigFilePath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'backup-config.json');
}

/**
 * Liest die persistierte Backup-Konfiguration.
 * Fällt auf Env-Vars zurück wenn keine JSON-Datei existiert.
 *
 * Priorität: JSON-Datei > Env-Vars > Hardcoded-Defaults
 *
 * @returns {Promise<BackupConfig>}
 */
export async function read() {
  const filePath = resolveConfigFilePath();

  if (filePath) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge mit Defaults (future-proof: neue Felder bekommen sicheren Default)
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Parse-Fehler oder Zugriffsrechte-Fehler → loggen, Env-Fallback
        console.error('[BackupConfigStore] Lesen der backup-config.json fehlgeschlagen:', err.message);
      }
      // ENOENT = Datei existiert noch nicht → Env-Fallback (Erstkonfig)
    }
  }

  // Env-Vars als Fallback (Architekt-Entscheid: Env ist Initial-Default)
  return _readFromEnv();
}

/**
 * Schreibt die Backup-Konfiguration atomar auf das Credential-Volume.
 * Atomar: tmp-Datei schreiben → chmod 0600 → rename.
 *
 * @param {Partial<BackupConfig>} config - Neue Konfiguration (wird mit aktueller gemergt)
 * @returns {Promise<BackupConfig>} Die vollständige, gespeicherte Konfiguration.
 * @throws {Error} Wenn CRED_STORE_DIR nicht gesetzt oder Schreiben fehlschlägt.
 */
export async function write(config) {
  const filePath = resolveConfigFilePath();
  if (!filePath) {
    throw new Error('[BackupConfigStore] CRED_STORE_DIR nicht gesetzt — Konfiguration kann nicht gespeichert werden.');
  }

  // Aktuelle Konfiguration lesen (als Merge-Basis)
  const current = await read();
  const merged = { ...current, ...config };

  // Validierung: retentionCount muss positiv sein
  if (typeof merged.retentionCount !== 'number' || merged.retentionCount < 1) {
    merged.retentionCount = DEFAULT_CONFIG.retentionCount;
  }

  const json = JSON.stringify(merged, null, 2);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');

  // Sicherstellen dass das Verzeichnis existiert (atomares Create)
  await mkdir(dirname(filePath), { recursive: true });

  try {
    // Atomar schreiben: tmp → chmod → rename
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
  } catch (err) {
    // Aufräumen des tmp-Files bei Fehler (best-effort)
    await unlink(tmpPath).catch(() => {});
    const e = new Error(`[BackupConfigStore] Atomar-Schreiben fehlgeschlagen: ${err.message}`);
    e.code = err.code;
    throw e;
  }

  // Rechte auch auf der finalen Datei sicherstellen (rename behält Rechte der tmp-Datei)
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Non-fatal: rename hat bereits chmod(tmpPath) gezogen
  }

  return merged;
}

/**
 * Liest Backup-Konfiguration aus BACKUP_OFFHOST_* Env-Vars (Initial-Default / Migration).
 * Entspricht der bisherigen resolveOffHostConfig()-Logik aus BackupUploader.js.
 *
 * @returns {BackupConfig}
 * @private
 */
function _readFromEnv() {
  const enabled = process.env.BACKUP_OFFHOST_ENABLED;
  const isEnabled = Boolean(enabled && (enabled.trim() === '1' || enabled.trim().toLowerCase() === 'true'));
  const type = process.env.BACKUP_OFFHOST_TYPE?.trim().toLowerCase();
  const retentionEnv = parseInt(process.env.CRED_BACKUP_RETENTION ?? '', 10);
  const retentionCount = Number.isFinite(retentionEnv) && retentionEnv > 0 ? retentionEnv : DEFAULT_CONFIG.retentionCount;

  // Ziel-Typ normalisieren
  let targetType = 'local';
  if (isEnabled && type === 's3') targetType = 's3';
  else if (isEnabled && type === 'sftp') targetType = 'sftp';

  return {
    offHostEnabled: isEnabled,
    targetType,
    endpoint: process.env.BACKUP_S3_ENDPOINT?.trim() ?? '',
    bucket: process.env.BACKUP_S3_BUCKET?.trim() ?? '',
    // SFTP nutzt absoluten Pfad-Default '/backups'; S3 nutzt relativen Key-Präfix 'dev-gui/' (AC19).
    // Getrennte Defaults sind nötig, weil die Konzepte verschieden sind.
    prefix: targetType === 'sftp'
      ? (process.env.BACKUP_SFTP_PREFIX?.trim() ?? '/backups')
      : (process.env.BACKUP_S3_PREFIX?.trim() ?? 'dev-gui/'),
    region: process.env.BACKUP_S3_REGION?.trim() ?? 'us-east-1',
    host: process.env.BACKUP_SFTP_HOST?.trim() ?? '',
    port: process.env.BACKUP_SFTP_PORT?.trim() ?? '22',
    user: process.env.BACKUP_SFTP_USER?.trim() ?? '',
    retentionCount,
  };
}
