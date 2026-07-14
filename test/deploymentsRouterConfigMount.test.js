/**
 * deploymentsRouterConfigMount.test.js — HTTP-Router-Tests für die config.yaml-Mount-
 * Durchreichung (deploy-config-volume-mount.md AC7/AC8/AC10, F-078/S-347/S-348).
 *
 * Covers (deploy-config-volume-mount):
 *   AC7  — POST /api/deployments akzeptiert optionale requiresConfig/configApp/configSeed;
 *          validateDeployBody() validiert Typen (requiresConfig: boolean), Slug-Zeichensatz
 *          (^[a-z0-9][a-z0-9._-]*$) + Längenlimit auf configApp/configSeed; ungültig → 400
 *          ohne den configSeed-Inhalt im Fehlertext zu leaken.
 *   AC8  — Bei requiresConfig:true reicht der Handler { requiresConfig, configApp, configSeed }
 *          an orchestrator.deploy() durch. Bei requiresConfig false/abwesend bleibt der
 *          orchestrator.deploy()-Aufruf unverändert (kein requiresConfig/configApp/configSeed-Key).
 *   AC10 (Floor) — configSeed erscheint nie in der 400-Fehlerantwort (kein Content-Leak).
 *          Neue Fehlerklassen config-file-missing/config-app-invalid werden auf HTTP 422
 *          mit passendem errorClass gemappt (Verträge-Sektion der Spec).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { deploymentsRouter } from '../src/deploymentsRouter.js';
import { AuditStore } from '../src/AuditStore.js';

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function closeServer(server) {
  return new Promise((r) => server.close(r));
}
function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let j = null;
          try { j = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, body: j, raw });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const VPS_TARGETS = new Map([['my-vps', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]);
const BASE_BODY = {
  image: 'ghcr.io/org/app:v1',
  vps: 'my-vps',
  hostname: 'app.example.com',
  tunnelId: 't-123',
};

function build({ deployResult } = {}) {
  const deploy = jest.fn(async () => deployResult ?? {
    result: 'ok',
    deployment: { containerId: 'c1', hostname: BASE_BODY.hostname },
  });
  const orchestrator = { deploy };
  const auditStore = new AuditStore();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.identity = { email: 'admin@example.com' };
    next();
  });
  app.use(deploymentsRouter(orchestrator, auditStore, VPS_TARGETS));
  return { app, deploy };
}

describe('POST /api/deployments — config.yaml-Mount-Durchreichung (deploy-config-volume-mount AC7/AC8/AC10)', () => {
  it('AC8: requiresConfig:false/abwesend → orchestrator.deploy() ohne requiresConfig/configApp/configSeed-Key (byte-identisch)', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', BASE_BODY);
      expect(res.status).toBe(200);
      const callArgs = deploy.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('requiresConfig');
      expect(callArgs).not.toHaveProperty('configApp');
      expect(callArgs).not.toHaveProperty('configSeed');
    } finally {
      await closeServer(server);
    }
  });

  it('AC7/AC8: requiresConfig:true + gültiger configApp + configSeed → durchgereicht an orchestrator.deploy()', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
        configSeed: 'key: value\n',
      });
      expect(res.status).toBe(200);
      const callArgs = deploy.mock.calls[0][0];
      expect(callArgs.requiresConfig).toBe(true);
      expect(callArgs.configApp).toBe('my-app');
      expect(callArgs.configSeed).toBe('key: value\n');
    } finally {
      await closeServer(server);
    }
  });

  it('AC7: requiresConfig:true ohne configSeed → configSeed bleibt null, requiresConfig/configApp durchgereicht', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
      });
      expect(res.status).toBe(200);
      const callArgs = deploy.mock.calls[0][0];
      expect(callArgs.requiresConfig).toBe(true);
      expect(callArgs.configApp).toBe('my-app');
      expect(callArgs.configSeed).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('AC7: requiresConfig als non-boolean → 400', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', { ...BASE_BODY, requiresConfig: 'true' });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('AC7/D3: configApp mit ungültigen Zeichen (Großbuchstaben) → 400, kein Deploy-Aufruf', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'My-App',
      });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('AC7/D3: configApp mit Shell-Metazeichen (; und Leerzeichen) → 400, kein Deploy-Aufruf', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'app; rm -rf /',
      });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('AC7: configApp überschreitet Längenlimit (65 Zeichen) → 400', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'a'.repeat(65),
      });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('AC7/AC10: configSeed überschreitet Längenlimit → 400, Inhalt NICHT in der Fehlermeldung', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const marker = 'SECRET-MARKER-XYZ';
      const oversized = marker + 'a'.repeat(70000);
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
        configSeed: oversized,
      });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
      expect(res.raw).not.toContain(marker);
    } finally {
      await closeServer(server);
    }
  });

  it('AC7: configSeed als non-string (Zahl) → 400', async () => {
    const { app, deploy } = build();
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
        configSeed: 12345,
      });
      expect(res.status).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('Verträge: orchestrator liefert errorClass config-file-missing → 422 mit errorClass im Body', async () => {
    const { app } = build({
      deployResult: { result: 'error', errorClass: 'config-file-missing', reason: 'config.yaml fehlt' },
    });
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
      });
      expect(res.status).toBe(422);
      expect(res.body.errorClass).toBe('config-file-missing');
      expect(res.body.result).toBe('error');
    } finally {
      await closeServer(server);
    }
  });

  it('Verträge: orchestrator liefert errorClass config-app-invalid → 422 mit errorClass im Body', async () => {
    const { app } = build({
      deployResult: { result: 'error', errorClass: 'config-app-invalid', reason: 'Ungültiger Slug' },
    });
    const { server, port } = await startServer(app);
    try {
      const res = await httpPost(port, '/api/deployments', {
        ...BASE_BODY,
        requiresConfig: true,
        configApp: 'my-app',
      });
      expect(res.status).toBe(422);
      expect(res.body.errorClass).toBe('config-app-invalid');
      expect(res.body.result).toBe('error');
    } finally {
      await closeServer(server);
    }
  });
});
