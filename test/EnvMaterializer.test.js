/**
 * EnvMaterializer.test.js — Unit-Tests für VpsComposeControl.ensureEnv()
 *
 * Spec:    stack-deploy-orchestration
 * Covers:
 *   AC3 — Erst-Deploy: .env existiert nicht → Generier-Skript auf VPS ausführen;
 *          generierte Werte NIE in Response/Audit/Log/WS; Audit-Eintrag nur Schlüsselnamen.
 *   AC4 — Re-Deploy: .env existiert → nicht überschreiben, nicht neu generieren;
 *          bestehende .env bleibt byte-identisch (keine Write-Kommandos an .env).
 *   AC5 — Fehlender required-Key: klarer, wertfreier Fehler (Schlüsselname, kein Wert);
 *          Schlüssel-Existenz-Prüfung nur über grep -oE (nur KEY=, nie Wert).
 *
 * Strategie:
 *   - CredentialStore mit tmpdir + injiziertem masterKey (echter Store für Boundary-Test)
 *   - SSH-Client durch _sshClientFactory gemockt (EventEmitter + exec/connect-Stubs)
 *   - Kein Netzwerk-I/O in keinem Test
 *   - Beweist Secret-Leak-Freiheit: kein Wert in capturedCmds, results, generatedKeys, reason
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { CredentialStore } from '../src/CredentialStore.js';
import { VpsComposeControl } from '../src/deploy/VpsComposeControl.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-env-materializer-key-not-real';

const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const FAKE_PRIVATE_KEY = pemDummy('FAKEPRIVATEKEYDATA_ENVMAT');

// VPS-Target für Tests
const TEST_VPS = { host: '10.0.0.2', port: 22, targetUser: 'root' };

// Beispiel-Secret-Wert — darf NIEMALS in Kommandos / Ergebnissen auftauchen
const FAKE_SECRET_VALUE = 'super-secret-db-password-12345';

// ── Mock-SSH-Client-Fabrik ─────────────────────────────────────────────────────

/**
 * Erstellt einen SSH-Mock-Client.
 *
 * Der `responses`-Array definiert die Antwort je SSH-exec-Aufruf in Reihenfolge.
 * Jedes Element: { stdout, exitCode }.
 * Ist `responses` erschöpft, wird der letzte Eintrag wiederholt.
 *
 * @param {object} opts
 * @param {Array<{stdout: string, exitCode: number}>} opts.responses
 * @param {Error}   [opts.connectError]
 * @param {(cmd: string) => void} [opts.onCommand]
 */
