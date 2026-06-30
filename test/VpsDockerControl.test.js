/**
 * VpsDockerControl.test.js — Unit-Tests für die Docker-on-VPS-Boundary (ADR-012, AC1/AC2/AC9).
 *
 * Covers:
 *   AC1  — VpsDockerControl ist die einzige schreibende Docker-on-VPS-Boundary
 *   AC2  — run() setzt Label cloudflare.tunnel-hostname=<hostname> im docker run Kommando
 *   AC9  — Kein SSH-Private-Key in Argv/Log/Result; Fehlerpfade ohne Geheim-Leak
 *   AC13 (stack-deploy-orchestration) — psAll() liest com.docker.compose.project-Label;
 *         composeProject-Feld in PsEntry; interne Stack-Container haben hostname:null
 *   AC9  (vps-container-overview) — start/stop/restart/logs Methoden; Container-ID-Validierung;
 *         secret-freie Fehlerklassen
 *   AC1  (vps-readiness-gate) — probe() exponiert Bereitschafts-Probe als VpsDockerControl-Methode
 *   AC2  (vps-readiness-gate) — probe() führt genau eine SSH-Session mit kanonischem Befehl aus;
 *         READY→ready, NOTREADY→provisioning, connect-fail/auth-fail/timeout→unreachable,
 *         unerwartetes stdout→provisioning (nie fälschlich ready)
 *   AC3  (vps-readiness-gate) — kanonischer Befehl prüft boot-finished + docker info + cloudflared
 *   AC13 (vps-readiness-gate) — SSH-Key nie in Argv/Reason; probe() wirft NIE
 *   AC3  (vps-tunnel-self-heal S-187) — pushTunnelEnvFile: bash -s exec, Token via stdin (nie Argv);
 *         Token NIE in SSH-exec-Argv; SSH-Fehler → errorClass korrekt
 *   AC4  (vps-tunnel-self-heal S-187) — Token NIE in Argv des SSH-exec-Aufrufs (kein Token in cmd)
 *
 * Strategie:
 *   - CredentialStore mit tmpdir + injiziertem masterKey (echter Store für Boundary-Test)
 *   - SSH-Client durch _sshClientFactory gemockt (EventEmitter + exec/connect-Stubs)
 *   - Kein Netzwerk-I/O in keinem Test
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { CredentialStore } from '../src/CredentialStore.js';
import { VpsDockerControl } from '../src/deploy/VpsDockerControl.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-vps-docker-control-key-not-real';

// Dummy-PEM zur Laufzeit zusammensetzen — der literale BEGIN-Marker im Quelltext
// würde den gitleaks-Secret-Scan (Rule private-key) als False Positive auslösen.
const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const FAKE_PRIVATE_KEY = pemDummy('FAKEPRIVATEKEYDATA');

// VPS-Target für Tests
const TEST_VPS = { host: '1.2.3.4', port: 22, targetUser: 'root' };

// ── Mock-SSH-Client-Fabrik ─────────────────────────────────────────────────────

/**
 * Erstellt einen Mock-SSH-Client, der sofort `ready` emittiert und
 * ein exec-Kommando mit dem angegebenen stdout und exitCode ausführt.
 *
 * @param {object} opts
 * @param {string}  [opts.stdout]         - stdout des Remote-Kommandos
 * @param {number}  [opts.exitCode]       - exit code (Default: 0)
 * @param {Error}   [opts.connectError]   - wenn gesetzt: emit('error') statt 'ready'
 * @param {Buffer}  [opts.fakeHostKey]    - wenn gesetzt: hostVerifier wird mit diesem Key aufgerufen
 * @param {(cmd: string) => void} [opts.onCommand] - Callback zum Abfangen des Kommandos
 */
function makeMockSshClient({
  stdout = '',
  exitCode = 0,
  connectError = null,
  fakeHostKey = null,
  onCommand = null,
} = {}) {
  return () => {
    const client = new EventEmitter();

    client.connect = (config) => {
      if (connectError) {
        setTimeout(() => client.emit('error', connectError), 0);
        return;
      }
      // hostVerifier aufrufen (analog ssh2 — synchron vor ready)
      if (fakeHostKey && typeof config.hostVerifier === 'function') {
        const accepted = config.hostVerifier(fakeHostKey);
        if (!accepted) {
          // hostVerifier hat reject ausgelöst (via setTimeout intern) — kein ready
          return;
        }
      }
      setTimeout(() => client.emit('ready'), 0);
    };

    client.exec = (cmd, _opts, callback) => {
      if (onCommand) onCommand(cmd);

      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();

      setTimeout(() => callback(null, stream), 0);

      // Stream-Events nach kurzem Delay
      setTimeout(() => {
        if (stdout) stream.emit('data', stdout);
        setTimeout(() => stream.emit('close', exitCode), 0);
      }, 5);
    };

    client.end = () => {};

    return client;
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

async function makeTmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'vps-docker-ctrl-test-'));
  const store = new CredentialStore({ dir, masterKey: TEST_MASTER_KEY });
  return { store, dir };
}

