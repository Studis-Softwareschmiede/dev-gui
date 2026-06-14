/**
 * credentialUnlockRouter.test.js — Tests für credential-unlock-dialog Backend (Item #185, AC3–AC9)
 *
 * Spec: docs/specs/credential-unlock-dialog.md
 *
 * Covers:
 *   AC3  — POST mit gültigen Daten → 200 { ok: true, state: "unlocked" }; KEIN Key in Response
 *   AC4  — not-found → 200 { ok: false, status: "not-found" }; create:true → createMasterKey
 *   AC5  — twofa-required/twofa-invalid → 401 { ok: false, errorClass }
 *   AC6  — auth-failed/bw-unreachable/invalid-key → 4xx/5xx ohne Secret-Leak
 *   AC7  — kein gültiger Access → 403; nicht in CRED_ADMIN_EMAILS → 403
 *   AC8  — Audit-First: Eintrag VOR Aktion; Audit-Fehler → Aktion unterbleibt (500)
 *   AC9  — Kein Key/Login-Daten in Response, kein Secret-Leak
 *
 * Strategie:
 *   - HTTP-Integration via Express + AccessGuard-Dev-Bypass (DEV_NO_ACCESS=1)
 *   - Fake-BitwardenMasterKeyService (controllierbares acquireMasterKey/createMasterKey)
 *   - Fake-CredentialStore mit steuerbarem getLockState()
 *   - Fake-AuditStore (kontrollierbar — kann fehlschlagen)
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { credentialUnlockRouter } from '../src/credentialUnlockRouter.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── HTTP-Helfer ───────────────────────────────────────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpPost(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
          ...headers,
        },
      },
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
    req.write(json);
    req.end();
  });
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

/**
 * Erstellt einen Fake-BitwardenMasterKeyService.
 *
 * @param {object} opts
 * @param {'found'|'not-found'|'created'|{status:'error',errorClass:string}} [opts.acquireResult]
 * @param {'created'|{status:'error',errorClass:string}} [opts.createResult]
 */
function makeFakeBwService({
  acquireResult = { status: 'found' },
  createResult = { status: 'created' },
} = {}) {
  const calls = { acquire: [], create: [] };
  return {
    async acquireMasterKey(params) {
      calls.acquire.push(params);
      if (typeof acquireResult === 'string') return { status: acquireResult };
      return acquireResult;
    },
    async createMasterKey(params) {
      calls.create.push(params);
      if (typeof createResult === 'string') return { status: createResult };
      return createResult;
    },
    _calls: calls,
  };
}

/**
 * Erstellt einen Fake-CredentialStore.
 * @param {{ state: "locked"|"unlocked", hasEncryptedEntries: boolean }} initial
 */
function makeFakeCredStore(initial = { state: 'unlocked', hasEncryptedEntries: false }) {
  let currentState = { ...initial };
  return {
    async getLockState() {
      return { ...currentState };
    },
    _setState(s) {
      currentState = { ...s };
    },
  };
}

/**
 * Erstellt einen Fake-AuditStore.
 * @param {{ shouldFail: boolean }} opts
 */
function makeFakeAuditStore({ shouldFail = false } = {}) {
  const records = [];
  return {
    record(entry) {
      if (shouldFail) throw new Error('AuditStore: Schreiben fehlgeschlagen');
      records.push({ ...entry });
    },
    _records: records,
  };
}

/**
 * Baut eine Express-App mit DEV_NO_ACCESS + AccessGuard + credentialUnlockRouter.
 */
function makeApp(credStore, auditStore, bwService) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(credentialUnlockRouter(credStore, auditStore, bwService));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const VALID_BODY = { email: 'user@example.com', password: 'master-password' };

describe('POST /api/settings/credential-unlock — AC3: Erfolg → { ok: true, state }; KEIN Key', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC3 — 200 { ok: true, state: "unlocked" } bei erfolgreicher Beschaffung', async () => {
    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('unlocked');
  });

  it('AC3/AC9 — Response enthält KEINEN Key/Klartext-Wert', async () => {
    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    const keys = Object.keys(res.body);
    // Nur ok + state erlaubt
    expect(keys).not.toContain('key');
    expect(keys).not.toContain('masterKey');
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('plaintext');
  });

  it('AC3 — acquireMasterKey wird aufgerufen (kein createMasterKey)', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    const { server: s, port: p } = await startServer(app);
    try {
      await httpPost(p, '/api/settings/credential-unlock', VALID_BODY);
      expect(bwService._calls.acquire).toHaveLength(1);
      expect(bwService._calls.create).toHaveLength(0);
    } finally {
      await closeServer(s);
    }
  });

  it('AC3 — acquireMasterKey empfängt email + password (KEINE weiteren Felder sichtbar)', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    const { server: s, port: p } = await startServer(app);
    try {
      await httpPost(p, '/api/settings/credential-unlock', VALID_BODY);
      const call = bwService._calls.acquire[0];
      expect(call.email).toBe('user@example.com');
      expect(call.password).toBe('master-password');
    } finally {
      await closeServer(s);
    }
  });
});

