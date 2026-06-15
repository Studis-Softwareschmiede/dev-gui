/**
 * workspaceHealth.test.js — Tests für WorkspaceHealthChecker + GET /api/settings/workspace-health
 *
 * Covers (workspace-health-hinweis):
 *   AC1 — Backend: alle 6 Health-Checks (mount-exists/-nonempty, board-roots-set/-valid,
 *          repos-found, board-projects-found); Gesamt-Status = höchste Schwere;
 *          Prüffehler → warn (kein Crash); jeder Check-Zweig (ok + nicht-ok).
 *   AC2 — GET /api/settings/workspace-health: 200 { overall, checks, counts };
 *          read-only hinter AccessGuard; kein Secret im Output.
 *          AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
 *   AC3 — Einstellungen zeigen Health-Status: abgedeckt in client/src/__tests__/SettingsView.test.jsx
 *          (WorkspacePathSection rendert ok/warn/error-Blöcke inkl. role=alert bei error).
 *   AC4 — Start-Log-Warnung: server.js try/catch um healthChecker.check() + console.warn je
 *          nicht-ok-Check; kein isolierter Unit-Test nötig (Startup nicht ohne Integration
 *          testbar — per Inspektion verifiziert, Start wird nie blockiert).
 *   AC5 — writeErrorSetup: isWorkspaceWriteError + buildWriteErrorSetup klassifizieren
 *          Schreibfehler (ENOENT/EACCES/EPERM/EROFS) korrekt; hostPath aus WORKSPACE_HOST_DIR
 *          oder Platzhalter wenn ungesetzt; commands = mkdir -p + chown 1000:1000.
 *
 * Strategy:
 *   - WorkspaceHealthChecker mit injizierten fsDeps + listClonesFn + getIndexFn testen.
 *   - HTTP-Ebene: Express-Testserver analog boardAggregator.test.js-Muster.
 *   - writeErrorSetup: Unit-Tests für Klassifizierung + Setup-Bau.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { WorkspaceHealthChecker } from '../src/WorkspaceHealthChecker.js';
import { workspacePathRouter } from '../src/workspacePathRouter.js';
import { isWorkspaceWriteError, buildWriteErrorSetup } from '../src/writeErrorSetup.js';
import { AuditStore } from '../src/AuditStore.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── HTTP-Helpers (analog boardAggregator.test.js) ────────────────────────────

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

// ── Fake FS-Deps ─────────────────────────────────────────────────────────────

/**
 * Erstellt injizierbare fsDeps für den WorkspaceHealthChecker.
 * @param {{ statMap?: Map<string,boolean>, readdirMap?: Map<string,string[]> }} opts
 */
function makeFsDeps({ statMap = new Map(), readdirMap = new Map() } = {}) {
  return {
    stat: async (p) => {
      if (!statMap.has(p)) {
        const e = new Error(`ENOENT: no such file or directory, stat '${p}'`);
        e.code = 'ENOENT';
        throw e;
      }
      return { isDirectory: () => statMap.get(p) };
    },
    readdir: async (p) => {
      if (!readdirMap.has(p)) {
        const e = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
        e.code = 'ENOENT';
        throw e;
      }
      return readdirMap.get(p);
    },
  };
}

// ── Fake CredentialStore (minimal, für Router-Test) ───────────────────────────

const fakeCredentialStore = {
  async readWorkspacePath() { return null; },
  async writeWorkspacePath() {},
  async deleteWorkspacePath() {},
};

// ── describe: WorkspaceHealthChecker Unit Tests ───────────────────────────────

