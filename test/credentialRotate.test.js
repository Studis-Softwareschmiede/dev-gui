/**
 * credentialRotate.test.js — HTTP-Router-Tests für POST /api/settings/credential-rotate
 * + POST /api/settings/credential-key-archive-discard
 * (credential-key-rotation, S-083 Kern + v2 S-342 — docs/specs/credential-key-rotation.md).
 *
 * Covers (credential-key-rotation):
 *   AC1/AC7 — Happy Path über HTTP: 200 { ok: true, swapped: true }; secrets.enc.json +
 *             .env sind danach mit dem neuen Key konsistent (Router-Ebene, nicht nur
 *             CredentialStore#rotate()-Unit-Test).
 *   AC6/AC12 (v2) — Erfolgs-Response enthält immer ein leak-freies `backup`-Feld
 *             (kein interner Volume-Pfad — toExternalBackup).
 *   AC4/AC11/AC13 (v2) — Stufe 2: mit bwEmail+bwPassword wird
 *             BitwardenMasterKeyService#archiveRotatedKey aufgerufen und das
 *             Ergebnis als `archive:{ok, errorClass?}` zurückgegeben; ohne
 *             bwEmail/bwPassword wird Stufe 2 übersprungen (Kern-Abwärtskompatibilität);
 *             ein Stufe-2-Fehlschlag rollt Stufe 1 NICHT zurück.
 *   AC5/AC13 (v2) — POST .../credential-key-archive-discard: GETRENNTE, explizit
 *             bestätigte Aktion (`confirm:true` Pflicht, sonst 400); ruft
 *             BitwardenMasterKeyService#discardArchivedKeys auf.
 *   AC8 — Schutz: 403 ohne CRED_ADMIN_EMAILS-Berechtigung (kein Audit bei 403);
 *         Audit-First-Eintrag (`credential-rotate`) vor Ausführung; ein fehlgeschlagener
 *         Audit-Write verhindert die Rotation (500, secrets.enc.json unverändert).
 *   AC9 — Weder alter noch neuer Key noch Bitwarden-Login-Werte erscheinen irgendwo im
 *         Response-Body (Erfolg + Fehler, inkl. Stufe 2 + Discard-Endpunkt).
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

/** Fake BitwardenMasterKeyService — nur die für die Router-Orchestrierung genutzten Methoden. */
function makeFakeBwService({ archiveResult, discardResult } = {}) {
  return {
    archiveRotatedKey: jest.fn(async () => archiveResult ?? { status: 'archived' }),
    discardArchivedKeys: jest.fn(async () => discardResult ?? { status: 'discarded' }),
  };
}

