/**
 * backupRestore.test.js — Tests für POST /api/settings/backup-restore (S-142, AC13–AC16).
 *
 * Covers (credential-backup S-142 — AC13–AC16):
 *   AC13 — Restore-Flow: ein zuvor erzeugtes Artefakt stellt einen Store mit erwarteten
 *           Einträgen wieder her; Store ist danach entsperrt/nutzbar.
 *   AC14 — Überschreib-Bestätigung: ohne confirm=true bleibt bestehender Store unverändert.
 *   AC15 — Restore-Sicherheit: falscher Key / korruptes Artefakt → klassifizierter,
 *           geheimnisfreier Fehler; bestehender Store nicht zerstört, kein Teil-Schreiben.
 *   AC16 — Restore-Schutz + Audit: 403 ohne CRED_ADMIN_EMAILS-Berechtigung;
 *           Audit-First-Eintrag (credential-restore) ohne Key/Klartext vor Ausführung;
 *           kein Audit bei 403.
 *   Floor — Kein Key/Klartext in Logs/Response; atomares Schreiben; temp aufräumen;
 *           kdf-Guard: Blob ohne kdf-Feld → restore-invalid, alter Store intakt.
 *   AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';

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

/**
 * POST-Anfrage mit raw-Binary-Body (application/octet-stream).
 */
function httpPostBinary(port, path, buffer) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
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
    req.write(buffer);
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

// ── GPG-Verschlüsselung (Test-Hilfsfunktionen) ───────────────────────────────
// Wir verwenden BackupCrypto direkt zum Erzeugen von Artefakten für Tests.
// Dabei brauchen wir gpg im PATH — Tests werden mit realer GPG-Instanz durchgeführt.

async function isGpgAvailableLocal() {
  const { isGpgAvailable } = await import('../src/BackupCrypto.js');
  return isGpgAvailable();
}

/**
 * Erzeugt ein gültiges verschlüsseltes Backup-Artefakt (wie BackupEngine es produziert).
 *
 * @param {string} masterKey
 * @param {object} storeData - secrets.enc.json-Inhalt
 * @returns {Promise<Buffer>}
 */
async function makeArtefact(masterKey, storeData) {
  const { encrypt } = await import('../src/BackupCrypto.js');
  const blob = JSON.stringify(storeData, null, 2);
  const manifest = {
    schemaVersion: 1,
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    storeSize: Buffer.byteLength(blob, 'utf8'),
  };
  const artefactJson = JSON.stringify({ manifest, blob });
  return encrypt(masterKey, Buffer.from(artefactJson, 'utf8'));
}

// ── Test-App-Fabrik ───────────────────────────────────────────────────────────

