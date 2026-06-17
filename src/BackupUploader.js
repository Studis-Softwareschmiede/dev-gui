/**
 * BackupUploader.js — Off-Host-Upload für Backup-Artefakte (S-141, S3-only ab S-160).
 *
 * Kapselt die Provider-Implementierung für den Upload des GPG-verschlüsselten
 * Backup-Artefakts an ein Off-Host-Ziel (S3-kompatibel).
 *
 * Verhaltens-Verträge (AC8–AC10, credential-backup spec):
 *   AC8:  Dasselbe Artefakt wird zusätzlich zur lokalen Kopie hochgeladen;
 *         die lokale Kopie bleibt vom Remote-Ergebnis unabhängig.
 *   AC9:  Remote-Zugangsdaten werden aus dem CredentialStore gelesen (Klartext
 *         nur zur Laufzeit); sie erscheinen NIEMALS in Logs, Responses, WS-Frames,
 *         Argv oder dem Frontend-Bundle.
 *   AC10: Remote-Fehler führen NICHT zum Crash und NICHT zum Rollback der
 *         Cred-Operation; begrenzter Retry; endgültiger Fehlschlag → 'failed'.
 *
 * SFTP-Off-Host-Pfad entfernt (S-160):
 *   _uploadSftp, targetType:'sftp'-Zweig und BACKUP_SFTP_*-Auflösung sind vollständig
 *   entfernt. Die ssh2-Dependency bleibt in package.json (VPS/cloudflared nutzen sie).
 *
 * Architekt-Entscheid (S-143, Variante B):
 *   resolveOffHostConfigAsync() liest zuerst aus BackupConfigStore (JSON-Datei auf
 *   dem Credential-Volume), fällt dann auf Env-Vars zurück. Damit wirkt eine UI-
 *   Änderung über PUT /api/settings/backup-config tatsächlich auf den nächsten
 *   Backup-Lauf.
 *   resolveOffHostConfig() (synchron, Env-only) bleibt für Rückwärtskompatibilität
 *   und Unit-Tests erhalten.
 *
 * Security-Floor (§NFRs, security/R01–R04):
 *   - Zugangsdaten werden ausschließlich über creds-Parameter übergeben (nie Argv/Log).
 *   - Alle Fehler werden abgefangen — kein uncaught-Exception-Crash.
 *   - Zugangsdaten erscheinen NICHT in Error-Messages nach außen.
 *   - Keine verarbeiteten Remote-Responses im Log (können Sensitive-Info enthalten).
 *
 * Provider-Schema:
 *   Typ "s3": { type:'s3', endpoint, bucket, prefix, region } + Creds { accessKey, secretKey }
 *
 * @module BackupUploader
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { read as readBackupConfig } from './BackupConfigStore.js';

/** Maximale Anzahl Upload-Versuche (Retry + Erstversuch = UPLOAD_MAX_ATTEMPTS Versuche total). */
export const UPLOAD_MAX_ATTEMPTS = 3;

/** Basis-Wartezeit (ms) zwischen Retry-Versuchen (exponentielles Backoff). */
const RETRY_BASE_MS = 500;

/** Timeout pro S3-Upload (ms). */
const S3_TIMEOUT_MS = 30_000;

/**
 * Liest Off-Host-Konfiguration aus Env-Vars.
 * Gibt null zurück wenn kein Ziel konfiguriert (→ offHost: 'disabled').
 *
 * Nicht-geheime Konfigurationsparameter:
 *   BACKUP_OFFHOST_TYPE    = 's3'  (Pflicht, wenn Off-Host aktiv)
 *   BACKUP_OFFHOST_ENABLED = '1' | 'true'   (Pflicht, sonst disabled)
 *
 * S3-spezifisch (nicht-geheim):
 *   BACKUP_S3_ENDPOINT  — vollständige S3-URL (z.B. https://s3.amazonaws.com oder MinIO-URL)
 *   BACKUP_S3_BUCKET    — Bucket-Name
 *   BACKUP_S3_PREFIX    — Pfad-Präfix im Bucket (optional, default: 'backups/')
 *   BACKUP_S3_REGION    — AWS Region (default: 'us-east-1')
 *
 * @returns {{ type: 's3', [key: string]: string } | null}
 */