function makeMockSshClient({
  responses = [{ stdout: '', exitCode: 0 }],
  connectError = null,
  onCommand = null,
} = {}) {
  let callIdx = 0;
  return () => {
    const client = new EventEmitter();

    client.connect = (config) => {
      if (connectError) {
        setTimeout(() => client.emit('error', connectError), 0);
        return;
      }
      // hostVerifier analog VpsComposeControl.test.js
      if (config.hostVerifier) {
        config.hostVerifier(Buffer.from('fake-host-key'));
      }
      setTimeout(() => client.emit('ready'), 0);
    };

    client.exec = (cmd, _opts, callback) => {
      if (onCommand) onCommand(cmd);

      const idx = Math.min(callIdx, responses.length - 1);
      callIdx++;
      const { stdout = '', exitCode = 0 } = responses[idx];

      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();

      setTimeout(() => callback(null, stream), 0);
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
  const dir = await mkdtemp(join(tmpdir(), 'env-mat-test-'));
  const store = new CredentialStore({ dir, masterKey: TEST_MASTER_KEY });
  return { store, dir };
}

// ── AC3: Erst-Deploy (.env nicht vorhanden) ────────────────────────────────────

describe('ensureEnv — AC3: Erst-Deploy (keine .env)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC3 — kein Private-Key → result:error, errorClass:no-private-key (kein SSH-Aufruf)', async () => {
    const ctrl = new VpsComposeControl(store);
    let sshCalled = false;
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
    expect(sshCalled).toBe(false);
  });

  it('AC3 — .env fehlt → Generier-Skript wird aufgerufen, result:generated', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      // Erste Antwort: MISSING (keine .env), zweite: Skript-Aufruf ok
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },  // test -f → MISSING
          { stdout: '', exitCode: 0 },             // bash generate-supabase-secrets.sh
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    expect(result.result).toBe('generated');
    // Prüfe dass das Generier-Skript aufgerufen wurde
    const generateCmd = capturedCmds.find((c) => c.includes('generate-supabase-secrets.sh'));
    expect(generateCmd).toBeDefined();
  });

  it('AC3 — Generier-Skript-Kommando enthält bash + Stack-Verzeichnis', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    const generateCmd = capturedCmds.find((c) => c.includes('generate-supabase-secrets.sh'));
    expect(generateCmd).toBeDefined();
    expect(generateCmd).toContain('bash');
    expect(generateCmd).toContain('myapp');
    expect(generateCmd).toContain('stacks');
  });

  it('AC3 — Existenz-Prüf-Kommando liest KEINE Werte (kein cat, kein echo-Wert)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    // AC3-Kernschutz: kein cat, kein echo mit Wert, kein source, kein eval
    const existsCmd = capturedCmds[0];
    expect(existsCmd).not.toMatch(/\bcat\b/);
    expect(existsCmd).not.toMatch(/\bsource\b/);
    expect(existsCmd).not.toMatch(/\beval\b/);
    // Defense-in-Depth: keine Command-Substitution im Existenz-Kommando (S1)
    expect(existsCmd).not.toMatch(/\$\(/);
    // Nur test -f oder Existenz-Prüfung
    expect(existsCmd).toMatch(/test\s+-f/);
  });

  it('AC3 — result.generatedKeys enthält NUR Schlüsselnamen, keinen Wert', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET', 'ANON_KEY'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('generated');
    // generatedKeys enthält nur die Namen aus dem Aufruf — keine Werte
    expect(result.generatedKeys).toContain('DB_PASSWORD');
    expect(result.generatedKeys).toContain('JWT_SECRET');
    expect(result.generatedKeys).toContain('ANON_KEY');
    // Kein echtes Secret darf erscheinen
    expect(result.generatedKeys).not.toContain(FAKE_SECRET_VALUE);
  });

  it('AC3 — generierte Werte erscheinen NICHT in Response (kein Wert-Leak)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    // Skript-stdout wird simuliert (auf echtem VPS wäre das der Output der Generierung)
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateKeys: ['DB_PASSWORD'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          // Generier-Skript gibt zufälligen Output aus — dev-gui nutzt ihn NICHT
          { stdout: `DB_PASSWORD=${FAKE_SECRET_VALUE}\n`, exitCode: 0 },
        ],
      }),
    });

    // AC3: Auch wenn Skript-stdout Werte enthält, erscheinen sie NICHT in der Response
    expect(result.result).toBe('generated');
    // Der Rückgabewert darf KEINEN echten Secret-Wert enthalten
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET_VALUE);
  });

  it('AC3 — Generier-Skript-Kommando enthält keinen Private-Key', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    for (const cmd of capturedCmds) {
      expect(cmd).not.toContain('FAKEPRIVATEKEYDATA');
      expect(cmd).not.toContain(FAKE_PRIVATE_KEY);
    }
  });

  it('AC3 — Generier-Skript fehlgeschlagen → result:error, errorClass:docker-failed', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },  // test -f → MISSING
          { stdout: '', exitCode: 1 },             // Skript schlägt fehl
        ],
      }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('docker-failed');
    // reason enthält keinen Secret-Wert
    expect(result.reason).not.toContain(FAKE_SECRET_VALUE);
    expect(result.reason).not.toContain('FAKEPRIVATEKEYDATA');
  });

  it('AC3 — ungültiger stackName → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: '../etc',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC3 — envFile mit ..-Segment → result:error ohne SSH-Call (Path-Traversal-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      envFile: '../../etc/.env',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC3 — generateScript mit absolutem Pfad → result:error ohne SSH-Call', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: '/usr/bin/evil-script.sh',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });

  it('AC3 — generateScript mit ..-Segment → result:error ohne SSH-Call (isValidRelativePath-Schutz)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    let sshCalled = false;
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: '../../etc/evil.sh',
      _sshClientFactory: makeMockSshClient({ onCommand: () => { sshCalled = true; } }),
    });

    expect(result.result).toBe('error');
    expect(sshCalled).toBe(false);
  });
});

// ── AC4: Re-Deploy (.env existiert bereits) ────────────────────────────────────

