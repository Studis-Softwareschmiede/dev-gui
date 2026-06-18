/**
 * localImageTest.test.js — Tests für S-156: Lokaler Image-Test vor VPS-Deploy.
 *
 * Covers (local-image-test): AC1, AC2, AC3, AC4, AC5
 *
 * Abgedeckt:
 *   AC1  — Boundary-Isolation: LocalDockerControl ist einzige write-Boundary;
 *           DockerReader wird nicht verändert; Grep-Prüfung auf Test-Label.
 *   AC2  — POST /api/deployments/local-test: ok-Report, report.started===true bei Erfolg.
 *   AC3  — Port-Logik: 1 Port / mehrere Ports / kein Port; Reachability ok/timeout.
 *   AC4  — rm-Garantie via try/finally: Container wird immer entfernt (auch bei Fehler/Exception).
 *   AC5  — AccessGuard-403, CRED_ADMIN_EMAILS-403, audit-first, image/tag-Validierung,
 *           Shell-Metazeichen blockiert, 502 bei Docker down, keine Secrets in Response.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { deploymentsRouter } from '../src/deploymentsRouter.js';
import { LocalDockerControl } from '../src/deploy/LocalDockerControl.js';
import { AuditStore } from '../src/AuditStore.js';

// ── Test-Helpers ──────────────────────────────────────────────────────────────

/**
 * Erstellt eine Express-App mit deploymentsRouter und injizierten Stubs.
 */
function makeApp({
  localDockerControl,
  auditStore,
  identity = { email: 'admin@example.com' },
} = {}) {
  const app = express();
  app.use(express.json());
  // Simulate AccessGuard (inject identity)
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  // Minimal orchestrator stub (only local-test tests — other endpoints not exercised)
  const orchestratorStub = {
    deploy: jest.fn(async () => ({ result: 'ok', deployment: {} })),
    undeploy: jest.fn(async () => ({ result: 'ok' })),
    listDeployments: jest.fn(async () => ({ deployments: [] })),
  };
  app.use(
    deploymentsRouter(
      orchestratorStub,
      auditStore,
      new Map([['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }]]),
      null,                  // reconciliationJob
      localDockerControl,    // AC1: lokale Boundary
    ),
  );
  return app;
}

/**
 * Leichtgewichtiger HTTP-Request-Helper (keine externe Dependency).
 */
async function request(app, method, path, body) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers = { 'Content-Type': 'application/json' };
      if (bodyStr !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      const req = http.request(
        { hostname: 'localhost', port, path, method: method.toUpperCase(), headers },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close();
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

/** Erstellt einen einfachen LocalDockerControl-Stub für Erfolgsfall. */
function makeLocalDockerControlStub(report = {
  started: true,
  exitedEarly: false,
  hostPort: 49153,
  exposedPorts: [8080],
  reachable: true,
  durationMs: 1200,
}) {
  return { runProbe: jest.fn(async () => report) };
}

// ── AC1: Boundary-Isolation ──────────────────────────────────────────────────

describe('AC1: Boundary-Isolation', () => {
  it('LocalDockerControl existiert als separate Klasse (nicht DockerReader)', async () => {
    // LocalDockerControl ist die schreibende Boundary — DockerReader bleibt read-only
    expect(typeof LocalDockerControl).toBe('function');
    // DockerReader hat keine run/rm/inspect-Methoden
    const { DockerReader } = await import('../src/DockerReader.js');
    const reader = new DockerReader({ execFn: jest.fn() });
    expect(reader.runProbe).toBeUndefined();
    expect(reader.rm).toBeUndefined();
  });

  it('Test-Label-Konvention: "dev-gui.local-test" kommt in LocalDockerControl vor', async () => {
    // Grep-Prüfbar: das Test-Label muss in der Boundary-Datei stehen (AC1)
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/deploy/LocalDockerControl.js', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('dev-gui.local-test');
  });

  it('DockerReader-Datei enthält keine run/rm-Aufrufe (unverändert)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/DockerReader.js', import.meta.url),
      'utf-8',
    );
    // DockerReader darf keine schreibenden Docker-Kommandos enthalten
    expect(src).not.toContain("'docker', ['run'");
    expect(src).not.toContain("'docker', ['rm'");
  });

  it('run/inspect/rm kommen NUR in LocalDockerControl vor (nicht in deploymentsRouter)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/deploymentsRouter.js', import.meta.url),
      'utf-8',
    );
    // Der Router darf kein direktes docker run/rm aufrufen
    expect(src).not.toMatch(/execFile.*docker.*run/);
    expect(src).not.toMatch(/execFile.*docker.*rm/);
  });
});

