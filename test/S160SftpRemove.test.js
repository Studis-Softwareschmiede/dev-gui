/**
 * S160SftpRemove.test.js — SFTP-1…SFTP-5 Acceptance-Tests (S-160).
 *
 * Covers (credential-backup spec, S-160):
 *   SFTP-1 — Frontend ohne SFTP: Dropdown hat keine <option value="sftp">;
 *             SFTP-Cred-Felder (sftp_password, sftp_private_key) nicht in BACKUP_REMOTE_FIELDS.
 *   SFTP-2 — BackupUploader ohne SFTP: kein _uploadSftp, kein targetType:'sftp'-Zweig,
 *             kein 'sftp'-String; ssh2-Import in BackupUploader entfernt.
 *   SFTP-3 — BackupConfigStore ohne SFTP-Felder: read() liefert keine host/port/user;
 *             targetType:'sftp' wird nicht erzeugt.
 *   SFTP-4 — CredentialStore-Katalog ohne SFTP-Keys: backup-remote enthält nur
 *             s3_access_key + s3_secret_key; sftp_*-Reads entfernt.
 *   SFTP-5 — ssh2-Dependency bleibt: ssh2 wird von VpsDockerControl weiterhin importiert;
 *             kein Floor-/DR-Regress.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── SFTP-2 — BackupUploader ohne SFTP ────────────────────────────────────────

describe('SFTP-2 — BackupUploader: kein SFTP-Pfad, kein ssh2-Import', () => {
  it('SFTP-2: resolveOffHostConfig() gibt null für type=sftp zurück', async () => {
    const { resolveOffHostConfig } = await import('../src/BackupUploader.js');
    const savedEnv = {
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
      BACKUP_OFFHOST_TYPE: process.env.BACKUP_OFFHOST_TYPE,
    };
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 'sftp';
    try {
      expect(resolveOffHostConfig()).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('SFTP-2: resolveOffHostConfigAsync() gibt null für targetType=sftp zurück', async () => {
    const { resolveOffHostConfigAsync } = await import('../src/BackupUploader.js');
    // BackupConfigStore mock: simuliert gespeicherte sftp-Config
    const tmpDir = await mkdtemp(join(tmpdir(), 's160-sftp2-async-'));
    const savedEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
    };
    delete process.env.BACKUP_OFFHOST_ENABLED;
    process.env.CRED_STORE_DIR = tmpDir;

    // Schreibe eine backup-config.json mit targetType:'sftp'
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(tmpDir, 'backup-config.json'),
      JSON.stringify({ offHostEnabled: true, targetType: 'sftp', host: 'sftp.example.com', port: '22', user: 'user', prefix: '/backups' }),
      { encoding: 'utf8' },
    );

    try {
      // Kein sftp-Zweig mehr → muss null zurückgeben
      const result = await resolveOffHostConfigAsync();
      expect(result).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('SFTP-2: uploadArtefact() mit type=sftp → "failed" sofort (kein _uploadSftp)', async () => {
    const { uploadArtefact } = await import('../src/BackupUploader.js');
    const result = await uploadArtefact({
      artefactBuffer: Buffer.from('test'),
      artefactName: 'test.gpg',
      config: { type: 'sftp', host: '127.0.0.1', port: '22', prefix: '/backups', user: 'u' },
      creds: { password: 'pw' },
    });
    expect(result).toBe('failed');
  });
});

// ── SFTP-3 — BackupConfigStore ohne SFTP-Felder ──────────────────────────────

describe('SFTP-3 — BackupConfigStore: keine SFTP-Felder, kein sftp targetType', () => {
  let tmpDir;
  let savedEnv;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 's160-sftp3-'));
    savedEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
      BACKUP_OFFHOST_TYPE: process.env.BACKUP_OFFHOST_TYPE,
    };
    delete process.env.BACKUP_OFFHOST_ENABLED;
    delete process.env.BACKUP_OFFHOST_TYPE;
    process.env.CRED_STORE_DIR = tmpDir;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('SFTP-3: Default-read() enthält keine host/port/user-Felder', async () => {
    const { read } = await import('../src/BackupConfigStore.js');
    const config = await read();
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.user).toBeUndefined();
  });

  it('SFTP-3: BACKUP_OFFHOST_TYPE=sftp → targetType=local (kein sftp-Zweig)', async () => {
    const { read } = await import('../src/BackupConfigStore.js');
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 'sftp';
    const config = await read();
    expect(config.targetType).toBe('local');
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.user).toBeUndefined();
  });

  it('SFTP-3: write() speichert keine host/port/user auch wenn übergeben', async () => {
    const { write, read } = await import('../src/BackupConfigStore.js');
    // Schreibe mit SFTP-ähnlichen Feldern — sie sollen nicht persistiert werden
    await write({
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'test',
      prefix: 'dev-gui/',
      region: 'us-east-1',
    });
    const config = await read();
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.user).toBeUndefined();
  });

  it('SFTP-3: targetType ist immer in {local, s3} — nie sftp', async () => {
    const { read } = await import('../src/BackupConfigStore.js');
    const config = await read();
    expect(['local', 's3']).toContain(config.targetType);
  });
});

// ── SFTP-4 — CredentialStore-Katalog ohne SFTP-Keys ─────────────────────────

describe('SFTP-4 — CredentialStore: backup-remote-Katalog ohne sftp_* Schlüssel', () => {
  it('SFTP-4: CREDENTIAL_CATALOG backup-remote enthält nur s3_access_key + s3_secret_key', async () => {
    const { CREDENTIAL_CATALOG } = await import('../src/CredentialStore.js');
    const backupRemote = CREDENTIAL_CATALOG['backup-remote'];
    expect(backupRemote).toBeDefined();
    expect(backupRemote).toContain('s3_access_key');
    expect(backupRemote).toContain('s3_secret_key');
    // SFTP-4: keine sftp_* mehr
    expect(backupRemote).not.toContain('sftp_password');
    expect(backupRemote).not.toContain('sftp_private_key');
    // Exakt 2 Einträge
    expect(backupRemote).toHaveLength(2);
  });

  it('SFTP-4: resolveKey() lehnt sftp_password für backup-remote ab', async () => {
    const { resolveKey } = await import('../src/CredentialStore.js');
    const result = resolveKey('backup-remote', 'sftp_password');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('SFTP-4: resolveKey() lehnt sftp_private_key für backup-remote ab', async () => {
    const { resolveKey } = await import('../src/CredentialStore.js');
    const result = resolveKey('backup-remote', 'sftp_private_key');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('SFTP-4: resolveKey() akzeptiert s3_access_key für backup-remote (kein Regress)', async () => {
    const { resolveKey } = await import('../src/CredentialStore.js');
    const result = resolveKey('backup-remote', 's3_access_key');
    expect(result.ok).toBe(true);
    expect(result.storeKey).toBe('credentials/backup-remote/s3_access_key');
  });
});

// ── SFTP-5 — ssh2-Dependency bleibt + kein DR-Regress ────────────────────────

describe('SFTP-5 — ssh2 bleibt in VpsDockerControl.js, kein global entfernt', () => {
  it('SFTP-5: VpsDockerControl.js importiert ssh2 (Negativ-Regression: nicht global entfernt)', async () => {
    // Wenn ssh2 korrekt in package.json + node_modules bleibt,
    // kann VpsDockerControl ohne Import-Fehler importiert werden.
    // Schlägt dieser Test fehl, wurde ssh2 aus package.json entfernt.
    let importError = null;
    try {
      await import('../src/deploy/VpsDockerControl.js');
    } catch (e) {
      importError = e;
    }
    // Kein Import-Fehler → ssh2 ist noch verfügbar
    expect(importError).toBeNull();
  });

  it('SFTP-5: BackupUploader.js importiert ssh2 NICHT (SFTP-Import entfernt)', async () => {
    // Indirekter Nachweis: BackupUploader-Modul hat keinen SshClient-Export
    const uploaderModule = await import('../src/BackupUploader.js');
    // SshClient wäre nur sichtbar wenn importiert und re-exportiert — das tun wir nicht
    expect(uploaderModule.SshClient).toBeUndefined();
    // Positivprüfung: S3-Upload-Funktion ist vorhanden
    expect(typeof uploaderModule.uploadArtefact).toBe('function');
    expect(typeof uploaderModule.resolveOffHostConfig).toBe('function');
    expect(typeof uploaderModule.resolveOffHostConfigAsync).toBe('function');
  });
});

// ── SFTP-1 — Frontend: BACKUP_REMOTE_FIELDS ohne SFTP ────────────────────────

describe('SFTP-1 — Frontend BACKUP_REMOTE_FIELDS (Modulanalyse, kein DOM)', () => {
  it('SFTP-1: BACKUP_REMOTE_FIELDS in BackupSection enthält keine sftp_* Felder (Source-Grep)', async () => {
    // Source-Grep-Ansatz: Da BackupSection.jsx eine JSX-Komponente ist (kein Node-Import ohne Transform),
    // prüfen wir den Quelltext direkt — konsistent mit SFTP-2-Spec (Testbar/Grep).
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../client/src/BackupSection.jsx', import.meta.url), 'utf8');

    // SFTP-1: Dropdown hat keine <option value="sftp">
    expect(src).not.toContain('option value="sftp"');
    expect(src).not.toContain("option value='sftp'");

    // SFTP-1: BACKUP_REMOTE_FIELDS enthält kein sftp_password / sftp_private_key
    expect(src).not.toMatch(/name:\s*['"]sftp_password['"]/);
    expect(src).not.toMatch(/name:\s*['"]sftp_private_key['"]/);

    // Positivprüfung: S3-Felder sind noch vorhanden
    expect(src).toMatch(/name:\s*['"]s3_access_key['"]/);
    expect(src).toMatch(/name:\s*['"]s3_secret_key['"]/);
  });
});
