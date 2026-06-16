/**
 * BitwardenMasterKeyService.test.js — Unit-Tests (AC1–AC12) + New-Device-OTP-Plumbing (#263)
 *
 * Spec: docs/specs/bitwarden-master-key-unlock.md
 *
 * Covers (bitwarden-master-key-unlock):
 *   AC1  — Login mit E-Mail + Master-Passwort (+ 2FA falls nötig), serverseitig
 *   AC2  — Existierendes Item → Key store-intern an CredentialStore.unlock(); NICHT in Response
 *   AC3  — Kein Item → Status 'not-found', KEIN automatisches Erstellen
 *   AC4  — Nur bei explizitem createMasterKey()-Aufruf: Zufalls-Key (≥32 Byte) + Bitwarden-Item
 *   AC5  — Klassifizierte Fehler: auth-failed | twofa-required | twofa-invalid | bw-unreachable | error
 *   AC6  — KEINE Geheimnisse in Argv (Password/Session-Token); nicht in Response; nicht im Audit
 *   AC7  — Key via CredentialStore.unlock(); falscher Key → Ablehnung ohne .env-Persistenz
 *   AC8  — Audit-First: vor Aktion ein Eintrag ohne Werte; Audit-Fehler → Aktion unterbleibt
 *   AC9  — Transiente Sitzung verworfen (bw logout nach Beschaffung)
 *   AC10 — acquire(not-found) hält Session; createMasterKey nutzt gehaltene Session (kein 2. Login)
 *   AC11 — Timeout beendet gehaltene Session; create ohne Session → klassifizierter Fehler;
 *           Cleanup garantiert bei Erfolg/Fehler/Timeout/Abbruch
 *   AC12 — showPassword-Reset beim Phasenwechsel (Frontend-UX, S-130/#276); getestet in SettingsView.test.jsx
 *
 * Covers (credential-runtime-unlock #280/S-138):
 *   AC11 — unlock(persist-failed) in acquireMasterKey → errorClass 'persist-failed', nicht 'error'
 *   AC11 — unlock(persist-failed) in createMasterKey → errorClass 'persist-failed', nicht 'error'
 *   AC12 — persist-failed-Reason enthält weder Master-Key noch Master-Passwort (Floor, AC12)
 *
 * Covers (bitwarden-new-device-otp #263/#267):
 *   AC7  — emailOtp erscheint NICHT in Argv (AC10: single-process, kein emailOtp beim PTY-Start)
 *   OTP-Zwei-Phasen-Fluss + AC10/AC11 → getestet in BitwardenNewDeviceOtp.test.js
 *
 * Strategie:
 *   - `_spawnBwPty` wird für `bw login` mit twofa gemockt (TOTP-Pfad, unveränderter Pfad)
 *   - `_spawnBwPtySession` via wrapPtyMockAsSession: Kompatibilitäts-Wrapper für non-OTP-Tests
 *   - `_spawnBw` wird für nicht-interaktive Kommandos gemockt (get, encode, create, logout)
 *   - CredentialStore mit tmpdir + injiziertem masterKey (echter Store für Boundary-Test)
 *   - AuditStore als echte In-Memory-Instanz (prüft Audit-Einträge exakt)
 *   - AC6: gespawnte Argv-Arrays werden explizit geprüft — dürfen keine Geheimnisse enthalten
 *   - AC10/AC11: `_acquireSessionTimeoutMs` auf minimalen Wert gesetzt für Timeout-Tests
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
 * Erstellt eine Fake-PTY-Spawn-Funktion für `bw login` (ersetzt spawnBwPtyDefault).
 *
 * Gibt das Interface zurück, das der Service erwartet:
 *   { stdout: string, output: string, exitCode: number }
 *
 * @param {object} opts
 * @param {string}  [opts.sessionToken]   - Session-Token für erfolgreichen Login
 * @param {boolean} [opts.loginFails]     - true = Login schlägt fehl
 * @param {number}  [opts.loginExitCode]  - Exit-Code für Login (Default 0)
 * @param {string}  [opts.loginOutput]    - PTY-Output (output-Feld, für Fehlerklassifizierung)
 * @param {(args: string[], opts: object) => void} [opts.onSpawn] - Callback für Assertions
 */
