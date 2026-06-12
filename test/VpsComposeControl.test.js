/**
 * VpsComposeControl.test.js — Unit-Tests für die Compose-Stack-Boundary (AC1–AC8).
 *
 * Covers:
 *   AC1  — VpsComposeControl ist die einzige Compose-Stack-Boundary via SSH; VpsDockerControl unverändert
 *   AC2  — SSH-Transport, Host-Key-Strategie (TOFU + Fingerprint-Match + Mismatch),
 *           Fehlerklassen, Connect-Timeout identisch zu VpsDockerControl
 *   AC3  — syncRepo(): clone falls nicht vorhanden, fetch+checkout+pull falls vorhanden; idempotent
 *   AC4  — git-Token erscheint nie in Remote-URL, Argv oder Response; stackName Path-Traversal-Schutz
 *   AC5  — composeUp(): docker compose -f … [--project-name] up -d; shell-escaped; kein Command-Injection
 *   AC6  — composeDown(): removeVolumes default false; --volumes nur bei explizitem true
 *   AC7  — composePs() → strukturierte Liste; psStack() → Container mit cloudflare.tunnel-hostname-Label
 *   AC8  — Kein SSH-Private-Key, kein git-Token in Response, Argv oder reason; stderr wird nicht weitergeleitet
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
import { VpsComposeControl } from '../src/deploy/VpsComposeControl.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-vps-compose-control-key-not-real';

// Dummy-PEM zur Laufzeit zusammensetzen — der literale BEGIN-Marker im Quelltext
// würde den gitleaks-Secret-Scan (Rule private-key) als False Positive auslösen.
const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const FAKE_PRIVATE_KEY = pemDummy('FAKEPRIVATEKEYDATA');
const FAKE_GIT_TOKEN = 'ghp_FAKE_GIT_TOKEN_FOR_TESTING_ONLY';

// VPS-Target für Tests
const TEST_VPS = { host: '10.0.0.1', port: 22, targetUser: 'root' };

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
  const dir = await mkdtemp(join(tmpdir(), 'vps-compose-ctrl-test-'));
  const store = new CredentialStore({ dir, masterKey: TEST_MASTER_KEY });
  return { store, dir };
}

// ── AC1: Konstruktor ───────────────────────────────────────────────────────────

describe('VpsComposeControl — AC1: Konstruktor', () => {
  it('wirft wenn kein CredentialStore übergeben wird', () => {
    expect(() => new VpsComposeControl(null)).toThrow(/credentialStore/i);
    expect(() => new VpsComposeControl(undefined)).toThrow(/credentialStore/i);
    expect(() => new VpsComposeControl({})).toThrow(/credentialStore/i);
  });

  it('initialisiert korrekt mit gültigem Store', () => {
    const fakeStore = { getPlaintext: () => {} };
    expect(() => new VpsComposeControl(fakeStore)).not.toThrow();
  });

  it('AC1 — VpsComposeControl hat die erwarteten Methoden (Compose-Boundary-Vertrag)', () => {
    const fakeStore = { getPlaintext: () => {} };
    const ctrl = new VpsComposeControl(fakeStore);
    expect(typeof ctrl.syncRepo).toBe('function');
    expect(typeof ctrl.composeUp).toBe('function');
    expect(typeof ctrl.composeDown).toBe('function');
    expect(typeof ctrl.composePs).toBe('function');
    expect(typeof ctrl.psStack).toBe('function');
  });
});

// ── AC2: SSH-Transport (analog VpsDockerControl) ────────────────────────────────

describe('VpsComposeControl — AC2: SSH-Transport + Host-Key', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('TOFU: kein hostFingerprint → Verbindung wird akzeptiert (result:ok)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);
    const fakeHostKey = Buffer.from('fake-host-key-bytes');

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0, fakeHostKey }),
    });

    expect(result.result).toBe('ok');
  });

  it('Fingerprint-Match: korrekte hostFingerprint → Verbindung akzeptiert (result:ok)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const fakeHostKey = Buffer.from('fake-host-key-for-match');
    const { createHash } = await import('node:crypto');
    const expectedFingerprint = createHash('sha256').update(fakeHostKey).digest('base64');

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      hostFingerprint: expectedFingerprint,
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0, fakeHostKey }),
    });

    expect(result.result).toBe('ok');
  });

  it('Fingerprint-Mismatch → errorClass:host-key-mismatch', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const fakeHostKey = Buffer.from('fake-host-key-for-mismatch');

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      hostFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0, fakeHostKey }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('host-key-mismatch');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });

  it('Fingerprint-Mismatch: reason enthält keinen Fingerprint-Wert', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      hostFingerprint: 'wrongfingerprint==',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        fakeHostKey: Buffer.from('sensitive-host-key-data'),
      }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('host-key-mismatch');
    expect(result.reason).not.toContain('wrongfingerprint');
    expect(result.reason).not.toContain('sensitive-host-key');
  });

  it('SSH unreachable (ECONNREFUSED) → errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
  });

  it('SSH Auth-Fehler → errorClass:auth-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const authErr = new Error('All configured authentication methods failed');

    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ connectError: authErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('kein Private-Key → errorClass:no-private-key, kein SSH-Aufruf', async () => {
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
    expect(sshCalled).toBe(false);
  });
});

// ── AC3: syncRepo() ────────────────────────────────────────────────────────────

describe('VpsComposeControl — AC3: syncRepo()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsComposeControl(store);
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC3 — syncRepo() sendet ein if-then-else-Kommando (clone vs pull)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    // Muss eine if/else-Logik enthalten (clone falls nicht vorhanden, sonst pull)
    expect(capturedCmd).toMatch(/if.*then.*else/s);
    expect(capturedCmd).toContain('git clone');
    expect(capturedCmd).toContain('pull --ff-only');
  });

  it('AC3 — syncRepo() enthält fetch + checkout + pull --ff-only für den pull-Pfad', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('fetch origin');
    expect(capturedCmd).toContain('checkout');
    expect(capturedCmd).toContain('pull --ff-only');
  });

  it('AC3 — syncRepo() enthält branch-Parameter im clone-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'feature-branch',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('feature-branch');
  });

  it('AC3 — syncRepo() verwendet ~/stacks/<stackName> als Zielverzeichnis', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('stacks');
    expect(capturedCmd).toContain('myapp');
  });

  it('docker exit 1 → result:error, errorClass:docker-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
  });
});

// ── AC4: Token-Sicherheit + Path-Traversal ─────────────────────────────────────

describe('VpsComposeControl — AC4: Token-Sicherheit + stackName-Validierung', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC4 — stackName mit .. → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: '../etc',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC4 — stackName mit Shell-Metazeichen → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp; rm -rf /',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC4 — stackName mit Slash → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp/evil',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('I1 — stackName > 64 Zeichen → result:error ohne SSH-Call (einheitliches Längenlimit)', async () => {
    // Nach I1 (Extraktion in stackValidation.js) gilt das 64-Zeichen-Limit auch in VpsComposeControl.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const longName = 'a'.repeat(65);
    let sshCalled = false;
    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: longName,
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC4/AC8 — git-Token erscheint NICHT im Kommando-String', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    await store.set('git/token', FAKE_GIT_TOKEN);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/private-app.git',
      branch: 'main',
      stackName: 'myapp',
      gitTokenRef: 'git/token',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // AC4: Token darf NICHT in der persistierten Remote-URL erscheinen (https://TOKEN@...)
    expect(capturedCmd).not.toContain(`https://${FAKE_GIT_TOKEN}@`);
    // AC8 (IMPORTANT 2 — direkter Assert): Token-Wert darf NICHT literal im Kommando-String stehen
    // (verhindert Leak via /proc/<pid>/cmdline und `ps` auf dem Remote-Host).
    expect(capturedCmd).not.toContain(FAKE_GIT_TOKEN);
  });

  it('AC3-Regression: mkdir -p ~/stacks enthält die Tilde NICHT in Single-Quotes', async () => {
    // Regression für CRITICAL-Tilde-Expansion-Bug:
    // shellEscape('~/stacks') → '\'~/stacks\'' — die Tilde wird von der Shell NICHT expandiert
    // und legt ein literales Verzeichnis relativ zum CWD an statt /root/stacks.
    // Der korrekte Fix: STACKS_BASE_DIR wird NICHT via shellEscape() in mkdir -p eingebettet.
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // mkdir -p muss die Tilde unquotiert enthalten (Shell-Expansion muss greifen)
    expect(capturedCmd).toContain('mkdir -p ~/stacks');
    // Die Tilde darf NICHT in Single-Quotes eingebettet sein (würde Expansion verhindern)
    expect(capturedCmd).not.toContain("mkdir -p '~/stacks'");
  });

  it('AC4/AC8 — Private-Key erscheint NICHT im syncRepo-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('AC4/AC8 — Private-Key erscheint NICHT im error-reason', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.syncRepo({
      vps: TEST_VPS,
      repoUrl: 'https://github.com/org/app.git',
      branch: 'main',
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });
});

// ── AC5: composeUp() ───────────────────────────────────────────────────────────

describe('VpsComposeControl — AC5: composeUp()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsComposeControl(store);
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC5 — composeUp() sendet docker compose -f … --project-name … up -d', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    expect(capturedCmd).toContain('docker compose');
    expect(capturedCmd).toContain('-f');
    expect(capturedCmd).toContain('docker-compose.yml');
    expect(capturedCmd).toContain('--project-name');
    expect(capturedCmd).toContain('myproject');
    expect(capturedCmd).toContain('up -d');
  });

  it('AC5 — composeUp() mit overrideFile sendet zwei -f-Argumente', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.override.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Beide Compose-Dateien müssen erscheinen
    expect(capturedCmd).toContain('docker-compose.yml');
    expect(capturedCmd).toContain('docker-compose.override.yml');
    // Zwei -f-Vorkommen
    const fCount = (capturedCmd.match(/-f /g) || []).length;
    expect(fCount).toBeGreaterThanOrEqual(2);
  });

  it('AC5 — Werte sind shell-escaped (Single-Quote-Muster)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Projektname muss in Single-Quotes erscheinen
    expect(capturedCmd).toContain("'myproject'");
  });

  it('AC5 — ungültiger stackName → result:error ohne SSH-Call (kein Command-Injection)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'app; rm -rf /',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC5 — composeFile mit .. → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: '../../../etc/docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC5 — overrideFile mit .. → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      overrideFile: '../override.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC5 — envFilePath mit absolutem Pfad → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      envFilePath: '/etc/secrets/.env',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC5 — ungültiger projectName → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'my project; evil',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC5/AC8 — Private-Key erscheint NICHT im composeUp-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('docker exit 1 → result:error, errorClass:docker-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ── AC6: composeDown() ─────────────────────────────────────────────────────────

describe('VpsComposeControl — AC6: composeDown()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsComposeControl(store);
    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC6 — composeDown() sendet docker compose --project-name … down', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    expect(capturedCmd).toContain('docker compose');
    expect(capturedCmd).toContain('--project-name');
    expect(capturedCmd).toContain('myproject');
    expect(capturedCmd).toContain('down');
  });

  it('AC6 — removeVolumes default false: --volumes NICHT im Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      // removeVolumes nicht gesetzt → default false
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain('--volumes');
  });

  it('AC6 — removeVolumes:false → --volumes NICHT im Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      removeVolumes: false,
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain('--volumes');
  });

  it('AC6 — removeVolumes:true → --volumes wird angehängt (Datenverlust-Schutz-Override)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      removeVolumes: true,
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).toContain('--volumes');
  });

  it('AC6/AC8 — Private-Key erscheint NICHT im composeDown-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('ungültiger stackName → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.composeDown({
      vps: TEST_VPS,
      stackName: '../etc',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });
});

// ── AC7: composePs() ───────────────────────────────────────────────────────────

describe('VpsComposeControl — AC7: composePs()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsComposeControl(store);
    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC7 — composePs() sendet docker compose --project-name … ps', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    expect(capturedCmd).toContain('docker compose');
    expect(capturedCmd).toContain('--project-name');
    expect(capturedCmd).toContain('myproject');
    expect(capturedCmd).toContain('ps');
  });

  it('AC7 — composePs() parst Ausgabe zu ComposePsEntry[]', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    // Mock-Output: tab-getrennte Felder: Name, Service, Status, Ports
    const mockOutput = [
      'myproject-web-1\tweb\trunning\t0.0.0.0:8080->80/tcp',
      'myproject-db-1\tdb\trunning\t',
    ].join('\n');

    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(2);
    expect(result.containers[0].name).toBe('myproject-web-1');
    expect(result.containers[0].service).toBe('web');
    expect(result.containers[0].status).toBe('running');
    expect(result.containers[0].ports).toBe('0.0.0.0:8080->80/tcp');
    expect(result.containers[1].name).toBe('myproject-db-1');
    expect(result.containers[1].service).toBe('db');
  });

  it('AC7 — composePs() gibt leere Liste zurück wenn Stack nicht läuft', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(0);
  });

  it('AC7 — composePs() Format-String ist shell-escaped (Single-Quotes)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Format-String muss in Single-Quotes erscheinen
    expect(capturedCmd).toContain("--format '{{.Name}}");
  });

  it('docker exit 1 → result:error, errorClass:docker-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
  });
});

// ── AC7: psStack() ─────────────────────────────────────────────────────────────

describe('VpsComposeControl — AC7: psStack()', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kein Private-Key → result:error, errorClass:no-private-key', async () => {
    const ctrl = new VpsComposeControl(store);
    const result = await ctrl.psStack({ vps: TEST_VPS, project: 'myproject' });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
  });

  it('AC7 — psStack() filtert auf com.docker.compose.project-Label', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(result.result).toBe('ok');
    expect(capturedCmd).toContain('com.docker.compose.project');
    expect(capturedCmd).toContain('myproject');
  });

  it('AC7 — psStack() parst Container mit cloudflare.tunnel-hostname-Label', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    // Format: ID, Image, Ports, Status, compose.service, cloudflare.tunnel-hostname
    const mockOutput = [
      'abc123def456\tghcr.io/org/web:latest\t0.0.0.0:8080->8080/tcp\tUp 2 hours\tweb\tapp.example.com',
      'bcd234ef5678\tpostgres:15\t\tUp 1 hour\tdb\t',
    ].join('\n');

    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: mockOutput, exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(2);

    // öffentlicher Service mit cloudflare.tunnel-hostname
    const webContainer = result.containers[0];
    expect(webContainer.containerId).toBe('abc123def456');
    expect(webContainer.image).toBe('ghcr.io/org/web:latest');
    expect(webContainer.service).toBe('web');
    expect(webContainer.hostname).toBe('app.example.com');
    expect(webContainer.hostPort).toBe(8080);

    // interner Service — hostname: null
    const dbContainer = result.containers[1];
    expect(dbContainer.containerId).toBe('bcd234ef5678');
    expect(dbContainer.service).toBe('db');
    expect(dbContainer.hostname).toBeNull();
    expect(dbContainer.hostPort).toBeNull();
  });

  it('AC7 — psStack() gibt leere Liste zurück wenn keine Stack-Container laufen', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 0 }),
    });

    expect(result.result).toBe('ok');
    expect(result.containers).toHaveLength(0);
  });

  it('AC7 — psStack() Format-String ist shell-escaped', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    // Format-String muss in Single-Quotes erscheinen
    expect(capturedCmd).toContain("--format '{{.ID}}");
    // cloudflare.tunnel-hostname-Label muss im Format-String enthalten sein
    expect(capturedCmd).toContain('cloudflare.tunnel-hostname');
  });

  it('ungültiger projectName → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'my project; evil',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC7/AC8 — Private-Key erscheint NICHT im psStack-Kommando', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let capturedCmd = null;
    await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({
        stdout: '',
        exitCode: 0,
        onCommand: (cmd) => { capturedCmd = cmd; },
      }),
    });

    expect(capturedCmd).not.toContain(FAKE_PRIVATE_KEY);
    expect(capturedCmd).not.toContain('FAKEPRIVATE');
  });

  it('docker exit 1 → result:error, errorClass:docker-failed, reason ohne Secret', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ stdout: '', exitCode: 1 }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ── AC8: Fehlerklassen-Mapping (analog VpsDockerControl) ──────────────────────

describe('VpsComposeControl — AC8: Fehlerklassen-Mapping + kein Geheim-Leak', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ETIMEDOUT → errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const connErr = new Error('ETIMEDOUT');
    connErr.code = 'ETIMEDOUT';

    const result = await ctrl.composeUp({
      vps: TEST_VPS,
      stackName: 'myapp',
      composeFile: 'docker-compose.yml',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('ECONNREFUSED → errorClass:unreachable', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.psStack({
      vps: TEST_VPS,
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
  });

  it('Auth-Fehler → errorClass:auth-failed, reason ohne Geheim-Leak', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const authErr = new Error('All configured authentication methods failed');

    const result = await ctrl.composePs({
      vps: TEST_VPS,
      stackName: 'myapp',
      project: 'myproject',
      _sshClientFactory: makeMockSshClient({ connectError: authErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });
});
