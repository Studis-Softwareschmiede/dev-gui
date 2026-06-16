/**
 * BackupEngine.js — Lokale Backup-Erzeugung + Off-Host-Upload (S-140/S-141).
 *
 * Wird als Post-Write-Hook am einzigen lock-geschützten Schreibpfad des
 * CredentialStore aufgerufen. Erzeugt ein GPG-symmetrisch verschlüsseltes
 * Artefakt (secrets.enc.json-Blob + Manifest), speichert es atomar (0600)
 * im konfigurierten Backup-Verzeichnis und lädt es ggf. an ein Off-Host-Ziel
 * (S3-kompatibel oder SFTP) hoch.
 *
 * Verhaltensgrenzen (AC1–AC10):
 *   AC1:  Einziger Auslöser = Post-Write-Hook. Kein Cron, kein zweiter Trigger.
 *   AC2:  Artefakt = JSON { manifest, blob } → GPG-symmetrisch (Passphrase = Master-Key).
 *   AC3:  Atomar (tmp + rename), Rechte 0600, im konfigurierten Backup-Dir.
 *   AC4:  Backup-Fehler rollt den Store-Write NICHT zurück.
 *   AC5:  Retention (max. N Dateien, jüngstes wird nie gelöscht).
 *   AC6:  Rückmeldung { local: 'ok'|'failed', offHost: 'ok'|'failed'|'disabled' }.
 *   AC7:  Master-Key / Passphrase erscheinen NIEMALS in Log/Argv/Fehlertext.
 *   AC8:  Zusätzlich zur lokalen Kopie wird das Artefakt an Off-Host-Ziel hochgeladen.
 *   AC9:  Remote-Creds erscheinen NIEMALS in Logs/Responses/WS/Argv/Bundle.
 *   AC10: Remote-Fehler führen NICHT zum Crash, NICHT zum Rollback; begrenzter Retry.
 *
 * @module BackupEngine
 */

import { readFile, readdir, rename, mkdir, open, unlink, writeFile, stat as fsStat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encrypt } from './BackupCrypto.js';
import { uploadArtefact, resolveOffHostConfigAsync } from './BackupUploader.js';

/** Aktuelle Backup-Schema-Version (für Restore-Kompatibilitäts-Check). */
export const BACKUP_SCHEMA_VERSION = 1;

/** Aktuelle Backup-Format-Version. */
export const BACKUP_VERSION = 1;

/** Default-Retention: max. N lokale Backup-Artefakte. */
export const DEFAULT_RETENTION_COUNT = 10;

/**
 * Erzeugt ein Backup-Artefakt und schreibt es atomar ins Backup-Verzeichnis.
 *
 * @param {object} opts
 * @param {string} opts.masterKeyRaw         - Master-Key-Rohwert (Passphrase für GPG). Wird NICHT geloggt.
 * @param {string} opts.storeFilePath        - Absoluter Pfad zu secrets.enc.json
 * @param {string} opts.backupDir            - Absoluter Pfad zum Backup-Verzeichnis
 * @param {number} [opts.retentionCount]     - Max. Anzahl lokaler Artefakte (default: DEFAULT_RETENTION_COUNT)
 * @param {string} [opts.storeBlob]          - Aktueller secrets.enc.json-Inhalt (bereits gelesen, für Tests)
 * @param {object|null} [opts.offHostConfig] - Off-Host-Konfiguration (nicht-geheim, aus Env).
 *                                             null/undefined → disabled. Default: resolveOffHostConfig()
 * @param {object} [opts.offHostCreds]       - Geheime Zugangsdaten (aus CredentialStore, NICHT loggen).
 *                                             { accessKey?, secretKey?, password?, privateKey? }
 * @param {Function} [opts._uploaderFn]      - Test-Override für uploadArtefact (Dependency Injection)
 *
 * @returns {Promise<BackupResult>}
 *
 * @typedef {object} BackupResult
 * @property {'ok'|'failed'} local              - Ergebnis der lokalen Kopie
 * @property {'ok'|'failed'|'disabled'} offHost - Ergebnis des Off-Host-Uploads
 * @property {string} [localPath]               - Absoluter Pfad zum erzeugten Artefakt (bei local: 'ok')
 * @property {string} [errorClass]              - Fehlerklasse (bei 'failed')
 * @property {string} [message]                 - Fehlermeldung ohne Secret-Inhalt (bei 'failed')
 */