describe('WorkspaceHealthChecker — AC1: alle 6 Checks', () => {
  it('overall=ok wenn alle Checks grün', async () => {
    const checker = new WorkspaceHealthChecker({
      fsDeps: makeFsDeps({
        statMap: new Map([['/workspace', true], ['/workspace/roots', true]]),
        readdirMap: new Map([['/workspace', ['repo1', 'repo2']]]),
      }),
      getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/workspace/roots' }[k]),
      listClonesFn: async () => [{ name: 'repo1' }, { name: 'repo2' }],
      getIndexFn: async () => [{ slug: 'proj', features: [] }],
    });
    const result = await checker.check();
    expect(result.overall).toBe('ok');
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(result.counts.repos).toBe(2);
    expect(result.counts.boardProjects).toBe(1);
  });

  describe('mount-exists', () => {
    it('status=error wenn WORKSPACE_DIR ungesetzt', async () => {
      const checker = new WorkspaceHealthChecker({
        getEnv: () => undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-exists');
      expect(c.status).toBe('error');
      expect(c.fix).toBeTruthy();
    });

    it('status=error wenn WORKSPACE_DIR nicht existiert (ENOENT)', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({ statMap: new Map() }),
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-exists');
      expect(c.status).toBe('error');
      expect(c.message).toContain('/workspace');
    });

    it('status=error wenn WORKSPACE_DIR kein Verzeichnis', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({ statMap: new Map([['/workspace', false]]) }), // isDirectory = false
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-exists');
      expect(c.status).toBe('error');
    });

    it('status=warn bei unerwartetem Prüffehler (kein Crash)', async () => {
      const badFsDeps = {
        stat: async () => { throw new Error('Unexpected FS error'); },
        readdir: async () => [],
      };
      const checker = new WorkspaceHealthChecker({
        fsDeps: badFsDeps,
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-exists');
      expect(c.status).toBe('warn');
    });
  });

  describe('mount-nonempty', () => {
    it('status=error wenn WORKSPACE_DIR leer', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true]]),
          readdirMap: new Map([['/workspace', []]]),
        }),
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-nonempty');
      expect(c.status).toBe('error');
      expect(c.fix).toBeTruthy();
    });

    it('status=ok wenn WORKSPACE_DIR Einträge hat', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true]]),
          readdirMap: new Map([['/workspace', ['repo1']]]),
        }),
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [{ name: 'repo1' }],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'mount-nonempty');
      expect(c.status).toBe('ok');
    });
  });

  describe('board-roots-set', () => {
    it('status=error wenn BOARD_ROOTS ungesetzt', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => k === 'WORKSPACE_DIR' ? '/workspace' : undefined,
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-roots-set');
      expect(c.status).toBe('error');
      expect(c.fix).toContain('VPS');
    });

    it('status=ok wenn BOARD_ROOTS gesetzt', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-roots-set');
      expect(c.status).toBe('ok');
    });
  });

  describe('board-roots-valid', () => {
    it('status=error wenn BOARD_ROOTS-Pfad nicht existiert', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/missing' }[k]),
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-roots-valid');
      expect(c.status).toBe('error');
      expect(c.message).toContain('/missing');
    });

    it('status=ok wenn alle BOARD_ROOTS-Pfade existieren und Verzeichnisse sind', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-roots-valid');
      expect(c.status).toBe('ok');
    });

    it('status=warn bei unerwartetem Prüffehler (kein Crash)', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: {
          stat: async (p) => {
            if (p === '/workspace') return { isDirectory: () => true };
            throw new Error('permission denied');
          },
          readdir: async () => ['x'],
        },
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-roots-valid');
      expect(c.status).toBe('warn');
    });
  });

  describe('repos-found', () => {
    it('status=warn wenn 0 Repos', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'repos-found');
      expect(c.status).toBe('warn');
      expect(result.counts.repos).toBe(0);
    });

    it('status=warn bei listClones-Fehler (kein Crash)', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => { throw new Error('scan error'); },
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'repos-found');
      expect(c.status).toBe('warn');
    });
  });

  describe('board-projects-found', () => {
    it('status=warn wenn 0 Board-Projekte', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [{ name: 'repo1' }],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-projects-found');
      expect(c.status).toBe('warn');
      expect(result.counts.boardProjects).toBe(0);
    });

    it('status=warn bei getIndex-Fehler (kein Crash)', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [{ name: 'r' }],
        getIndexFn: async () => { throw new Error('board error'); },
      });
      const result = await checker.check();
      const c = result.checks.find((x) => x.key === 'board-projects-found');
      expect(c.status).toBe('warn');
    });

    it('zählt nur fehlerfreie Board-Projekte', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [{ name: 'r' }],
        getIndexFn: async () => [
          { slug: 'proj1', features: [] },
          { slug: 'proj2', error: 'board.yaml fehlt', features: [] },
        ],
      });
      const result = await checker.check();
      expect(result.counts.boardProjects).toBe(1);
    });
  });

  describe('Gesamt-Status', () => {
    it('overall=error wenn mindestens ein Check error ist', async () => {
      const checker = new WorkspaceHealthChecker({
        getEnv: () => undefined, // WORKSPACE_DIR + BOARD_ROOTS ungesetzt → error
        listClonesFn: async () => [],
        getIndexFn: async () => [],
      });
      const result = await checker.check();
      expect(result.overall).toBe('error');
    });

    it('overall=warn wenn höchste Schwere warn (kein error)', async () => {
      const checker = new WorkspaceHealthChecker({
        fsDeps: makeFsDeps({
          statMap: new Map([['/workspace', true], ['/roots', true]]),
          readdirMap: new Map([['/workspace', ['x']]]),
        }),
        getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
        listClonesFn: async () => [], // → repos-found: warn
        getIndexFn: async () => [],   // → board-projects-found: warn
      });
      const result = await checker.check();
      expect(result.overall).toBe('warn');
    });
  });
});