// ── Konstruktor ────────────────────────────────────────────────────────────────

describe('VpsDockerControl — Konstruktor', () => {
  it('wirft wenn kein CredentialStore übergeben wird', () => {
    expect(() => new VpsDockerControl(null)).toThrow(/credentialStore/i);
    expect(() => new VpsDockerControl(undefined)).toThrow(/credentialStore/i);
    expect(() => new VpsDockerControl({})).toThrow(/credentialStore/i);
  });

  it('initialisiert korrekt mit gültigem Store', () => {
    const fakeStore = { getPlaintext: () => {} };
    expect(() => new VpsDockerControl(fakeStore)).not.toThrow();
  });
});

// ── pull() ─────────────────────────────────────────────────────────────────────

describe('VpsDockerControl — pull()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → errorClass:no-private-key, result:error', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
    // Kein Geheim-Leak
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('erfolgreicher Pull → result:ok', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
  });

  it('richtiger docker pull Befehl wird verwendet', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.pull(TEST_VPS, 'ghcr.io/org/app:v1.0', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toMatch(/docker pull/);
    expect(capturedCmd).toContain('ghcr.io/org/app:v1.0');
  });

  it('AC9 — Private-Key erscheint NICHT im Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('docker exit 1 → errorClass:docker-failed, result:error', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:notfound', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    // Kein Geheim-Leak
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('SSH unreachable → errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ── run() ─────────────────────────────────────────────────────────────────────

describe('VpsDockerControl — run() — AC2: Label-Konvention', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC2 — run() setzt Label cloudflare.tunnel-hostname=<hostname> im Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const hostname = 'app.example.com';

    let capturedCmd = null;
    await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', hostname, {
      _sshClientFactory: makeMockSshClient({
        stdout: 'abc123def456',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Der Befehl muss den Label-Key enthalten; der Wert ist shell-quoted
    expect(capturedCmd).toContain('cloudflare.tunnel-hostname=');
    expect(capturedCmd).toContain(hostname);
  });

  it('run() setzt --restart unless-stopped', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'abc123def456',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('--restart unless-stopped');
  });

  it('run() enthält Host-Port-Mapping', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      hostPort: 8082,
      containerPort: 3000,
      _sshClientFactory: makeMockSshClient({
        stdout: 'abc123def456',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('-p 8082:3000');
  });

  it('run() gibt containerId aus stdout zurück', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const fakeContainerId = 'abc123def456789012345';

    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({
        stdout: `${fakeContainerId}\n`,
        exitCode: 0,
      }),
    });

    expect(result.result).toBe('ok');
    expect(result.containerId).toBe(fakeContainerId);
  });

  it('run() gibt hostPort zurück', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      hostPort: 8090,
      _sshClientFactory: makeMockSshClient({ stdout: 'cid123', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.hostPort).toBe(8090);
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC9 — Private-Key erscheint NICHT im run()-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'cid123',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('docker exit 1 bei run → result:error, errorClass:docker-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('Hostname mit Single-Quote wird durch Validierung abgelehnt (kein Shell-Injection)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // Hostname mit Single-Quote: wird durch Hostname-Validierung (DNS-Zeichensatz) abgelehnt
    // bevor er in Shell-Kommandos eingebettet wird — kein Shell-Command-Injection möglich
    const hostnameWithQuote = "app.example.com'test";
    let sshCalled = false;

    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', hostnameWithQuote, {
      _sshClientFactory: makeMockSshClient({
        stdout: 'cid123',
        exitCode: 0,
        onCommand: () => { sshCalled = true; },
      }),
    });

    // Hostname mit ' wird als ungültig erkannt — kein SSH-Call, kein Shell-Injection
    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });
});

// ── rm() ─────────────────────────────────────────────────────────────────────