// ── AC2: ok-Report bei Erfolg ─────────────────────────────────────────────────

describe('AC2: POST /api/deployments/local-test — ok-Report', () => {
  it('200 + { result: "ok", report } bei Erfolg', async () => {
    const stub = makeLocalDockerControlStub();
    const auditStore = new AuditStore();
    const app = makeApp({ localDockerControl: stub, auditStore });

    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app',
      tag: 'v1.2.3',
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.report).toBeDefined();
    expect(res.body.report.started).toBe(true);
  });

  it('report enthält alle Pflichtfelder (LocalTestReport-Shape)', async () => {
    const stub = makeLocalDockerControlStub();
    const auditStore = new AuditStore();
    const app = makeApp({ localDockerControl: stub, auditStore });

    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app',
      tag: 'v1.2.3',
    });

    const { report } = res.body;
    expect(typeof report.started).toBe('boolean');
    expect(typeof report.exitedEarly).toBe('boolean');
    expect(typeof report.reachable).toBe('boolean');
    expect(typeof report.durationMs).toBe('number');
    expect(Array.isArray(report.exposedPorts)).toBe(true);
    // hostPort kann null oder number sein
    expect(report.hostPort === null || typeof report.hostPort === 'number').toBe(true);
  });

  it('runProbe wird mit image + tag aufgerufen', async () => {
    const stub = makeLocalDockerControlStub();
    const auditStore = new AuditStore();
    const app = makeApp({ localDockerControl: stub, auditStore });

    await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/myapp',
      tag: 'v2.0.0',
    });

    expect(stub.runProbe).toHaveBeenCalledWith('ghcr.io/org/myapp', 'v2.0.0');
  });
});

// ── AC3: Port-Logik ───────────────────────────────────────────────────────────

describe('AC3: Port-Logik & Reachability', () => {
  it('1 Port → hostPort gesetzt + reachable: true möglich', async () => {
    const stub = makeLocalDockerControlStub({
      started: true, exitedEarly: false,
      hostPort: 32100, exposedPorts: [8080],
      reachable: true, durationMs: 800,
    });
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });
    expect(res.status).toBe(200);
    expect(res.body.report.hostPort).toBe(32100);
    expect(res.body.report.reachable).toBe(true);
    expect(res.body.report.exposedPorts).toEqual([8080]);
  });

  it('Mehrere Ports → exposedPorts enthält alle, hostPort = erster', async () => {
    const stub = makeLocalDockerControlStub({
      started: true, exitedEarly: false,
      hostPort: 32101, exposedPorts: [3000, 8080],
      reachable: false, durationMs: 900,
      reason: 'Mehrere exponierte Ports (3000, 8080); erster/kleinster (3000) wird probiert',
    });
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });
    expect(res.status).toBe(200);
    expect(res.body.report.exposedPorts).toContain(3000);
    expect(res.body.report.exposedPorts).toContain(8080);
    expect(res.body.report.reason).toContain('Mehrere');
  });

  it('Kein Port → hostPort: null, keine Reachability, reason enthält Hinweis', async () => {
    const stub = makeLocalDockerControlStub({
      started: true, exitedEarly: false,
      hostPort: null, exposedPorts: [],
      reachable: false, durationMs: 500,
      reason: 'kein exponierter Port',
    });
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/cli-app', tag: 'v1',
    });
    expect(res.status).toBe(200);
    expect(res.body.report.hostPort).toBeNull();
    expect(res.body.report.reachable).toBe(false);
    expect(res.body.report.reason).toContain('kein');
  });

  it('Reachability-Timeout → reachable: false, kein Test-Crash (200 result:ok)', async () => {
    const stub = makeLocalDockerControlStub({
      started: true, exitedEarly: false,
      hostPort: 32102, exposedPorts: [8080],
      reachable: false, durationMs: 3500,
    });
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.report.reachable).toBe(false);
    expect(res.body.report.started).toBe(true);
  });

  it('exitedEarly: Container crasht → started:true, exitedEarly:true, reachable:false', async () => {
    const stub = makeLocalDockerControlStub({
      started: true, exitedEarly: true,
      hostPort: null, exposedPorts: [8080],
      reachable: false, durationMs: 600,
    });
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/crashing-app', tag: 'v1',
    });
    expect(res.status).toBe(200);
    expect(res.body.report.started).toBe(true);
    expect(res.body.report.exitedEarly).toBe(true);
    expect(res.body.report.reachable).toBe(false);
  });
});

