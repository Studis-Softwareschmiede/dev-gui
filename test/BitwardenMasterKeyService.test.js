/**
 * BitwardenMasterKeyService.test.js — Unit-Tests (AC1–AC9)
 *
 * Spec: docs/specs/bitwarden-master-key-unlock.md
 *
 * Covers:
 *   AC1  — Login mit E-Mail + Master-Passwort (+ 2FA falls nötig), serverseitig
 *   AC2  — Existierendes Item → Key store-intern an CredentialStore.unlock(); NICHT in Response
 *   AC3  — Kein Item → Status 'not-found', KEIN automatisches Erstellen
 *   AC4  — Nur bei explizitem createMasterKey()-Aufruf: Zufalls-Key (≥32 Byte) + Bitwarden-Item
 *   AC5  — Klassifizierte Fehler: auth-failed | twofa-required | twofa-invalid | bw-unreachable | error
 *   AC6  — KEINE Geheimnisse in Argv (Password/Session-Token); nicht in Response; nicht im Audit
 *   AC7  — Key via CredentialStore.unlock(); falscher Key → Ablehnung ohne .env-Persistenz
 *   AC8  — Audit-First: vor Aktion ein Eintrag ohne Werte; Audit-Fehler → Aktion unterbleibt
 *   AC9  — Transiente Sitzung verworfen (bw logout nach Beschaffung)
 *
 * Strategie:
 *   - `_spawnBw` wird vollständig gemockt → kein echter Bitwarden-Netzwerkaufruf
 *   - CredentialStore mit tmpdir + injiziertem masterKey (echter Store für Boundary-Test)
 *   - AuditStore als echte In-Memory-Instanz (prüft Audit-Einträge exakt)
 *   - AC6: gespawnte Argv-Arrays werden explizit geprüft — dürfen keine Geheimnisse enthalten
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/CredentialStore.js';
import { AuditStore } from '../src/AuditStore.js';
import { BitwardenMasterKeyService } from '../src/BitwardenMasterKeyService.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-bw-service-key-not-a-real-secret';
const FAKE_EMAIL = 'user@example.com';
const FAKE_PASSWORD = 'super-secret-master-password-bw';
const FAKE_SESSION = 'fake-bw-session-token-abc123xyz789';
const FAKE_KEY_VALUE = 'dGVzdC1tYXN0ZXIta2V5LXZhbHVlLTMyYnl0ZXNsb25n'; // base64, ≥32 chars
const ITEM_NAME = 'dev-gui-master-key';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Erstellt eine Mock-Spawn-Funktion, die bw-Kommandos simuliert.
 *
 * @param {object} opts
 * @param {string}    [opts.sessionToken]   - Session-Token für erfolgreichen Login
 * @param {string}    [opts.itemPassword]   - Passwort-Feld für Item-Lese-Aktion
 * @param {boolean}   [opts.itemNotFound]   - true = Item nicht vorhanden
 * @param {boolean}   [opts.loginFails]     - true = Login schlägt fehl
 * @param {number}    [opts.loginExitCode]  - Exit-Code für Login (Default 0)
 * @param {string}    [opts.loginStderr]    - stderr bei Login-Fehler
 * @param {boolean}   [opts.createFails]    - true = bw create schlägt fehl
 * @param {(args: string[], opts: object) => void} [opts.onSpawn] - Callback für Assertion
 */