describe('VpsDockerControl — rm()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rm() sendet docker rm -f <containerId>', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const containerId = 'abc123def456';

    let capturedCmd = null;
    const result = await ctrl.rm(TEST_VPS, containerId, {
      _sshClientFactory: makeMockSshClient({
        stdout: containerId,
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    expect(capturedCmd).toContain('docker rm -f');
    expect(capturedCmd).toContain(containerId);
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.rm(TEST_VPS, 'abc123');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('ungültige Container-ID (Shell-Injection) → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let sshCalled = false;
    const result = await ctrl.rm(TEST_VPS, 'abc; rm -rf /', {
      _sshClientFactory: makeMockSshClient({
        onCommand: () => { sshCalled = true; },
      }),
    });

    expect(result.result).toBe('error');
    // SSH darf bei ungültiger ID nicht aufgerufen werden
    expect(sshCalled).toBe(false);
  });

  it('AC9 — Private-Key erscheint NICHT im rm()-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.rm(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'abc123def456',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('docker exit 1 bei rm → result:error', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.rm(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
  });
});

// ── ps() ─────────────────────────────────────────────────────────────────────

describe('VpsDockerControl — ps()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ps() gibt Container mit cloudflare.tunnel-hostname-Label zurück', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // docker ps --format '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "cloudflare.tunnel-hostname"}}'
    const mockOutput = [
      'abc123def456\tghcr.io/org/app:latest\t0.0.0.0:8080->8080/tcp\tUp 2 hours\tapp.example.com',
      'bcd234ef5678\tghcr.io/org/other:v2\t0.0.0.0:8081->8080/tcp\tUp 1 hour\tother.example.com',
    ].join('\n');

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(2);
    expect(result.containers[0].containerId).toBe('abc123def456');
    expect(result.containers[0].hostname).toBe('app.example.com');
    expect(result.containers[0].image).toBe('ghcr.io/org/app:latest');
    expect(result.containers[0].hostPort).toBe(8080);
  });

  it('ps() gibt leere Liste zurück wenn keine managed Container laufen', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(0);
  });

  it('ps() filtert auf label=cloudflare.tunnel-hostname im Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('label=cloudflare.tunnel-hostname');
  });

  it('ps() Format-String ist shell-escaped (Single-Quotes, Tabs+Quotes geschützt)', async () => {
    // Regression-Guard: Format-String muss shellEscape()-gequotet sein — nackter String mit
    // echten Tabs würde per IFS-Split in der Remote-POSIX-Shell zerfallen; nacktes " bricht
    // striktes Quoting. Audit-First liegt beim Orchestrator (DeployOrchestrator), nicht hier.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Das --format-Argument muss in Single-Quotes eingebettet sein, damit Tabs (\t)
    // nicht als IFS-Trennzeichen und " nicht als Quote-Begrenzer wirken.
    expect(capturedCmd).toContain("--format '{{.ID}}");
    // Die Tabs müssen innerhalb der Single-Quotes liegen (kein IFS-Split durch POSIX-Shell)
    expect(capturedCmd).toMatch(/--format '.*\t.*'/);
    // Das Double-Quote um cloudflare.tunnel-hostname muss ebenfalls innerhalb Single-Quotes liegen
    expect(capturedCmd).toMatch(/--format '.*"cloudflare\.tunnel-hostname".*'/);
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.ps(TEST_VPS);
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('SSH-Fehler → result:error, errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = new Error('ETIMEDOUT');
    connErr.code = 'ETIMEDOUT';

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('AC9 — Private-Key erscheint NICHT im ps()-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('ps() extrahiert hostPort korrekt aus Port-Mapping', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const mockOutput = 'def789abc012\tghcr.io/org/svc:v3\t0.0.0.0:9000->8080/tcp\tUp 30 min\tsvc.example.com';

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers[0].hostPort).toBe(9000);
  });

  it('ps() gibt hostPort:null wenn kein Port-Mapping vorhanden', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const mockOutput = 'def789abc012\tghcr.io/org/svc:v3\t\tUp 30 min\tsvc.example.com';

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers[0].hostPort).toBeNull();
  });

  it('ps() gibt composeProject:null für jeden Container (PsEntry-Typedef-Konformität)', async () => {
    // Typ-Contract: PsEntry.composeProject ist string|null (nie undefined).
    // ps() fragt das com.docker.compose.project-Label nicht ab — Feld muss explizit null sein.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const mockOutput = 'abc123def456\tghcr.io/org/app:latest\t0.0.0.0:8080->8080/tcp\tUp 2 hours\tapp.example.com';

    const result = await ctrl.ps(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(1);
    // composeProject muss null sein (nicht undefined) — Typedef string|null ist eingehalten
    expect(result.containers[0].composeProject).toBeNull();
    expect('composeProject' in result.containers[0]).toBe(true);
  });
});

// ── psAll() — stack-aware (AC13) ─────────────────────────────────────────────
// psAll() reads ALL containers including com.docker.compose.project label.
// Public stack containers (with cloudflare.tunnel-hostname) get hostname set.
// Internal stack containers (no cloudflare.tunnel-hostname) get hostname: null.

