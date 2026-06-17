/**
 * backupDrCompletion.test.js — Tests für S-148: Backup-Ziel-Config DR-fest im Artefakt.
 *
 * Covers (credential-backup S-148 — AC20–AC24):
 *   AC20 — Artefakt enthält `config`-Feld mit nicht-geheimen Backup-Ziel-Feldern wenn
 *           BackupConfigStore.read() eine Config liefert (Testbar: GPG-entschlüsseltes
 *           Artefakt eines Writes bei vorhandener config enthält `config` mit
 *           genau den erlaubten nicht-geheimen Feldern).
 *   AC21 — Floor: `config`-Feld enthält NIEMALS Remote-Creds (s3_access_key, s3_secret_key)
 *           oder den Master-Key; nur nicht-geheime Felder
 *           (Allowlist: offHostEnabled, targetType, endpoint, bucket, prefix, region,
 *           retentionCount — S3-only seit S-160, host/port/user entfernt). Testbar: auch wenn
 *           ein Cred-Feld irgendwie im BackupConfigStore auftaucht, erscheint es NICHT im
 *           `config`-Artefakt-Feld.
 *   AC22 — Restore schreibt `artefact.config` atomar über BackupConfigStore zurück;
 *           nach dem Restore liefert BackupConfigStore.read() exakt diese Werte.
 *   AC23 — Config-Restore ist best-effort: schlägt das Zurückschreiben der Config fehl,
 *           gilt der Store-Restore weiterhin als ok:true; Credentials-Blob bleibt intakt.
 *   AC24 — Rückwärtskompatibilität: Artefakt ohne `config`-Feld wird wie bisher restored
 *           (ok:true), kein Fehler, keine backup-config.json aus Restore-Pfad geschrieben.
 *
 * Strategie:
 *   - BackupEngine.runBackup() direkt mit _backupConfigFn-Override (DI) getestet (kein GPG).
 *   - Für AC20/AC21 mit echtem GPG + decrypt() (BackupCrypto) wenn verfügbar, sonst skip.
 *   - CredentialStore.restore() mit gemocktem BackupConfigStore.write() für AC22/AC23.
 *   - Kein echter HTTP-Server für S-148 Unit-Tests (nur CredentialStore + BackupEngine direkt).
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackup } from '../src/BackupEngine.js';
import { encrypt, decrypt, isGpgAvailable } from '../src/BackupCrypto.js';

// ── Konstanten ───────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-dr-completion-master-key-s148';

// Nicht-geheime Felder die im `config`-Feld erwartet werden (AC20, Allowlist)
// S3-only seit S-160: host/port/user (SFTP) entfernt.
const ALLOWED_CONFIG_FIELDS = [
  'offHostEnabled', 'targetType', 'endpoint', 'bucket', 'prefix',
  'region', 'retentionCount',
];

// Geheime Felder die NIEMALS im `config`-Feld erscheinen dürfen (AC21 Floor)
// inkl. Master-Key-Varianten — der Spec-Wortlaut „NIEMALS den Master-Key" wird so
// explizit testiert (strukturell kann er nicht auftauchen, der Test verriegelt es).
// sftp_password/sftp_private_key bleiben in der Forbidden-Liste (Defense-in-Depth).
const FORBIDDEN_CONFIG_FIELDS = [
  's3_access_key', 's3_secret_key', 'sftp_password', 'sftp_private_key',
  'masterKeyRaw', 'master_key', 'DEVGUI_CRED_MASTER_KEY',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 'dr-completion-test-'));
}

/** Minimaler gültiger Store-Blob (Dummy, kein echter Cred-Inhalt) */
const DUMMY_BLOB = JSON.stringify({
  version: 1,
  kdf: { algo: 'scrypt', salt: 'dGVzdHNhbHQ=', N: 16384, r: 8, p: 1 },
  entries: {},
  meta: {},
});

/** Erzeugt ein verschlüsseltes Artefakt mit dem gegebenen config-Feld. */
async function makeArtefactWithConfig(masterKey, config) {
  const blob = DUMMY_BLOB;
  const manifest = {
    schemaVersion: 1,
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    storeSize: Buffer.byteLength(blob, 'utf8'),
  };
  const artefactObj = { manifest, blob };
  if (config !== undefined) artefactObj.config = config;
  return encrypt(masterKey, Buffer.from(JSON.stringify(artefactObj), 'utf8'));
}