// ── describe: GET /api/settings/workspace-health (AC2) ───────────────────────

describe('workspacePathRouter HTTP — GET /api/settings/workspace-health (AC2)', () => {
  let server, port;

  beforeEach(async () => {
    // DEV_NO_ACCESS=1 — AccessGuard dev-bypass (analog workspacePath.test.js)
    process.env.DEV_NO_ACCESS = '1';

    const app = express();
    app.use(express.json());

    const accessGuard = createAccessGuard();
    app.use('/api', accessGuard);

    const auditStore = new AuditStore();

    // Inject a HealthChecker that always returns ok
    const healthChecker = new WorkspaceHealthChecker({
      fsDeps: makeFsDeps({
        statMap: new Map([['/workspace', true], ['/roots', true]]),
        readdirMap: new Map([['/workspace', ['repo1']]]),
      }),
      getEnv: (k) => ({ WORKSPACE_DIR: '/workspace', BOARD_ROOTS: '/roots' }[k]),
      listClonesFn: async () => [{ name: 'repo1' }],
      getIndexFn: async () => [{ slug: 'proj', features: [] }],
    });

    app.use(workspacePathRouter(fakeCredentialStore, auditStore, { healthChecker }));

    const result = await startServer(app);
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    if (server) await closeServer(server);
  });

  it('liefert 200 { overall, checks, counts } mit korrekter Shape', async () => {
    const { status, body } = await httpGet(port, '/api/settings/workspace-health');
    expect(status).toBe(200);
    expect(['ok', 'warn', 'error']).toContain(body.overall);
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(typeof body.counts).toBe('object');
    expect(typeof body.counts.repos).toBe('number');
    expect(typeof body.counts.boardProjects).toBe('number');
  });

  it('kein Secret im Output (keine Tokens/Passwörter in checks oder counts)', async () => {
    const { body } = await httpGet(port, '/api/settings/workspace-health');
    const json = JSON.stringify(body);
    // Kein Secret-Pattern im Output
    expect(json).not.toMatch(/ghp_[A-Za-z0-9]{30,}/);
    expect(json).not.toMatch(/ghs_[A-Za-z0-9]{30,}/);
  });

  it('liefert bei overall=ok grünen Status und counts.repos > 0', async () => {
    const { body } = await httpGet(port, '/api/settings/workspace-health');
    // Mit injizierten ok-Deps sollte overall=ok sein
    expect(body.overall).toBe('ok');
    expect(body.counts.repos).toBe(1);
    expect(body.counts.boardProjects).toBe(1);
  });

  it('liefert 200 auch wenn HealthChecker alle Checks als warn zurückgibt (graceful degrade)', async () => {
    // Separater Server mit HealthChecker der alles warn zurückgibt (keine throws — check() wirft nicht)
    const app2 = express();
    app2.use(express.json());
    const guard2 = createAccessGuard();
    app2.use('/api', guard2);
    const audit2 = new AuditStore();
    const warnHealthChecker = new WorkspaceHealthChecker({
      fsDeps: { stat: async () => { throw new Error('FS gone'); }, readdir: async () => { throw new Error('FS gone'); } },
      getEnv: () => undefined,
      listClonesFn: async () => { throw new Error('scan gone'); },
      getIndexFn: async () => { throw new Error('index gone'); },
    });
    app2.use(workspacePathRouter(fakeCredentialStore, audit2, { healthChecker: warnHealthChecker }));
    const { server: s2, port: p2 } = await startServer(app2);
    try {
      const { status, body } = await httpGet(p2, '/api/settings/workspace-health');
      // WorkspaceHealthChecker wirft nie — liefert immer warn/error-Checks, nie Crash
      expect(status).toBe(200);
      expect(body.overall).toBeDefined();
      // Checks sollen warn/error sein
      expect(['warn', 'error']).toContain(body.overall);
    } finally {
      await closeServer(s2);
    }
  });
});

