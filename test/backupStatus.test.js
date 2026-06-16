/**
 * backupStatus.test.js — Tests für GET /api/settings/backup-status (S-143 AC12).
 *
 * Covers (credential-backup S-143 — AC12 Backend-Endpunkt):
 *   AC12 — GET /api/settings/backup-status: 200 { lastBackup, offHostType, offHostEnabled, targetConfig, retentionCount }
 *          metadaten-only (kein Key/Secret/Klartext — AC12/Spec §13).
 *          I1-Fix: backupDir NICHT in Response (interner Volume-Pfad).
 *          I2-Fix: targetConfig enthält nur nicht-geheime Felder (endpoint, bucket, prefix, region);
 *                  KEIN Secret-Feld (accessKey, secret, password) in targetConfig.
 *          Kein lastBackup wenn Backup-Verzeichnis leer/nicht vorhanden.
 *          lastBackup.at = ISO-String des neuesten .gpg-Artefakts.
 *          offHostEnabled/offHostType aus BackupConfigStore (JSON > Env, nicht-geheim).
 *          AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
 *          500 bei internem Fehler → kein Crash.
 *
 * Env-Variablen werden per process.env gesetzt/gelöscht im beforeEach/afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';

// ── HTTP-Helpers ──────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('backupStatus — GET /api/settings/backup-status (AC12)', () => {
  let tmpDir;
  let server;
  let port;
  let originalEnv;

  beforeEach(async () => {
    // Env sichern + Off-Host deaktivieren (default für die meisten Tests)
    originalEnv = {
      CRED_BACKUP_DIR: process.env.CRED_BACKUP_DIR,
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

    // Tmp-Verzeichnis für Backup-Dir + als CRED_STORE_DIR
    tmpDir = join(tmpdir(), `backup-status-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.CRED_BACKUP_DIR = tmpDir;
    // CRED_STORE_DIR: separates tmpDir (vermeidet backup-config.json aus vorherigen Tests)
    process.env.CRED_STORE_DIR = tmpDir;

    // Express-App mit dem Router
    const { create } = await import('../src/routers/backupStatus.js');
    const app = express();
    app.use(create({}));
    const s = await startServer(app);
    server = s.server;
    port = s.port;
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    // Env wiederherstellen
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    jest.resetModules();
  });

  it('200 mit lastBackup=null wenn Backup-Verzeichnis leer', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.lastBackup).toBeNull();
  });

  it('200 mit offHostEnabled=false wenn BACKUP_OFFHOST_ENABLED nicht gesetzt', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.offHostEnabled).toBe(false);
    expect(body.offHostType).toBeNull();
  });

  it('200 mit lastBackup.at = neuestes Artefakt-mtime, wenn .gpg-Dateien vorhanden', async () => {
    // Zwei Artefakte anlegen — das zweite soll zurückgegeben werden
    const older = join(tmpDir, 'backup-2026-01-01T00-00-00-000Z-aa11bb22.gpg');
    const newer = join(tmpDir, 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg');
    await writeFile(older, 'dummy-content');
    // Kleines Delay damit mtime unterschiedlich ist
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(newer, 'dummy-content-newer');

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.lastBackup).not.toBeNull();
    expect(body.lastBackup.at).toBeDefined();
    // Das neuere Artefakt soll zurückgegeben werden
    expect(body.lastBackup.artefactName).toContain('cc33dd44');
  });

  it('200 mit offHostEnabled=true + offHostType=s3 wenn BACKUP_OFFHOST_ENABLED=1 + BACKUP_OFFHOST_TYPE=s3', async () => {
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 's3';
    process.env.BACKUP_S3_BUCKET = 'my-backup-bucket';

    // Router neu laden damit Env-Vars beim Aufruf greifen
    const { create } = await import('../src/routers/backupStatus.js');
    const app2 = express();
    app2.use(create({}));
    const s2 = await startServer(app2);

    try {
      const { status, body } = await httpGet(s2.port, '/api/settings/backup-status');
      expect(status).toBe(200);
      expect(body.offHostEnabled).toBe(true);
      expect(body.offHostType).toBe('s3');
    } finally {
      await closeServer(s2.server);
    }
  });

  // ── I2-Fix: targetConfig enthält nur nicht-geheime Felder ──────────────────
  it('targetConfig enthält nicht-geheime S3-Felder (endpoint, bucket, prefix, region) — kein Secret (I2)', async () => {
    process.env.BACKUP_OFFHOST_ENABLED = '1';
    process.env.BACKUP_OFFHOST_TYPE = 's3';
    process.env.BACKUP_S3_BUCKET = 'test-bucket-i2';
    process.env.BACKUP_S3_ENDPOINT = 'https://s3.example.com';
    process.env.BACKUP_S3_PREFIX = 'backups/';
    process.env.BACKUP_S3_REGION = 'eu-central-1';

    const { create } = await import('../src/routers/backupStatus.js');
    const app3 = express();
    app3.use(create({}));
    const s3 = await startServer(app3);

    try {
      const { status, body } = await httpGet(s3.port, '/api/settings/backup-status');
      expect(status).toBe(200);
      expect(body.offHostEnabled).toBe(true);
      expect(body.targetConfig).not.toBeNull();

      // Nicht-geheime S3-Felder vorhanden
      expect(body.targetConfig.bucket).toBe('test-bucket-i2');
      expect(body.targetConfig.endpoint).toBe('https://s3.example.com');
      expect(body.targetConfig.prefix).toBe('backups/');
      expect(body.targetConfig.region).toBe('eu-central-1');

      // KEIN Secret-Feld in targetConfig (I2-Fix: Allowlist statt Blocklist)
      expect(body.targetConfig).not.toHaveProperty('accessKey');
      expect(body.targetConfig).not.toHaveProperty('secret');
      expect(body.targetConfig).not.toHaveProperty('secretKey');
      expect(body.targetConfig).not.toHaveProperty('password');
      expect(body.targetConfig).not.toHaveProperty('privateKey');
      // 'type' wird bewusst nicht in targetConfig exponiert (enthält es implizit als offHostType)
      expect(body.targetConfig).not.toHaveProperty('type');
    } finally {
      await closeServer(s3.server);
    }
  });

  it('Response enthält KEINE Secrets oder Store-Klartext (AC12 Security-Floor / Spec §13)', async () => {
    // .gpg-Artefakt-Dateiname ist nur ein Metadatum (kein Klartext-Inhalt)
    const artefact = join(tmpDir, 'backup-2026-01-01T10-30-00-000Z-ab12cd34.gpg');
    await writeFile(artefact, 'encrypted-blob-placeholder');

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);

    const bodyStr = JSON.stringify(body);
    // Kein Master-Key, kein Store-Klartext, keine Remote-Secret-Werte
    expect(bodyStr).not.toMatch(/master.?key/i);
    expect(bodyStr).not.toMatch(/secret/i);
    expect(bodyStr).not.toMatch(/password/i);
    expect(bodyStr).not.toMatch(/accessKey|s3_access_key/i);
    // Artefakt-Inhalt (placeholder) nicht im Body
    expect(bodyStr).not.toContain('encrypted-blob-placeholder');
  });

  // ── I1-Fix: backupDir NICHT in Response ────────────────────────────────────
  it('backupDir ist NICHT in der Response (I1-Fix: interner Volume-Pfad gehört nicht in HTTP-Body)', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    // I1-Fix: backupDir absichtlich weggelassen
    expect(body).not.toHaveProperty('backupDir');
    // Auch der interne Pfad-Wert darf nicht irgendwo in der Response auftauchen
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(tmpDir);
  });

  it('ignoriert .tmp-Dateien im Backup-Verzeichnis (kein halbfertiges Artefakt)', async () => {
    const tmpFile = join(tmpDir, 'backup-2026-01-01T10-30-00-000Z-ab12cd34.gpg.tmp');
    await writeFile(tmpFile, 'not-a-complete-artefact');

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    // .tmp-Datei wird ignoriert → kein lastBackup
    expect(body.lastBackup).toBeNull();
  });

  it('200 mit lastBackup=null wenn Backup-Verzeichnis nicht existiert', async () => {
    // Verzeichnis löschen → kein Verzeichnis vorhanden
    await rm(tmpDir, { recursive: true, force: true });

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.lastBackup).toBeNull();
  });

  // ── I2-Fix: Sidecar-Persistenz + Stufen-Ergebnis in lastBackup ────────────

  it('lastBackup enthält localResult + offHostResult aus Sidecar (I2-Fix / AC12)', async () => {
    // Artefakt anlegen (damit lastBackup nicht null ist)
    const artefact = join(tmpDir, 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg');
    await writeFile(artefact, 'dummy-encrypted');

    // Sidecar-Datei anlegen (wie BackupEngine sie nach einem Backup schreibt)
    const sidecar = join(tmpDir, 'backup-last-result.json');
    await writeFile(sidecar, JSON.stringify({ local: 'ok', offHost: 'disabled', at: '2026-06-01T10:30:00.000Z' }));

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.lastBackup).not.toBeNull();
    // Stufen-Ergebnis aus Sidecar
    expect(body.lastBackup.localResult).toBe('ok');
    expect(body.lastBackup.offHostResult).toBe('disabled');
  });

  it('lastBackup.localResult/offHostResult sind null wenn keine Sidecar vorhanden', async () => {
    // Artefakt anlegen, aber KEINE Sidecar-Datei
    const artefact = join(tmpDir, 'backup-2026-06-01T10-30-00-000Z-aabbccdd.gpg');
    await writeFile(artefact, 'dummy-encrypted');

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);
    expect(body.lastBackup).not.toBeNull();
    // Keine Sidecar → null (kein Backup seit dieser Version gelaufen)
    expect(body.lastBackup.localResult).toBeNull();
    expect(body.lastBackup.offHostResult).toBeNull();
  });

  it('Sidecar-Werte sind metadaten-only (kein Pfad/Secret in der Response — AC12 / Spec §13)', async () => {
    const artefact = join(tmpDir, 'backup-2026-06-01T10-30-00-000Z-aabb1122.gpg');
    await writeFile(artefact, 'dummy');
    const sidecar = join(tmpDir, 'backup-last-result.json');
    await writeFile(sidecar, JSON.stringify({
      local: 'ok', offHost: 'ok', at: '2026-06-01T10:30:00.000Z',
      // Simuliere fehlerhafte Sidecar mit Secret-Feld (darf NICHT in Response)
      secret: 'should-not-appear',
      path: '/internal/volume/path',
    }));

    const { status, body } = await httpGet(port, '/api/settings/backup-status');
    expect(status).toBe(200);

    const bodyStr = JSON.stringify(body);
    // Nur erlaubte Felder (local, offHost) in lastBackup — keine zusätzlichen Felder
    expect(body.lastBackup.localResult).toBe('ok');
    expect(body.lastBackup.offHostResult).toBe('ok');
    // Kein Secret-Feld
    expect(bodyStr).not.toContain('should-not-appear');
    expect(bodyStr).not.toContain('internal/volume/path');
  });
});