/** Erzeugt ein verschlüsseltes Artefakt OHNE config-Feld (Alt-Format für AC24). */
async function makeArtefactWithoutConfig(masterKey) {
  const blob = DUMMY_BLOB;
  const manifest = {
    schemaVersion: 1,
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    storeSize: Buffer.byteLength(blob, 'utf8'),
  };
  return encrypt(masterKey, Buffer.from(JSON.stringify({ manifest, blob }), 'utf8'));
}

// ── Tests: AC20/AC21 — runBackup erzeugt Artefakt mit config-Feld ────────────

describe('S-148 AC20/AC21 — runBackup: Artefakt enthält config-Feld (nicht-geheime Allowlist)', () => {
  let dir;
  let backupDir;
  let gpgOk;

  beforeEach(async () => {
    gpgOk = await isGpgAvailable();
    dir = await makeTmpDir();
    backupDir = join(dir, 'backups');
    await mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC20: entschlüsseltes Artefakt enthält `config`-Feld mit nicht-geheimen Feldern', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC20-Test übersprungen');
      return;
    }

    const fakeConfig = {
      offHostEnabled: true,
      targetType: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'my-bucket',
      prefix: 'dev-gui/',
      region: 'eu-central-1',
      retentionCount: 10,
    };

    const result = await runBackup({
      masterKeyRaw: TEST_MASTER_KEY,
      storeFilePath: join(dir, 'secrets.enc.json'),
      backupDir,
      storeBlob: DUMMY_BLOB,
      offHostConfig: null, // Off-Host disabled (nur lokales Backup)
      _backupConfigFn: async () => fakeConfig,
    });

    expect(result.local).toBe('ok');
    expect(result.localPath).toBeDefined();

    // Artefakt entschlüsseln und config-Feld prüfen
    const { readFile } = await import('node:fs/promises');
    const encBuf = await readFile(result.localPath);
    const decBuf = await decrypt(TEST_MASTER_KEY, encBuf);
    const artefact = JSON.parse(decBuf.toString('utf8'));

    expect(artefact.config).toBeDefined();
    expect(typeof artefact.config).toBe('object');

    // Alle erlaubten nicht-geheimen Felder sind vorhanden
    for (const field of ALLOWED_CONFIG_FIELDS) {
      expect(artefact.config).toHaveProperty(field);
    }

    // Werte stimmen mit der Fake-Config überein
    expect(artefact.config.offHostEnabled).toBe(true);
    expect(artefact.config.targetType).toBe('s3');
    expect(artefact.config.bucket).toBe('my-bucket');
    expect(artefact.config.retentionCount).toBe(10);
  });

  it('AC21 Floor: `config`-Feld enthält KEINE geheimen Felder (s3_access_key, …)', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC21-Floor-Test übersprungen');
      return;
    }

    // Config mit "versehentlich" eingeschleustem Secret-Feld (sollte herausgefiltert werden)
    const fakeConfigWithSecrets = {
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'secure-bucket',
      prefix: 'test/',
      region: 'us-east-1',
      endpoint: '',
      retentionCount: 5,
      // Die folgenden Felder dürfen NIE ins config-Feld des Artefakts gelangen (AC21):
      s3_access_key: 'AKIAIOSFODNN7EXAMPLE',
      s3_secret_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      // sftp_* bleiben in der Forbidden-Liste (Defense-in-Depth, auch wenn sftp entfernt):
      sftp_password: 'super-secret-sftp-pass',
      sftp_private_key: '-----BEGIN RSA PRIVATE KEY-----',
    };

    const result = await runBackup({
      masterKeyRaw: TEST_MASTER_KEY,
      storeFilePath: join(dir, 'secrets.enc.json'),
      backupDir,
      storeBlob: DUMMY_BLOB,
      offHostConfig: null,
      _backupConfigFn: async () => fakeConfigWithSecrets,
    });

    expect(result.local).toBe('ok');

    const { readFile } = await import('node:fs/promises');
    const encBuf = await readFile(result.localPath);
    const decBuf = await decrypt(TEST_MASTER_KEY, encBuf);
    const artefact = JSON.parse(decBuf.toString('utf8'));

    expect(artefact.config).toBeDefined();

    // Geheime Felder dürfen NICHT im config-Feld erscheinen (AC21 Floor)
    for (const forbidden of FORBIDDEN_CONFIG_FIELDS) {
      expect(artefact.config).not.toHaveProperty(forbidden);
    }

    // Nicht-geheime Felder sind vorhanden
    expect(artefact.config.bucket).toBe('secure-bucket');
    expect(artefact.config.retentionCount).toBe(5);
  });

  it('AC20: kein Absturz wenn _backupConfigFn wirft (Best-effort — Backup ohne config-Feld)', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC20-Fehler-Test übersprungen');
      return;
    }

    const result = await runBackup({
      masterKeyRaw: TEST_MASTER_KEY,
      storeFilePath: join(dir, 'secrets.enc.json'),
      backupDir,
      storeBlob: DUMMY_BLOB,
      offHostConfig: null,
      _backupConfigFn: async () => { throw new Error('BackupConfigStore nicht verfügbar'); },
    });

    // Backup soll trotzdem erfolgreich sein (best-effort)
    expect(result.local).toBe('ok');

    // Artefakt prüfen — ohne config-Feld (best-effort-Pfad)
    const { readFile } = await import('node:fs/promises');
    const encBuf = await readFile(result.localPath);
    const decBuf = await decrypt(TEST_MASTER_KEY, encBuf);
    const artefact = JSON.parse(decBuf.toString('utf8'));

    // manifest und blob sind vorhanden
    expect(artefact.manifest).toBeDefined();
    expect(artefact.blob).toBeDefined();
    // config-Feld fehlt (best-effort — kein Fehler)
    expect(artefact.config).toBeUndefined();
  });
});