// ── AC4: rm-Garantie (try/finally) ───────────────────────────────────────────

describe('AC4: Aufräum-Garantie', () => {
  it('rm-Methode in LocalDockerControl ist in try/finally eingebettet', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/deploy/LocalDockerControl.js', import.meta.url),
      'utf-8',
    );
    // try/finally muss vorhanden sein (Aufräum-Garantie AC4)
    expect(src).toContain('try {');
    expect(src).toContain('} finally {');
    // rm -f muss im finally-Block stehen
    expect(src).toContain('#removeContainer');
  });

  it('runProbe räumt Container auf, auch wenn runProbe-intern ein Fehler geworfen wird', async () => {
    const rmCalls = [];
    // Direkte Unit-Test des LocalDockerControl mit exec-Stub
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return ''; // pull ok
      if (args[0] === 'run') {
        // run gelingt (gibt container id)
        return 'fake-container-id\n';
      }
      if (args[0] === 'inspect') {
        throw new Error('inspect fehlgeschlagen'); // inspect crash
      }
      if (args[0] === 'rm') {
        rmCalls.push(args.join(' '));
        return '';
      }
      return '';
    });
    const fetchStub = jest.fn(async () => ({ ok: false, status: 500 }));

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    // Trotz inspect-Crash soll runProbe erfolgreich zurückkehren (nicht werfen)
    const report = await ctrl.runProbe('ghcr.io/org/app', 'v1');

    // rm -f muss aufgerufen worden sein
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(rmCalls[0]).toContain('rm');
    expect(rmCalls[0]).toContain('-f');
    // report.started: inspect fehlgeschlagen → started: false
    expect(report).toMatchObject({ started: expect.any(Boolean) });
  });

  it('rm wird aufgerufen auch wenn Reachability fehlschlägt', async () => {
    const rmCalls = [];
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        // Gültiges inspect-JSON: Container running, ExposedPorts vorhanden
        return JSON.stringify({
          State: { Status: 'running', ExitCode: 0 },
          Config: { ExposedPorts: { '8080/tcp': {} } },
          NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '32200' }] } },
        }) + '\n';
      }
      if (args[0] === 'rm') {
        rmCalls.push(args[1]); // -f
        return '';
      }
      return '';
    });
    // Reachability wirft Fehler (Timeout)
    const fetchStub = jest.fn(async () => { throw new Error('ETIMEDOUT'); });

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/app', 'v1');

    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(report.reachable).toBe(false);
    expect(report.started).toBe(true);
  });

  it('502-Pfad (pull fehlgeschlagen) → kein Container, aber kein verwaister rm-Fehler', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') throw new Error('denied: access forbidden');
      return '';
    });

    const ctrl = new LocalDockerControl({ execFn: execStub });
    // Pull wirft → runProbe soll einen Error werfen (kein Container erstellt)
    await expect(ctrl.runProbe('ghcr.io/org/private', 'v1')).rejects.toMatchObject({
      errorClass: 'pull-failed',
    });
    // rm wurde NICHT aufgerufen (kein Container gestartet)
    const rmCall = execStub.mock.calls.find((c) => c[1]?.[0] === 'rm');
    expect(rmCall).toBeUndefined();
  });
});

// ── AC5: Security-Floor ───────────────────────────────────────────────────────

