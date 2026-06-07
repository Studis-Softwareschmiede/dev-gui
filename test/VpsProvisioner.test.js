/**
 * VpsProvisioner.test.js — Unit-Tests für die VPS-Provisionierungs-Boundary (ADR-008, AC7–AC10).
 *
 * Covers:
 *   AC7  — provision() trägt Public-Key idempotent in authorized_keys ein → 'added'
 *   AC8  — Wiederholte Provisionierung → 'already-present' (keine Duplikate)
 *   AC9  — Fehlerfälle (kein Public-Key, kein Private-Key, SSH-Fehler) ohne Geheim-Leak
 *   Transport — Kein echter SSH-Verkehr im Test (mock via _sshClientFactory)
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
import { VpsProvisioner } from '../src/VpsProvisioner.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-vps-provisioner-key-not-a-real-secret';

const VALID_ED25519_PUBKEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTestingPurposesOnlyNotReal test@example.com';

// Dummy-PEM zur Laufzeit zusammensetzen — der literale BEGIN-Marker im Quelltext
// würde den gitleaks-Secret-Scan (Rule private-key) als False Positive auslösen.
const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const FAKE_PRIVATE_KEY = pemDummy('FAKEPRIVATEKEYDATA');

// ── Mock-SSH-Client-Fabrik ─────────────────────────────────────────────────────

/**
 * Erstellt einen Mock-SSH-Client, der sofort `ready` emittiert und
 * ein exec-Kommando mit dem angegebenen stdout ausführt.
 *
 * @param {object} opts
 * @param {'added'|'already-present'} [opts.scriptOutput] - stdout des Remote-Skripts
 * @param {number} [opts.exitCode] - exit code des Remote-Skripts (Default: 0)
 * @param {Error} [opts.connectError] - wenn gesetzt: emit('error', ...) statt 'ready'
 * @param {boolean} [opts.hostKeyReject] - wenn true: hostVerifier gibt false zurück
 */
function makeMockSshClient({
  scriptOutput = 'added',
  exitCode = 0,
  connectError = null,
} = {}) {
  return () => {
    const client = new EventEmitter();

    client.connect = (config) => {
      // hostVerifier aufrufen (sync — ssh2-Vertrag)
      if (config.hostVerifier) {
        const fakeKey = Buffer.from('fake-host-key');
        const accepted = config.hostVerifier(fakeKey);
        if (!accepted) {
          // hostVerifier hat false zurückgegeben → VpsProvisioner self-rejects via setTimeout
          return;
        }
      }

      if (connectError) {
        setTimeout(() => client.emit('error', connectError), 0);
      } else {
        setTimeout(() => client.emit('ready'), 0);
      }
    };

    client.exec = (_cmd, _opts, callback) => {
      const stream = new EventEmitter();
      stream.stdin = {
        write: () => {},
        end: () => {
          // Nach stdin.end: stdout liefern + close emittieren
          setTimeout(() => {
            stream.emit('data', scriptOutput);
            setTimeout(() => stream.emit('close', exitCode), 0);
          }, 0);
        },
      };
      stream.stderr = new EventEmitter();
      setTimeout(() => callback(null, stream), 0);
    };

    client.end = () => {};

    return client;
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function makeTmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'vps-prov-test-'));
  const store = new CredentialStore({ dir, masterKey: TEST_MASTER_KEY });
  return { store, dir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('VpsProvisioner — Konstruktor', () => {
  it('wirft wenn kein CredentialStore übergeben wird', () => {
    expect(() => new VpsProvisioner(null)).toThrow(/credentialStore/i);
    expect(() => new VpsProvisioner(undefined)).toThrow(/credentialStore/i);
    expect(() => new VpsProvisioner({})).toThrow(/credentialStore/i);
  });

  it('initialisiert korrekt mit gültigem Store', () => {
    const fakeStore = { getPublicKey: () => {}, getPlaintext: () => {} };
    expect(() => new VpsProvisioner(fakeStore)).not.toThrow();
  });
});

describe('VpsProvisioner — AC9: fehlende Keys', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC9 — kein Public-Key → errorClass:no-public-key, result:error', async () => {
    const prov = new VpsProvisioner(store);
    const result = await prov.provision('root', { host: '1.2.3.4', targetUser: 'root' });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-public-key');
    expect(result.reason).toMatch(/kein public-key/i);
    // Kein Geheim-Leak: reason darf keinen Private-Key-Klartext enthalten
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
  });

  it('AC9 — Public-Key gesetzt aber kein Private-Key → errorClass:no-private-key, result:error', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    const prov = new VpsProvisioner(store);
    const result = await prov.provision('root', { host: '1.2.3.4', targetUser: 'root' });
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('no-private-key');
    expect(result.reason).toMatch(/kein private-key/i);
  });
});