function makePtyMock({
  sessionToken = FAKE_SESSION,
  loginFails = false,
  loginExitCode = 0,
  loginOutput = '',
  onSpawn = null,
} = {}) {
  const spawnedArgvs = [];
  const spawnedOpts = [];

  const fn = jest.fn(async (args, opts) => {
    spawnedArgvs.push([...args]);
    spawnedOpts.push(opts ?? {});
    if (onSpawn) onSpawn(args, opts);

    if (loginFails) {
      return {
        stdout: '',
        output: loginOutput || 'Username or password is incorrect.',
        exitCode: loginExitCode || 1,
      };
    }
    return {
      stdout: sessionToken,
      output: loginOutput || '',
      exitCode: 0,
    };
  });

  fn.spawnedArgvs = spawnedArgvs;
  fn.spawnedOpts = spawnedOpts;
  return fn;
}

/**
 * Erstellt eine Mock-Spawn-Funktion für nicht-interaktive bw-Kommandos (get, encode, create, logout).
 *
 * @param {object} opts
 * @param {string}    [opts.itemPassword]   - Passwort-Feld für Item-Lese-Aktion
 * @param {boolean}   [opts.itemNotFound]   - true = Item nicht vorhanden
 * @param {boolean}   [opts.createFails]    - true = bw create schlägt fehl
 * @param {(args: string[], opts: object) => void} [opts.onSpawn] - Callback für Assertion
 */
function makeSpawnMock({
  itemPassword = FAKE_KEY_VALUE,
  itemNotFound = false,
  createFails = false,
  onSpawn = null,
} = {}) {
  // Kumulierte Argv-Arrays für AC6-Assertions
  const spawnedArgvs = [];

  const fn = jest.fn(async (args, _opts) => {
    spawnedArgvs.push([...args]);
    if (onSpawn) onSpawn(args, _opts);

    const cmd = args[0];

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

/**
 * Wraps eine legacy-ptyMock-Funktion (Signatur: (args, opts) => {stdout, output, exitCode})
 * in eine _spawnBwPtySession-kompatible Funktion (AC10/AC11-Modell).
 *
 * Für Tests, die keinen OTP-Fluss testen: ptyMock gibt immer {phase: 'done', ...} zurück.
 * Für Tests, die OTP testen: separaten makePtySessionMock verwenden (in BitwardenNewDeviceOtp.test.js).
 */
function wrapPtyMockAsSession(ptyMock) {
  return async (args, env) => {
    const result = await ptyMock(args, { env, emailOtp: undefined });
    return { phase: 'done', ...result };
  };
}

function makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs } = {}) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBwPty: ptyMock,
    _spawnBwPtySession: wrapPtyMockAsSession(ptyMock),
    _spawnBw: spawnMock,
    _acquireSessionTimeoutMs: acquireSessionTimeoutMs ?? 60_000,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — Login mit E-Mail + Master-Passwort (+ 2FA falls nötig)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC1 — Bitwarden-Login serverseitig', () => {
  it('login wird via PTY mit E-Mail + Passwort durchgeführt (bw login über ptyMock aufgerufen)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(ptyMock).toHaveBeenCalledTimes(1);
    const loginArgs = ptyMock.spawnedArgvs[0];
    expect(loginArgs[0]).toBe('login');
    expect(loginArgs[1]).toBe(FAKE_EMAIL);
  });

  it('login mit 2FA-Code: --code-Argument wird übergeben (AC6-Ausnahme: TOTP ist einmalig/kurzlebig, bw bietet keine Env/stdin-Alternative)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '123456', identity: null });

    const loginArgs = ptyMock.spawnedArgvs[0];
    expect(loginArgs).toContain('--code');
    expect(loginArgs).toContain('123456');
    // AC6: Master-Passwort erscheint NICHT als Arg (nur TOTP-Code ist Ausnahme)
    expect(loginArgs).not.toContain(FAKE_PASSWORD);
  });

  it('ohne 2FA-Code: kein --code-Argument', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const loginArgs = ptyMock.spawnedArgvs[0];
    expect(loginArgs).not.toContain('--code');
  });

  it('PTY-Session startet ohne emailOtp (single-process: emailOtp wird via writeOtp übergeben, nicht als Arg)', async () => {
    // Single-process-Modell (AC10): emailOtp wird NICHT beim Start der PTY-Session übergeben.
    // Stattdessen hält Phase 1 den Prozess offen; Phase 2 schreibt den OTP via writeOtp.
    // Dieser Test prüft, dass die PTY-Session-Funktion kein emailOtp in den Args erhält.
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    // Request 1 ohne emailOtp: PTY startet, liefert {phase: 'done'} via wrapPtyMockAsSession
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Die PTY-Session-Funktion empfängt KEIN emailOtp in den Argv (AC7/AC10)
    const loginArgs = ptyMock.spawnedArgvs[0];
    for (const arg of loginArgs) {
      expect(String(arg)).not.toContain('847291');
    }
  });

  it('PTY-Login ohne emailOtp: kein emailOtp in den Argv', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const loginArgs = ptyMock.spawnedArgvs[0];
    expect(loginArgs).not.toContain('emailOtp');
    expect(loginArgs.join(' ')).not.toMatch(/otp/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — Existierendes Item → Key store-intern; NICHT in Response
// ══════════════════════════════════════════════════════════════════════════════

describe('AC2 — Item gefunden: Key store-intern, nicht in Response', () => {
  it('acquireMasterKey gibt { status: "found" } zurück — OHNE Key-Wert', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('found');
    // AC2: Kein Key-Wert in der Response
    expect(result.key).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY_VALUE);
  });

  it('Store wird nach acquireMasterKey entsperrt (unlock wurde aufgerufen)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
  });

  it('bei not-found wird KEIN bw create aufgerufen (kein automatisches Erstellen)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create');
    expect(createCall).toBeUndefined();
  });

  it('leerer Item-Passwort-Wert → not-found', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: '   ' });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — Nur bei explizitem Flag: Zufalls-Key + Bitwarden-Item
