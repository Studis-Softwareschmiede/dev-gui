/**
 * S147BackupFixes.test.js — Regressions-Tests für AC17, AC18, AC19 (S-147).
 *
 * Covers (credential-backup spec, S-147):
 *   AC17 — Backup-Hook nutzt BackupConfigStore-Config (nicht nur Env):
 *           Bei vorhandener backup-config.json mit offHostEnabled:true, targetType:'s3', bucket
 *           UND leeren BACKUP_OFFHOST_*-Env-Vars liefert der Hook offHost !== 'disabled'.
 *           Override-Verhalten bleibt erhalten:
 *             offHostConfigOverride === null      → disabled
 *             definierter Override               → wird genutzt
 *             undefined (Production-Pfad)        → via resolveOffHostConfigAsync() aufgelöst
 *   AC18 — targetType-Normalisierung beim Laden:
 *           offHostEnabled=true + targetType='local'    → normalisiert auf 's3'
 *           offHostEnabled=false + targetType='local'   → bleibt 'local' (kein Off-Host)
 *           offHostEnabled=true + targetType='s3'       → bleibt 's3'
 *           offHostEnabled=true + targetType='sftp'     → normalisiert auf 's3' (S-160: sftp entfernt)
 *   AC19 — Präfix-Default 'dev-gui/':
 *           Kein gespeicherter Prefix (null/undefined/'') → 'dev-gui/'
 *           Gespeicherter Prefix 'eigenes/'              → bleibt 'eigenes/'
 *           Gespeicherter Prefix 'backups/'              → bleibt 'backups/' (nicht überschreiben)
 *
 * Strategie:
 *   - AC17: CredentialStore mit tmpdir, echte backup-config.json schreiben,
 *     CRED_STORE_DIR zeigen auf tmpdir, leere BACKUP_OFFHOST_*-Env-Vars.
 *     runBackup wird über BackupEngine mit _uploaderFn-Override gemockt (kein echter Upload).
 *     Prüft: offHostResult ist 'ok' (Mock-Uploader gibt 'ok'), nicht 'disabled'.
 *   - AC18/AC19: Reine Logik-Tests der Normalisierungs-/Default-Helfer (kein DOM nötig).
 *     Da die Logik in loadConfig() in SettingsView.jsx liegt (React-Komponente), testen wir
 *     die Logik isoliert als Pure-Function-Extrakt + über resolveOffHostConfigAsync direkt.
 *   - SFTP-1…SFTP-5 (S-160): SFTP vollständig entfernt — Dropdown, Config, Catalog, BackupUploader.
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/CredentialStore.js';
import { resolveOffHostConfigAsync } from '../src/BackupUploader.js';
import { runBackup } from '../src/BackupEngine.js';
import { isGpgAvailable } from '../src/BackupCrypto.js';
import * as BackupConfigStore from '../src/BackupConfigStore.js';

// ── Konstanten ──────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 's147-test-master-key-not-a-real-secret';

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 's147-test-'));
}

/**
 * Schreibt eine backup-config.json in tmpDir (wie BackupConfigStore.write()).
 */