describe('VpsProvisioner — AC7: Key-Eintrag (added)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await rm(dir, { recursive: true, force: true });
  });

  it('AC7 — provision() liefert result:added wenn Key neu eingetragen', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: 'added' }) },
    );

    expect(result.result).toBe('added');
    expect(result.errorClass).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('AC7 — Private-Key erscheint NICHT im result (kein Geheim-Leak)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: 'added' }) },
    );

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(FAKE_PRIVATE_KEY);
    expect(resultStr).not.toContain('FAKEPRIVATE');
  });

  it('AC7 — provision() verwendet Standard-Port 22 wenn port nicht angegeben', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    let capturedConfig = null;
    const factory = () => {
      const client = new EventEmitter();
      client.connect = (config) => {
        capturedConfig = config;
        if (config.hostVerifier) config.hostVerifier(Buffer.from('fakekey'));
        setTimeout(() => client.emit('ready'), 0);
      };
      client.exec = (_cmd, _opts, cb) => {
        const stream = new EventEmitter();
        stream.stdin = { write: () => {}, end: () => { setTimeout(() => { stream.emit('data', 'added'); setTimeout(() => stream.emit('close', 0), 0); }, 0); } };
        stream.stderr = new EventEmitter();
        setTimeout(() => cb(null, stream), 0);
      };
      client.end = () => {};
      return client;
    };

    const prov = new VpsProvisioner(store);
    await prov.provision('root', { host: '1.2.3.4', targetUser: 'root' }, { _sshClientFactory: factory });

    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig.port).toBe(22);
  });

  it('AC7 — provision() nutzt angegebenen Port', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    let capturedConfig = null;
    const factory = () => {
      const client = new EventEmitter();
      client.connect = (config) => {
        capturedConfig = config;
        if (config.hostVerifier) config.hostVerifier(Buffer.from('fakekey'));
        setTimeout(() => client.emit('ready'), 0);
      };
      client.exec = (_cmd, _opts, cb) => {
        const stream = new EventEmitter();
        stream.stdin = { write: () => {}, end: () => { setTimeout(() => { stream.emit('data', 'added'); setTimeout(() => stream.emit('close', 0), 0); }, 0); } };
        stream.stderr = new EventEmitter();
        setTimeout(() => cb(null, stream), 0);
      };
      client.end = () => {};
      return client;
    };

    const prov = new VpsProvisioner(store);
    await prov.provision('root', { host: '1.2.3.4', port: 2222, targetUser: 'root' }, { _sshClientFactory: factory });

    expect(capturedConfig.port).toBe(2222);
  });
});

describe('VpsProvisioner — AC8: Idempotenz (already-present)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC8 — provision() liefert result:already-present wenn Key bereits vorhanden', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: 'already-present' }) },
    );

    expect(result.result).toBe('already-present');
  });
});