export async function runBackup(opts) {
  const {
    masterKeyRaw,
    storeFilePath,
    backupDir,
    retentionCount = DEFAULT_RETENTION_COUNT,
    storeBlob,
    // AC8/AC9/AC10: Off-Host-Upload (S-141)
    // offHostConfig: nicht-geheime Konfiguration (Typ, Host/Bucket, Präfix, Region)
    // undefined → wird aus Env gelesen; null → disabled (Override für Tests)
    offHostConfig: _offHostConfigArg,
    // AC9: geheime Zugangsdaten (aus CredentialStore, NICHT loggen, NICHT nach außen)
    offHostCreds = {},
    // Test-Override: Dependency Injection für uploadArtefact
    _uploaderFn = uploadArtefact,
  } = opts;

  // Resolve off-host config:
  //   null       = explicitly disabled (test override)
  //   object     = explicit override (tests or callers with pre-resolved config)
  //   undefined  = read from BackupConfigStore (JSON-Datei > Env-Vars, Architekt-Entscheid S-143)
  const offHostConfig = _offHostConfigArg === null
    ? null
    : (_offHostConfigArg !== undefined ? _offHostConfigArg : await resolveOffHostConfigAsync());

  // AC7: masterKeyRaw wird NIEMALS geloggt
  try {
    // 1. Artefakt-Inhalt aufbauen: Manifest + secrets.enc.json-Blob
    let blob;
    if (storeBlob !== undefined) {
      blob = storeBlob;
    } else {
      try {
        blob = await readFile(storeFilePath, 'utf8');
      } catch (err) {
        const offHostVal = offHostConfig ? 'failed' : 'disabled';
        await writeSidecar('failed', offHostVal);
        return {
          local: 'failed',
          offHost: offHostVal,
          errorClass: 'backup-failed',
          message: `[BackupEngine] secrets.enc.json nicht lesbar: ${err.message}`,
        };
      }
    }

    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      backupVersion: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      storeSize: Buffer.byteLength(blob, 'utf8'),
    };

    const artefactJson = JSON.stringify({ manifest, blob });

    // 2. GPG-Verschlüsselung (AC2, AC7: Passphrase via stdin, nicht Argv)
    let encryptedBuf;
    try {
      encryptedBuf = await encrypt(masterKeyRaw, Buffer.from(artefactJson, 'utf8'));
    } catch (gpgErr) {
      const offHostVal = offHostConfig ? 'failed' : 'disabled';
      await writeSidecar('failed', offHostVal);
      return {
        local: 'failed',
        offHost: offHostVal,
        errorClass: gpgErr.errorClass ?? 'backup-failed',
        // AC7: Fehlertext enthält NICHT den Master-Key
        message: `[BackupEngine] GPG-Verschlüsselung fehlgeschlagen: ${gpgErr.message}`,
      };
    }

    // 3. Backup-Verzeichnis idempotent anlegen (mode 0700)
    await mkdir(backupDir, { recursive: true, mode: 0o700 });

    // 4. Atomares Schreiben: tmp → rename (AC3)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    const filename = `backup-${timestamp}-${rand}.gpg`;
    const finalPath = join(backupDir, filename);
    const tmpPath = `${finalPath}.tmp`;

    let fd;
    try {
      fd = await open(tmpPath, 'w', 0o600);
      await fd.writeFile(encryptedBuf);
      await fd.sync();
    } finally {
      if (fd) await fd.close();
    }

    // rename ist atomar auf demselben Dateisystem (AC3)
    await rename(tmpPath, finalPath);

    // sicherstellen dass mode korrekt ist nach rename (AC3: 0600)
    await chmod(finalPath, 0o600);

    // 5. Retention aufräumen (AC5: älteste Artefakte löschen, jüngstes nie)
    // Nicht-fatal: Aufräum-Fehler → Backup gilt als erfolgreich
    try {
      await _applyRetention(backupDir, retentionCount);
    } catch {
      // Nicht-fatal — intern ignorieren (AC5: Aufräum-Warnung ist intern, kein Cred-Rollback)
    }

    // 6. Off-Host-Upload (AC8/AC9/AC10 — S-141)
    // AC8: Lokale Kopie bleibt unabhängig vom Remote-Ergebnis bestehen.
    // AC10: Remote-Fehler kein Crash, kein Rollback; begrenzter Retry in uploadArtefact().
    let offHostResult = 'disabled';
    if (offHostConfig) {
      try {
        // AC9: offHostCreds (Secrets) werden NICHT geloggt, NICHT in Fehlertexten nach außen
        offHostResult = await _uploaderFn({
          artefactBuffer: encryptedBuf,
          artefactName: filename,
          config: offHostConfig,
          creds: offHostCreds,
        });
      } catch {
        // AC10: Kein Crash — unerwartete Exception (sollte nicht vorkommen, uploadArtefact gibt immer string)
        offHostResult = 'failed';
      }
    }

    // 7. Sidecar-Persistenz: Stufen-Ergebnis für Status-Kachel (AC12 / I2-Fix).
    // Metadaten-only (kein Pfad/Secret/Artefakt-Inhalt). Best-effort: Fehler darf Flow nicht brechen.
    await writeSidecar('ok', offHostResult);

    return {
      local: 'ok',
      offHost: offHostResult,
      localPath: finalPath,
    };
  } catch (err) {
    // AC4: Kein Rollback des Store-Writes — nur Fehlerbericht
    // AC7: err.message enthält NICHT den Master-Key (alle internen Fehlertexte oben halten das ein)
    // AC10: Remote-Fehler dürfen nie diese Stelle erreichen (uploadArtefact fängt selbst ab)
    // Sidecar: best-effort auch im Fehlerfall (damit Status-Kachel letzten Fehler zeigen kann)
    await writeSidecar('failed', offHostConfig ? 'failed' : 'disabled');
    return {
      local: 'failed',
      offHost: offHostConfig ? 'failed' : 'disabled',
      errorClass: err.errorClass ?? 'backup-failed',
      message: `[BackupEngine] Unerwarteter Fehler: ${err.message}`,
    };
  }
}