export function resolveOffHostConfig() {
  const enabled = process.env.BACKUP_OFFHOST_ENABLED;
  if (!enabled || (enabled.trim() !== '1' && enabled.trim().toLowerCase() !== 'true')) {
    return null;
  }

  const type = process.env.BACKUP_OFFHOST_TYPE?.trim().toLowerCase();
  if (!type) return null;

  if (type === 's3') {
    const bucket = process.env.BACKUP_S3_BUCKET?.trim();
    if (!bucket) return null; // Bucket ist Pflicht
    return {
      type: 's3',
      endpoint: process.env.BACKUP_S3_ENDPOINT?.trim() ?? '',
      bucket,
      prefix: process.env.BACKUP_S3_PREFIX?.trim() ?? 'backups/',
      region: process.env.BACKUP_S3_REGION?.trim() ?? 'us-east-1',
    };
  }

  return null;
}

/**
 * Liest Off-Host-Konfiguration: zuerst aus BackupConfigStore (JSON-Datei),
 * dann Env-Vars als Fallback (Architekt-Entscheid S-143, Variante B).
 *
 * Konvertiert das BackupConfig-Format in das von BackupEngine/uploadArtefact
 * erwartete { type, ...} Format.
 *
 * Gibt null zurück wenn Off-Host deaktiviert oder kein Ziel konfiguriert.
 *
 * @returns {Promise<{ type: 's3', [key: string]: string } | null>}
 */
export async function resolveOffHostConfigAsync() {
  let config;
  try {
    config = await readBackupConfig();
  } catch {
    // Fallback auf synchrone Env-Variante bei Fehler
    return resolveOffHostConfig();
  }

  if (!config.offHostEnabled) return null;

  const type = config.targetType;
  if (type === 's3') {
    if (!config.bucket) return null; // Bucket ist Pflicht
    return {
      type: 's3',
      endpoint: config.endpoint ?? '',
      bucket: config.bucket,
      prefix: config.prefix ?? 'backups/',
      region: config.region ?? 'us-east-1',
    };
  }

  return null; // targetType='local' oder unbekannt → kein Off-Host-Upload
}

/**
 * Führt den Off-Host-Upload durch.
 *
 * AC9: `creds` enthält Zugangsdaten (Klartext, aus CredentialStore entschlüsselt);
 *      sie erscheinen NICHT in Logs oder Fehlermeldungen nach außen.
 * AC10: Begrenzter Retry; keine Exception nach außen; Fehler → 'failed'.
 *
 * @param {object} opts
 * @param {Buffer} opts.artefactBuffer       - Das verschlüsselte GPG-Artefakt
 * @param {string} opts.artefactName         - Dateiname (z.B. 'backup-2026-01-01T00-00-00-000Z-abcd1234.gpg')
 * @param {{ type: 's3', [key: string]: string }} opts.config   - Nicht-geheime Konfiguration
 * @param {object} opts.creds                - Zugangsdaten (NICHT loggen)
 * @param {string} [opts.creds.accessKey]    - S3 Access Key ID
 * @param {string} [opts.creds.secretKey]    - S3 Secret Access Key
 * @returns {Promise<'ok'|'failed'>}
 */
export async function uploadArtefact({ artefactBuffer, artefactName, config, creds }) {
  if (!config || !config.type) return 'failed';
  if (!artefactBuffer || !artefactName) return 'failed';

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      if (config.type === 's3') {
        await _uploadS3({ artefactBuffer, artefactName, config, creds });
      } else {
        // Unbekannter Provider
        return 'failed';
      }
      return 'ok';
    } catch {
      // AC10: begrenzter Retry — bei transientem Fehler warten, dann wiederholen.
      // AC9: Fehlertext wird NICHT nach außen weitergegeben (kann Conn-Info enthalten).
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        await _sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  // AC10: Alle Versuche fehlgeschlagen — 'failed' zurückgeben, kein Throw
  return 'failed';
}