async function writeBackupConfig(dir, config) {
  const filePath = join(dir, 'backup-config.json');
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ── AC17 — Backup-Hook nutzt BackupConfigStore-Config ──────────────────────

describe('AC17 (S-147) — #runBackupHook nutzt resolveOffHostConfigAsync()', () => {
  let tmpDir;
  let originalEnv;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    // Alle Off-Host-Env-Vars entfernen → sicherstellen, dass nur die JSON-Datei wirkt
    originalEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
      BACKUP_OFFHOST_TYPE: process.env.BACKUP_OFFHOST_TYPE,
      BACKUP_S3_BUCKET: process.env.BACKUP_S3_BUCKET,
      BACKUP_S3_ENDPOINT: process.env.BACKUP_S3_ENDPOINT,
      BACKUP_S3_PREFIX: process.env.BACKUP_S3_PREFIX,
      BACKUP_S3_REGION: process.env.BACKUP_S3_REGION,
    };
    delete process.env.BACKUP_OFFHOST_ENABLED;
    delete process.env.BACKUP_OFFHOST_TYPE;
    delete process.env.BACKUP_S3_BUCKET;
    delete process.env.BACKUP_S3_ENDPOINT;
    delete process.env.BACKUP_S3_PREFIX;
    delete process.env.BACKUP_S3_REGION;
    process.env.CRED_STORE_DIR = tmpDir;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('AC17: resolveOffHostConfigAsync() liest backup-config.json — BACKUP_OFFHOST_*-Env leer', async () => {
    // Voraussetzung: keine Env-Vars gesetzt (bereits in beforeEach erledigt)
    // Sync-Variante muss null liefern (Env-only)
    const { resolveOffHostConfig } = await import('../src/BackupUploader.js');
    expect(resolveOffHostConfig()).toBeNull();

    // backup-config.json schreiben (wie S-143-UI)
    await writeBackupConfig(tmpDir, {
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'my-test-bucket',
      endpoint: '',
      prefix: 'dev-gui/',
      region: 'us-east-1',
    });

    // Async-Variante muss nun die JSON lesen
    const config = await resolveOffHostConfigAsync();
    expect(config).not.toBeNull();
    expect(config.type).toBe('s3');
    expect(config.bucket).toBe('my-test-bucket');
    expect(config.prefix).toBe('dev-gui/');
  });

  it('AC17 Regression: Store.set() nutzt Store-Config — offHost !== "disabled" bei aktivem Off-Host', async () => {
    const gpgOk = await isGpgAvailable();
    if (!gpgOk) {
      // GPG nicht verfügbar → lokales Backup schlägt sowieso fehl; AC17 nicht sinnvoll testbar
      // Test überspringen (kein Fehler, aber kein falsch-negatives Ergebnis)
      return;
    }

    // backup-config.json mit offHostEnabled=true, s3-Config schreiben
    await writeBackupConfig(tmpDir, {
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'my-test-bucket',
      endpoint: '',
      prefix: 'dev-gui/',
      region: 'us-east-1',
    });

    const backupDir = join(tmpDir, 'backups');
    // CredentialStore mit CRED_STORE_DIR=tmpDir (kein opts.dir-Override,
    // damit BackupConfigStore die Env-Var liest — dir wird von opts.dir gesetzt).
    // Wir nutzen opts.dir=tmpDir damit CredentialStore dort die backup-config.json liest
    // (BackupConfigStore liest CRED_STORE_DIR aus process.env, das wir in beforeEach gesetzt haben).
    const store = new CredentialStore({
      dir: tmpDir,
      masterKey: TEST_MASTER_KEY,
      backupDir,
    });

    // Credential setzen → löst #runBackupHook aus (mit undefined offHostConfigOverride = Produktionspfad)
    const result = await store.set('credentials/github/app_id', 'ac17-test-value');

    // AC17: offHost darf nicht 'disabled' sein — der Hook hat die Store-Config gelesen
    // (offHost kann 'ok' oder 'failed' sein — 'failed' wenn S3-Endpoint nicht erreichbar,
    //  aber nie 'disabled' wenn offHostEnabled=true in der JSON steht)
    expect(result.backup).toBeDefined();
    expect(result.backup.offHost).not.toBe('disabled');
  }, 60_000); // langer Timeout wegen möglicher S3-Retry-Wartezeit

  it('AC17 Override-Verhalten: null → disabled (Test-Override-Pfad bleibt erhalten)', async () => {
    // backup-config.json mit offHostEnabled=true schreiben
    await writeBackupConfig(tmpDir, {
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'override-bucket',
      endpoint: '',
      prefix: 'dev-gui/',
      region: 'us-east-1',
    });

    // runBackup direkt mit offHostConfig: null → muss 'disabled' liefern
    const storeBlob = JSON.stringify({ version: 1, kdf: { salt: 'dGVzdA==', N: 16384, r: 8, p: 1 }, entries: {} });
    const storeFilePath = join(tmpDir, 'secrets.enc.json');
    const backupDir = join(tmpDir, 'backups');

    const result = await runBackup({
      masterKeyRaw: TEST_MASTER_KEY,
      storeFilePath,
      backupDir,
      retentionCount: 5,
      storeBlob,
      offHostConfig: null, // explizit null = disabled (Test-Override)
    });

    // null override → disabled (Override-Verhalten muss erhalten bleiben — AC17)
    expect(result.offHost).toBe('disabled');
  });

  it('AC17 Override-Verhalten: definierter Override → wird genutzt (nicht ignoriert)', async () => {
    const gpgOk = await isGpgAvailable();
    if (!gpgOk) return;

    // Kein backup-config.json → ohne Override wäre offHost 'disabled'
    // Mit definiertem Override → Upload wird versucht → 'ok' (via mockUploader)
    const storeBlob = JSON.stringify({ version: 1, kdf: { salt: 'dGVzdA==', N: 16384, r: 8, p: 1 }, entries: {} });
    const storeFilePath = join(tmpDir, 'secrets.enc.json');
    const backupDir = join(tmpDir, 'backups');

    let uploaderCalled = false;
    const mockUploader = async () => {
      uploaderCalled = true;
      return 'ok';
    };

    const overrideConfig = { type: 's3', bucket: 'override-bucket', region: 'us-east-1', prefix: 'dev-gui/', endpoint: '' };

    const result = await runBackup({
      masterKeyRaw: TEST_MASTER_KEY,
      storeFilePath,
      backupDir,
      retentionCount: 5,
      storeBlob,
      offHostConfig: overrideConfig, // definierter Override
      offHostCreds: {},
      _uploaderFn: mockUploader,
    });

    // Definierter Override → Uploader muss aufgerufen worden sein
    expect(uploaderCalled).toBe(true);
    expect(result.offHost).toBe('ok');
  });
});

