/**
 * BackupUploader.js — Off-Host-Upload für Backup-Artefakte (S-141).
 *
 * Kapselt die Provider-Implementierungen für den Upload des GPG-verschlüsselten
 * Backup-Artefakts an ein Off-Host-Ziel (S3-kompatibel oder SFTP).
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
 * Security-Floor (§NFRs, security/R01–R04):
 *   - Zugangsdaten werden ausschließlich über creds-Parameter übergeben (nie Argv/Log).
 *   - Alle Fehler werden abgefangen — kein uncaught-Exception-Crash.
 *   - Zugangsdaten erscheinen NICHT in Error-Messages nach außen.
 *   - Keine verarbeiteten Remote-Responses im Log (können Sensitive-Info enthalten).
 *
 * Provider-Schema:
 *   Typ "s3":   { type:'s3', endpoint, bucket, prefix, region } + Creds { accessKey, secretKey }
 *   Typ "sftp": { type:'sftp', host, port, prefix, user } + Creds { password?, privateKey? }
 *
 * @module BackupUploader
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client as SshClient } from 'ssh2';

/** Maximale Anzahl Upload-Versuche (Retry + Erstversuch = UPLOAD_MAX_ATTEMPTS Versuche total). */
export const UPLOAD_MAX_ATTEMPTS = 3;

/** Basis-Wartezeit (ms) zwischen Retry-Versuchen (exponentielles Backoff). */
const RETRY_BASE_MS = 500;

/** Timeout pro SFTP-Verbindung + Upload (ms). */
const SFTP_TIMEOUT_MS = 30_000;

/** Timeout pro S3-Upload (ms). */
const S3_TIMEOUT_MS = 30_000;

/**
 * Liest Off-Host-Konfiguration aus Env-Vars.
 * Gibt null zurück wenn kein Ziel konfiguriert (→ offHost: 'disabled').
 *
 * Nicht-geheime Konfigurationsparameter:
 *   BACKUP_OFFHOST_TYPE    = 's3' | 'sftp'  (Pflicht, wenn Off-Host aktiv)
 *   BACKUP_OFFHOST_ENABLED = '1' | 'true'   (Pflicht, sonst disabled)
 *
 * S3-spezifisch (nicht-geheim):
 *   BACKUP_S3_ENDPOINT  — vollständige S3-URL (z.B. https://s3.amazonaws.com oder MinIO-URL)
 *   BACKUP_S3_BUCKET    — Bucket-Name
 *   BACKUP_S3_PREFIX    — Pfad-Präfix im Bucket (optional, default: 'backups/')
 *   BACKUP_S3_REGION    — AWS Region (default: 'us-east-1')
 *
 * SFTP-spezifisch (nicht-geheim):
 *   BACKUP_SFTP_HOST    — Hostname/IP
 *   BACKUP_SFTP_PORT    — Port (default: 22)
 *   BACKUP_SFTP_USER    — Benutzername
 *   BACKUP_SFTP_PREFIX  — Remote-Verzeichnis-Präfix (default: '/backups')
 *
 * @returns {{ type: 's3'|'sftp', [key: string]: string } | null}
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

  if (type === 'sftp') {
    const host = process.env.BACKUP_SFTP_HOST?.trim();
    if (!host) return null; // Host ist Pflicht
    return {
      type: 'sftp',
      host,
      port: process.env.BACKUP_SFTP_PORT?.trim() ?? '22',
      user: process.env.BACKUP_SFTP_USER?.trim() ?? '',
      prefix: process.env.BACKUP_SFTP_PREFIX?.trim() ?? '/backups',
    };
  }

  return null;
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
 * @param {{ type: 's3'|'sftp', [key: string]: string }} opts.config   - Nicht-geheime Konfiguration
 * @param {object} opts.creds                - Zugangsdaten (NICHT loggen)
 * @param {string} [opts.creds.accessKey]    - S3 Access Key ID
 * @param {string} [opts.creds.secretKey]    - S3 Secret Access Key
 * @param {string} [opts.creds.password]     - SFTP Passwort
 * @param {string} [opts.creds.privateKey]   - SFTP Private Key (PEM)
 * @returns {Promise<'ok'|'failed'>}
 */