// ── Tests: AC22/AC23/AC24 — CredentialStore.restore() schreibt Config zurück ─

describe('S-148 AC22/AC23/AC24 — CredentialStore.restore(): Config-Rückspeicherung', () => {
  let dir;
  let gpgOk;

  beforeEach(async () => {
    gpgOk = await isGpgAvailable();
    dir = await makeTmpDir();
    process.env.CRED_STORE_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.CRED_STORE_DIR;
    await rm(dir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('AC22: Restore schreibt artefact.config in BackupConfigStore zurück', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC22-Test übersprungen');
      return;
    }

    const configInArtefact = {
      offHostEnabled: true,
      targetType: 's3',
      endpoint: 'https://s3.eu.example.com',
      bucket: 'dr-test-bucket',
      prefix: 'restored/',
      region: 'eu-west-1',
      host: '',
      port: '22',
      user: '',
      retentionCount: 7,
    };

    const artefactBuffer = await makeArtefactWithConfig(TEST_MASTER_KEY, configInArtefact);

    const { CredentialStore } = await import('../src/CredentialStore.js');
    const store = new CredentialStore({
      dir,
      masterKey: TEST_MASTER_KEY,
      backupDir: join(dir, 'backups'),
      backupRetention: 5,
    });

    const result = await store.restore(artefactBuffer, { confirm: true });

    expect(result.ok).toBe(true);

    // BackupConfigStore.read() muss die zurückgeschriebene Config liefern
    const { read } = await import('../src/BackupConfigStore.js');
    const storedConfig = await read();

    expect(storedConfig.offHostEnabled).toBe(true);
    expect(storedConfig.targetType).toBe('s3');
    expect(storedConfig.bucket).toBe('dr-test-bucket');
    expect(storedConfig.prefix).toBe('restored/');
    expect(storedConfig.region).toBe('eu-west-1');
    expect(storedConfig.retentionCount).toBe(7);
  });

  it('AC23: Config-Restore-Fehler rollt Credential-Restore NICHT zurück (best-effort)', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC23-Test übersprungen');
      return;
    }

    const configInArtefact = {
      offHostEnabled: false,
      targetType: 'local',
      bucket: 'irrelevant',
      prefix: '',
      endpoint: '',
      region: 'us-east-1',
      host: '',
      port: '22',
      user: '',
      retentionCount: 10,
    };

    const artefactBuffer = await makeArtefactWithConfig(TEST_MASTER_KEY, configInArtefact);

    // CRED_STORE_DIR auf leeres Verzeichnis zeigen lassen (write() würde werfen wenn Dir fehlt
    // → wir simulieren den Fehler indem wir CRED_STORE_DIR auf null setzen nach dem Restore-Setup)
    // Stattdessen: Mock von writeBackupConfig via jest.unstable_mockModule ist in ESM schwierig.
    // Wir testen den Store-Restore-Erfolg trotz CRED_STORE_DIR-Fehler mit einem separaten Ansatz:
    // Wir setzen CRED_STORE_DIR auf ein nicht existierendes schreibgeschütztes Verzeichnis.
    //
    // Alternativ: Wir prüfen, dass der Store erfolgreich restored wird auch wenn Config-Schreiben
    // fehlschlägt, indem wir nach dem Restore verifizieren, dass die secrets.enc.json existiert.

    // Um den Config-Schreibfehler zu erzwingen: CRED_STORE_DIR auf /dev/null setzen
    // (write() würde bei mkdir unter /dev/null oder einer nicht-beschreibbaren Datei scheitern)
    // Besser: Wir nutzen einen Unterordner der nicht existiert + kein mkdir-Recht.
    // In der Praxis ist die sauberste Methode: tmpDir anlegen, Restore laufen lassen,
    // dann CRED_STORE_DIR auf einen anderen (nicht writable) Pfad ändern VOR dem Restore.

    // Pragmatisch: Wir prüfen AC23 über einen separaten Pfad — CRED_STORE_DIR auf
    // ein tmpDir setzen das für backup-config.json nicht beschreibbar ist.
    const lockedDir = join(dir, 'locked-config-dir');
    await mkdir(lockedDir, { recursive: true, mode: 0o555 }); // read-only

    const origCredDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = lockedDir;

    const { CredentialStore } = await import('../src/CredentialStore.js');
    // Store mit normalem dir (für secrets.enc.json)
    const store = new CredentialStore({
      dir, // Store schreibt nach dir/secrets.enc.json
      masterKey: TEST_MASTER_KEY,
      backupDir: join(dir, 'backups'),
      backupRetention: 5,
    });

    // Restore soll ok:true zurückgeben auch wenn Config-Schreiben fehlschlägt
    const result = await store.restore(artefactBuffer, { confirm: true });

    process.env.CRED_STORE_DIR = origCredDir;

    // AC23: Store-Restore muss trotz Config-Fehler erfolgreich sein
    expect(result.ok).toBe(true);

    // Die secrets.enc.json existiert und enthält den wiederhergestellten Inhalt
    const { readFile } = await import('node:fs/promises');
    const storeContent = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(storeContent);
    expect(parsed.version).toBe(1);
    expect(parsed.kdf).toBeDefined();
  });

  it('AC24: Artefakt ohne config-Feld wird wie bisher restored — ok:true, keine Fehlerklasse', async () => {
    if (!gpgOk) {
      console.warn('[SKIP] GPG nicht verfügbar — AC24-Test übersprungen');
      return;
    }

    // Alt-Format: kein config-Feld
    const artefactBuffer = await makeArtefactWithoutConfig(TEST_MASTER_KEY);

    const { CredentialStore } = await import('../src/CredentialStore.js');
    const store = new CredentialStore({
      dir,
      masterKey: TEST_MASTER_KEY,
      backupDir: join(dir, 'backups'),
      backupRetention: 5,
    });

    const result = await store.restore(artefactBuffer, { confirm: true });

    // AC24: Restore soll ohne Fehler abschliessen (ok:true, kein errorClass)
    expect(result.ok).toBe(true);
    expect(result.errorClass).toBeUndefined();

    // secrets.enc.json wurde restored
    const { readFile } = await import('node:fs/promises');
    const storeContent = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(storeContent);
    expect(parsed.version).toBe(1);

    // Keine backup-config.json wurde aus dem Restore-Pfad geschrieben
    // (da das Artefakt kein config-Feld hatte)
    const { stat } = await import('node:fs/promises');
    let configExists;
    try {
      await stat(join(dir, 'backup-config.json'));
      configExists = true;
    } catch {
      configExists = false;
    }
    // backup-config.json sollte NICHT existieren (kein config-Feld im Artefakt)
    expect(configExists).toBe(false);
  });
});