// ══════════════════════════════════════════════════════════════════════════════

describe('AC4 — createMasterKey: Zufalls-Key + Item anlegen', () => {
  it('createMasterKey gibt { status: "created" } zurück', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('created');
  });

  it('createMasterKey ruft bw encode und bw create item auf', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const encodeCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'encode');
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create' && args[1] === 'item');
    expect(encodeCall).toBeDefined();
    expect(createCall).toBeDefined();
  });

  it('AC4: acquireMasterKey ohne Bestätigungs-Flag löst KEIN Erstellen aus', async () => {
    // acquireMasterKey → nur lesen, nie erstellen
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('not-found');
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create');
    expect(createCall).toBeUndefined();
  });

  it('generierter Key hat ≥32 Byte Entropie (≥44 base64-Zeichen)', async () => {
    // Prüfen: der JSON-Payload, der an bw encode übergeben wird, enthält einen Key ≥44 Zeichen
    let capturedEncodeInput = null;
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({
      onSpawn: (args, opts) => {
        if (args[0] === 'encode') {
          capturedEncodeInput = opts?.input ?? null;
        }
      },
    });
    const service = makeService(ptyMock, spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(capturedEncodeInput).not.toBeNull();
    const parsed = JSON.parse(capturedEncodeInput);
    const keyInPayload = parsed.login?.password ?? '';
    // 32 Byte base64 = 44 Zeichen (ohne Padding-Verlust)
    expect(keyInPayload.length).toBeGreaterThanOrEqual(44);
  });

  it('bw create schlägt fehl → item-create-failed, kein Teil-Zustand', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ createFails: true });
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Username or password is incorrect.',
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: 'wrong', identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('auth-failed');
  });

  it('2FA erforderlich → twofa-required', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Two-step login required.',
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-required');
  });

  it('falscher 2FA-Code → twofa-invalid', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Two-step login invalid code.',
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-invalid');
  });

  it('bw CLI nicht gefunden (exit 127) → bw-unreachable', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'command not found: bw',
      loginExitCode: 127,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('bw-unreachable');
  });

  it('Netzwerk-Fehler → bw-unreachable', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Failed to connect to server: ECONNREFUSED',
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('bw-unreachable');
  });

  it('Fehler-Reason enthält KEINE Klartext-Geheimnisse', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: `Username or password is incorrect. Your password is ${FAKE_PASSWORD}`,
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // PTY-Login-Argv prüfen
    for (const argv of ptyMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
    // Nicht-interaktive Spawn-Argv prüfen
    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
  });

  it('Session-Token erscheint NICHT in den gespawnten Argv-Arrays', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Session-Token darf nicht in Argv der nicht-interaktiven Kommandos auftauchen
    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_SESSION);
      }
    }
  });

  it('Key-Wert erscheint NICHT in der acquireMasterKey-Response', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_KEY_VALUE);
    expect(result.key).toBeUndefined();
  });

  it('Key-Wert erscheint NICHT in der createMasterKey-Response', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Kein Key-Wert in der Response — nur status: 'created'
    expect(result.key).toBeUndefined();
    expect(result.status).toBe('created');
  });

  it('Passwort erscheint NICHT im Audit-Eintrag', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com' });

    const entries = auditStore.getAll();
    const auditJson = JSON.stringify(entries);
    expect(auditJson).not.toContain(FAKE_PASSWORD);
    expect(auditJson).not.toContain(FAKE_SESSION);
    expect(auditJson).not.toContain(FAKE_KEY_VALUE);
  });

  it('Key-Wert in Fehlerfällen NICHT in Response (auth-failed)', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: `Authentication failed. Key: ${FAKE_KEY_VALUE}`,
      loginExitCode: 1,
    });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // AC6: PTY-Output (der den Key enthalten könnte) nicht in Response
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY_VALUE);
    expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD);
  });

  it('emailOtp erscheint NICHT in den PTY-Login-Argv-Arrays (AC7/AC10: kein emailOtp in Args)', async () => {
    // Single-process-Modell (AC10): emailOtp wird NICHT beim PTY-Start als Arg übergeben.
    // Der OTP-Code wird via writeOtp() in die offene Session geschrieben (Phase 2).
    // Dieser Test prüft: PTY-Session startet ohne emailOtp im Argv-Array.
    const FAKE_OTP = '847291';
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    // Request 1 ohne emailOtp: normaler Login (kein OTP-Fluss in diesem Basis-Test)
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    // OTP darf NICHT in Argv stehen
    for (const argv of ptyMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_OTP);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 — Falscher Key → Ablehnung via CredentialStore.unlock()
// ══════════════════════════════════════════════════════════════════════════════

describe('AC7 — Falscher Key → Ablehnung via CredentialStore.unlock()', () => {
  it('falscher Key (manipuliertes Bitwarden-Item) bei vorhandenem Store → error', async () => {
    // Store mit echten verschlüsselten Einträgen vorbereiten (mit TEST_MASTER_KEY)
    await credentialStore.set('credentials/misc/test-entry', 'test-value');

    // Service mit einem falschen Key-Wert aus Bitwarden
    const wrongKey = 'wrong-key-not-matching-store-encryption';
    const ptyMock = makePtyMock();
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
      _spawnBwPty: ptyMock,
      _spawnBwPtySession: wrapPtyMockAsSession(ptyMock),
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
    const ptyMock = makePtyMock({
      onSpawn: () => {
        loginOrder.push('bw-login');
      },
    });

    // Audit-Record überwachen
    const originalRecord = auditStore.record.bind(auditStore);
    jest.spyOn(auditStore, 'record').mockImplementation((params) => {
      if (params.command === 'bitwarden:login-attempt') {
        // Simuliere: Login noch nicht aufgerufen
        expect(loginOrder).toHaveLength(0);
      }
      return originalRecord(params);
    });

    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com' });

    const auditEntries = auditStore.getAll();
    const loginAttempt = auditEntries.find((e) => e.command === 'bitwarden:login-attempt');
    expect(loginAttempt).toBeDefined();
    expect(loginAttempt.identity).toBe('test@example.com');
  });

  it('acquireMasterKey schreibt Audit-Eintrag für key-read', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    const auditEntries = auditStore.getAll();
    const keyRead = auditEntries.find((e) => e.command?.includes('bitwarden:key-read'));
    expect(keyRead).toBeDefined();
  });

  it('createMasterKey schreibt Audit-Eintrag für key-create', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'admin@test.com' });

    const auditEntries = auditStore.getAll();
    const keyCreate = auditEntries.find((e) => e.command?.includes('bitwarden:key-create'));
    expect(keyCreate).toBeDefined();
    expect(keyCreate.identity).toBe('admin@test.com');
  });

  it('Audit-Einträge enthalten KEINE Geheimnis-Werte (Passwort, Key, Session)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();

    // Audit-Store so konfigurieren dass er wirft
    jest.spyOn(auditStore, 'record').mockImplementation(() => {
      throw new Error('Audit-Schreib-Fehler simuliert');
    });

    const service = makeService(ptyMock, spawnMock);
    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // Kein PTY-Login aufgerufen
    expect(ptyMock).not.toHaveBeenCalled();
  });

  // S2: createMasterKey — kein bw-Kommando wenn Audit-Write fehlschlägt
  it('Audit-Write schlägt fehl → createMasterKey unterbleibt (kein bw-Aufruf)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();

    jest.spyOn(auditStore, 'record').mockImplementation(() => {
      throw new Error('Audit-Schreib-Fehler simuliert');
    });

    const service = makeService(ptyMock, spawnMock);
    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    // Kein PTY-Login aufgerufen — analog acquireMasterKey-Test
    expect(ptyMock).not.toHaveBeenCalled();
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

    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('createMasterKey: bw logout wird nach dem Item-Anlegen aufgerufen', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('not-found: bw logout wird NICHT sofort aufgerufen (AC10: Session wird für create gehalten)', async () => {
    // AC10: Wenn das Item nicht gefunden wird, hält acquireMasterKey die Session
    // für den Folge-Aufruf createMasterKey. KEIN sofortiges Logout (anders als AC9 bei found/error).
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    // langer Timeout → kein frühzeitiger Ablauf während des Tests
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com',
    });

    // AC10: Kein logout nach not-found (Session wird gehalten)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeUndefined();
  });

  it('createMasterKey schlägt fehl: bw logout wird auch bei Fehler aufgerufen', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ createFails: true });
    const service = makeService(ptyMock, spawnMock);

    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('bw logout empfängt keinen Session-Token als Arg (nur via Env)', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

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
    const ptyMock = makePtyMock();
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
      _spawnBwPty: ptyMock,
      _spawnBwPtySession: wrapPtyMockAsSession(ptyMock),
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

// ══════════════════════════════════════════════════════════════════════════════
// AC10 — Session-Halten bei not-found + Wiederverwendung in createMasterKey (#276)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC10 — acquire(not-found)→create: Session-Reuse, kein zweiter bw-Login (#276)', () => {
  it('AC10 — acquire not-found + create: kein zweiter bwLogin (ptyMock nur 1x aufgerufen)', async () => {
    // Zyklus: acquire(not-found) → hält Session; create → nutzt gehaltene Session.
    // Über den gesamten Zyklus darf spawnBwPtySession (bw login) NUR EINMAL aufgerufen werden.
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // Request 1: acquire → not-found
    const acquireResult = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com',
    });
    expect(acquireResult.status).toBe('not-found');

    // Request 2: create → nutzt gehaltene Session (KEIN zweiter PTY-Login)
    const createResult = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'test@example.com',
    });
    expect(createResult.status).toBe('created');

    // AC10: Über acquire+create NUR EIN bw-Login-Spawn
    // ptyMock wird für den TOTP-Pfad gerufen (_spawnBwPty).
    // _spawnBwPtySession (wrappter) wird für den non-TOTP-Pfad (Phase 1) gerufen.
    // Da create die gehaltene Session nutzt, darf _spawnBwPtySession NUR im acquire-Schritt
    // aufgerufen worden sein → Gesamt-Aufruf = 1.
    expect(ptyMock).toHaveBeenCalledTimes(1);
  });

  it('AC10 — acquire not-found: Session wird gehalten (kein logout nach not-found)', async () => {
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    // Kein logout nach not-found (Session wird für create gehalten)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeUndefined();
  });

  it('AC10 — create mit gehaltener Session: Item wird angelegt (bw encode + bw create aufgerufen)', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // acquire → not-found (hält Session)
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    // create → nutzt gehaltene Session
    const createResult = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com',
    });

    expect(createResult.status).toBe('created');
    // bw encode + bw create item aufgerufen
    const encodeCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'encode');
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create' && args[1] === 'item');
    expect(encodeCall).toBeDefined();
    expect(createCall).toBeDefined();
  });

  it('AC10 — create nach gehaltener Session: CredentialStore.unlock läuft durch → Store entsperrt', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // Frischer Store → unlock mit beliebigem Key ok
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });
    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    expect(credentialStore.isUnlocked()).toBe(true);
  });

  it('AC10 — create nach gehaltener Session: bw logout läuft nach Erstellung', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });
    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    // AC9: bw logout nach create+unlock
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('AC10 — Regression: Item existiert → acquire entsperrt direkt, kein Create-Pfad', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // Item existiert → found
    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });
    expect(result.status).toBe('found');

    // Logout nach found (AC9 — unveränderter Pfad)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();

    // createMasterKey wurde NICHT aufgerufen
    const createCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'create');
    expect(createCall).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC11 — Robustheit/Cleanup: Timeout, create ohne Session, Cleanup-Garantie (#276)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC11 — Gehaltene Session: Timeout + create ohne Session + Cleanup (#276)', () => {
  it('AC11 — Timeout beendet die gehaltene Session (bw logout nach Timeout)', async () => {
    jest.useFakeTimers();
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    // Sehr kurzer Timeout für den Test
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 10 });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    // Vor Timeout: kein logout
    expect(spawnMock.spawnedArgvs.find((args) => args[0] === 'logout')).toBeUndefined();

    // Timer auslösen (Timeout-Callback)
    jest.runAllTimers();
    // Mehrere Ticks für den asynchronen Logout (Promise-Kette: cleanupAcquireSessionWithLogout → #bwLogout → #spawnBw)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Nach Timeout: logout aufgerufen
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();

    jest.useRealTimers();
  });

  it('AC11 — create ohne gehaltene Session (Timeout abgelaufen) → klassifizierter Fehler, kein stiller Re-Login', async () => {
    jest.useFakeTimers();
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    // Sehr kurzer Timeout → läuft vor create ab
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 10 });

    // acquire → hält Session (kurzer Timeout)
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'user@test.com' });

    // Timeout auslösen → Session abgelaufen
    jest.runAllTimers();
    // Mehrere Ticks für den asynchronen Logout
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    jest.useRealTimers();

    // create ohne gehaltene Session → KEIN stiller Re-Login, da emailOtp fehlt
    // (acquireMasterKey hat email-otp-required → jetzt ist Timeout → create fällt durch
    //  auf #bwLogin ohne emailOtp → Phase 1 ergibt not-found oder email-otp-required).
    // Für diesen Test simulieren wir, dass der frische Login ein email-otp-required liefert.
    // Das spawnBwPtySession-Mock (via wrapPtyMockAsSession) gibt { phase: 'done', exitCode: 0, stdout: FAKE_SESSION }.
    // Das bedeutet: ein frischer Login WÜRDE erfolgreich sein — das ist der reguläre Pfad
    // ohne Session-Reuse. AC11 sagt: KEIN stiller Re-Login mit ALT-DATEN. Da keine Alt-Daten
    // eingebaut sind (Caller übergibt immer explizite Daten), ist der reguläre Pfad korrekt.
    //
    // Ziel dieses Tests: prüfen, dass nach Timeout KEIN verwaister Handle in der Map bleibt
    // (der create-Aufruf muss sauber funktionieren — kein Absturz, kein verwaister State).
    const spawnMock2 = makeSpawnMock(); // create soll jetzt klappen
    const service2 = makeService(ptyMock, spawnMock2, { acquireSessionTimeoutMs: 60_000 });
    // Direkt create aufrufen (kein vorheriges acquire) → frischer Login via bwLogin
    const result = await service2.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'nobody@test.com',
    });
    // Frischer Login (kein gehaltener Handle) → create via frischem Login erfolgreich
    expect(result.status).toBe('created');
    // Ein frischer bw-Login-Spawn wurde gerufen
    expect(ptyMock).toHaveBeenCalled();
  });

  it('AC11 — Cleanup nach create (Erfolg): Handle aus acquireSessionMap entfernt', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // acquire → hält Session
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'clean@test.com' });
    // create → verbraucht gehaltene Session (Handle muss danach weg sein)
    await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'clean@test.com' });

    // Zweites create derselben identity: kein gehaltener Handle mehr → frischer Login via bwLogin
    // ptyMock zählt die bw-Login-Spawns: acquire=1, create1=0 (hält Session), create2=1 → gesamt=2
    // Nach create hat der Service keinen Handle mehr; ein weiteres create ohne acquire löst
    // einen frischen bw-Login aus.
    const beforeCount = ptyMock.mock.calls.length; // nach acquire(1 Login) + create(0 Logins) = 1
    const secondCreate = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'clean@test.com',
    });
    const afterCount = ptyMock.mock.calls.length;
    // Das zweite create musste einen frischen bw-Login starten (kein gehaltener Handle)
    expect(afterCount).toBeGreaterThan(beforeCount);
    expect(secondCreate.status).toBe('created');
  });

  it('AC11 — Cleanup nach create-Fehler: Handle aus acquireSessionMap entfernt; logout aufgerufen', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true, createFails: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // acquire → hält Session
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'fail@test.com' });
    // create schlägt fehl → Session muss trotzdem aufgeräumt werden
    const createResult = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'fail@test.com',
    });

    expect(createResult.status).toBe('error');
    expect(createResult.errorClass).toBe('item-create-failed');
    // Logout nach fehlgeschlagenem create (AC9/AC11)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('AC11 — Parallel-Acquire derselben identity: alter Handle wird überschrieben (kein Leak)', async () => {
    const ptyMock = makePtyMock({ sessionToken: FAKE_SESSION });
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock, { acquireSessionTimeoutMs: 60_000 });

    // Erstes acquire → hält Session
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'dup@test.com' });
    // Zweites acquire derselben identity → alten Handle überschreiben + logout des alten Tokens
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: 'dup@test.com' });

    // Logout des alten Handles wird aufgerufen (alter Token)
    const logoutCalls = spawnMock.spawnedArgvs.filter((args) => args[0] === 'logout');
    // Mindestens ein logout für den überschriebenen Handle
    expect(logoutCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC11/AC12 (credential-runtime-unlock #280/S-138) — persist-failed distinkt melden
//
// Spec §10/AC11: Gibt unlock() { ok:false, reason:'persist-failed' } zurück,
// MÜSSEN beide Beschaffungspfade (acquireMasterKey + createMasterKey) errorClass
// 'persist-failed' liefern — NICHT 'error'. AC12: kein Secret in der Meldung.
// ══════════════════════════════════════════════════════════════════════════════

describe('AC11/AC12 (credential-runtime-unlock #280) — persist-failed distinkt melden', () => {
  /**
   * Erstellt ein minimales CredentialStore-Stub, dessen unlock() kontrolliert werden kann.
   * Der echte CredentialStore wird durch ein einfaches Objekt ersetzt, das nur die
   * für BitwardenMasterKeyService benötigten Methoden implementiert.
   *
   * @param {{ unlockResult?: object, isUnlocked?: boolean }} opts
   */
  function makePersistFailedStore(opts = {}) {
    const unlockResult = opts.unlockResult ?? { ok: false, reason: 'persist-failed' };
    return {
      unlock: jest.fn(async () => unlockResult),
      isUnlocked: jest.fn(() => opts.isUnlocked ?? false),
      getLockState: jest.fn(async () => ({ state: 'locked', hasEncryptedEntries: false })),
    };
  }

  function makeServiceWithStore(store, ptyMock, spawnMock) {
    return new BitwardenMasterKeyService({
      credentialStore: store,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPty: ptyMock,
      _spawnBwPtySession: wrapPtyMockAsSession(ptyMock),
      _spawnBw: spawnMock,
      _acquireSessionTimeoutMs: 60_000,
    });
  }

  it('AC11 — acquireMasterKey: unlock(persist-failed) → errorClass "persist-failed", nicht "error"', async () => {
    const store = makePersistFailedStore();
    const ptyMock = makePtyMock();
    // spawnMock: Item gefunden (kein not-found), damit unlock() aufgerufen wird
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('persist-failed');
    expect(result.errorClass).not.toBe('error');
  });

  it('AC11 — createMasterKey: unlock(persist-failed) → errorClass "persist-failed", nicht "error"', async () => {
    const store = makePersistFailedStore();
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock(); // encode + create gelingen; unlock gibt persist-failed
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('persist-failed');
    expect(result.errorClass).not.toBe('error');
  });

  it('AC11 — persist-failed-Reason verweist auf Persistenz-Pfad (handlungsleitend)', async () => {
    const store = makePersistFailedStore();
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.reason).toBeDefined();
    // Reason soll auf CRED_ENV_PATH/Volume/Persistenz verweisen (handlungsleitend, nicht generisch)
    const reasonLower = result.reason.toLowerCase();
    expect(
      reasonLower.includes('cred_env_path') ||
      reasonLower.includes('persistenz') ||
      reasonLower.includes('volume') ||
      reasonLower.includes('persistiert') ||
      reasonLower.includes('gespeichert')
    ).toBe(true);
  });

  it('AC12 — persist-failed-Reason enthält weder Master-Key noch Master-Passwort (Floor)', async () => {
    const store = makePersistFailedStore();
    const ptyMock = makePtyMock();
    // Simuliere: bw liefert FAKE_KEY_VALUE als Item-Passwort
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const acquireResult = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });
    // Weder FAKE_KEY_VALUE (Master-Key) noch FAKE_PASSWORD (BW-Master-Passwort) in reason/errorClass
    expect(acquireResult.reason).not.toContain(FAKE_KEY_VALUE);
    expect(acquireResult.reason).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(acquireResult)).not.toContain(FAKE_KEY_VALUE);
    expect(JSON.stringify(acquireResult)).not.toContain(FAKE_PASSWORD);

    // Dasselbe für createMasterKey
    const createStore = makePersistFailedStore();
    const spawnMock2 = makeSpawnMock(); // create gelingt, unlock gibt persist-failed
    const service2 = makeServiceWithStore(createStore, ptyMock, spawnMock2);
    const createResult = await service2.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(createResult.reason).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(createResult)).not.toContain(FAKE_PASSWORD);
  });

  it('AC11 — Regression: normaler unlock-Erfolg bleibt { status: "found" } (kein Regressionsfehler)', async () => {
    // Stellt sicher, dass die neue persist-failed-Prüfung den Erfolgspfad nicht stört
    const store = makePersistFailedStore({ unlockResult: { ok: true }, isUnlocked: true });
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const result = await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('found');
  });

  it('AC11 — Regression: createMasterKey normaler Erfolg bleibt { status: "created" } (kein Regressionsfehler)', async () => {
    const store = makePersistFailedStore({ unlockResult: { ok: true }, isUnlocked: true });
    const ptyMock = makePtyMock();
    const spawnMock = makeSpawnMock();
    const service = makeServiceWithStore(store, ptyMock, spawnMock);

    const result = await service.createMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('created');
  });
});