export async function uploadArtefact({ artefactBuffer, artefactName, config, creds }) {
  if (!config || !config.type) return 'failed';
  if (!artefactBuffer || !artefactName) return 'failed';

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      if (config.type === 's3') {
        await _uploadS3({ artefactBuffer, artefactName, config, creds });
      } else if (config.type === 'sftp') {
        await _uploadSftp({ artefactBuffer, artefactName, config, creds });
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
 * SFTP-Upload via ssh2.
 * AC9: password/privateKey erscheinen NIEMALS im Log/Fehlertext.
 *
 * @private
 */
async function _uploadSftp({ artefactBuffer, artefactName, config, creds }) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        const e = new Error('[BackupUploader] SFTP-Upload-Timeout');
        e.errorClass = 'remote-upload-failed';
        reject(e);
      }
    }, SFTP_TIMEOUT_MS);

    const fail = (msg) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        conn.end();
        // AC9: msg enthält KEINE Credentials (bereits durch _scrubCredsFromMessage bereinigt)
        const e = new Error(`[BackupUploader] SFTP-Upload fehlgeschlagen: ${msg}`);
        e.errorClass = 'remote-upload-failed';
        reject(e);
      }
    };

    conn.on('error', (err) => {
      // AC9: err.message wird bereinigt (kann Host/User enthalten — das ist OK)
      // Passwort/PrivateKey erscheinen nicht (ssh2 gibt sie nicht in Fehlern aus)
      fail(_scrubCredsFromMessage(err.message ?? '', creds));
    });

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          fail(_scrubCredsFromMessage(err.message ?? '', creds));
          return;
        }

        const remotePath = _buildSftpPath(config.prefix, artefactName);

        // S-4 Fix: mkdir MUSS abgeschlossen sein, bevor createWriteStream aufgerufen wird —
        // sonst kann ENOENT auftreten wenn das Verzeichnis noch nicht existiert.
        // mkdir-Callback-Fehler ignorieren (EEXIST = Verzeichnis existiert bereits → OK).
        sftp.mkdir(config.prefix, (_mkErr) => {
          // Fehler ignorieren (EEXIST ist erwartet wenn Verzeichnis schon existiert)
          // Erst NACH dem mkdir-Callback den WriteStream öffnen
          const writeStream = sftp.createWriteStream(remotePath);

          writeStream.on('error', (writeErr) => {
            fail(_scrubCredsFromMessage(writeErr.message ?? '', creds));
          });

          writeStream.on('close', () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              conn.end();
              resolve();
            }
          });

          // Artefakt schreiben
          writeStream.end(artefactBuffer);
        });
      });
    });

    // AC9: Verbindungsparameter übergeben — Credentials erscheinen NICHT im Argv/Log
    const connectConfig = {
      host: config.host,
      port: parseInt(config.port || '22', 10),
      username: config.user || '',
      readyTimeout: SFTP_TIMEOUT_MS,
    };

    // Priorität: privateKey > password (wie SSH-Standard)
    if (creds.privateKey) {
      connectConfig.privateKey = creds.privateKey;
    } else if (creds.password) {
      connectConfig.password = creds.password;
    }

    try {
      conn.connect(connectConfig);
    } catch (connectErr) {
      fail(_scrubCredsFromMessage(connectErr.message ?? '', creds));
    }
  });
}

/**
 * Baut den SFTP-Remote-Pfad aus Präfix und Dateiname.
 * @param {string} prefix - Remote-Verzeichnis-Präfix
 * @param {string} filename - Dateiname
 * @returns {string}
 */
function _buildSftpPath(prefix, filename) {
  const normalPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return `${normalPrefix}/${filename}`;
}

/**
 * Bereinigt bekannte Credential-Werte aus einer Fehlermeldung (Defense-in-Depth).
 * AC9: Verhindert dass accessKey/secretKey/password/privateKey in Fehlertexten erscheinen.
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
  // I-2 Fix: privateKey Defence-in-Depth — bei fehlerhaftem PEM kann OpenSSH/ssh2
  // Teile des Keys in Fehlertexten zurückgeben. Den ersten ~40-Zeichen-Header-Snippet
  // (PEM-Zeile 1, z.B. "-----BEGIN OPENSSH PRIVATE KEY-----") redaktieren.
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