describe('VpsDockerControl — psAll() — stack-aware (AC13)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC13 — psAll() Format-String enthält com.docker.compose.project-Label', async () => {
    // The psAll() command must include the com.docker.compose.project label in its format string
    // so that ReconciliationJob can use it for stack-aware reconciliation.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('com.docker.compose.project');
  });

  it('AC13 — psAll() gibt composeProject-Feld für Stack-Container zurück', async () => {
    // A public stack container: both cloudflare.tunnel-hostname and com.docker.compose.project set.
    // Format (I1): ID\tNames\tImage\tPorts\tStatus\tcloudflare.tunnel-hostname\tcom.docker.compose.project
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const mockOutput = 'abc123def\tmyapp_web_1\tmyapp/web:latest\t0.0.0.0:8080->8080/tcp\tUp 2h\tweb.example.com\tmyapp';

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(1);
    const c = result.containers[0];
    expect(c.containerId).toBe('abc123def');
    expect(c.name).toBe('myapp_web_1');          // I1: lesbarer Container-Name
    expect(c.hostname).toBe('web.example.com'); // public container → hostname set
    expect(c.composeProject).toBe('myapp');      // stack container → composeProject set
    expect(c.hostPort).toBe(8080);
  });

  it('AC13 — psAll() gibt hostname:null und composeProject für interne Stack-Container', async () => {
    // Internal stack container: NO cloudflare.tunnel-hostname, but has com.docker.compose.project.
    // hostname must be null (→ reportedUnmanaged in ReconciliationJob, never routed).
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // Format (I1): ID\tNames\tImage\tPorts\tStatus\t(empty cf label)\tcom.docker.compose.project
    const mockOutput = 'db-xyz-001\tmyapp_db_1\tpostgres:15\t\tUp 5h\t\tmyapp';

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(1);
    const c = result.containers[0];
    expect(c.containerId).toBe('db-xyz-001');
    expect(c.name).toBe('myapp_db_1');      // I1: Container-Name
    expect(c.hostname).toBeNull();           // no cloudflare.tunnel-hostname → internal
    expect(c.composeProject).toBe('myapp'); // stack container
  });

  it('AC13 — psAll() gibt composeProject:null für Non-Stack-Container (Single-Image)', async () => {
    // Single-image (non-compose) container: has cloudflare.tunnel-hostname but no compose project.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // Format (I1): ID\tNames\tImage\tPorts\tStatus\tcloudflare.tunnel-hostname\t(empty compose label)
    const mockOutput = 'single-abc\tmy-app\tghcr.io/org/app:v1\t0.0.0.0:8080->8080/tcp\tUp 3h\tapp.example.com\t';

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    const c = result.containers[0];
    expect(c.name).toBe('my-app');               // I1: Container-Name
    expect(c.hostname).toBe('app.example.com'); // managed (single-image)
    expect(c.composeProject).toBeNull();         // not a stack container
  });

  it('AC13 — psAll() verarbeitet Mix aus Single-Image und Stack-Containern korrekt', async () => {
    // Mixed output: one single-image (managed), one stack-public, one stack-internal.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const mockOutput = [
      // Single-image: hostname set, no compose project; Format: ID\tNames\tImage\tPorts\tStatus\tCF\tCompose
      'single-abc\tmy-app\tghcr.io/org/app:v1\t0.0.0.0:8080->8080/tcp\tUp 3h\tapp.example.com\t',
      // Stack-public: hostname set, compose project set
      'web-def\tmyapp_web_1\tmyapp/web:latest\t0.0.0.0:8081->8080/tcp\tUp 2h\tweb.example.com\tmyapp',
      // Stack-internal: no hostname, compose project set
      'db-ghi\tmyapp_db_1\tpostgres:15\t\tUp 5h\t\tmyapp',
    ].join('\n');

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(3);

    const singleImg = result.containers.find((c) => c.containerId === 'single-abc');
    expect(singleImg.hostname).toBe('app.example.com');
    expect(singleImg.composeProject).toBeNull();

    const stackPublic = result.containers.find((c) => c.containerId === 'web-def');
    expect(stackPublic.hostname).toBe('web.example.com');
    expect(stackPublic.composeProject).toBe('myapp');

    const stackInternal = result.containers.find((c) => c.containerId === 'db-ghi');
    expect(stackInternal.hostname).toBeNull();
    expect(stackInternal.composeProject).toBe('myapp');
  });

  it('AC13 — psAll() kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.psAll(TEST_VPS);
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('I1 — psAll() Format-String enthält {{.Names}} und name-Feld in PsEntry', async () => {
    // psAll() muss {{.Names}} im Format-String haben und das name-Feld in PsEntry füllen.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    // Format (I1): ID\tNames\tImage\tPorts\tStatus\tCF-Label\tCompose-Label
    const mockOutput = 'abc123def\tmy-app-name\tghcr.io/org/app:v1\t0.0.0.0:8080->8080/tcp\tUp 1h\tapp.example.com\t';

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: mockOutput,
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Format-String muss {{.Names}} enthalten
    expect(capturedCmd).toContain('{{.Names}}');

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(1);
    const c = result.containers[0];
    expect(c.containerId).toBe('abc123def');
    expect(c.name).toBe('my-app-name'); // I1: lesbarer Container-Name
    expect(c.hostname).toBe('app.example.com');
    expect(c.hostPort).toBe(8080);
  });

  it('I1 — psAll() name-Feld ist undefined wenn Names-Spalte leer ist', async () => {
    // Leere Names-Spalte → kein name-Feld in PsEntry (Fallback auf containerId im Router)
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // Format: ID\t(leer)\tImage\tPorts\tStatus\tCF-Label\tCompose-Label
    const mockOutput = 'abc123def\t\tghcr.io/org/app:v1\t\tUp 1h\t\t';

    const result = await ctrl.psAll(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(1);
    const c = result.containers[0];
    // name-Feld ist nicht gesetzt (undefined) wenn leer
    expect(c.name).toBeUndefined();
  });
});

// ── Fehlerklassen ─────────────────────────────────────────────────────────────