async function buildApp({ tmpDir, masterKey, identity, adminEmails }) {
  process.env.CRED_STORE_DIR = tmpDir;
  if (adminEmails !== undefined) {
    process.env.CRED_ADMIN_EMAILS = adminEmails;
  } else {
    delete process.env.CRED_ADMIN_EMAILS;
  }

  // CredentialStore mit Test-Key + Test-Dir
  const { CredentialStore } = await import('../src/CredentialStore.js');
  const credentialStore = new CredentialStore({
    dir: tmpDir,
    masterKey,
    backupDir: join(tmpDir, 'backups'),
    backupRetention: 5,
  });

  // Router
  const { create } = await import('../src/routers/backupRestore.js');
  const auditStore = makeAuditStore();

  const app = express();
  app.use(express.json());
  app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
  // Simuliere AccessGuard-Ergebnis (Identity-Injection)
  app.use((req, _res, next) => {
    req.identity = identity ?? { email: 'admin@test.example.com' };
    next();
  });
  app.use(create({ auditStore, credentialStore }));

  return { app, auditStore, credentialStore };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('backupRestore — POST /api/settings/backup-restore (AC13–AC16)', () => {
  let tmpDir;
  let originalEnv;
  let gpgAvailable;

  beforeEach(async () => {
    originalEnv = {
      CRED_STORE_DIR: process.env.CRED_STORE_DIR,
      CRED_ADMIN_EMAILS: process.env.CRED_ADMIN_EMAILS,
    };
    tmpDir = join(tmpdir(), `restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    gpgAvailable = await isGpgAvailableLocal();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  // ── AC13 — Restore-Flow ────────────────────────────────────────────────────

  describe('AC13 — Restore-Flow: Artefakt hochladen → Store wiederherstellen', () => {
    it('stellt einen Store mit einem erwarteten Credential-Eintrag wieder her', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — AC13-Test übersprungen');
        return;
      }

      const masterKey = 'test-master-key-ac13-restore';

      // Vorbereitung: Store-Inhalt den wir wiederherstellen wollen
      const originalStoreData = {
        version: 1,
        kdf: { algo: 'scrypt', salt: 'YWJjZGVmZ2hpamtsbW5vcA==', N: 16384, r: 8, p: 1 },
        entries: {
          'credentials/github/app_id': {
            iv: 'c29tZWl2MTIzNDU2',
            tag: 'c29tZXRhZ3RhZ3RhZ3Q=',
            ct: 'c29tZWN0c29tZWN0',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };

      // Artefakt erstellen (wie BackupEngine es produziert)
      const artefactBuffer = await makeArtefact(masterKey, originalStoreData);

      // Aktuellen Store (kann leer sein — wird überschrieben)
      const { app, auditStore } = await buildApp({ tmpDir, masterKey, identity: { email: 'admin@test.example.com' } });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.manifest).toBeDefined();
        expect(body.manifest.schemaVersion).toBe(1);

        // Store-Datei existiert und enthält den wiederhergestellten Inhalt
        const storeContent = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
        const parsed = JSON.parse(storeContent);
        expect(parsed.version).toBe(1);
        expect(parsed.entries['credentials/github/app_id']).toBeDefined();

        // Audit-Eintrag wurde geschrieben (AC16)
        const entries = auditStore.getEntries();
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[entries.length - 1].command).toBe('credential-restore');
      } finally {
        await closeServer(server);
      }
    });

    it('Store ist nach Restore sofort durch credentialStore nutzbar (AC13)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — AC13-Nutzbarkeits-Test übersprungen');
        return;
      }

      const masterKey = 'test-restore-usable-key';
      const storeData = {
        version: 1,
        kdf: { algo: 'scrypt', salt: Buffer.from('restoresalt1').toString('base64'), N: 16384, r: 8, p: 1 },
        entries: {},
        meta: {},
      };

      const artefactBuffer = await makeArtefact(masterKey, storeData);
      const { app, credentialStore } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        const { status } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );
        expect(status).toBe(200);

        // Store ist lesbar (kein Fehler beim Lesen)
        const lockState = await credentialStore.getLockState();
        expect(lockState.state).toBe('unlocked');
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC14 — Überschreib-Bestätigung ────────────────────────────────────────

  describe('AC14 — Überschreib-Bestätigung: ohne confirm → Store unverändert', () => {
    it('liefert 400 confirm-required ohne confirm-Flag', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — AC14-Test übersprungen');
        return;
      }

      const masterKey = 'test-confirm-key';
      const artefactBuffer = await makeArtefact(masterKey, { version: 1, kdf: {}, entries: {} });

      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        // Kein ?confirm=true im Query
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore',
          artefactBuffer,
        );
        expect(status).toBe(400);
        expect(body.ok).toBe(false);
        expect(body.errorClass).toBe('confirm-required');
      } finally {
        await closeServer(server);
      }
    });

    it('bestehende secrets.enc.json bleibt unverändert ohne confirm (AC14)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — AC14-Integrität-Test übersprungen');
        return;
      }

      const masterKey = 'test-no-overwrite-key';
      const existingStoreContent = JSON.stringify({ version: 1, kdf: { original: true }, entries: {} });

      // Bestehenden Store anlegen
      await writeFile(join(tmpDir, 'secrets.enc.json'), existingStoreContent, { encoding: 'utf8', mode: 0o600 });

      const artefactBuffer = await makeArtefact(masterKey, { version: 1, kdf: { restored: true }, entries: {} });
      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        await httpPostBinary(port, '/api/settings/backup-restore', artefactBuffer);

        // Store bleibt unverändert
        const storeContent = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
        const parsed = JSON.parse(storeContent);
        expect(parsed.kdf.original).toBe(true);
        expect(parsed.kdf.restored).toBeUndefined();
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC15 — Restore-Sicherheit ─────────────────────────────────────────────

  describe('AC15 — Restore-Sicherheit: falscher Key / korruptes Artefakt', () => {
    it('falscher Master-Key → gpg-decrypt-failed, alter Store intakt', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — AC15-falscher-Key-Test übersprungen');
        return;
      }

      const correctKey = 'correct-master-key-ac15';
      const wrongKey = 'wrong-master-key-different';

      const existingStore = JSON.stringify({ version: 1, kdf: { original: true }, entries: {} });
      await writeFile(join(tmpDir, 'secrets.enc.json'), existingStore, { encoding: 'utf8', mode: 0o600 });

      // Artefakt mit korrektem Key verschlüsseln, aber Store-Instanz mit falschem Key
      const artefactBuffer = await makeArtefact(correctKey, { version: 1, kdf: {}, entries: {} });

      const { app } = await buildApp({ tmpDir, masterKey: wrongKey });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );

        expect(status).toBe(422);
        expect(body.ok).toBe(false);
        expect(body.errorClass).toBe('gpg-decrypt-failed');
        // Geheimnisfreier Fehler (kein Key im Fehlertext)
        expect(JSON.stringify(body)).not.toMatch(/correct-master-key|wrong-master-key/);

        // Alter Store bleibt intakt (AC15: kein Teil-Überschreiben)
        const storeContent = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
        const parsed = JSON.parse(storeContent);
        expect(parsed.kdf.original).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('korruptes Artefakt → restore-invalid oder gpg-decrypt-failed, alter Store intakt', async () => {
      const masterKey = 'test-corrupt-key';
      const existingStore = JSON.stringify({ version: 1, kdf: { original: true }, entries: {} });
      await writeFile(join(tmpDir, 'secrets.enc.json'), existingStore, { encoding: 'utf8', mode: 0o600 });

      // Komplett zufälliger (korrupter) Buffer als Artefakt
      const corruptBuffer = Buffer.from('this-is-not-a-valid-gpg-artefact-abcdef1234567890');

      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          corruptBuffer,
        );

        // Fehler: gpg-decrypt-failed oder restore-invalid (je nach gpg-Verhalten)
        expect([422, 400]).toContain(status);
        expect(body.ok).toBe(false);
        expect(['gpg-decrypt-failed', 'restore-invalid']).toContain(body.errorClass);
        // Kein Key/Klartext in der Response
        expect(JSON.stringify(body)).not.toMatch(/test-corrupt-key/);

        // Alter Store bleibt intakt (AC15)
        const storeContent = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
        const parsed = JSON.parse(storeContent);
        expect(parsed.kdf.original).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('kein Artefakt hochgeladen → restore-invalid 400', async () => {
      const masterKey = 'test-no-file-key';
      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        // Leerer Buffer
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          Buffer.alloc(0),
        );
        expect(status).toBe(400);
        expect(body.ok).toBe(false);
        expect(body.errorClass).toBe('restore-invalid');
      } finally {
        await closeServer(server);
      }
    });

    it('Blob ohne kdf-Feld → restore-invalid 400, alter Store bleibt intakt (kdf-Guard)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — kdf-Guard-Test übersprungen');
        return;
      }

      const masterKey = 'test-kdf-guard-key';

      // Vorhandenen Store mit kdf anlegen (wird nicht überschrieben)
      const existingStoreContent = JSON.stringify({ version: 1, kdf: { original: true }, entries: {} });
      await writeFile(join(tmpDir, 'secrets.enc.json'), existingStoreContent, { encoding: 'utf8', mode: 0o600 });

      // Artefakt mit Blob OHNE kdf-Feld (leeres Objekt {})
      const artefactBuffer = await makeArtefact(masterKey, {});

      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );

        // kdf-Guard schlägt an → restore-invalid (422 wie bei allen ungültigen Artefakt-Fehlern)
        expect(status).toBe(422);
        expect(body.ok).toBe(false);
        expect(body.errorClass).toBe('restore-invalid');

        // Alter Store bleibt intakt — kein Überschreiben
        const storeContent = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
        const parsed = JSON.parse(storeContent);
        expect(parsed.kdf.original).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('kein tmp-File bleibt bei Decrypt-Fehler liegen (Floor: kein Klartext als Datei)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Floor-tmp-Test übersprungen');
        return;
      }

      const masterKey = 'test-no-tmp-leak';
      const correctKey = 'different-key-for-artefact';
      const artefactBuffer = await makeArtefact(correctKey, { version: 1, kdf: {}, entries: {} });

      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        await httpPostBinary(port, '/api/settings/backup-restore?confirm=true', artefactBuffer);

        // Kein .restore-tmp-File soll liegen
        let tmpExists = false;
        try {
          await stat(join(tmpDir, 'secrets.enc.json.restore-tmp'));
          tmpExists = true;
        } catch {
          // Erwünscht: Datei existiert nicht
        }
        expect(tmpExists).toBe(false);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── AC16 — Restore-Schutz + Audit ─────────────────────────────────────────

  describe('AC16 — Restore-Schutz + Audit', () => {
    it('403 wenn Identität nicht in CRED_ADMIN_EMAILS (kein Audit bei 403)', async () => {
      const masterKey = 'test-403-key';
      const { app, auditStore } = await buildApp({
        tmpDir,
        masterKey,
        identity: { email: 'notadmin@test.example.com' },
        adminEmails: 'admin@test.example.com',
      });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          Buffer.from('doesnt-matter'),
        );

        expect(status).toBe(403);
        expect(body.error).toBeTruthy();
        // Kein Audit-Eintrag bei 403 (AC16: nur bei berechtigtem Zugriff)
        const entries = auditStore.getEntries();
        expect(entries.length).toBe(0);
      } finally {
        await closeServer(server);
      }
    });

    it('403-Response enthält keinen Key/Klartext (Floor)', async () => {
      const masterKey = 'secret-key-must-not-leak-403';
      const { app } = await buildApp({
        tmpDir,
        masterKey,
        identity: { email: 'notadmin@test.example.com' },
        adminEmails: 'admin@test.example.com',
      });
      const { server, port } = await startServer(app);

      try {
        const { body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          Buffer.from('x'),
        );
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toMatch(/secret-key-must-not-leak/);
        expect(bodyStr).not.toMatch(/masterKey|master_key/i);
      } finally {
        await closeServer(server);
      }
    });

    it('Audit-First: Audit-Eintrag credential-restore VOR Ausführung (AC16)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Audit-First-Test übersprungen');
        return;
      }

      const masterKey = 'test-audit-first-key';
      const callOrder = [];

      const { app, auditStore, credentialStore } = await buildApp({ tmpDir, masterKey });

      // auditStore.record spy — trackt Reihenfolge
      const originalRecord = auditStore.record.getMockImplementation?.() ?? null;
      auditStore.record = jest.fn(({ identity, command }) => {
        callOrder.push('audit');
        if (originalRecord) originalRecord({ identity, command });
        else auditStore.getEntries().push({ time: new Date().toISOString(), identity, command });
      });

      // restore() auch tracken
      const originalRestore = credentialStore.restore.bind(credentialStore);
      credentialStore.restore = jest.fn(async (...args) => {
        callOrder.push('restore');
        return originalRestore(...args);
      });

      const artefactBuffer = await makeArtefact(masterKey, { version: 1, kdf: {}, entries: {} });
      const { server, port } = await startServer(app);

      try {
        await httpPostBinary(port, '/api/settings/backup-restore?confirm=true', artefactBuffer);

        // Audit MUSS vor Restore aufgerufen worden sein
        const auditIdx = callOrder.indexOf('audit');
        const restoreIdx = callOrder.indexOf('restore');
        expect(auditIdx).toBeGreaterThanOrEqual(0);
        expect(restoreIdx).toBeGreaterThanOrEqual(0);
        expect(auditIdx).toBeLessThan(restoreIdx);
      } finally {
        await closeServer(server);
      }
    });

    it('Audit-Eintrag enthält Identität + Aktion — KEIN Key/Klartext (AC16 Floor)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Audit-Content-Test übersprungen');
        return;
      }

      const masterKey = 'secret-never-in-audit';
      const artefactBuffer = await makeArtefact(masterKey, { version: 1, kdf: {}, entries: {} });

      const { app, auditStore } = await buildApp({
        tmpDir,
        masterKey,
        identity: { email: 'admin@test.example.com' },
      });
      const { server, port } = await startServer(app);

      try {
        await httpPostBinary(port, '/api/settings/backup-restore?confirm=true', artefactBuffer);

        const entries = auditStore.getEntries();
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const entry = entries[entries.length - 1];

        // Aktion muss credential-restore sein
        expect(entry.command).toBe('credential-restore');
        // Identität vorhanden
        expect(entry.identity).toBe('admin@test.example.com');

        // Floor: kein Key/Klartext im Audit-Eintrag
        const entryStr = JSON.stringify(entry);
        expect(entryStr).not.toMatch(/secret-never-in-audit/);
        expect(entryStr).not.toMatch(/masterKey|master_key|passphrase/i);
        expect(entryStr).not.toMatch(/entries|blob|ct|kdf/); // kein Store-Inhalt
      } finally {
        await closeServer(server);
      }
    });

    it('200 wenn kein CRED_ADMIN_EMAILS gesetzt (jede Identität darf)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Open-Gate-Test übersprungen');
        return;
      }

      const masterKey = 'test-open-gate-key';
      // adminEmails = undefined → delete CRED_ADMIN_EMAILS → keine Einschränkung
      const { app } = await buildApp({
        tmpDir,
        masterKey,
        identity: { email: 'anyone@test.example.com' },
        adminEmails: undefined,
      });
      const artefactBuffer = await makeArtefact(masterKey, { version: 1, kdf: {}, entries: {} });
      const { server, port } = await startServer(app);

      try {
        const { status, body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
      } finally {
        await closeServer(server);
      }
    });
  });

  // ── Floor: kein Key/Klartext in Response ──────────────────────────────────

  describe('Floor — kein Key/Klartext in Response/Log', () => {
    it('Success-Response enthält keinen Master-Key oder Store-Klartext', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Floor-Response-Test übersprungen');
        return;
      }

      const masterKey = 'super-secret-floor-test-key';
      const storeData = { version: 1, kdf: {}, entries: {} };
      const artefactBuffer = await makeArtefact(masterKey, storeData);

      const { app } = await buildApp({ tmpDir, masterKey });
      const { server, port } = await startServer(app);

      try {
        const { body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );
        const bodyStr = JSON.stringify(body);

        // Kein Master-Key in der Response
        expect(bodyStr).not.toMatch(/super-secret-floor-test-key/);
        // Kein Store-Blob/Klartext in der Response
        expect(bodyStr).not.toMatch(/"entries"/);
        expect(bodyStr).not.toMatch(/"blob"/);
        // Metadaten sind OK (manifest)
        if (body.ok) {
          expect(body.manifest).toBeDefined();
          expect(typeof body.manifest.schemaVersion).toBe('number');
        }
      } finally {
        await closeServer(server);
      }
    });

    it('Error-Response enthält keinen Master-Key (gpg-decrypt-failed Fall)', async () => {
      if (!gpgAvailable) {
        console.warn('[SKIP] GPG nicht verfügbar — Floor-Error-Response übersprungen');
        return;
      }

      const correctKey = 'correct-floor-key';
      const wrongKey = 'wrong-floor-key-should-not-appear-in-response';
      const artefactBuffer = await makeArtefact(correctKey, { version: 1, kdf: {}, entries: {} });

      const { app } = await buildApp({ tmpDir, masterKey: wrongKey });
      const { server, port } = await startServer(app);

      try {
        const { body } = await httpPostBinary(
          port,
          '/api/settings/backup-restore?confirm=true',
          artefactBuffer,
        );
        const bodyStr = JSON.stringify(body);

        expect(bodyStr).not.toMatch(/wrong-floor-key/);
        expect(bodyStr).not.toMatch(/correct-floor-key/);
        expect(body.errorClass).toBe('gpg-decrypt-failed');
      } finally {
        await closeServer(server);
      }
    });
  });
});

// ── CredentialStore.restore() Unit-Tests ─────────────────────────────────────

describe('CredentialStore.restore() — Unit (AC13–AC15)', () => {
  let tmpDir;
  let gpgAvailable;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `restore-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    gpgAvailable = await isGpgAvailableLocal();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('AC14: restore() ohne confirm gibt confirm-required zurück', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const store = new CredentialStore({ dir: tmpDir, masterKey: 'somekey' });
    const result = await store.restore(Buffer.from('anything'), { confirm: false });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('confirm-required');
  });

  it('AC15: restore() ohne Master-Key gibt no-master-key zurück', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    // kein masterKey → gesperrt
    const store = new CredentialStore({ dir: tmpDir });
    const result = await store.restore(Buffer.from('something'), { confirm: true });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('no-master-key');
  });

  it('AC15: restore() mit korruptem Artefakt gibt gpg-decrypt-failed zurück', async () => {
    if (!gpgAvailable) {
      console.warn('[SKIP] GPG nicht verfügbar — AC15-corrupt-Unit-Test übersprungen');
      return;
    }
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const store = new CredentialStore({ dir: tmpDir, masterKey: 'mykey' });
    const result = await store.restore(Buffer.from('not-a-gpg-file'), { confirm: true });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('gpg-decrypt-failed');
  });

  it('AC13/AC15: restore() schreibt Store atomar zurück (kein .restore-tmp liegen)', async () => {
    if (!gpgAvailable) {
      console.warn('[SKIP] GPG nicht verfügbar — AC15-atomic-Unit-Test übersprungen');
      return;
    }

    const masterKey = 'atomic-test-key';
    const storeData = { version: 1, kdf: { test: true }, entries: {}, meta: {} };
    const { encrypt } = await import('../src/BackupCrypto.js');
    const blob = JSON.stringify(storeData, null, 2);
    const manifest = { schemaVersion: 1, backupVersion: 1, createdAt: new Date().toISOString(), storeSize: blob.length };
    const artefactBuf = await encrypt(masterKey, Buffer.from(JSON.stringify({ manifest, blob }), 'utf8'));

    const { CredentialStore } = await import('../src/CredentialStore.js');
    const store = new CredentialStore({ dir: tmpDir, masterKey });
    const result = await store.restore(artefactBuf, { confirm: true });

    expect(result.ok).toBe(true);
    expect(result.manifest.schemaVersion).toBe(1);

    // secrets.enc.json wurde geschrieben
    const content = await readFile(join(tmpDir, 'secrets.enc.json'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.kdf.test).toBe(true);

    // Kein .restore-tmp liegen
    let tmpExists = false;
    try {
      await stat(join(tmpDir, 'secrets.enc.json.restore-tmp'));
      tmpExists = true;
    } catch { /* erwartet */ }
    expect(tmpExists).toBe(false);
  });
});