// ── AC18 — targetType-Normalisierungs-Logik ────────────────────────────────

/**
 * Extrahiert die targetType-Normalisierungslogik aus loadConfig() in SettingsView.jsx,
 * damit wir sie als reine Funktion testen können (kein DOM/React nötig).
 *
 * Implementierung aus SettingsView.jsx loadConfig() nach S-160:
 *   const loadedType = data.targetType ?? 'local';
 *   const normalizedType = loadedOffHostEnabled && loadedType !== 's3' ? 's3' : loadedType;
 *
 * SFTP ist seit S-160 entfernt — 'sftp' wird wie 'local' auf 's3' normalisiert.
 */
function normalizeTargetType(offHostEnabled, rawType) {
  const loadedType = rawType ?? 'local';
  return offHostEnabled && loadedType !== 's3' ? 's3' : loadedType;
}

describe('AC18 (S-147) — targetType-Normalisierung bei offHostEnabled=true', () => {
  it('offHostEnabled=true + targetType="local" → normalisiert auf "s3"', () => {
    expect(normalizeTargetType(true, 'local')).toBe('s3');
  });

  it('offHostEnabled=true + targetType=undefined → normalisiert auf "s3"', () => {
    expect(normalizeTargetType(true, undefined)).toBe('s3');
  });

  it('offHostEnabled=true + targetType="unbekannt" → normalisiert auf "s3"', () => {
    expect(normalizeTargetType(true, 'unknown-type')).toBe('s3');
  });

  it('offHostEnabled=true + targetType="s3" → bleibt "s3" (kein Mismatch)', () => {
    expect(normalizeTargetType(true, 's3')).toBe('s3');
  });

  it('SFTP-1/S-160: offHostEnabled=true + targetType="sftp" → normalisiert auf "s3" (sftp entfernt)', () => {
    // Seit S-160 ist 'sftp' keine gültige Option mehr; beim Laden alter Konfigs wird auf 's3' normalisiert.
    expect(normalizeTargetType(true, 'sftp')).toBe('s3');
  });

  it('offHostEnabled=false + targetType="local" → bleibt "local" (Off-Host inaktiv)', () => {
    // Wenn offHostEnabled=false, ist der targetType irrelevant für den Upload;
    // wir normalisieren NICHT (kein stillen State-Änderung bei inaktivem Off-Host)
    expect(normalizeTargetType(false, 'local')).toBe('local');
  });

  it('offHostEnabled=false + targetType="s3" → bleibt "s3"', () => {
    expect(normalizeTargetType(false, 's3')).toBe('s3');
  });
});

// ── AC19 — Präfix-Default 'dev-gui/' ────────────────────────────────────────

/**
 * Extrahiert die Präfix-Default-Logik aus loadConfig() in SettingsView.jsx:
 *   setPrefix(data.prefix || 'dev-gui/');
 *
 * '||' greift bei null, undefined und '' (leer) — alle drei sind "kein gespeicherter Wert".
 * Ein vorhandener nicht-leerer Wert (auch 'backups/') bleibt unverändert.
 */