describe('VpsDockerControl — Fehlerklassen-Mapping', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Auth-Fehler → errorClass:auth-failed, reason ohne Geheim-Leak', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const authErr = new Error('All configured authentication methods failed');

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({ connectError: authErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });

  it('ECONNREFUSED → errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.rm(TEST_VPS, 'abc123', {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
  });
});

// ── hostVerifier — TOFU + Mismatch ────────────────────────────────────────────

describe('VpsDockerControl — hostVerifier (ADR-008-Linie)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('TOFU: kein hostFingerprint → Verbindung wird akzeptiert (result:ok)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // fakeHostKey simuliert den Host-Key-Buffer, den ssh2 an hostVerifier übergibt
    const fakeHostKey = Buffer.from('fake-host-key-bytes');

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        fakeHostKey,
      }),
      // kein hostFingerprint → TOFU
    });

    expect(result.result).toBe('ok');
  });

  it('Fingerprint-Match: korrekte hostFingerprint → Verbindung wird akzeptiert (result:ok)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const fakeHostKey = Buffer.from('fake-host-key-for-match');
    // SHA-256 des fakeHostKey berechnen (Base64 ohne Prefix — wie VpsProvisioner)
    const { createHash } = await import('node:crypto');
    const expectedFingerprint = createHash('sha256').update(fakeHostKey).digest('base64');

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        fakeHostKey,
      }),
      hostFingerprint: expectedFingerprint,
    });

    expect(result.result).toBe('ok');
  });

  it('Fingerprint-Mismatch: falscher hostFingerprint → errorClass:host-key-mismatch', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const fakeHostKey = Buffer.from('fake-host-key-for-mismatch');

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        fakeHostKey,
      }),
      hostFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', // falscher Fingerprint
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('host-key-mismatch');
    // Kein Geheim-Leak im reason
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });

  it('Fingerprint-Mismatch: reason enthält keinen Host-Key-Hash (kein Geheim-Leak)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const fakeHostKey = Buffer.from('sensitive-host-key-data');

    const result = await ctrl.pull(TEST_VPS, 'ghcr.io/org/image:latest', {
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        fakeHostKey,
      }),
      hostFingerprint: 'wrongfingerprint==',
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('host-key-mismatch');
    // Fingerprint darf NICHT im reason erscheinen
    expect(result.reason).not.toContain('wrongfingerprint');
    expect(result.reason).not.toContain('sensitive-host-key');
  });
});

// ── run() — Hostname-Validierung ──────────────────────────────────────────────