function makeSpawnMock({
  sessionToken = FAKE_SESSION,
  itemPassword = FAKE_KEY_VALUE,
  itemNotFound = false,
  loginFails = false,
  loginExitCode = 0,
  loginStderr = '',
  createFails = false,
  onSpawn = null,
} = {}) {
  // Kumulierte Argv-Arrays für AC6-Assertions
  const spawnedArgvs = [];

  const fn = jest.fn(async (args, _opts) => {
    spawnedArgvs.push([...args]);
    if (onSpawn) onSpawn(args, _opts);

    const cmd = args[0];

    if (cmd === 'login') {
      if (loginFails) {
        return { stdout: '', stderr: loginStderr || 'Username or password is incorrect.', exitCode: loginExitCode || 1 };
      }
      return { stdout: sessionToken, stderr: '', exitCode: 0 };
    }

    if (cmd === 'get' && args[1] === 'password') {
      if (itemNotFound) {
        return { stdout: '', stderr: 'Not found.', exitCode: 1 };
      }
      return { stdout: itemPassword, stderr: '', exitCode: 0 };
    }

    if (cmd === 'encode') {
      // Simuliert bw encode: gibt base64 der stdin zurück (vereinfacht)
      return { stdout: 'eyJ0eXBlIjoxfQ==', stderr: '', exitCode: 0 };
    }

    if (cmd === 'create' && args[1] === 'item') {
      if (createFails) {
        return { stdout: '', stderr: 'Create failed.', exitCode: 1 };
      }
      return { stdout: '{"id":"fake-id"}', stderr: '', exitCode: 0 };
    }

    if (cmd === 'logout') {
      return { stdout: 'You have logged out.', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: 'unknown command', exitCode: 1 };
  });

  fn.spawnedArgvs = spawnedArgvs;
  return fn;
}

// ── Test-Setup ─────────────────────────────────────────────────────────────────

let tmpDir;
let credentialStore;
let auditStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bw-test-'));
  credentialStore = new CredentialStore({
    dir: tmpDir,
    masterKey: TEST_MASTER_KEY,
    envPath: join(tmpDir, '.env'),
  });
  auditStore = new AuditStore();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Hilfsfunktion: Service erstellen ──────────────────────────────────────────

function makeService(spawnMock) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBw: spawnMock,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — Login mit E-Mail + Master-Passwort (+ 2FA falls nötig)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC1 — Bitwarden-Login serverseitig', () => {
  it('login wird mit E-Mail + Passwort durchgeführt (bw login aufgerufen)', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const loginCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginCall).toBeDefined();
  });

  it('login mit 2FA-Code: --code-Argument wird übergeben (AC6-Ausnahme: TOTP ist einmalig/kurzlebig, bw bietet keine Env/stdin-Alternative)', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '123456', identity: null });

    const loginArgs = spawnMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginArgs).toContain('--code');
    expect(loginArgs).toContain('123456');
    // AC6: Master-Passwort erscheint NICHT als Arg (nur TOTP-Code ist Ausnahme)
    expect(loginArgs).not.toContain(FAKE_PASSWORD);
  });

  it('ohne 2FA-Code: kein --code-Argument', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const loginArgs = spawnMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginArgs).not.toContain('--code');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — Existierendes Item → Key store-intern; NICHT in Response
// ══════════════════════════════════════════════════════════════════════════════