describe('ensureEnv — AC4: Re-Deploy (.env existiert)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC4 — .env existiert → result:exists, Generier-Skript NICHT aufgerufen', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },  // test -f → EXISTS
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    expect(result.result).toBe('exists');
    // AC4: Generier-Skript wurde NICHT aufgerufen
    const generateCmd = capturedCmds.find((c) => c.includes('generate-supabase-secrets.sh'));
    expect(generateCmd).toBeUndefined();
  });

  it('AC4 — .env existiert → kein Write-Kommando an .env (keine Überschreibung)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    // AC4: kein Schreib-Kommando an .env (kein echo/tee/cat >.env)
    for (const cmd of capturedCmds) {
      expect(cmd).not.toMatch(/>\s*\.env/);
      expect(cmd).not.toMatch(/tee\s+.*\.env/);
      expect(cmd).not.toMatch(/\becho\b.*>\s*\S+\.env/);
    }
  });

  it('AC4 — .env existiert → generatedKeys ist undefined (keine Generierung)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('exists');
    // Bei Re-Deploy: keine generatedKeys (wurde nicht generiert)
    expect(result.generatedKeys).toBeUndefined();
  });

  it('AC4 — .env existiert und alle required-Keys vorhanden → result:exists', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },  // test -f → EXISTS
          // grep-Ausgabe: nur KEY=-Namen (AC5-Muster), keine Werte
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\nANON_KEY=\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('exists');
  });

  it('AC4 — SSH-Fehler bei Existenz-Prüfung → result:error (kein Wert-Leak)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      _sshClientFactory: makeMockSshClient({ connectError: connErr }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).not.toContain(FAKE_SECRET_VALUE);
    expect(result.reason).not.toContain('FAKEPRIVATEKEYDATA');
  });
});

// ── AC5: Fehlende required-Keys (wertfreier Fehler) ───────────────────────────

describe('ensureEnv — AC5: Fehlende required-Keys', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC5 — fehlender required-Key nach Erst-Deploy → result:error mit Schlüsselname', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    // Nach Generierung: OPENAI_API_KEY fehlt in der .env (wurde nicht generiert)
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      requiredKeys: ['DB_PASSWORD', 'JWT_SECRET', 'OPENAI_API_KEY'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },         // test -f → MISSING
          { stdout: '', exitCode: 0 },                   // bash generate-supabase-secrets.sh
          // grep: DB_PASSWORD= und JWT_SECRET= vorhanden, OPENAI_API_KEY fehlt
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('missing-required-key');
    // AC5: Fehler nennt den Schlüsselnamen
    expect(result.reason).toContain('OPENAI_API_KEY');
    expect(result.missingKeys).toContain('OPENAI_API_KEY');
    // AC5: KEIN Wert in reason oder missingKeys
    expect(result.reason).not.toContain(FAKE_SECRET_VALUE);
  });

  it('AC5 — fehlender required-Key bei Re-Deploy → result:error mit Schlüsselname', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['OPENAI_API_KEY'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },       // test -f → EXISTS
          // grep: OPENAI_API_KEY ist nicht in der .env
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('missing-required-key');
    expect(result.reason).toContain('OPENAI_API_KEY');
    expect(result.missingKeys).toContain('OPENAI_API_KEY');
  });

  it('AC5 — Schlüssel-Existenz-Prüfung nur via grep -oE (nur KEY=, kein Wert)', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['DB_PASSWORD'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
          { stdout: 'DB_PASSWORD=\n', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    // grep-Kommando muss vorhanden sein
    const grepCmd = capturedCmds.find((c) => c.includes('grep'));
    expect(grepCmd).toBeDefined();
    // AC5: grep verwendet -oE mit Pattern das nur KEY= (ohne Wert) extrahiert
    expect(grepCmd).toContain('-oE');
    // Das Pattern muss mit ^ beginnen (Zeilenanfang) und mit = enden (nur KEY=, nicht KEY=VALUE)
    expect(grepCmd).toMatch(/\^\[A-Z_\]/);
    // kein cat, kein read, kein source
    expect(grepCmd).not.toMatch(/\bcat\b/);
    expect(grepCmd).not.toMatch(/\bsource\b/);
  });

  it('AC5 — grep-Output enthält Wert-Trennzeichen → Wert wird trotzdem nicht gelesen', async () => {
    // Simulation: grep -oE gibt nur KEY= zurück (keine Werte), selbst wenn .env-Zeilen
    // KEY=VALUE-Paare haben — der grep-Filter extrahiert nur KEY=
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
          // grep -oE gibt nur KEY=-Muster zurück (kein Wert):
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\n', exitCode: 0 },
        ],
      }),
    });

    // Alle required-Keys vorhanden → result:exists
    expect(result.result).toBe('exists');
    // Kein Wert in der Response
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET_VALUE);
  });

  it('AC5 — mehrere fehlende Keys → alle im missingKeys-Array aufgeführt', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['OPENAI_API_KEY', 'SENDGRID_KEY', 'DB_PASSWORD'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
          // Nur DB_PASSWORD vorhanden
          { stdout: 'DB_PASSWORD=\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('error');
    expect(result.missingKeys).toContain('OPENAI_API_KEY');
    expect(result.missingKeys).toContain('SENDGRID_KEY');
    expect(result.missingKeys).not.toContain('DB_PASSWORD');
    // Kein Wert in der Response
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET_VALUE);
  });

  it('AC5 — keine requiredKeys → kein grep-Aufruf, keine Prüfung', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const capturedCmds = [];
    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: [],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
        ],
        onCommand: (cmd) => capturedCmds.push(cmd),
      }),
    });

    expect(result.result).toBe('exists');
    // Kein grep-Kommando wenn keine required-Keys
    const grepCmd = capturedCmds.find((c) => c.includes('grep'));
    expect(grepCmd).toBeUndefined();
  });

  it('AC5 — Fehler (SSH-Problem) bei required-Key-Prüfung → result:error, kein Wert-Leak', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    // Erste SSH-Verbindung (Existenz-Prüfung) ok, zweite (grep) schlägt fehl
    let callCount = 0;
    const factory = () => {
      const client = new EventEmitter();
      client.connect = (config) => {
        if (config.hostVerifier) config.hostVerifier(Buffer.from('fake-host-key'));
        setTimeout(() => client.emit('ready'), 0);
      };
      client.exec = (cmd, _opts, callback) => {
        callCount++;
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        setTimeout(() => callback(null, stream), 0);
        setTimeout(() => {
          if (callCount === 1) {
            // Erste Anfrage: EXISTS
            stream.emit('data', 'EXISTS\n');
            setTimeout(() => stream.emit('close', 0), 0);
          } else {
            // Zweite Anfrage (grep): SSH-Exit-Fehler
            setTimeout(() => stream.emit('close', 1), 0);
          }
        }, 5);
      };
      client.end = () => {};
      return client;
    };

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['OPENAI_API_KEY'],
      _sshClientFactory: factory,
    });

    // grep-Fehler → result:error (exit 1 = docker-failed)
    expect(result.result).toBe('error');
    expect(result.reason).not.toContain(FAKE_SECRET_VALUE);
    expect(result.reason).not.toContain('FAKEPRIVATEKEYDATA');
  });

  it('AC5 — reason-String enthält Schlüsselnamen, niemals einen Wert', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      requiredKeys: ['OPENAI_API_KEY'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'EXISTS\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },  // grep gibt nichts zurück → OPENAI_API_KEY fehlt
        ],
      }),
    });

    expect(result.result).toBe('error');
    // AC5: reason enthält den Schlüsselnamen
    expect(result.reason).toContain('OPENAI_API_KEY');
    // AC5: reason enthält KEINEN Secret-Wert
    expect(result.reason).not.toContain(FAKE_SECRET_VALUE);
    // Kein Wert in der gesamten Response
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET_VALUE);
  });
});