describe('VpsDockerControl — run() — Hostname-Validierung (I2)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ungültiger Hostname (Semikolon) → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let sshCalled = false;
    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com; rm -rf /', {
      _sshClientFactory: makeMockSshClient({
        onCommand: () => { sshCalled = true; },
      }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('ungültiger Hostname (Leerzeichen) → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let sshCalled = false;
    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'bad hostname', {
      _sshClientFactory: makeMockSshClient({
        onCommand: () => { sshCalled = true; },
      }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('gültiger Hostname (DNS-Zeichen) → Verbindung wird aufgebaut', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({ stdout: 'cid123', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
  });

  it('Label KEY=VALUE-Block ist als eine Shell-Einheit gequotet', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.run(TEST_VPS, 'ghcr.io/org/app:latest', 'app.example.com', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'cid123',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Der gesamte KEY=VALUE-Block muss als Single-Quote-Einheit erscheinen
    expect(capturedCmd).toContain("'cloudflare.tunnel-hostname=app.example.com'");
  });
});

// ── AC13: inspect() — ExposedPorts via docker inspect ─────────────────────────

describe('VpsDockerControl.inspect() — AC13', () => {
  let store, dir;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gibt result:ok + ports-Array zurück wenn docker inspect JSON-Objekt liefert', async () => {
    const inspectOutput = JSON.stringify({ '3000/tcp': {}, '8080/tcp': {} });
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({ stdout: inspectOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.ports).toEqual(expect.arrayContaining(['3000/tcp', '8080/tcp']));
    expect(result.ports.length).toBe(2);
  });

  it('gibt result:ok + leeres ports-Array zurück wenn ExposedPorts null (kein Port exponiert)', async () => {
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({ stdout: 'null', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.ports).toEqual([]);
  });

  it('gibt result:ok + leeres ports-Array zurück wenn stdout kein valides JSON ist', async () => {
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({ stdout: 'not-json', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.ports).toEqual([]);
  });

  it('gibt result:ok + leeres ports-Array zurück wenn stdout leer ist', async () => {
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.ports).toEqual([]);
  });

  it('inspect-Kommando enthält docker inspect --format mit dem Image-Pfad', async () => {
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;

    await ctrl.inspect(TEST_VPS, 'ghcr.io/org/my-app:v2', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'null',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('docker inspect');
    expect(capturedCmd).toContain('ExposedPorts');
    expect(capturedCmd).toContain('ghcr.io/org/my-app:v2');
  });

  it('gibt result:error zurück wenn SSH-Verbindung fehlschlägt', async () => {
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({
        connectError: new Error('Connection refused'),
      }),
    });

    expect(result.result).toBe('error');
    expect(result.ports).toEqual([]);
  });

  it('gibt result:error zurück wenn kein Private Key in Store vorhanden', async () => {
    const { store: emptyStore, dir: emptyDir } = await makeTmpStore();
    const ctrl = new VpsDockerControl(emptyStore);

    const result = await ctrl.inspect(TEST_VPS, 'ghcr.io/org/app:v1', {
      _sshClientFactory: makeMockSshClient({ stdout: 'null', exitCode: 0 }),
    });

    await rm(emptyDir, { recursive: true, force: true });

    expect(result.result).toBe('error');
    expect(result.ports).toEqual([]);
  });
});

// ── AC9 (vps-container-overview): start() ─────────────────────────────────────

describe('VpsDockerControl — start() (AC9, vps-container-overview)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.start(TEST_VPS, 'abc123');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('ungültige containerId → errorClass:error ohne SSH-Verbindung', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let sshCalled = false;
    const result = await ctrl.start(TEST_VPS, 'abc; rm -rf /', {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0, onCommand: () => { sshCalled = true; } }),
    });
    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false); // SSH wird nicht aufgerufen bei ungültiger ID
  });

  it('erfolgreicher start → result:ok', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.start(TEST_VPS, 'abc123', {
      _sshClientFactory: makeMockSshClient({ stdout: 'abc123\n', exitCode: 0 }),
    });
    expect(result.result).toBe('ok');
  });

  it('führt docker start mit containerId aus', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;
    await ctrl.start(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({
        stdout: '', exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });
    expect(capturedCmd).toMatch(/docker start/);
    expect(capturedCmd).toContain('abc123def456');
    // Kein Private-Key im Kommando (AC13)
    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('SSH-Fehler → errorClass:unreachable, kein Geheim-Leak', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';
    const result = await ctrl.start(TEST_VPS, 'abc123', {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ── AC9 (vps-container-overview): stop() ──────────────────────────────────────

describe('VpsDockerControl — stop() (AC9, vps-container-overview)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.stop(TEST_VPS, 'abc123');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('ungültige containerId → error ohne SSH', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let sshCalled = false;
    const result = await ctrl.stop(TEST_VPS, '../etc/passwd', {
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });
    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('erfolgreicher stop → result:ok, Kommando enthält docker stop', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;
    const result = await ctrl.stop(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({
        stdout: '', exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });
    expect(result.result).toBe('ok');
    expect(capturedCmd).toMatch(/docker stop/);
    expect(capturedCmd).toContain('abc123def456');
  });
});

// ── AC9 (vps-container-overview): restart() ───────────────────────────────────

describe('VpsDockerControl — restart() (AC9, vps-container-overview)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.restart(TEST_VPS, 'abc123');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('erfolgreicher restart → result:ok, Kommando enthält docker restart', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;
    const result = await ctrl.restart(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({
        stdout: '', exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });
    expect(result.result).toBe('ok');
    expect(capturedCmd).toMatch(/docker restart/);
    expect(capturedCmd).toContain('abc123def456');
    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY); // kein Secret-Leak
  });
});

// ── AC9 (vps-container-overview): logs() ──────────────────────────────────────

describe('VpsDockerControl — logs() (AC9, vps-container-overview)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.logs(TEST_VPS, 'abc123');
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('ungültige containerId → error ohne SSH', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let sshCalled = false;
    const result = await ctrl.logs(TEST_VPS, 'abc; rm -rf /', {
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });
    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('liefert Log-Zeilen als Array', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.logs(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({
        stdout: 'line1\nline2\nline3\n', exitCode: 0,
      }),
    });
    expect(result.result).toBe('ok');
    expect(result.lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('führt docker logs --tail mit korrektem Wert aus', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;
    await ctrl.logs(TEST_VPS, 'abc123def456', {
      tail: 50,
      _sshClientFactory: makeMockSshClient({
        stdout: '', exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });
    expect(capturedCmd).toContain('docker logs');
    expect(capturedCmd).toContain('--tail 50');
    expect(capturedCmd).toContain('abc123def456');
    // Private-Key NICHT im Kommando (AC13)
    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('tail wird auf 1000 begrenzt (kein unkontrolliertes Lesen)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    let capturedCmd = null;
    await ctrl.logs(TEST_VPS, 'abc123def456', {
      tail: 9999,
      _sshClientFactory: makeMockSshClient({
        stdout: '', exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });
    // Erwartet: --tail 1000 (Maximum), nicht 9999
    expect(capturedCmd).toContain('--tail 1000');
    expect(capturedCmd).not.toContain('9999');
  });

  it('Fehler-Antwort enthält keinen Private-Key (AC13)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);
    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';
    const result = await ctrl.logs(TEST_VPS, 'abc123def456', {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });
    expect(result.result).toBe('error');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ── AC1/AC2/AC3/AC13 (vps-readiness-gate): probe() ──────────────────────────

describe('VpsDockerControl — probe() (vps-readiness-gate AC1/AC2/AC3/AC13)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── AC2: stdout READY → state:ready ──────────────────────────────────────

  it('AC2 — stdout READY → state:ready', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: 'READY\n', exitCode: 0 }),
    });

    expect(result.state).toBe('ready');
    expect(result.reason).toBeUndefined();
  });

  it('AC2 — stdout READY (mit Whitespace) → state:ready (trim)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: '  READY  \n', exitCode: 0 }),
    });

    expect(result.state).toBe('ready');
  });

  // ── AC2: stdout NOTREADY → state:provisioning ─────────────────────────────

  it('AC2 — stdout NOTREADY → state:provisioning', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: 'NOTREADY\n', exitCode: 0 }),
    });

    expect(result.state).toBe('provisioning');
  });

  // ── AC2: unerwartetes stdout → provisioning (nie fälschlich ready) ─────────

  it('AC2 — unerwartetes stdout → state:provisioning (konservativ, nie ready)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: 'some unexpected output\n', exitCode: 0 }),
    });

    expect(result.state).toBe('provisioning');
  });

  it('AC2 — leeres stdout → state:provisioning (nie fälschlich ready)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.state).toBe('provisioning');
  });

  // ── AC2: Connect-Fehler → state:unreachable ───────────────────────────────

  it('AC2 — Connect-Fehler (ECONNREFUSED) → state:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.state).toBe('unreachable');
  });

  it('AC2 — Connect-Timeout (ETIMEDOUT) → state:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const timeoutErr = new Error('ETIMEDOUT');
    timeoutErr.code = 'ETIMEDOUT';

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: timeoutErr }),
    });

    expect(result.state).toBe('unreachable');
  });

  it('AC2 — Auth-Fehler → state:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const authErr = new Error('All configured authentication methods failed');

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: authErr }),
    });

    expect(result.state).toBe('unreachable');
  });

  it('AC2 — Host-nicht-erreichbar (EHOSTUNREACH) → state:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const hostErr = new Error('No route to host');
    hostErr.code = 'EHOSTUNREACH';

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: hostErr }),
    });

    expect(result.state).toBe('unreachable');
  });

  // ── AC3: kanonischer Befehl wird verwendet ────────────────────────────────

  it('AC3 — probe() verwendet genau den kanonischen Befehl (boot-finished + docker info + cloudflared)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: 'READY',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Kanonischer Befehl (Spec §2) muss enthalten:
    expect(capturedCmd).toContain('/var/lib/cloud/instance/boot-finished');
    expect(capturedCmd).toContain('docker info');
    expect(capturedCmd).toContain('/dev/null');
    expect(capturedCmd).toContain('cloudflared');
    expect(capturedCmd).toContain('echo READY');
    expect(capturedCmd).toContain('echo NOTREADY');
  });

  it('AC2 — probe() öffnet genau EINE SSH-Session (kein zweiter SSH-Aufruf)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let connectCount = 0;
    const factory = () => {
      const base = makeMockSshClient({ stdout: 'READY', exitCode: 0 })();
      const origConnect = base.connect.bind(base);
      base.connect = (cfg) => { connectCount++; origConnect(cfg); };
      return base;
    };

    await ctrl.probe(TEST_VPS, { _sshClientFactory: () => factory() });

    expect(connectCount).toBe(1);
  });

  // ── AC13/Security: kein Private-Key in Argv/Reason ───────────────────────

  it('AC13 — Private-Key erscheint NICHT im probe()-Kommando (Argv)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({
        stdout: 'READY',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('AC13 — probe()-Fehler-reason enthält keinen Private-Key (kein Secret-Leak)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });

  it('AC13 — probe() wirft NIE (kein Private-Key → unreachable statt Throw)', async () => {
    // Kein Key im Store → probe() gibt unreachable zurück (wirft nicht)
    const ctrl = new VpsDockerControl(store); // leerer Store
    const result = await ctrl.probe(TEST_VPS);
    expect(result.state).toBe('unreachable');
    expect(result).toHaveProperty('state');
  });

  it('AC13 — probe() reason enthält keinen Host, kein Token (nur neutrale Meldung)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: 'NOTREADY', exitCode: 0 }),
    });

    expect(result.state).toBe('provisioning');
    // reason darf Host-IP nicht enthalten
    if (result.reason) {
      expect(result.reason).not.toContain('1.2.3.4');
      expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    }
  });

  // ── AC2: Docker-Info-Fehler erzeugt kein DOCKER_FAILED / keinen state:error ─

  it('AC2 — docker info exit != 0 (aber /dev/null-umgeleitet) → provisioning, kein DOCKER_FAILED', async () => {
    // Der Probe-Befehl hat >/dev/null 2>&1 für docker info; das bedeutet exit 0 des Befehls
    // und stdout NOTREADY. Dieser Test bestätigt, dass ein exit-Code 0 mit NOTREADY-stdout
    // zu provisioning führt (nicht zu einem Fehler-State).
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    // Simuliert: cloud-init fertig, docker info fehlgeschlagen (exit 0 des Skripts = NOTREADY)
    const result = await ctrl.probe(TEST_VPS, {
      _sshClientFactory: makeMockSshClient({ stdout: 'NOTREADY\n', exitCode: 0 }),
    });

    expect(result.state).toBe('provisioning');
    // KEIN error-state, kein DOCKER_FAILED (AC2)
    expect(result.state).not.toBe('error');
  });
});