describe('POST /api/settings/credential-unlock — AC4: not-found + create-Flow', () => {
  let server, port;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC4 — not-found → 200 { ok: false, status: "not-found" }', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'not-found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('not-found');
  });

  it('AC4 — create:true → createMasterKey wird aufgerufen (nicht acquireMasterKey)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ createResult: { status: 'created' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', { ...VALID_BODY, create: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bwService._calls.create).toHaveLength(1);
    expect(bwService._calls.acquire).toHaveLength(0);
  });

  it('AC4 — create:true → Audit-Aktion ist "credential-master-key-create"', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ createResult: { status: 'created' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    await httpPost(port, '/api/settings/credential-unlock', { ...VALID_BODY, create: true });
    expect(auditStore._records).toHaveLength(1);
    expect(auditStore._records[0].command).toBe('credential-master-key-create');
  });

  it('AC4 — ohne create:true → Audit-Aktion ist "credential-unlock"', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(auditStore._records).toHaveLength(1);
    expect(auditStore._records[0].command).toBe('credential-unlock');
  });

  it('AC4 — create:true ohne vorherige Bestätigung nicht ausgelöst (kein Frontend-Test — Backend: nur bei explizitem create:true)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'not-found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    // Ohne create:true → kein createMasterKey-Aufruf
    await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(bwService._calls.create).toHaveLength(0);
    expect(bwService._calls.acquire).toHaveLength(1);
  });
});

describe('POST /api/settings/credential-unlock — AC5: 2FA-Fehler', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC5 — twofa-required → 401 { ok: false, errorClass: "twofa-required" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'twofa-required', reason: '2FA nötig' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorClass).toBe('twofa-required');
  });

  it('AC5 — twofa-invalid → 401 { ok: false, errorClass: "twofa-invalid" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'twofa-invalid', reason: '2FA ungültig' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', {
      ...VALID_BODY,
      twofa: '123456',
    });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorClass).toBe('twofa-invalid');
  });

  it('AC5 — Response enthält KEINEN Geheimnis-Wert bei 2FA-Fehlern', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'twofa-required', reason: '2FA nötig' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('master-password');
    expect(bodyStr).not.toContain('user@example.com');
    expect(bodyStr).not.toContain('password');
    expect(bodyStr).not.toContain('email');
  });
});

describe('POST /api/settings/credential-unlock — AC6: Fehlerklassen ohne Secret-Leak', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC6 — auth-failed → 401 { ok: false, errorClass: "auth-failed" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'auth-failed', reason: 'Auth fehlgeschlagen' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorClass).toBe('auth-failed');
    // Kein Secret im Body
    expect(JSON.stringify(res.body)).not.toContain('master-password');
  });

  it('AC6 — bw-unreachable → 503 { ok: false, errorClass: "bw-unreachable" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'bw-unreachable', reason: 'Bitwarden nicht erreichbar' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.errorClass).toBe('bw-unreachable');
  });

  it('AC6 — invalid-key (falscher Key vs. Store) → 422 { ok: false, errorClass: "invalid-key" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: true });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'invalid-key', reason: 'Key abgelehnt' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(422);
    expect(res.body.errorClass).toBe('invalid-key');
  });

  it('AC6 — error (generic) → 500 { ok: false, errorClass: "error" }', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'error', reason: 'Unbekannter Fehler' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('error');
  });

  it('AC6 — Fehler-Response enthält keinen Geheimnis-Leak (auth-failed)', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'auth-failed', reason: 'secret-reason-must-not-leak' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    const bodyStr = JSON.stringify(res.body);
    // 'reason' aus dem Service darf NICHT in der Response erscheinen
    expect(bodyStr).not.toContain('secret-reason-must-not-leak');
    // Erlaubt: ok, errorClass
    expect(res.body.ok).toBe(false);
    expect(res.body.errorClass).toBe('auth-failed');
  });
});

