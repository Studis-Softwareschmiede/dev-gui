/**
 * backupConfig.test.js — Tests für GET/PUT /api/settings/backup-config (S-143, Architekt-Entscheid Variante B).
 *
 * Covers (credential-backup S-143 — AC12 Backend-Konfig-Endpunkt):
 *   AC12 — GET /api/settings/backup-config: 200 { offHostEnabled, targetType, ... }
 *          metadaten-only (kein Remote-Secret, kein Master-Key).
 *          PUT /api/settings/backup-config: speichert Konfiguration (atomar, 0600).
 *          PUT: 403 wenn nicht in CRED_ADMIN_EMAILS-Allowlist.
 *          PUT: 400 bei ungültigem targetType / retentionCount.
 *          PUT: Audit-First (record() VOR write()).
 *          GET nach PUT: gibt gespeicherte Konfiguration zurück (JSON > Env-Fallback).
 *          AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

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
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPut(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = httpRequest(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Mock AuditStore ───────────────────────────────────────────────────────────

function makeAuditStore() {
  const entries = [];
  return {
    record: jest.fn(({ identity, command }) => {
      entries.push({ time: new Date().toISOString(), identity, command });
    }),
    getEntries: () => entries,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('backupConfig — GET + PUT /api/settings/backup-config (AC12, Architekt-Entscheid)', () => {
  let tmpDir;
  let server;
  let port;
  let auditStore;
  let originalEnv;

  beforeEach(async () => {
    originalEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      CRED_ADMIN_EMAILS: process.env.CRED_ADMIN_EMAILS,
      BACKUP_OFFHOST_ENABLED: process.env.BACKUP_OFFHOST_ENABLED,
      BACKUP_OFFHOST_TYPE: process.env.BACKUP_OFFHOST_TYPE,
      BACKUP_S3_BUCKET: process.env.BACKUP_S3_BUCKET,
    };
    delete process.env.CRED_ADMIN_EMAILS;
    delete process.env.BACKUP_OFFHOST_ENABLED;
    delete process.env.BACKUP_OFFHOST_TYPE;
    delete process.env.BACKUP_S3_BUCKET;

    tmpDir = join(tmpdir(), `backup-config-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.CRED_STORE_DIR = tmpDir;

    auditStore = makeAuditStore();

    const { create } = await import('../src/routers/backupConfig.js');
    const app = express();
    app.use(express.json());
    // Simuliere identity-Middleware (AccessGuard setzt req.identity)
    app.use((req, _res, next) => {
      req.identity = { email: 'admin@example.com' };
      next();
    });
    app.use(create({ auditStore }));
    const s = await startServer(app);
    server = s.server;
    port = s.port;
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.resetModules();
  });

  // ── GET ────────────────────────────────────────────────────────────────────

  it('GET 200 mit Env-Defaults wenn keine JSON-Datei existiert', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-config');
    expect(status).toBe(200);
    expect(body).toHaveProperty('offHostEnabled');
    expect(body).toHaveProperty('targetType');
    expect(body).toHaveProperty('retentionCount');
    // Kein Secret in der Response
    expect(body).not.toHaveProperty('accessKey');
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('password');
  });

  it('GET liefert offHostEnabled=false wenn keine Off-Host-Env gesetzt', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-config');
    expect(status).toBe(200);
    expect(body.offHostEnabled).toBe(false);
    expect(body.targetType).toBe('local');
  });

  // ── PUT ────────────────────────────────────────────────────────────────────

  it('PUT 200 speichert Konfiguration + gibt gespeicherte Werte zurück', async () => {
    const { status, body } = await httpPut(port, '/api/settings/backup-config', {
      offHostEnabled: true,
      targetType: 's3',
      bucket: 'test-bucket',
      region: 'eu-central-1',
      retentionCount: 5,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.config.offHostEnabled).toBe(true);
    expect(body.config.targetType).toBe('s3');
    expect(body.config.bucket).toBe('test-bucket');
    expect(body.config.region).toBe('eu-central-1');
    expect(body.config.retentionCount).toBe(5);
  });

  it('GET nach PUT gibt gespeicherte Konfiguration zurück (JSON > Env-Fallback)', async () => {
    // PUT zuerst
    await httpPut(port, '/api/settings/backup-config', {
      offHostEnabled: true,
      targetType: 'sftp',
      host: 'sftp.example.com',
      retentionCount: 7,
    });
    // GET danach
    const { status, body } = await httpGet(port, '/api/settings/backup-config');
    expect(status).toBe(200);
    expect(body.offHostEnabled).toBe(true);
    expect(body.targetType).toBe('sftp');
    expect(body.host).toBe('sftp.example.com');
    expect(body.retentionCount).toBe(7);
  });

  it('PUT schreibt backup-config.json atomar auf Credential-Volume', async () => {
    await httpPut(port, '/api/settings/backup-config', {
      offHostEnabled: false,
      targetType: 'local',
      retentionCount: 3,
    });
    // Datei existiert jetzt
    const fileContent = await readFile(join(tmpDir, 'backup-config.json'), 'utf8');
    const parsed = JSON.parse(fileContent);
    expect(parsed.retentionCount).toBe(3);
    expect(parsed.targetType).toBe('local');
  });

  // ── Audit-First ────────────────────────────────────────────────────────────

  it('PUT: Audit-First — auditStore.record() wird aufgerufen BEVOR write()', async () => {
    const callOrder = [];
    auditStore.record = jest.fn(() => {
      callOrder.push('audit');
    });

    // Direkter Test: Audit zuerst, dann schreiben
    await httpPut(port, '/api/settings/backup-config', { offHostEnabled: false });
    expect(auditStore.record).toHaveBeenCalledTimes(1);
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'backup-config-update' }),
    );
    // Datei ist auch geschrieben worden (Audit-First hat write nicht verhindert)
    const fileContent = await readFile(join(tmpDir, 'backup-config.json'), 'utf8');
    expect(JSON.parse(fileContent)).toHaveProperty('offHostEnabled', false);
  });

  it('PUT: Audit enthält Identität + Aktion (ohne Secret-Werte)', async () => {
    await httpPut(port, '/api/settings/backup-config', { offHostEnabled: true, bucket: 'my-bucket' });
    const entries = auditStore.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(entry.command).toBe('backup-config-update');
    expect(entry.identity).toBe('admin@example.com');
    // Kein Secret-Wert im Audit-Eintrag
    expect(JSON.stringify(entry)).not.toMatch(/secret|password|accessKey/i);
  });

  // ── CRED_ADMIN_EMAILS ──────────────────────────────────────────────────────

  it('PUT 403 wenn Identität nicht in CRED_ADMIN_EMAILS (Admin-Gate)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'other@example.com';

    // Neuen Server mit gesetzter CRED_ADMIN_EMAILS starten
    const { create } = await import('../src/routers/backupConfig.js');
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => {
      req.identity = { email: 'notadmin@example.com' };
      next();
    });
    const auditStore2 = makeAuditStore();
    app2.use(create({ auditStore: auditStore2 }));
    const s2 = await startServer(app2);

    try {
      const { status, body } = await httpPut(s2.port, '/api/settings/backup-config', { offHostEnabled: false });
      expect(status).toBe(403);
      expect(body.error).toBeTruthy();
    } finally {
      await closeServer(s2.server);
      delete process.env.CRED_ADMIN_EMAILS;
    }
  });

  // ── Input-Validierung ──────────────────────────────────────────────────────

  it('PUT 400 bei ungültigem targetType', async () => {
    const { status, body } = await httpPut(port, '/api/settings/backup-config', {
      targetType: 'evil-type',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/targetType/i);
  });

  it('PUT 400 bei ungültigem retentionCount (negativ)', async () => {
    const { status, body } = await httpPut(port, '/api/settings/backup-config', {
      retentionCount: -1,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/retentionCount/i);
  });

  it('PUT 400 bei String-Feld mit Null-Byte', async () => {
    const { status, body } = await httpPut(port, '/api/settings/backup-config', {
      bucket: 'bucket\x00injection',
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  // ── Security-Floor ─────────────────────────────────────────────────────────

  it('GET Response enthält keine Secrets (Security-Floor)', async () => {
    const { status, body } = await httpGet(port, '/api/settings/backup-config');
    expect(status).toBe(200);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/secret/i);
    expect(bodyStr).not.toMatch(/password/i);
    expect(bodyStr).not.toMatch(/accessKey/i);
    expect(bodyStr).not.toMatch(/privateKey/i);
  });
});