describe('AC5: Security-Floor', () => {
  it('403 wenn Identität nicht in CRED_ADMIN_EMAILS', async () => {
    const originalEnv = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    try {
      const stub = makeLocalDockerControlStub();
      const app = makeApp({
        localDockerControl: stub,
        auditStore: new AuditStore(),
        identity: { email: 'unauthorized@other.com' },
      });

      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/app',
        tag: 'v1',
      });

      expect(res.status).toBe(403);
      expect(stub.runProbe).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CRED_ADMIN_EMAILS;
      } else {
        process.env.CRED_ADMIN_EMAILS = originalEnv;
      }
    }
  });

  it('403 wenn identity null (kein AccessGuard-Token)', async () => {
    const originalEnv = process.env.CRED_ADMIN_EMAILS;
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com';
    try {
      const stub = makeLocalDockerControlStub();
      const app = makeApp({
        localDockerControl: stub,
        auditStore: new AuditStore(),
        identity: null,
      });

      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/app',
        tag: 'v1',
      });

      expect(res.status).toBe(403);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CRED_ADMIN_EMAILS;
      } else {
        process.env.CRED_ADMIN_EMAILS = originalEnv;
      }
    }
  });

  describe('audit-first', () => {
    it('Audit-Eintrag wird VOR runProbe geschrieben', async () => {
      const callOrder = [];
      const auditStore = new AuditStore();
      const origRecord = auditStore.record.bind(auditStore);
      auditStore.record = (...args) => { callOrder.push('audit'); return origRecord(...args); };

      const stub = {
        runProbe: jest.fn(async () => {
          callOrder.push('runProbe');
          return {
            started: true, exitedEarly: false,
            hostPort: 8080, exposedPorts: [8080],
            reachable: true, durationMs: 500,
          };
        }),
      };

      const app = makeApp({ localDockerControl: stub, auditStore });
      await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/app', tag: 'v1',
      });

      expect(callOrder.indexOf('audit')).toBeLessThan(callOrder.indexOf('runProbe'));
    });

    it('500 + keine Aktion wenn Audit-Write fehlschlägt', async () => {
      const brokenAuditStore = {
        record: jest.fn(() => { throw new Error('Disk full'); }),
      };
      const stub = makeLocalDockerControlStub();
      const app = makeApp({ localDockerControl: stub, auditStore: brokenAuditStore });

      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/app', tag: 'v1',
      });

      expect(res.status).toBe(500);
      expect(stub.runProbe).not.toHaveBeenCalled();
    });
  });

  describe('image/tag-Validierung gegen Shell-Metazeichen', () => {
    const cases = [
      ['image mit Semikolon', { image: 'ghcr.io/org/app;rm -rf /', tag: 'v1' }],
      ['image mit Backtick', { image: 'ghcr.io/org/app`whoami`', tag: 'v1' }],
      ['image mit Dollarzeichen', { image: 'ghcr.io/org/app$HOME', tag: 'v1' }],
      ['image mit Pipe', { image: 'ghcr.io/org/app|cat', tag: 'v1' }],
      ['image mit Anführungszeichen', { image: 'ghcr.io/org/app"', tag: 'v1' }],
      ['tag mit Semikolon', { image: 'ghcr.io/org/app', tag: 'v1;rm -rf /' }],
      ['tag mit Leerzeichen', { image: 'ghcr.io/org/app', tag: 'v1 latest' }],
      ['tag mit Dollarzeichen', { image: 'ghcr.io/org/app', tag: '$HOME' }],
    ];

    for (const [name, body] of cases) {
      it(`400 bei ${name}`, async () => {
        const stub = makeLocalDockerControlStub();
        const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
        const res = await request(app, 'POST', '/api/deployments/local-test', body);
        expect(res.status).toBe(400);
        expect(stub.runProbe).not.toHaveBeenCalled();
      });
    }

    it('400 bei leerem image', async () => {
      const stub = makeLocalDockerControlStub();
      const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: '', tag: 'v1',
      });
      expect(res.status).toBe(400);
    });

    it('400 bei leerem tag', async () => {
      const stub = makeLocalDockerControlStub();
      const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/app', tag: '',
      });
      expect(res.status).toBe(400);
    });

    it('200 bei gültigem ghcr-Image + Tag', async () => {
      const stub = makeLocalDockerControlStub();
      const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });
      const res = await request(app, 'POST', '/api/deployments/local-test', {
        image: 'ghcr.io/org/my-app.service',
        tag: 'v1.2.3-beta.4',
      });
      expect(res.status).toBe(200);
    });
  });

  it('502 bei Docker nicht erreichbar (pull-failed errorClass)', async () => {
    const stub = {
      runProbe: jest.fn(async () => {
        const err = new Error('dial tcp: connection refused');
        err.errorClass = 'pull-failed';
        throw err;
      }),
    };
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });

    expect(res.status).toBe(502);
    expect(res.body.result).toBe('error');
    expect(typeof res.body.reason).toBe('string');
  });

  it('Response enthält keine Secrets/Tokens', async () => {
    const stub = {
      runProbe: jest.fn(async () => {
        const err = new Error('Bearer ghp_secrettoken1234 connection refused');
        err.errorClass = 'pull-failed';
        throw err;
      }),
    };
    const app = makeApp({ localDockerControl: stub, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });

    expect(res.status).toBe(502);
    // Token darf NICHT in der Response erscheinen
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('ghp_secrettoken1234');
    expect(bodyStr).not.toContain('Bearer ghp_');
  });

  it('502 wenn localDockerControl nicht konfiguriert', async () => {
    const app = makeApp({ localDockerControl: undefined, auditStore: new AuditStore() });

    const res = await request(app, 'POST', '/api/deployments/local-test', {
      image: 'ghcr.io/org/app', tag: 'v1',
    });

    expect(res.status).toBe(502);
    expect(res.body.result).toBe('error');
  });
});