// ── pushTunnelEnvFile() (S-187 AC3/AC4) ───────────────────────────────────────

/**
 * Mock-SSH-Client für stdin-basierte Kommandos (bash -s).
 * Simuliert: exec('bash -s') → stream mit stdin + sofortiger close(0).
 * Token wird VIA stdin.write() übergeben und erfasst.
 */
function makeMockSshClientWithStdin({
  exitCode = 0,
  connectError = null,
  onCommand = null,
  onStdinWrite = null,
} = {}) {
  return () => {
    const client = new EventEmitter();

    client.connect = (_config) => {
      if (connectError) {
        setTimeout(() => client.emit('error', connectError), 0);
        return;
      }
      setTimeout(() => client.emit('ready'), 0);
    };

    client.exec = (cmd, _opts, callback) => {
      if (onCommand) onCommand(cmd);

      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();

      // stdin: Token fließt via stdin.write() — NIE via exec-Argv
      let stdinContent = '';
      stream.stdin = {
        write: (data) => {
          stdinContent += String(data);
          if (onStdinWrite) onStdinWrite(stdinContent);
        },
        end: () => {
          setTimeout(() => {
            stream.emit('close', exitCode);
          }, 5);
        },
      };

      setTimeout(() => callback(null, stream), 0);
    };

    client.end = () => {};

    return client;
  };
}