// ── describe: writeErrorSetup — AC5 ─────────────────────────────────────────

describe('writeErrorSetup — AC5: Schreibfehler-Klassifizierung', () => {
  describe('isWorkspaceWriteError', () => {
    it('erkennt ENOENT per code', () => {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt EACCES per code', () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt EPERM per code', () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt EROFS per code', () => {
      const err = new Error('read-only file system');
      err.code = 'EROFS';
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt Schreibfehler per Nachricht (Fallback)', () => {
      const err = new Error('ENOENT: no such file or directory');
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt "permission denied" per Nachricht', () => {
      const err = new Error('permission denied');
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('erkennt read-only file system per Nachricht', () => {
      const err = new Error('read-only file system');
      expect(isWorkspaceWriteError(err)).toBe(true);
    });

    it('false für nicht-Schreibfehler', () => {
      const err = new Error('network timeout');
      expect(isWorkspaceWriteError(err)).toBe(false);
    });

    it('false für null', () => {
      expect(isWorkspaceWriteError(null)).toBe(false);
    });
  });

  describe('buildWriteErrorSetup', () => {
    const origEnv = process.env.WORKSPACE_HOST_DIR;

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.WORKSPACE_HOST_DIR;
      } else {
        process.env.WORKSPACE_HOST_DIR = origEnv;
      }
    });

    it('nutzt WORKSPACE_HOST_DIR wenn gesetzt', () => {
      process.env.WORKSPACE_HOST_DIR = '/host/workspace';
      const result = buildWriteErrorSetup({ errorMessage: 'test error' });
      expect(result.error).toBe('test error');
      expect(result.setup.hostPath).toBe('/host/workspace');
      expect(result.setup.commands[0]).toContain('/host/workspace');
      expect(result.setup.commands[1]).toContain('/host/workspace');
      expect(result.setup.commands[1]).toContain('1000:1000');
    });

    it('verwendet Platzhalter wenn WORKSPACE_HOST_DIR ungesetzt', () => {
      delete process.env.WORKSPACE_HOST_DIR;
      const result = buildWriteErrorSetup({ errorMessage: 'write fail' });
      expect(result.setup.hostPath).toBe('<dein-host-workspace-pfad>');
      expect(result.setup.commands[0]).toContain('<dein-host-workspace-pfad>');
      expect(result.setup.message).toContain('WORKSPACE_HOST_DIR');
    });

    it('commands enthält mkdir -p und chown 1000:1000', () => {
      process.env.WORKSPACE_HOST_DIR = '/mypath';
      const result = buildWriteErrorSetup({});
      expect(result.setup.commands).toHaveLength(2);
      expect(result.setup.commands[0]).toMatch(/^sudo mkdir -p/);
      expect(result.setup.commands[1]).toMatch(/chown -R 1000:1000/);
    });

    it('setup.message ist gesetzt und nicht leer', () => {
      const result = buildWriteErrorSetup({});
      expect(typeof result.setup.message).toBe('string');
      expect(result.setup.message.length).toBeGreaterThan(10);
    });

    it('error-Feld nimmt errorMessage an', () => {
      const result = buildWriteErrorSetup({ errorMessage: 'spezifischer Fehler' });
      expect(result.error).toBe('spezifischer Fehler');
    });

    it('error-Feld hat Fallback wenn errorMessage fehlt', () => {
      const result = buildWriteErrorSetup({});
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    });
  });
});