describe('POST /api/settings/credential-unlock — AC7: Access + CRED_ADMIN_EMAILS', () => {
  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  it('AC7 — kein gültiger Access (kein DEV_NO_ACCESS, kein Token) → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const credStore = makeFakeCredStore();
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService();
    const app = makeApp(credStore, auditStore, bwService);
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, E-Mail nicht gelistet → 403', async () => {
    process.env.DEV_NO_ACCESS = '1';
    process.env.CRED_ADMIN_EMAILS = 'other@example.com,admin@example.com';

    const credStore = makeFakeCredStore();
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService();

    // Simuliere eine Identität (DEV_NO_ACCESS setzt req.identity.email auf 'dev@local')
    // Der echte AccessGuard setzt bei DEV_NO_ACCESS req.identity = { email: 'dev@local' }
    const app = makeApp(credStore, auditStore, bwService);
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
      delete process.env.CRED_ADMIN_EMAILS;
    }
  });

  it('AC7 — CRED_ADMIN_EMAILS gesetzt, E-Mail gelistet → Zugang erlaubt', async () => {
    process.env.DEV_NO_ACCESS = '1';
    // DEV_NO_ACCESS setzt identity.email auf 'dev@local' — diese wird in die Allowlist aufgenommen
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';

    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      await closeServer(server);
      delete process.env.CRED_ADMIN_EMAILS;
    }
  });

  it('AC7 — CRED_ADMIN_EMAILS nicht gesetzt → jede Access-Identität darf', async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.CRED_ADMIN_EMAILS;

    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});

describe('POST /api/settings/credential-unlock — AC8: Audit-First', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC8 — Audit-Eintrag wird VOR Aktion geschrieben', async () => {
    const executionOrder = [];
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = {
      record(_entry) {
        executionOrder.push('audit');
      },
      _records: [],
    };
    const bwService = {
      async acquireMasterKey() {
        executionOrder.push('acquire');
        return { status: 'found' };
      },
      async createMasterKey() {
        executionOrder.push('create');
        return { status: 'created' };
      },
    };

    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(executionOrder[0]).toBe('audit');
    expect(executionOrder[1]).toBe('acquire');
  });

  it('AC8 — Audit-Eintrag enthält Identität + Aktion, KEINE Werte', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(auditStore._records).toHaveLength(1);
    const entry = auditStore._records[0];
    expect(entry.command).toBe('credential-unlock');
    // Kein Passwort/Key im Audit-Eintrag
    const entryStr = JSON.stringify(entry);
    expect(entryStr).not.toContain('master-password');
    expect(entryStr).not.toContain('password');
  });

  it('AC8 — Audit-Fehler → Aktion unterbleibt (500), kein acquireMasterKey-Aufruf', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore({ shouldFail: true });
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(500);
    // Bitwarden-Service wurde NICHT aufgerufen
    expect(bwService._calls.acquire).toHaveLength(0);
  });
});

describe('POST /api/settings/credential-unlock — AC9: kein Secret-Leak in Response', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
  });

  it('AC9 — Erfolgs-Response enthält keine Geheimnis-Felder', async () => {
    const credStore = makeFakeCredStore({ state: 'unlocked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({ acquireResult: { status: 'found' } });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    expect(res.status).toBe(200);
    const forbidden = ['key', 'masterKey', 'master_key', 'password', 'token', 'secret', 'plaintext', 'rawKey'];
    for (const f of forbidden) {
      expect(res.body).not.toHaveProperty(f);
    }
  });

  it('AC9 — Fehler-Response enthält keine Geheimnis-Felder', async () => {
    const credStore = makeFakeCredStore({ state: 'locked', hasEncryptedEntries: false });
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService({
      acquireResult: { status: 'error', errorClass: 'auth-failed', reason: 'geheimer-grund' },
    });
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    const res = await httpPost(port, '/api/settings/credential-unlock', VALID_BODY);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('geheimer-grund');
    expect(bodyStr).not.toContain('master-password');
    // Nur ok + errorClass erwartet
    expect(res.body.ok).toBe(false);
    expect(res.body.errorClass).toBeDefined();
  });

  it('AC9 — Pflichtfeld-Fehler lässt kein Passwort durchscheinen', async () => {
    const credStore = makeFakeCredStore();
    const auditStore = makeFakeAuditStore();
    const bwService = makeFakeBwService();
    const app = makeApp(credStore, auditStore, bwService);
    ({ server, port } = await startServer(app));

    // Fehlende E-Mail
    const res = await httpPost(port, '/api/settings/credential-unlock', { password: 'secret-pw' });
    expect(res.status).toBe(400);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('secret-pw');
  });
});