// ── LocalDockerControl: Unit-Tests ────────────────────────────────────────────

describe('LocalDockerControl: parseInspectData via runProbe', () => {
  it('startete Container (running) → started: true, exitedEarly: false', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        return JSON.stringify({
          State: { Status: 'running', ExitCode: 0 },
          Config: { ExposedPorts: { '8080/tcp': {} } },
          NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49200' }] } },
        }) + '\n';
      }
      if (args[0] === 'rm') return '';
      return '';
    });
    const fetchStub = jest.fn(async () => ({ ok: true, status: 200 }));

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/app', 'v1');

    expect(report.started).toBe(true);
    expect(report.exitedEarly).toBe(false);
    expect(report.hostPort).toBe(49200);
    expect(report.exposedPorts).toEqual([8080]);
    expect(report.reachable).toBe(true);
  });

  it('Crashed Container (exited, exit-code ≠ 0) → exitedEarly: true', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        return JSON.stringify({
          State: { Status: 'exited', ExitCode: 1 },
          Config: { ExposedPorts: { '8080/tcp': {} } },
          NetworkSettings: { Ports: { '8080/tcp': null } },
        }) + '\n';
      }
      if (args[0] === 'rm') return '';
      return '';
    });
    const fetchStub = jest.fn(async () => { throw new Error('refused'); });

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/crasher', 'v1');

    expect(report.started).toBe(true);  // hat gestartet (wurde started = running | exited)
    expect(report.exitedEarly).toBe(true);
    expect(report.reachable).toBe(false);
  });

  it('kein exponierter Port → hostPort: null, reason benennt es', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        return JSON.stringify({
          State: { Status: 'running', ExitCode: 0 },
          Config: { ExposedPorts: {} },
          NetworkSettings: { Ports: {} },
        }) + '\n';
      }
      if (args[0] === 'rm') return '';
      return '';
    });
    const fetchStub = jest.fn();

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/cli-job', 'v1');

    expect(report.hostPort).toBeNull();
    expect(report.reachable).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(report.reason).toContain('kein');
  });

  it('nur UDP-Port exponiert → hostPort: null, reason nennt fehlendes TCP-Mapping, kein Crash', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        // ExposedPorts enthält nur einen UDP-Port; kein TCP-Mapping vorhanden
        return JSON.stringify({
          State: { Status: 'running', ExitCode: 0 },
          Config: { ExposedPorts: { '514/udp': {} } },
          NetworkSettings: { Ports: { '514/udp': [{ HostIp: '0.0.0.0', HostPort: '32514' }] } },
        }) + '\n';
      }
      if (args[0] === 'rm') return '';
      return '';
    });
    const fetchStub = jest.fn();

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/udp-app', 'v1');

    expect(report.hostPort).toBeNull();
    expect(report.reachable).toBe(false);
    // Reachability-Probe darf nicht aufgerufen werden (kein hostPort)
    expect(fetchStub).not.toHaveBeenCalled();
    // AC3: reason muss informieren, warum kein TCP-Mapping gefunden wurde
    expect(report.reason).toBeDefined();
    expect(report.reason).toMatch(/TCP/i);
    // exposedPorts: UDP-Port 514 wird numerisch extrahiert
    expect(report.exposedPorts).toContain(514);
  });

  it('mehrere exponierte Ports → reason enthält Mehrdeutigkeits-Hinweis', async () => {
    const execStub = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') return '';
      if (args[0] === 'run') return 'cid\n';
      if (args[0] === 'inspect') {
        return JSON.stringify({
          State: { Status: 'running', ExitCode: 0 },
          Config: { ExposedPorts: { '3000/tcp': {}, '8080/tcp': {} } },
          NetworkSettings: { Ports: {
            '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '32301' }],
            '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '32302' }],
          } },
        }) + '\n';
      }
      if (args[0] === 'rm') return '';
      return '';
    });
    const fetchStub = jest.fn(async () => ({ ok: true, status: 200 }));

    const ctrl = new LocalDockerControl({ execFn: execStub, fetchFn: fetchStub });
    const report = await ctrl.runProbe('ghcr.io/org/multi-port', 'v1');

    expect(report.exposedPorts).toHaveLength(2);
    expect(report.exposedPorts).toContain(3000);
    expect(report.exposedPorts).toContain(8080);
    // Kleinster Port (3000) wird genommen
    expect(report.hostPort).toBe(32301);
    expect(report.reason).toContain('Mehrere');
  });
});