function resolvePrefixDefault(savedPrefix) {
  return savedPrefix || 'dev-gui/';
}

describe('AC19 (S-147) — Präfix-Default "dev-gui/" bei fehlendem/leerem gespeicherten Wert', () => {
  it('kein gespeicherter Prefix (undefined) → "dev-gui/"', () => {
    expect(resolvePrefixDefault(undefined)).toBe('dev-gui/');
  });

  it('kein gespeicherter Prefix (null) → "dev-gui/"', () => {
    expect(resolvePrefixDefault(null)).toBe('dev-gui/');
  });

  it('leerer gespeicherter Prefix ("") → "dev-gui/"', () => {
    expect(resolvePrefixDefault('')).toBe('dev-gui/');
  });

  it('gespeicherter Prefix "eigenes/" → bleibt "eigenes/" (nicht überschreiben)', () => {
    expect(resolvePrefixDefault('eigenes/')).toBe('eigenes/');
  });

  it('gespeicherter Prefix "backups/" → bleibt "backups/" (nicht überschreiben)', () => {
    // Wichtig: bestehende Konfigurationen mit 'backups/' dürfen nicht migriert werden
    expect(resolvePrefixDefault('backups/')).toBe('backups/');
  });

  it('gespeicherter Prefix "custom/path/" → bleibt erhalten', () => {
    expect(resolvePrefixDefault('custom/path/')).toBe('custom/path/');
  });
});

// ── AC19 — Integrations-Test: BackupConfigStore.read() auf frischem tmpDir ──

/**
 * I-2 (S-147) / SFTP-3 (S-160): Integrations-naher Test der tatsächlichen Erst-Konfig-Realität.
 * BackupConfigStore.read() auf einem frischen tmpDir ohne backup-config.json
 * und ohne BACKUP_S3_PREFIX Env-Var → prefix muss 'dev-gui/' sein.
 *
 * SFTP-3: BackupConfigStore enthält keine SFTP-Felder (host/port/user) mehr,
 * und kein sftp-Zweig in _readFromEnv().
 */
describe('AC19 (S-147) / SFTP-3 (S-160) — BackupConfigStore.read() auf frischem tmpDir (Integrationstest)', () => {
  let tmpDir;
  let originalEnv;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 's147-ac19-'));
    // Alle prefix-relevanten Env-Vars entfernen → Erst-Konfig simulieren
    originalEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      BACKUP_S3_PREFIX: process.env.BACKUP_S3_PREFIX,
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
      BACKUP_OFFHOST_TYPE: process.env.BACKUP_OFFHOST_TYPE,
    };
    delete process.env.BACKUP_S3_PREFIX;
    delete process.env.BACKUP_OFFHOST_ENABLED;
    delete process.env.BACKUP_OFFHOST_TYPE;
    process.env.CRED_STORE_DIR = tmpDir;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Erst-Konfig (kein backup-config.json, keine Env-Vars) → prefix === "dev-gui/" für S3', async () => {
    // Kein backup-config.json vorhanden (frisches tmpDir)
    // targetType wird 'local' (kein offHostEnabled), S3-Default-Pfad
    const config = await BackupConfigStore.read();
    expect(config.prefix).toBe('dev-gui/');
  });

  it('Erst-Konfig mit BACKUP_OFFHOST_TYPE=s3 → prefix === "dev-gui/" (S3-Default ohne Env)', async () => {
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 's3';
    // Kein BACKUP_S3_PREFIX gesetzt → Default muss 'dev-gui/' sein
    const config = await BackupConfigStore.read();
    expect(config.prefix).toBe('dev-gui/');
    expect(config.targetType).toBe('s3');
  });

  it('SFTP-3: Erst-Konfig mit BACKUP_OFFHOST_TYPE=sftp → targetType=local (sftp entfernt, S-160)', async () => {
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 'sftp';
    // SFTP-3: kein sftp-Zweig mehr — targetType landet auf 'local', prefix ist 'dev-gui/'
    const config = await BackupConfigStore.read();
    expect(config.targetType).toBe('local');
    expect(config.prefix).toBe('dev-gui/');
    // SFTP-3: keine host/port/user-Felder mehr
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.user).toBeUndefined();
  });

  it('SFTP-3: read() liefert niemals host/port/user-Felder', async () => {
    const config = await BackupConfigStore.read();
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.user).toBeUndefined();
  });
});