describe('VpsDockerControl — pushTunnelEnvFile() (S-187 AC3/AC4)', () => {
  const FAKE_TUNNEL_TOKEN = 'eyJhbGciOiJFZERTQSJ9.TUNNEL_SECRET.signature';
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC3: kein Private-Key → errorClass:no-private-key', async () => {
    const ctrl = new VpsDockerControl(store);
    const result = await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN);
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC3: erfolgreich → result:ok', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN, {
      _sshClientFactory: makeMockSshClientWithStdin({ exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
  });

  it('AC4 (HART): Token NIE in SSH-exec-Argv — exec-Kommando ist nur "bash -s"', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedCmd = null;
    await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN, {
      _sshClientFactory: makeMockSshClientWithStdin({
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // AC4 HART: Token NIE im exec-Argv
    expect(capturedCmd).toBeDefined();
    expect(capturedCmd).not.toContain(FAKE_TUNNEL_TOKEN);
    // exec-Kommando muss "bash -s" sein (stdin-Muster)
    expect(capturedCmd).toBe('bash -s');
  });

  it('AC4 (HART): Token fließt via stdin.write() — capturedStdin enthält Token', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    let capturedStdin = '';
    await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN, {
      _sshClientFactory: makeMockSshClientWithStdin({
        exitCode: 0,
        onStdinWrite: (content) => { capturedStdin = content; },
      }),
    });

    // Token kommt via stdin (Dateiinhalt), nicht via Argv
    expect(capturedStdin).toContain(FAKE_TUNNEL_TOKEN);
    // stdin enthält TUNNEL_TOKEN= Zuweisung (env-file Format)
    expect(capturedStdin).toContain('TUNNEL_TOKEN=');
    // cloudflared wird NEU ERSTELLT (rm + run --env-file), NICHT `docker restart`
    // — `docker restart` würde die neue env-file nicht neu einlesen.
    expect(capturedStdin).not.toContain('docker restart cloudflared');
    expect(capturedStdin).toContain('docker rm -f cloudflared');
    expect(capturedStdin).toContain('docker run -d --name cloudflared');
    expect(capturedStdin).toContain('--env-file /etc/cloudflared/env');
    // Token-Floor: das Token steht NUR in der env-file-Zuweisung (printf), NICHT im docker-run-Argv
    const runLine = capturedStdin.split('\n').find((l) => l.includes('docker run'));
    expect(runLine).toBeDefined();
    expect(runLine).not.toContain(FAKE_TUNNEL_TOKEN);
  });

  it('AC3: SSH-Fehler (connectError) → errorClass:unreachable, result:error', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const connErr = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
    const result = await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN, {
      _sshClientFactory: makeMockSshClientWithStdin({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    // Security-Floor: kein Token im reason
    expect(result.reason).not.toContain(FAKE_TUNNEL_TOKEN);
  });

  it('AC3: Skript-Exit != 0 → errorClass:docker-failed, kein Token in reason', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsDockerControl(store);

    const result = await ctrl.pushTunnelEnvFile(TEST_VPS, FAKE_TUNNEL_TOKEN, {
      _sshClientFactory: makeMockSshClientWithStdin({ exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    // Security-Floor: Token nie im reason (AC4)
    expect(result.reason).not.toContain(FAKE_TUNNEL_TOKEN);
  });
});
