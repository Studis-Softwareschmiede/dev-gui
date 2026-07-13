/**
 * credentialRotate.test.js — HTTP-Router-Tests für POST /api/settings/credential-rotate
 * (credential-key-rotation, S-083 Kern — docs/specs/credential-key-rotation.md).
 *
 * Covers (credential-key-rotation):
 *   AC1/AC7 — Happy Path über HTTP: 200 { ok: true, swapped: true }; secrets.enc.json +
 *             .env sind danach mit dem neuen Key konsistent (Router-Ebene, nicht nur
 *             CredentialStore#rotate()-Unit-Test).
 *   AC8 — Schutz: 403 ohne CRED_ADMIN_EMAILS-Berechtigung (kein Audit bei 403);
 *         Audit-First-Eintrag (`credential-rotate`) vor Ausführung; ein fehlgeschlagener
 *         Audit-Write verhindert die Rotation (500, secrets.enc.json unverändert).
 *   AC9 — Weder alter noch neuer Key erscheint irgendwo im Response-Body (Erfolg + Fehler).
 *   Edge-Case — ungültiger Body (fehlender/leerer newKey) ⇒ 400 empty-key, kein Audit-
 *               unabhängiges Verhalten (Audit wird trotzdem geschrieben, Aktion aber
 *               abgelehnt — s. Router-Kommentar).
 *   Edge-Case — kein Master-Key (Store gesperrt) ⇒ 503 no-master-key.
 *   AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test
 *   (Muster analog backupRestore.test.js).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

import { CredentialStore } from '../src/CredentialStore.js';
import { create } from '../src/routers/credentialRotate.js';

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

function httpPostJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body ?? {});
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = httpRequest(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Mock AuditStore ───────────────────────────────────────────────────────────

function makeAuditStore({ failNext = false } = {}) {
  const entries = [];
  return {
    record: jest.fn(({ identity, command }) => {
      if (failNext) {
        throw new Error('simulated audit write failure');
      }
      entries.push({ time: new Date().toISOString(), identity, command });
    }),
    getEntries: () => entries,
  };
}

// ── Test-App-Fabrik ───────────────────────────────────────────────────────────

const OLD_KEY = 'old-master-key-router-test-not-a-real-secret';
const NEW_KEY = 'new-master-key-router-test-not-a-real-secret';

async function buildApp({ tmpDir, masterKey = OLD_KEY, identity, adminEmails, auditStore }) {
  if (adminEmails !== undefined) {
    process.env.CRED_ADMIN_EMAILS = adminEmails;
  } else {
    delete process.env.CRED_ADMIN_EMAILS;
  }

  const credentialStore = new CredentialStore({
    dir: tmpDir,
    masterKey,
    envPath: join(tmpDir, '.env'),
  });

  const audit = auditStore ?? makeAuditStore();

  const app = express();
  app.use(express.json());
  // Simuliert das AccessGuard-Ergebnis (Identity-Injection) — analog backupRestore.test.js.
  app.use((req, _res, next) => {
    req.identity = identity ?? { email: 'admin@test.example.com' };
    next();
  });
  app.use(create({ auditStore: audit, credentialStore }));

  return { app, auditStore: audit, credentialStore };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('credentialRotate — POST /api/settings/credential-rotate', () => {
  let tmpDir;
  let originalAdminEmails;
  let server;
  let port;

  beforeEach(async () => {
    originalAdminEmails = process.env.CRED_ADMIN_EMAILS;
    tmpDir = join(tmpdir(), `credrotate-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    if (originalAdminEmails !== undefined) {
      process.env.CRED_ADMIN_EMAILS = originalAdminEmails;
    } else {
      delete process.env.CRED_ADMIN_EMAILS;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('AC1/AC7 — Happy Path', () => {
    it('200 { ok: true, swapped: true } bei gültiger Rotation; Store danach mit neuem Key nutzbar', async () => {
      const { app, credentialStore } = await buildApp({ tmpDir });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, swapped: true });

      const envContent = await readFile(join(tmpDir, '.env'), 'utf8');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
    });
  });

  describe('AC8 — Schutz: CRED_ADMIN_EMAILS + Audit-First', () => {
    it('403 wenn Identität nicht in CRED_ADMIN_EMAILS gelistet ist (kein Audit-Eintrag)', async () => {
      const auditStore = makeAuditStore();
      const { app } = await buildApp({
        tmpDir,
        adminEmails: 'admin@test.example.com',
        identity: { email: 'someone-else@test.example.com' },
        auditStore,
      });

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(auditStore.getEntries()).toHaveLength(0);
    });

    it('200 wenn kein CRED_ADMIN_EMAILS gesetzt ist (jede Identität darf)', async () => {
      const { app, credentialStore } = await buildApp({ tmpDir, adminEmails: '' });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('Audit-First: Eintrag `credential-rotate` mit Identität, VOR Ausführung, ohne Key-Werte', async () => {
      const auditStore = makeAuditStore();
      const { app, credentialStore } = await buildApp({
        tmpDir,
        identity: { email: 'admin@test.example.com' },
        auditStore,
      });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      const entries = auditStore.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].command).toBe('credential-rotate');
      expect(entries[0].identity).toBe('admin@test.example.com');
      expect(JSON.stringify(entries[0])).not.toContain(OLD_KEY);
      expect(JSON.stringify(entries[0])).not.toContain(NEW_KEY);
    });

    it('fehlgeschlagener Audit-Write verhindert die Rotation (500, secrets.enc.json unverändert)', async () => {
      const auditStore = makeAuditStore({ failNext: true });
      const { app, credentialStore } = await buildApp({ tmpDir, auditStore });
      await credentialStore.set('credentials/misc/foo', 'plain-value');
      const beforeRaw = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);

      const afterRaw = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
      expect(afterRaw).toBe(beforeRaw);
    });
  });

  describe('Edge-Case — ungültiger Body', () => {
    it('fehlender newKey ⇒ 400 empty-key', async () => {
      const { app } = await buildApp({ tmpDir });
      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, reason: 'empty-key', swapped: false });
    });

    it('newKey == aktiver Key ⇒ 400 same-key', async () => {
      const { app } = await buildApp({ tmpDir });
      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: OLD_KEY });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, reason: 'same-key', swapped: false });
    });
  });

  describe('Edge-Case — kein Master-Key (Store gesperrt)', () => {
    it('503 no-master-key', async () => {
      const { app } = await buildApp({ tmpDir, masterKey: null });
      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, reason: 'no-master-key', swapped: false });
    });
  });

  describe('AC9 — Key-Leak-Freiheit (Response)', () => {
    it('Success-Response enthält keinen Key-Wert', async () => {
      const { app, credentialStore } = await buildApp({ tmpDir });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(OLD_KEY);
      expect(raw).not.toContain(NEW_KEY);
    });

    it('Fehler-Response (same-key) enthält keinen Key-Wert', async () => {
      const { app } = await buildApp({ tmpDir });
      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: OLD_KEY });

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(OLD_KEY);
    });
  });
});