/**
 * Retention-Logik: hält max. `maxCount` Artefakte im Backup-Verzeichnis.
 * Löscht älteste zuerst, das jüngste wird nie gelöscht (AC5).
 *
 * @param {string} backupDir
 * @param {number} maxCount
 */
async function _applyRetention(backupDir, maxCount) {
  let entries;
  try {
    entries = await readdir(backupDir);
  } catch {
    return; // Verzeichnis nicht lesbar → nicht-fatal
  }

  // Nur .gpg-Dateien berücksichtigen
  const gpgFiles = entries.filter((f) => f.endsWith('.gpg') && !f.endsWith('.tmp'));

  if (gpgFiles.length <= maxCount) {
    return; // Nichts zu löschen
  }

  // Stat alle Dateien um mtime zu erhalten
  const withMtime = await Promise.all(
    gpgFiles.map(async (name) => {
      try {
        const s = await fsStat(join(backupDir, name));
        return { name, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  // Valide Einträge nach mtime sortieren (älteste zuerst)
  const valid = withMtime
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);

  if (valid.length <= maxCount) return;

  // Zu löschende Einträge (älteste, aber NICHT das jüngste — AC5)
  const toDelete = valid.slice(0, valid.length - maxCount);

  for (const entry of toDelete) {
    try {
      await unlink(join(backupDir, entry.name));
    } catch {
      // Nicht-fatal — wenn eine Datei nicht gelöscht werden kann, weitermachen
    }
  }
}

/**
 * Gibt den konfigurierten Backup-Verzeichnis-Pfad zurück.
 * Liest CRED_BACKUP_DIR aus der Umgebung; Fallback: CRED_STORE_DIR + '/backups'.
 *
 * @param {string} [storeDir] - Basis-Verzeichnis des Credential-Stores
 * @returns {string}
 */
export function resolveBackupDir(storeDir) {
  if (process.env.CRED_BACKUP_DIR && process.env.CRED_BACKUP_DIR.trim()) {
    return process.env.CRED_BACKUP_DIR.trim();
  }
  const base = storeDir
    ?? (process.env.CRED_STORE_DIR && process.env.CRED_STORE_DIR.trim()
      ? process.env.CRED_STORE_DIR.trim()
      : '/home/node/.cred');
  return join(base, 'backups');
}

/**
 * Gibt die konfigurierte Retention-Anzahl zurück.
 * Liest CRED_BACKUP_RETENTION aus der Umgebung; Fallback: DEFAULT_RETENTION_COUNT.
 *
 * @returns {number}
 */
export function resolveRetentionCount() {
  const raw = process.env.CRED_BACKUP_RETENTION;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_RETENTION_COUNT;
}

/**
 * Gibt den Pfad zur Sidecar-Datei zurück (backup-last-result.json).
 * Neben backup-config.json auf dem persistenten Credential-Volume (CRED_STORE_DIR).
 *
 * @returns {string|null} Absoluter Pfad oder null wenn CRED_STORE_DIR nicht gesetzt.
 */
export function resolveSidecarPath() {
  const storeDir = process.env.CRED_STORE_DIR?.trim();
  if (!storeDir) return null;
  return join(storeDir, 'backup-last-result.json');
}

/**
 * Schreibt das Stufen-Ergebnis atomar in die Sidecar-Datei (best-effort).
 * Metadaten-only: local/offHost-Ergebnis + Zeitstempel — KEIN Pfad/Secret/Artefakt-Inhalt.
 * Rechte: 0600. Atomar: tmp + rename.
 * Fehler beim Schreiben brechen den Backup-/Cred-Flow NICHT (AC4).
 *
 * @param {'ok'|'failed'} local
 * @param {'ok'|'failed'|'disabled'} offHost
 * @returns {Promise<void>}
 */
export async function writeSidecar(local, offHost) {
  const sidecarPath = resolveSidecarPath();
  if (!sidecarPath) return; // CRED_STORE_DIR nicht gesetzt → still überspringen

  const payload = JSON.stringify({ local, offHost, at: new Date().toISOString() });
  const tmpPath = sidecarPath + '.tmp.' + randomBytes(4).toString('hex');

  try {
    await writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, sidecarPath);
  } catch {
    // best-effort: Sidecar-Fehler darf den Backup-/Cred-Flow nicht brechen (AC4)
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}