async function buildApp({ tmpDir, masterKey = OLD_KEY, identity, adminEmails, auditStore, bitwardenMasterKeyService }) {
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
  app.use(create({ auditStore: audit, credentialStore, bitwardenMasterKeyService }));

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
      expect(res.body).toEqual({ ok: true, swapped: true, backup: expect.any(Object) });
      // AC12/v2: backup ist leak-frei (kein interner Volume-Pfad, s. toExternalBackup)
      expect(res.body.backup.localPath).toBeUndefined();

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

  describe('AC4/AC11/AC13 (v2, S-342) — Stufe 2: Bitwarden-Archivierung nach erfolgreicher Rotation', () => {
    it('mit bwEmail+bwPassword: archiveRotatedKey wird mit newKey aufgerufen, Response enthält archive:{ok:true}', async () => {
      const bwService = makeFakeBwService({ archiveResult: { status: 'archived' } });
      const { app, credentialStore } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {
        newKey: NEW_KEY,
        bwEmail: 'admin@example.com',
        bwPassword: 'bw-master-password',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.archive).toEqual({ ok: true });

      expect(bwService.archiveRotatedKey).toHaveBeenCalledTimes(1);
      const callArg = bwService.archiveRotatedKey.mock.calls[0][0];
      expect(callArg.newKey).toBe(NEW_KEY);
      expect(callArg.email).toBe('admin@example.com');
      expect(callArg.password).toBe('bw-master-password');
    });

    it('Review-Finding 2 (Iteration 2) — whitespace-gepaddeter newKey: archiveRotatedKey erhält denselben GETRIMMTEN Wert, den CredentialStore#rotate() intern aktiviert (nicht den rohen, gepaddeten Body-Wert)', async () => {
      const bwService = makeFakeBwService({ archiveResult: { status: 'archived' } });
      const { app, credentialStore } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const paddedNewKey = `  ${NEW_KEY}  `;
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {
        newKey: paddedNewKey,
        bwEmail: 'admin@example.com',
        bwPassword: 'bw-master-password',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // archiveRotatedKey bekommt den GETRIMMTEN Wert — identisch zu dem, was
      // CredentialStore#rotate() intern als aktiven Key übernimmt (.env enthält
      // ebenfalls den getrimmten Wert, s. Assertion unten) — NICHT den rohen,
      // whitespace-gepaddeten Body-Wert.
      const callArg = bwService.archiveRotatedKey.mock.calls[0][0];
      expect(callArg.newKey).toBe(NEW_KEY);
      expect(callArg.newKey).not.toBe(paddedNewKey);

      const envContent = await readFile(join(tmpDir, '.env'), 'utf8');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
    });

    it('OHNE bwEmail/bwPassword: Stufe 2 wird übersprungen — kein archive-Feld, kein Aufruf (S-083-Kern-Abwärtskompatibilität)', async () => {
      const bwService = makeFakeBwService();
      const { app, credentialStore } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', { newKey: NEW_KEY });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.archive).toBeUndefined();
      expect(bwService.archiveRotatedKey).not.toHaveBeenCalled();
    });

    it('archiveRotatedKey scheitert: Rotation bleibt trotzdem erfolgreich (Stage-1 rollt nicht zurück), archive:{ok:false}', async () => {
      const bwService = makeFakeBwService({ archiveResult: { status: 'error', errorClass: 'auth-failed' } });
      const { app, credentialStore } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {
        newKey: NEW_KEY,
        bwEmail: 'admin@example.com',
        bwPassword: 'wrong-password',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.swapped).toBe(true);
      expect(res.body.archive).toEqual({ ok: false, errorClass: 'auth-failed' });

      // Store ist tatsächlich mit dem neuen Key aktiv, unabhängig vom Archiv-Fehlschlag
      const envContent = await readFile(join(tmpDir, '.env'), 'utf8');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
    });

    it('Response mit archive-Feld enthält keinen Bitwarden-Login-Wert (Floor)', async () => {
      const bwService = makeFakeBwService({ archiveResult: { status: 'archived' } });
      const { app, credentialStore } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });
      await credentialStore.set('credentials/misc/foo', 'plain-value');

      ({ server, port } = await startServer(app));
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {
        newKey: NEW_KEY,
        bwEmail: 'admin@example.com',
        bwPassword: 'bw-master-password-should-not-leak',
      });

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('bw-master-password-should-not-leak');
      expect(raw).not.toContain('admin@example.com');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC5/AC13 (v2, S-342) — POST /api/settings/credential-key-archive-discard
// ══════════════════════════════════════════════════════════════════════════════

describe('credentialRotate — POST /api/settings/credential-key-archive-discard (v2, S-342)', () => {
  let tmpDir;
  let originalAdminEmails;
  let server;
  let port;

  beforeEach(async () => {
    originalAdminEmails = process.env.CRED_ADMIN_EMAILS;
    tmpDir = join(tmpdir(), `credarchive-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('200 { ok: true } bei gültiger, bestätigter Entsorgung', async () => {
    const bwService = makeFakeBwService({ discardResult: { status: 'discarded' } });
    const { app } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', {
      bwEmail: 'admin@example.com',
      bwPassword: 'bw-master-password',
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(bwService.discardArchivedKeys).toHaveBeenCalledTimes(1);
  });

  it('AC5/AC13 — ohne confirm:true ⇒ 400, kein Bitwarden-Zugriff', async () => {
    const bwService = makeFakeBwService();
    const { app } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', {
      bwEmail: 'admin@example.com',
      bwPassword: 'bw-master-password',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(bwService.discardArchivedKeys).not.toHaveBeenCalled();
  });

  it('fehlende Bitwarden-Zugangsdaten ⇒ 400, kein Bitwarden-Zugriff', async () => {
    const bwService = makeFakeBwService();
    const { app } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', { confirm: true });

    expect(res.status).toBe(400);
    expect(bwService.discardArchivedKeys).not.toHaveBeenCalled();
  });

  it('403 wenn Identität nicht in CRED_ADMIN_EMAILS gelistet ist', async () => {
    const bwService = makeFakeBwService();
    const { app } = await buildApp({
      tmpDir,
      adminEmails: 'admin@test.example.com',
      identity: { email: 'someone-else@test.example.com' },
      bitwardenMasterKeyService: bwService,
    });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', {
      bwEmail: 'admin@example.com',
      bwPassword: 'bw-master-password',
      confirm: true,
    });

    expect(res.status).toBe(403);
    expect(bwService.discardArchivedKeys).not.toHaveBeenCalled();
  });

  it('discardArchivedKeys scheitert ⇒ 500 mit sanitisierter errorClass', async () => {
    const bwService = makeFakeBwService({ discardResult: { status: 'error', errorClass: 'item-update-failed' } });
    const { app } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', {
      bwEmail: 'admin@example.com',
      bwPassword: 'bw-master-password',
      confirm: true,
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, reason: 'item-update-failed' });
  });

  it('Response enthält keinen Bitwarden-Login-Wert (Floor)', async () => {
    const bwService = makeFakeBwService({ discardResult: { status: 'discarded' } });
    const { app } = await buildApp({ tmpDir, bitwardenMasterKeyService: bwService });

    ({ server, port } = await startServer(app));
    const res = await httpPostJson(port, '/api/settings/credential-key-archive-discard', {
      bwEmail: 'admin@example.com',
      bwPassword: 'bw-master-password-should-not-leak',
      confirm: true,
    });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('bw-master-password-should-not-leak');
  });
});