// ── AC3/AC5 kombiniert: Erst-Deploy mit required-Keys ────────────────────────

describe('ensureEnv — AC3+AC5: Erst-Deploy + required-Keys vorhanden', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC3+AC5 — Erst-Deploy, alle required-Keys nach Generierung vorhanden → result:generated', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      requiredKeys: ['DB_PASSWORD', 'JWT_SECRET'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },         // test -f
          { stdout: '', exitCode: 0 },                   // bash generate-supabase-secrets.sh
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\n', exitCode: 0 }, // grep → beide vorhanden
        ],
      }),
    });

    expect(result.result).toBe('generated');
    expect(result.missingKeys).toBeUndefined();
  });

  it('AC3+AC5 — Audit-relevante Info: generatedKeys enthält Schlüsselnamen, nie Werte', async () => {
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);
    const ctrl = new VpsComposeControl(store);

    const result = await ctrl.ensureEnv({
      vps: TEST_VPS,
      stackName: 'myapp',
      generateScript: 'generate-supabase-secrets.sh',
      generateKeys: ['DB_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_KEY'],
      requiredKeys: ['DB_PASSWORD'],
      _sshClientFactory: makeMockSshClient({
        responses: [
          { stdout: 'MISSING\n', exitCode: 0 },
          { stdout: '', exitCode: 0 },
          { stdout: 'DB_PASSWORD=\nJWT_SECRET=\nANON_KEY=\nSERVICE_KEY=\n', exitCode: 0 },
        ],
      }),
    });

    expect(result.result).toBe('generated');
    // generatedKeys ist ein CSV der Schlüsselnamen (kein Wert)
    expect(result.generatedKeys).toContain('DB_PASSWORD');
    expect(result.generatedKeys).toContain('JWT_SECRET');
    // Kein echter Secret-Wert
    expect(result.generatedKeys).not.toContain(FAKE_SECRET_VALUE);
    expect(result.generatedKeys).not.toContain('FAKEPRIVATEKEYDATA');
  });
});