/**
 * S3-Upload via @aws-sdk/client-s3.
 * AC9: accessKey/secretKey erscheinen NIEMALS im Log/Fehlertext.
 *
 * @private
 */
async function _uploadS3({ artefactBuffer, artefactName, config, creds }) {
  // AC9: credentials werden NICHT geloggt — nur zum SDK übergeben
  const s3Config = {
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKey ?? '',
      secretAccessKey: creds.secretKey ?? '',
    },
  };

  // Endpoint-Override für S3-kompatible Dienste (MinIO, Backblaze B2, etc.)
  if (config.endpoint) {
    s3Config.endpoint = config.endpoint;
    // Für MinIO/S3-kompatible Dienste ist Path-Style erforderlich
    s3Config.forcePathStyle = true;
  }

  const client = new S3Client(s3Config);

  // Timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);

  const prefix = config.prefix.endsWith('/') ? config.prefix : config.prefix + '/';
  const key = prefix + artefactName;

  try {
    const cmd = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: artefactBuffer,
      ContentType: 'application/octet-stream',
    });

    await client.send(cmd, { abortSignal: controller.signal });
  } catch (err) {
    // AC9: Fehlertext enthält KEINE Credentials (accessKey/secretKey)
    // AWS SDK-Fehler können Region/Endpoint-Info enthalten — das ist OK (nicht-geheim)
    // aber wir scrubben zur Sicherheit den err.message von Key-artigen Strings
    const safeMsg = _scrubCredsFromMessage(err.message ?? '', creds);
    const e = new Error(`[BackupUploader] S3-Upload fehlgeschlagen: ${safeMsg}`);
    e.errorClass = 'remote-upload-failed';
    throw e;
  } finally {
    clearTimeout(timer);
    // S3Client hat keinen expliziten destroy-Aufruf nötig (connectionTimeout managed intern)
  }
}

/**
 * Bereinigt bekannte Credential-Werte aus einer Fehlermeldung (Defense-in-Depth).
 * AC9: Verhindert dass accessKey/secretKey in Fehlertexten erscheinen.
 *
 * @param {string} message
 * @param {object} creds
 * @returns {string}
 *
 * @internal Exportiert für Unit-Tests; nicht Teil der öffentlichen API.
 */
export function _scrubCredsFromMessage(message, creds) {
  let result = message;
  // Nur nicht-leere Credentials scrubben (leere Strings würden alles ersetzen)
  if (creds.accessKey && creds.accessKey.length > 4) {
    result = result.replaceAll(creds.accessKey, '[REDACTED]');
  }
  if (creds.secretKey && creds.secretKey.length > 4) {
    result = result.replaceAll(creds.secretKey, '[REDACTED]');
  }
  if (creds.password && creds.password.length > 4) {
    result = result.replaceAll(creds.password, '[REDACTED]');
  }
  // privateKey Defence-in-Depth (erhalten für Rückwärtskompatibilität mit _scrubCredsFromMessage-Aufrufen)
  if (creds.privateKey && creds.privateKey.length > 10) {
    // Ersten 40 Zeichen des PEM-Schlüssels aus dem Fehlertext entfernen
    const pkSnippet = creds.privateKey.slice(0, 40);
    result = result.replaceAll(pkSnippet, '[REDACTED-PK]');
    // Zeilenweise scrubben: jede Zeile mit >10 Zeichen (PEM-Body-Zeilen sind Base64)
    for (const line of creds.privateKey.split('\n')) {
      if (line.length > 10) {
        result = result.replaceAll(line, '[REDACTED-PK]');
      }
    }
  }
  return result;
}

/**
 * Sleep-Hilfsfunktion für Retry-Backoff.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