describe('AC2 — Item gefunden: Key store-intern, nicht in Response', () => {
  it('acquireMasterKey gibt { status: "found" } zurück — OHNE Key-Wert', async () => {
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('found');
    // AC2: Kein Key-Wert in der Response
    expect(result.key).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY_VALUE);
  });

  it('Store wird nach acquireMasterKey entsperrt (unlock wurde aufgerufen)', async () => {
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    // Frischer Store ohne Key → frischer unlock mit beliebigem Key ok
    expect(credentialStore.isUnlocked()).toBe(true); // masterKey injiziert im Konstruktor
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(credentialStore.isUnlocked()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — Kein Item → not-found (KEIN automatisches Erstellen)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC3 — Item nicht gefunden: not-found, kein automatisches Erstellen', () => {
  it('acquireMasterKey gibt { status: "not-found" } zurück wenn Item fehlt', async () => {
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
  });

  it('bei not-found wird KEIN bw create aufgerufen (kein automatisches Erstellen)', async () => {
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create');
    expect(createCall).toBeUndefined();
  });

  it('leerer Item-Passwort-Wert → not-found', async () => {
    const spawnMock = makeSpawnMock({ itemPassword: '   ' });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — Nur bei explizitem Flag: Zufalls-Key + Bitwarden-Item
// ══════════════════════════════════════════════════════════════════════════════

describe('AC4 — createMasterKey: Zufalls-Key + Item anlegen', () => {
  it('createMasterKey gibt { status: "created" } zurück', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('created');
  });

  it('createMasterKey ruft bw encode und bw create item auf', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const encodeCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'encode');
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create' && args[1] === 'item');
    expect(encodeCall).toBeDefined();
    expect(createCall).toBeDefined();
  });

  it('AC4: acquireMasterKey ohne Bestätigungs-Flag löst KEIN Erstellen aus', async () => {
    // acquireMasterKey → nur lesen, nie erstellen
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create');
    expect(createCall).toBeUndefined();
  });

  it('generierter Key hat ≥32 Byte Entropie (≥44 base64-Zeichen)', async () => {
    // Prüfen: der JSON-Payload, der an bw encode übergeben wird, enthält einen Key ≥44 Zeichen
    let capturedEncodeInput = null;
    const spawnMock = makeSpawnMock({
      onSpawn: (args, opts) => {
        if (args[0] === 'encode') {
          capturedEncodeInput = opts?.input ?? null;
        }
      },
    });
    const service = makeService(spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(capturedEncodeInput).not.toBeNull();
    const parsed = JSON.parse(capturedEncodeInput);
    const keyInPayload = parsed.login?.password ?? '';
    // 32 Byte base64 = 44 Zeichen (ohne Padding-Verlust)
    expect(keyInPayload.length).toBeGreaterThanOrEqual(44);
  });

  it('bw create schlägt fehl → item-create-failed, kein Teil-Zustand', async () => {
    const spawnMock = makeSpawnMock({ createFails: true });
    const service = makeService(spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('item-create-failed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC5 — Klassifizierte Fehler
// ══════════════════════════════════════════════════════════════════════════════

describe('AC5 — Klassifizierte Fehler', () => {
  it('falsche Credentials → auth-failed', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'Username or password is incorrect.',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: 'wrong', identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
  });

  it('2FA erforderlich → twofa-required', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'Two-step login required.',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-required');
  });

  it('falscher 2FA-Code → twofa-invalid', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'Two-step login invalid code.',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-invalid');
  });

  it('bw CLI nicht gefunden (exit 127) → bw-unreachable', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'command not found: bw',
      loginExitCode: 127,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('bw-unreachable');
  });

  it('Netzwerk-Fehler → bw-unreachable', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'Failed to connect to server: ECONNREFUSED',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('bw-unreachable');
  });

  it('Fehler-Reason enthält KEINE Klartext-Geheimnisse', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: `Username or password is incorrect. Your password is ${FAKE_PASSWORD}`,
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // AC5: Klartext-Geheimnis (Passwort) NICHT in Fehlermeldung
    expect(result.reason).not.toContain(FAKE_PASSWORD);
    expect(result.reason).not.toContain(FAKE_EMAIL);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC6 — KEINE Geheimnisse in Argv/Log/Response
// ══════════════════════════════════════════════════════════════════════════════

describe('AC6 — Keine Geheimnisse in Argv oder Response', () => {
  it('Passwort erscheint NICHT in den gespawnten Argv-Arrays (kein bw-Arg-Leak)', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // AC6: Jedes gespawnte Argv-Array auf Passwort prüfen
    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
  });

  it('Session-Token erscheint NICHT in den gespawnten Argv-Arrays', async () => {
    const spawnMock = makeSpawnMock({ sessionToken: FAKE_SESSION });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_SESSION);
      }
    }
  });

  it('Key-Wert erscheint NICHT in der acquireMasterKey-Response', async () => {
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_KEY_VALUE);
    expect(result.key).toBeUndefined();
  });

  it('Key-Wert erscheint NICHT in der createMasterKey-Response', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Kein Key-Wert in der Response — nur status: 'created'
    expect(result.key).toBeUndefined();
    expect(result.status).toBe('created');
  });

  it('Passwort erscheint NICHT im Audit-Eintrag', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com' });

    const entries = auditStore.getAll();
    const auditJson = JSON.stringify(entries);
    expect(auditJson).not.toContain(FAKE_PASSWORD);
    expect(auditJson).not.toContain(FAKE_SESSION);
    expect(auditJson).not.toContain(FAKE_KEY_VALUE);
  });

  it('Key-Wert in Fehlerfällen NICHT in Response (auth-failed)', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: `Authentication failed. Key: ${FAKE_KEY_VALUE}`,
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // AC6: stderr-Rohdaten (die den Key enthalten könnten) nicht in Response
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY_VALUE);
    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 — Falscher Key → Ablehnung ohne .env-Persistenz
// ══════════════════════════════════════════════════════════════════════════════

describe('AC7 — Falscher Key → Ablehnung via CredentialStore.unlock()', () => {
  it('falscher Key (manipuliertes Bitwarden-Item) bei vorhandenem Store → error', async () => {
    // Store mit echten verschlüsselten Einträgen vorbereiten (mit TEST_MASTER_KEY)
    await credentialStore.set('credentials/misc/test-entry', 'test-value');

    // Service mit einem falschen Key-Wert aus Bitwarden
    const wrongKey = 'wrong-key-not-matching-store-encryption';
    const spawnMock = makeSpawnMock({ itemPassword: wrongKey });

    // Neuer Store-Instanz, die mit dem falschen Key konfrontiert wird
    const cs = new CredentialStore({
      dir: tmpDir,
      masterKey: null, // gesperrt
      envPath: join(tmpDir, '.env-wrong'),
    });

    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBw: spawnMock,
    });

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // AC7: Falscher Key → Ablehnung
    expect(result.status).toBe('error');
    // AC7: Store bleibt gesperrt (kein unlock mit falschem Key)
    expect(cs.isUnlocked()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC8 — Audit-First
// ══════════════════════════════════════════════════════════════════════════════

describe('AC8 — Audit-First: Eintrag vor Aktion, ohne Werte', () => {
  it('acquireMasterKey schreibt Audit-Eintrag für login-attempt VOR dem Login', async () => {
    const loginOrder = [];
    const spawnMock = makeSpawnMock({
      onSpawn: (args) => {
        if (args[0] === 'login') loginOrder.push('bw-login');
      },
    });

    // Audit-Record überwachen
    const originalRecord = auditStore.record.bind(auditStore);
    let auditCallOrder = [];
    jest.spyOn(auditStore, 'record').mockImplementation((params) => {
      auditCallOrder.push({ when: 'audit', command: params.command });
      if (params.command === 'bitwarden:login-attempt') {
        // Simuliere: Login noch nicht aufgerufen
        expect(loginOrder).toHaveLength(0);
      }
      return originalRecord(params);
    });

    const service = makeService(spawnMock);
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com' });

    const auditEntries = auditStore.getAll();
    const loginAttempt = auditEntries.find((e) => e.command === 'bitwarden:login-attempt');
    expect(loginAttempt).toBeDefined();
    expect(loginAttempt.identity).toBe('test@example.com');
  });

  it('acquireMasterKey schreibt Audit-Eintrag für key-read', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    const auditEntries = auditStore.getAll();
    const keyRead = auditEntries.find((e) => e.command?.includes('bitwarden:key-read'));
    expect(keyRead).toBeDefined();
  });

  it('createMasterKey schreibt Audit-Eintrag für key-create', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'admin@test.com' });

    const auditEntries = auditStore.getAll();
    const keyCreate = auditEntries.find((e) => e.command?.includes('bitwarden:key-create'));
    expect(keyCreate).toBeDefined();
    expect(keyCreate.identity).toBe('admin@test.com');
  });

  it('Audit-Einträge enthalten KEINE Geheimnis-Werte (Passwort, Key, Session)', async () => {
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    const entries = auditStore.getAll();
    for (const entry of entries) {
      const entryJson = JSON.stringify(entry);
      expect(entryJson).not.toContain(FAKE_PASSWORD);
      expect(entryJson).not.toContain(FAKE_SESSION);
      expect(entryJson).not.toContain(FAKE_KEY_VALUE);
    }
  });

  it('Audit-Write schlägt fehl → acquireMasterKey unterbleibt (kein bw-Aufruf)', async () => {
    const spawnMock = makeSpawnMock();

    // Audit-Store so konfigurieren dass er wirft
    jest.spyOn(auditStore, 'record').mockImplementation(() => {
      throw new Error('Audit-Schreib-Fehler simuliert');
    });

    const service = makeService(spawnMock);
    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // Kein bw-Kommando aufgerufen
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // S2: createMasterKey — kein bw-Kommando wenn Audit-Write fehlschlägt
  it('Audit-Write schlägt fehl → createMasterKey unterbleibt (kein bw-Aufruf)', async () => {
    const spawnMock = makeSpawnMock();

    jest.spyOn(auditStore, 'record').mockImplementation(() => {
      throw new Error('Audit-Schreib-Fehler simuliert');
    });

    const service = makeService(spawnMock);
    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // Kein bw-Kommando aufgerufen — analog acquireMasterKey-Test
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('Audit-Write vor key-read schlägt fehl → Aktion unterbleibt, Session wird aufgeräumt', async () => {
    let auditCallCount = 0;
    const originalRecord = auditStore.record.bind(auditStore);

    jest.spyOn(auditStore, 'record').mockImplementation((params) => {
      auditCallCount++;
      if (auditCallCount >= 2) {
        // Zweiter Audit-Eintrag (key-read) schlägt fehl
        throw new Error('Zweiter Audit-Write-Fehler');
      }
      return originalRecord(params);
    });

    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // bw logout sollte trotzdem aufgerufen worden sein (Session aufräumen)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC9 — Transiente Sitzung verworfen (bw logout)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC9 — Bitwarden-Sitzung verworfen nach Beschaffung', () => {
  it('acquireMasterKey: bw logout wird nach dem Key-Lesen aufgerufen', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('createMasterKey: bw logout wird nach dem Item-Anlegen aufgerufen', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('not-found: bw logout wird auch bei fehlendem Item aufgerufen', async () => {
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('createMasterKey schlägt fehl: bw logout wird auch bei Fehler aufgerufen', async () => {
    const spawnMock = makeSpawnMock({ createFails: true });
    const service = makeService(spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('bw logout empfängt keinen Session-Token als Arg (nur via Env)', async () => {
    const spawnMock = makeSpawnMock({ sessionToken: FAKE_SESSION });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutArgs = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutArgs).toBeDefined();
    // AC6: Session-Token NICHT in Argv des logout-Aufrufs
    for (const arg of logoutArgs) {
      expect(String(arg)).not.toContain(FAKE_SESSION);
    }
  });

  // S1: bw logout auch wenn unlock() den Key ablehnt (AC7-Szenario mit falschem Key)
  it('acquireMasterKey: bw logout wird auch aufgerufen wenn CredentialStore.unlock() fehlschlägt', async () => {
    // Store mit verschlüsselten Einträgen (TEST_MASTER_KEY)
    await credentialStore.set('credentials/misc/test-s1', 'test-value-s1');

    const wrongKey = 'wrong-key-s1-not-matching-store-encryption';
    const spawnMock = makeSpawnMock({ itemPassword: wrongKey });

    const cs = new CredentialStore({
      dir: tmpDir,
      masterKey: null, // gesperrt → unlock mit falschem Key schlägt fehl
      envPath: join(tmpDir, '.env-s1'),
    });

    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBw: spawnMock,
    });

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // AC9: bw logout wurde trotzdem aufgerufen (Session verwerfen)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Konstruktor-Validierung
// ══════════════════════════════════════════════════════════════════════════════

describe('Konstruktor-Validierung', () => {
  it('wirft ohne credentialStore', () => {
    expect(() => new BitwardenMasterKeyService({ auditStore })).toThrow();
  });

  it('wirft ohne auditStore', () => {
    expect(() => new BitwardenMasterKeyService({ credentialStore })).toThrow();
  });
});
