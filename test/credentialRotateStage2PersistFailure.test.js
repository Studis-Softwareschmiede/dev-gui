/**
 * credentialRotateStage2PersistFailure.test.js — dedizierter Router-Test für Review-
 * Finding 1 (Iteration 2, S-342): Stufe 2 (Bitwarden-Archivierung) muss auch im
 * `persist-failed`-Fall laufen (`ok:false, swapped:true`) — NICHT nur bei `ok:true`.
 *
 * Covers (credential-key-rotation, v2 S-342):
 *   AC4/AC11 (Review-Finding 1) — Der Spec-Vertrag sagt: „swapped:true signalisiert,
 *     dass der Store bereits ausschließlich mit dem neuen Key arbeitet (unabhängig
 *     vom .env-Persistenz-Ausgang) … also der Zeitpunkt für Archivierung/Backup
 *     erreicht ist." Genau bei persist-failed (Reboot-Risiko) ist Bitwarden der
 *     einzige Recovery-Pfad für den neuen Key — Stufe 2 (archiveRotatedKey) MUSS
 *     dort laufen, wenn bwEmail/bwPassword mitgeliefert wurden. Die Response bleibt
 *     `ok:false, reason:'persist-failed', swapped:true`, enthält aber zusätzlich das
 *     `archive`-Ergebnis (geheimnisfrei).
 *
 * Warum eine eigene Datei + Modul-Mock (Muster CredentialStoreRotatePersistFailure.test.js):
 *   `#persistKeyToEnv()` schreibt über `open(<envPath>.cred-tmp, ...)`. Um GEZIELT NUR
 *   den `.env`-Persistenz-Schritt scheitern zu lassen (nicht den Store-Swap), wird
 *   `open()` selektiv für Pfade mit Suffix `.cred-tmp` gemockt. Der Mock gilt modulweit
 *   für diese Datei — daher getrennt von credentialRotate.test.js (dort ungemockt).
 *   Alle betroffenen Module (CredentialStore, der Router, express, node:http) werden
 *   erst NACH der Mock-Registrierung dynamisch importiert (Muster wie im Vorbild).
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as realFsPromises from 'node:fs/promises';

jest.unstable_mockModule('node:fs/promises', () => ({
  ...realFsPromises,
  open: jest.fn((path, ...rest) => {
    if (typeof path === 'string' && path.endsWith('.cred-tmp')) {
      return Promise.reject(new Error('simulated .env write failure (EACCES)'));
    }
    return realFsPromises.open(path, ...rest);
  }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('credentialRotate — Review-Finding 1 (Iteration 2): Stufe 2 läuft auch bei persist-failed', () => {
  it('persist-failed + bwEmail/bwPassword ⇒ archiveRotatedKey wird aufgerufen; Response bleibt ok:false/reason persist-failed, enthält archive-Ergebnis', async () => {
    const express = (await import('express')).default;
    const { createServer } = await import('node:http');
    const { request: httpRequest } = await import('node:http');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const { CredentialStore } = await import('../src/CredentialStore.js');
    const { create } = await import('../src/routers/credentialRotate.js');

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
        const req = httpRequest({
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res) => {
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

    const OLD_KEY = 'old-master-key-stage2-persist-fail-not-real';
    const NEW_KEY = 'new-master-key-stage2-persist-fail-not-real';

    const tmpDir = join(tmpdir(), `credrotate-stage2-persistfail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await realFsPromises.mkdir(tmpDir, { recursive: true });
    delete process.env.CRED_ADMIN_EMAILS;

    const credentialStore = new CredentialStore({
      dir: tmpDir,
      masterKey: OLD_KEY,
      envPath: join(tmpDir, '.env'),
    });
    await credentialStore.set('credentials/misc/foo', 'plain-value');

    const auditStore = { record: jest.fn(), getEntries: () => [] };
    const bitwardenMasterKeyService = {
      archiveRotatedKey: jest.fn(async () => ({ status: 'archived' })),
      discardArchivedKeys: jest.fn(async () => ({ status: 'discarded' })),
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.identity = { email: 'admin@test.example.com' };
      next();
    });
    app.use(create({ auditStore, credentialStore, bitwardenMasterKeyService }));

    const { server, port } = await startServer(app);
    try {
      const res = await httpPostJson(port, '/api/settings/credential-rotate', {
        newKey: NEW_KEY,
        bwEmail: 'admin@example.com',
        bwPassword: 'bw-master-password',
      });

      // Response bleibt der persist-failed-Vertrag — ok:false, reason:persist-failed, swapped:true
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe('persist-failed');
      expect(res.body.swapped).toBe(true);

      // Finding 1: Stufe 2 LIEF trotz ok:false (weil swapped:true)
      expect(bitwardenMasterKeyService.archiveRotatedKey).toHaveBeenCalledTimes(1);
      expect(res.body.archive).toEqual({ ok: true });
    } finally {
      await closeServer(server);
      await realFsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