describe('VpsProvisioner — AC9: Fehlerklassen', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('AC9 — ECONNREFUSED → errorClass:unreachable, reason ohne Geheim-Leak', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const connErr = new Error('Connection refused');
    connErr.code = 'ECONNREFUSED';

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ connectError: connErr }) },
    );

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
    expect(result.reason).toMatch(/nicht erreichbar|verbindung/i);
    // Kein Geheim-Leak
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('FAKEPRIVATE');
  });

  it('AC9 — Auth-Fehler → errorClass:auth-failed', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const authErr = new Error('All configured authentication methods failed');

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ connectError: authErr }) },
    );

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
    expect(result.reason).toMatch(/authentifizierung|auth/i);
  });

  it('AC9 — Remote-Skript exit 1 → result:error', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: '', exitCode: 1 }) },
    );

    expect(result.result).toBe('error');
  });

  it('AC9 — Host-Key-Fingerprint-Mismatch → errorClass:host-key-mismatch', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    // SHA256 von 'fake-host-key' berechnen — wäre ein bekannter Wert; wir übergeben einen falschen
    const wrongFingerprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      {
        hostFingerprint: wrongFingerprint,
        _sshClientFactory: makeMockSshClient({ scriptOutput: 'added' }),
      },
    );

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('host-key-mismatch');
  });

  it('AC9 — ETIMEDOUT → errorClass:unreachable', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const timeoutErr = new Error('SSH-Verbindungs-Timeout');
    timeoutErr.code = 'ETIMEDOUT';

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ connectError: timeoutErr }) },
    );

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
  });
});

describe('VpsProvisioner — S1: Escaping-Invariante (Single-Quote im Public-Key-Kommentar)', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("S1 — Public-Key mit Single-Quote im Kommentar → Skript läuft, Ergebnis 'added'", async () => {
    // Ein Public-Key, dessen Kommentar-Teil ein Single-Quote enthält.
    // Das Single-Quote-Escaping (' → '\''  ) im Skript muss greifen.
    const keyWithQuote =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyForTestingPurposesOnlyNotReal user's-laptop";

    await store.setPublicKey('root', keyWithQuote);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    // capturedScript prüfen: das erzeugte Skript muss korrekt escaped sein
    let capturedScript = '';
    const factory = () => {
      const client = new EventEmitter();
      client.connect = (config) => {
        if (config.hostVerifier) config.hostVerifier(Buffer.from('fake-host-key'));
        setTimeout(() => client.emit('ready'), 0);
      };
      client.exec = (_cmd, _opts, cb) => {
        const stream = new EventEmitter();
        stream.stdin = {
          write: (data) => { capturedScript += data; },
          end: () => {
            // Skript läuft durch (exitCode 0) und liefert 'added'
            setTimeout(() => {
              stream.emit('data', 'added');
              setTimeout(() => stream.emit('close', 0), 0);
            }, 0);
          },
        };
        stream.stderr = new EventEmitter();
        setTimeout(() => cb(null, stream), 0);
      };
      client.end = () => {};
      return client;
    };

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: factory },
    );

    expect(result.result).toBe('added');
    // Das Skript enthält das korrekt escaped Single-Quote ('\'' statt rohem ')
    expect(capturedScript).toContain("'\\''");
    // Kein rohes Single-Quote im Kommentar-Teil des Skripts (wäre Injection)
    // (das '\'' Pattern ist escaped — rohe un-escaped Quotes würden das Shell-Skript brechen)
  });
});

describe('VpsProvisioner — S5: exit 0 mit unerwartetem stdout → EXEC_FAILED', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('S5 — exit 0 mit unbekanntem stdout → result:error (EXEC_FAILED-Reject)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: 'unexpected-garbage', exitCode: 0 }) },
    );

    expect(result.result).toBe('error');
    // Kein Klartext-Leak im Fehlergrund
    expect(result.reason).not.toContain(FAKE_PRIVATE_KEY);
    expect(result.reason).not.toContain('unexpected-garbage');
  });
});

describe('VpsProvisioner — hostKeyHash im Ergebnis', () => {
  let dir, store;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hostKeyHash ist im Ergebnis vorhanden (TOFU — kein hostFingerprint angegeben)', async () => {
    await store.setPublicKey('root', VALID_ED25519_PUBKEY);
    await store.set('ssh/root/private_key', FAKE_PRIVATE_KEY);

    const prov = new VpsProvisioner(store);
    const result = await prov.provision(
      'root',
      { host: '1.2.3.4', targetUser: 'root' },
      { _sshClientFactory: makeMockSshClient({ scriptOutput: 'added' }) },
    );

    expect(result.result).toBe('added');
    // hostKeyHash sollte gesetzt sein (SHA256-Base64 von 'fake-host-key')
    expect(typeof result.hostKeyHash).toBe('string');
    expect(result.hostKeyHash.length).toBeGreaterThan(0);
  });
});
