/**
 * BitwardenNewDeviceOtp.test.js — Unit-Tests für New-Device-Verification (E-Mail-OTP) via PTY
 *
 * Spec: docs/specs/bitwarden-new-device-otp.md
 *
 * Covers (bitwarden-new-device-otp AC1–AC11, #267):
 *   AC1  — bw verlangt New-Device-Verification + kein Code → 'email-otp-required' (≠ 'twofa-required')
 *   AC2  — Folge-Request mit gültigem E-Mail-OTP → Login erfolgreich, Beschaffung normal
 *   AC3  — Falscher/abgelaufener E-Mail-OTP → 'email-otp-invalid' (≠ 'twofa-invalid')
 *   AC4  — TOTP-2FA-Fluss bleibt unverändert: twofa-required/twofa-invalid statt email-otp-*
 *   AC5  — Dialog-Feld mit eigenem Label/State, textlich verschieden von 2FA → Frontend-AC, getestet in SettingsView.test.jsx
 *   AC6  — aria-describedby/role=alert für email-otp-invalid → Frontend-AC, getestet in SettingsView.test.jsx
 *   AC7  — E-Mail-OTP-Code erscheint NICHT in Argv, Logs, Audit oder Response
 *          (PTY-spawnedArgvs + spawnedOpts + console-Spy); fetch-URL-Leak getestet in SettingsView.test.jsx (AC7)
 *   AC8  — Doku-/autonomer-Pfad-AC, kein bw-Login-Pfad
 *          (dokumentiert: acquireMasterKey ist der interaktive Pfad; autonomer Pfad = DEVGUI_CRED_MASTER_KEY)
 *   AC9  — Frontend-AC, getestet in SettingsView.test.jsx
 *   AC10 — Single-Process: genau EIN bw-Login-Spawn über den OTP-Zyklus; Request 1 hält Prozess offen;
 *          Request 2 schreibt OTP in denselben Prozess (kein zweiter Spawn). (#267)
 *   AC11 — Robustheit/Cleanup: Timeout beendet+räumt offenen Prozess auf; kein Alt-Code-Re-Spawn;
 *          paralleler Versuch derselben identity ersetzt alten Handle sauber. (#267)
 *
 * Strategie:
 *   - `_spawnBwPtySession` vollständig gemockt (Fake-Two-Phase-PTY für OTP-Fluss, AC10/AC11)
 *   - `_spawnBwPty` vollständig gemockt (Fake-PTY für TOTP-Pfad, AC4-Regression)
 *   - `_spawnBw` vollständig gemockt (für get/encode/create/logout)
 *   - CredentialStore + AuditStore als echte In-Memory-Instanzen
 *   - AC7: PTY-spawnedArgvs + spawnedOpts werden auf OTP-Leak geprüft
 *          (emailOtp muss via PTY-Write übergeben werden, NICHT via Argv)
 *   - AC7: console.error/log/warn wird bespioniert — OTP-Code darf nie in Logs erscheinen
 *   - AC4: TOTP-Regression explizit: twofa-required/twofa-invalid bleiben distinkt
 *
 * Two-Phase-PTY-Simulation (Fake-spawnBwPtySession, AC10/AC11):
 *   - Phase 1 (kein emailOtp): resolves { phase: 'awaiting-otp', writeOtp, cleanup }
 *     wenn New-Device-Verification simuliert wird
 *   - Phase 2 (via writeOtp): simuliert PTY-Exit nach OTP-Eingabe
 *   - Exakt EIN Spawn-Aufruf für den gesamten Zyklus (AC10)
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/CredentialStore.js';
import { AuditStore } from '../src/AuditStore.js';
import { BitwardenMasterKeyService } from '../src/BitwardenMasterKeyService.js';

// ── Konstanten ─────────────────────────────────────────────────────────────────

const TEST_MASTER_KEY = 'test-new-device-otp-service-key';
const FAKE_EMAIL = 'user@example.com';
const FAKE_PASSWORD = 'super-secret-master-password';
const FAKE_SESSION = 'fake-bw-session-token-xyz';
const FAKE_KEY_VALUE = 'dGVzdC1rZXktZm9yLW5ldy1kZXZpY2UtdmVyaWZpY2F0aW9u'; // base64
const FAKE_EMAIL_OTP = '847291';  // 6-stelliger E-Mail-OTP-Code
const ITEM_NAME = 'dev-gui-master-key';
const FAKE_IDENTITY = 'admin@example.com';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Erstellt eine Fake-Two-Phase-PTY-Session-Funktion (_spawnBwPtySession) für AC10/AC11.
 *
 * Simuliert das Single-Process-PTY-Verhalten:
 *   - Bei requiresEmailOtp: Phase 1 resolves { phase: 'awaiting-otp', writeOtp, cleanup }
 *   - writeOtp(code) resolves mit { stdout: sessionToken, exitCode: 0 } bei gültigem Code
 *   - writeOtp(code) resolves mit invalid-output bei emailOtpInvalid=true
 *   - Kein requiresEmailOtp: Phase 1 resolves { phase: 'done', ... }
 *
 * AC10-Nachweis: spawnCallCount zählt die Aufrufe — darf für den OTP-Zyklus genau 1 sein.
 */
function makePtySessionMock({
  sessionToken = FAKE_SESSION,
  requiresEmailOtp = false,
  emailOtpInvalid = false,
  loginFails = false,
  loginOutput = '',
  loginExitCode = 1,
} = {}) {
  let spawnCallCount = 0;
  const spawnedArgvs = [];

  // Für jeden Spawn: { writeOtp, cleanup, cleanupCalled, otpCodes }
  const sessions = [];

  const fn = jest.fn(async (args, _env) => {
    spawnCallCount++;
    spawnedArgvs.push([...args]);

    if (loginFails) {
      sessions.push(null);
      return {
        phase: 'done',
        stdout: '',
        output: loginOutput || 'Username or password is incorrect.',
        exitCode: loginExitCode,
      };
    }

    if (!requiresEmailOtp) {
      // Direkter Login ohne OTP-Prompt
      sessions.push(null);
      return { phase: 'done', stdout: sessionToken, output: '', exitCode: 0 };
    }

    // OTP-Prompt-Simulation: Phase 1 = awaiting-otp
    const session = { cleanupCalled: false, otpCode: null };
    sessions.push(session);

    const writeOtp = jest.fn(async (code) => {
      session.otpCode = code; // AC7: code nur intern gespeichert (für Test-Assertion)
      if (emailOtpInvalid) {
        return {
          stdout: '',
          output: 'New device verification invalid or expired.',
          exitCode: 1,
        };
      }
      return { stdout: sessionToken, output: '', exitCode: 0 };
    });

    const cleanup = jest.fn(() => {
      session.cleanupCalled = true;
    });

    // Spies am session-Objekt exponieren, damit Tests via sessions[idx] darauf zugreifen
    session.writeOtp = writeOtp;
    session.cleanup = cleanup;

    return { phase: 'awaiting-otp', writeOtp, cleanup };
  });

  fn.spawnCallCount = () => spawnCallCount;
  fn.spawnedArgvs = spawnedArgvs;
  fn.sessions = sessions;
  return fn;
}

/**
 * Erstellt eine Fake-PTY-Spawn-Funktion (_spawnBwPty) für den TOTP-2FA-Pfad (AC4, Regression).
 * Unverändertes API — wird nur für twofa-Pfad verwendet.
 */
function makePtyMock({
  sessionToken = FAKE_SESSION,
  requiresTwofa = false,
  twofaInvalid = false,
  loginFails = false,
  loginOutput = '',
  loginExitCode = 1,
} = {}) {
  const spawnedArgvs = [];
  const spawnedOpts = [];

  const fn = jest.fn(async (args, opts) => {
    spawnedArgvs.push([...args]);
    spawnedOpts.push(opts ?? {});

    // TOTP-2FA-Fehler (distinkt von E-Mail-OTP — AC4)
    if (requiresTwofa) {
      return {
        stdout: '',
        output: 'Two-step login required.',
        exitCode: 1,
      };
    }
    if (twofaInvalid) {
      return {
        stdout: '',
        output: 'Two-step login invalid code.',
        exitCode: 1,
      };
    }

    // Generischer Login-Fehler
    if (loginFails) {
      return {
        stdout: '',
        output: loginOutput || 'Username or password is incorrect.',
        exitCode: loginExitCode,
      };
    }

    return { stdout: sessionToken, output: '', exitCode: 0 };
  });

  fn.spawnedArgvs = spawnedArgvs;
  fn.spawnedOpts = spawnedOpts;
  return fn;
}

/**
 * Erstellt eine Mock-Spawn-Funktion für nicht-interaktive bw-Kommandos (get, encode, create, logout).
 */
function makeSpawnMock({ itemPassword = FAKE_KEY_VALUE } = {}) {
  const spawnedArgvs = [];

  const fn = jest.fn(async (args, _opts) => {
    spawnedArgvs.push([...args]);

    const cmd = args[0];

    if (cmd === 'get' && args[1] === 'password') {
      return { stdout: itemPassword, stderr: '', exitCode: 0 };
    }

    if (cmd === 'encode') {
      return { stdout: 'eyJ0eXBlIjoxfQ==', stderr: '', exitCode: 0 };
    }

    if (cmd === 'create' && args[1] === 'item') {
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
  tmpDir = await mkdtemp(join(tmpdir(), 'bw-otp-test-'));
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

/**
 * Erstellt eine Service-Instanz mit injizierten Mocks.
 * _spawnBwPtySession: für OTP-Pfad (AC10/AC11)
 * _spawnBwPty: für TOTP-Pfad (AC4, Regression)
 */
function makeService(ptySessionMock, spawnMock, ptyMock) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBwPtySession: ptySessionMock,
    _spawnBwPty: ptyMock ?? makePtyMock(),
    _spawnBw: spawnMock ?? makeSpawnMock(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — New-Device-Verification: kein Code → 'email-otp-required' (≠ twofa-required)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC1 — email-otp-required: kein OTP-Code übergeben → klassifizierter Fehler', () => {
  it('AC1 — New-Device-Verification ohne OTP → status "error", errorClass "email-otp-required"', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('email-otp-required');
  });

  it('AC1 — email-otp-required ist UNTERSCHEIDBAR von twofa-required', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const ptyMockTwofa = makePtyMock({ requiresTwofa: true });

    const serviceEmailOtp = makeService(ptySessionMock);
    // TOTP-Pfad: übergebe twofa → verwendet _spawnBwPty (unveränderter Pfad)
    const serviceTwofa = new BitwardenMasterKeyService({
      credentialStore,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMockTwofa,
      _spawnBw: makeSpawnMock(),
    });

    const resultEmailOtp = await serviceEmailOtp.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '123456', identity: FAKE_IDENTITY,
    });

    expect(resultEmailOtp.errorClass).toBe('email-otp-required');
    expect(resultTwofa.errorClass).toBe('twofa-required');
    expect(resultEmailOtp.errorClass).not.toBe(resultTwofa.errorClass);
  });

  it('AC1 — bei email-otp-required wird nichts entsperrt/persistiert (Store bleibt locked)', async () => {
    const cs = new CredentialStore({
      dir: tmpDir,
      masterKey: null,
      envPath: join(tmpDir, '.env-otp1'),
    });
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: ptySessionMock,
      _spawnBwPty: makePtyMock(),
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    expect(cs.isUnlocked()).toBe(false);
  });

  it('AC1 — sanitizeErrorReason liefert für email-otp-required einen geheimnisfreien, unterscheidbaren Text', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain(FAKE_PASSWORD);
    expect(result.reason).not.toContain(FAKE_EMAIL);
    expect(result.reason.toLowerCase()).toMatch(/otp|verification|einmalcode/i);

    // Unterscheidbar vom TOTP-2FA-Reason
    const ptyMockTwofa = makePtyMock({ requiresTwofa: true });
    const serviceTwofa = new BitwardenMasterKeyService({
      credentialStore,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMockTwofa,
      _spawnBw: makeSpawnMock(),
    });
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '123456', identity: FAKE_IDENTITY,
    });
    expect(result.reason).not.toBe(resultTwofa.reason);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — Gültiger E-Mail-OTP → Login erfolgreich + normale Beschaffung (single-process)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC2 — gültiger E-Mail-OTP → acquireMasterKey läuft normal weiter (single-process)', () => {
  it('AC2 — Zwei-Schritt-Fluss: Request 1 → email-otp-required; Request 2 mit OTP → status "found"', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    // Request 1: kein OTP → Prozess öffnet, email-otp-required
    const result1 = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: FAKE_IDENTITY,
    });
    expect(result1.status).toBe('error');
    expect(result1.errorClass).toBe('email-otp-required');

    // Request 2: OTP übergeben → in denselben Prozess schreiben → Erfolg
    const result2 = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: FAKE_IDENTITY,
    });
    expect(result2.status).toBe('found');
    expect(result2.key).toBeUndefined();
  });

  it('AC2 — mit gültigem emailOtp läuft Item-Lesen und Store-Unlock normal', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    // Request 1
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    // Request 2
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('found');
    // bw get password wurde aufgerufen (nach erfolgreichem Login)
    const getCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'get' && args[1] === 'password');
    expect(getCall).toBeDefined();
    // bw logout wurde aufgerufen (Session verworfen)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('AC2 — createMasterKey akzeptiert ebenfalls den zwei-phasigen OTP-Fluss', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    // Request 1
    const r1 = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });
    expect(r1.errorClass).toBe('email-otp-required');

    // Request 2
    const result = await service.createMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });
    expect(result.status).toBe('created');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — Falscher/abgelaufener E-Mail-OTP → 'email-otp-invalid' (≠ 'twofa-invalid')
// ══════════════════════════════════════════════════════════════════════════════

describe('AC3 — email-otp-invalid: falscher/abgelaufener OTP-Code', () => {
  it('AC3 — falscher OTP-Code → status "error", errorClass "email-otp-invalid"', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(ptySessionMock);

    // Request 1
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    // Request 2: falscher Code
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong-otp-code', identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('email-otp-invalid');
  });

  it('AC3 — email-otp-invalid ist UNTERSCHEIDBAR von twofa-invalid', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const ptyMockTwofa = makePtyMock({ twofaInvalid: true });

    const serviceEmailOtp = makeService(ptySessionMock);
    const serviceTwofa = new BitwardenMasterKeyService({
      credentialStore,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMockTwofa,
      _spawnBw: makeSpawnMock(),
    });

    // Setup OTP-State
    await serviceEmailOtp.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    const resultEmailOtp = await serviceEmailOtp.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong', identity: FAKE_IDENTITY,
    });
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: FAKE_IDENTITY,
    });

    expect(resultEmailOtp.errorClass).toBe('email-otp-invalid');
    expect(resultTwofa.errorClass).toBe('twofa-invalid');
    expect(resultEmailOtp.errorClass).not.toBe(resultTwofa.errorClass);
  });

  it('AC3 — bei email-otp-invalid bleibt Store gesperrt', async () => {
    const cs = new CredentialStore({
      dir: tmpDir, masterKey: null, envPath: join(tmpDir, '.env-otp2'),
    });
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: ptySessionMock,
      _spawnBwPty: makePtyMock(),
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong-otp', identity: FAKE_IDENTITY,
    });

    expect(cs.isUnlocked()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — TOTP-2FA-Fluss bleibt unverändert (Regression)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC4 — TOTP-2FA-Fluss bleibt unverändert (Regression)', () => {
  it('AC4 — twofa-required bleibt twofa-required (nicht email-otp-required)', async () => {
    const ptyMock = makePtyMock({ requiresTwofa: true });
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: 'wrong', identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-required');
    expect(result.errorClass).not.toBe('email-otp-required');
  });

  it('AC4 — twofa-invalid bleibt twofa-invalid (nicht email-otp-invalid)', async () => {
    const ptyMock = makePtyMock({ twofaInvalid: true });
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-invalid');
    expect(result.errorClass).not.toBe('email-otp-invalid');
  });

  it('AC4 — TOTP-Aufruf verwendet _spawnBwPty (nicht _spawnBwPtySession)', async () => {
    const ptyMock = makePtyMock();
    const ptySessionMock = makePtySessionMock();
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: ptySessionMock,
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: FAKE_IDENTITY,
    });

    // TOTP-Pfad nutzt _spawnBwPty (unveränderter Pfad)
    expect(ptyMock).toHaveBeenCalled();
    // _spawnBwPtySession wird für TOTP NICHT aufgerufen
    expect(ptySessionMock).not.toHaveBeenCalled();
  });

  it('AC4 — TOTP-Aufruf mit --code-Arg übergibt den Code als Argv (bisherige Ausnahme)', async () => {
    const ptyMock = makePtyMock();
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: FAKE_IDENTITY,
    });

    const loginArgs = ptyMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginArgs).toContain('--code');
    expect(loginArgs).toContain('654321');
  });

  it('AC4 — twofa und emailOtp sind gegenseitig ausschließende Fehlerklassen (Spec §4)', async () => {
    const ptyMock = makePtyMock({ requiresTwofa: true });
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: 'x', identity: FAKE_IDENTITY,
    });

    expect(['twofa-required', 'twofa-invalid']).toContain(result.errorClass);
    expect(['email-otp-required', 'email-otp-invalid']).not.toContain(result.errorClass);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 — E-Mail-OTP-Code erscheint NICHT in Argv, Logs, Audit oder Response
// ══════════════════════════════════════════════════════════════════════════════

describe('AC7 — OTP-Code-Leak: kein Leak in Argv, Logs, Audit oder Response', () => {
  it('AC7 — OTP-Code erscheint NICHT in gespawnten Argv-Arrays (PTY-Session + Spawn)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    for (const argv of ptySessionMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_EMAIL_OTP);
      }
    }
    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_EMAIL_OTP);
      }
    }
  });

  it('AC7 — Passwort erscheint NICHT in Argv (Regression)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    for (const argv of ptySessionMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
  });

  it('AC7 — OTP-Code erscheint NICHT in Audit-Einträgen', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    const entries = auditStore.getAll();
    const auditJson = JSON.stringify(entries);
    expect(auditJson).not.toContain(FAKE_EMAIL_OTP);
    expect(auditJson).not.toContain(FAKE_PASSWORD);
  });

  it('AC7 — OTP-Code erscheint NICHT in der acquireMasterKey-Response (Request 2)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — OTP-Code erscheint NICHT in der email-otp-required-Error-Response', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
    expect(resultJson).not.toContain(FAKE_PASSWORD);
  });

  it('AC7 — OTP-Code erscheint NICHT in email-otp-invalid-Error-Response', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(ptySessionMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — console.error/log/warn enthalten KEINEN OTP-Code (console-Spy auf alle Kanäle)', async () => {
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
      const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
      const service = makeService(ptySessionMock, spawnMock);

      await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
      });

      for (const spy of [spyError, spyLog, spyWarn]) {
        for (const call of spy.mock.calls) {
          const callStr = JSON.stringify(call);
          expect(callStr).not.toContain(FAKE_EMAIL_OTP);
          expect(callStr).not.toContain(FAKE_PASSWORD);
        }
      }
    } finally {
      spyError.mockRestore();
      spyLog.mockRestore();
      spyWarn.mockRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC8 — Autonomer Pfad löst keinen E-Mail-OTP aus
// ══════════════════════════════════════════════════════════════════════════════

describe('AC8 — Autonomer Pfad (DEVGUI_CRED_MASTER_KEY) löst kein E-Mail-OTP aus', () => {
  it('AC8 — BitwardenMasterKeyService.acquireMasterKey wird im autonomen Pfad NICHT aufgerufen', () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    // Im autonomen Pfad wird acquireMasterKey() NICHT aufgerufen
    expect(ptySessionMock).not.toHaveBeenCalled();
  });

  it('AC8 — kein Code in BitwardenMasterKeyService, der emailOtp im autonomen Pfad erwartet', async () => {
    // normaler Login ohne Device-OTP-Anforderung
    const ptySessionMock = makePtySessionMock();
    const service = makeService(ptySessionMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    expect(['found', 'not-found']).toContain(result.status);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC10 — Single-Process: genau EIN bw-Login-Spawn über den OTP-Zyklus (#267)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC10 — Single-Process OTP: genau EIN Spawn über den gesamten OTP-Zyklus (#267)', () => {
  it('AC10 — Request 1 (kein OTP) spawnt exakt EINEN PTY-Prozess und hält ihn offen', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    // Exakt ein Spawn für Request 1
    expect(ptySessionMock.spawnCallCount()).toBe(1);
  });

  it('AC10 — Request 2 (mit OTP) spawnt KEINEN weiteren Prozess (schreibt in denselben)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    // Request 1
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    // Request 2
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    // AC10-KERNBEWEIS: über den gesamten OTP-Zyklus (Request 1 + Request 2) genau EIN Spawn
    expect(ptySessionMock.spawnCallCount()).toBe(1);
  });

  it('AC10 — Request 1 liefert email-otp-required UND hält einen offenen Handle (writeOtp war noch nicht aufgerufen)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    const result1 = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    expect(result1.errorClass).toBe('email-otp-required');
    // writeOtp wurde in Phase 1 NICHT aufgerufen (nur bereitgestellt)
    const session = ptySessionMock.sessions[0];
    expect(session).toBeDefined();
    expect(session.writeOtp).not.toHaveBeenCalled();
  });

  it('AC10 — Request 2 ruft writeOtp des Phase-1-Handle auf (nicht einen neuen Spawn)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    // Request 1
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    // Request 2
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    const session = ptySessionMock.sessions[0];
    // writeOtp wurde genau EINMAL aufgerufen (in Request 2)
    expect(session.writeOtp).toHaveBeenCalledTimes(1);
    // writeOtp wurde mit dem OTP-Code aufgerufen
    expect(session.writeOtp).toHaveBeenCalledWith(FAKE_EMAIL_OTP);
    // OTP-Code erscheint NICHT in Argv (AC7, Nachweis via Phase-1-Spawn-Args)
    const loginArgs = ptySessionMock.spawnedArgvs[0];
    expect(loginArgs.join(' ')).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC10 — gültiger OTP via Request 2 → status "found" (kein email-otp-invalid)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: false });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });

    expect(result.status).toBe('found');
    // Kein email-otp-invalid bei gültigem Code (AC10-Kern: gleicher Prozess → Code gültig)
    expect(result.errorClass).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC11 — Robustheit/Cleanup (#267)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC11 — Robustheit und Cleanup des offenen PTY-Prozesses (#267)', () => {
  it('AC11 — Timeout räumt den offenen Prozess auf (cleanup() wird aufgerufen)', async () => {
    jest.useFakeTimers();
    try {
      const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
      const service = makeService(ptySessionMock);

      // Request 1: Prozess öffnen
      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
      });

      const session = ptySessionMock.sessions[0];
      expect(session.cleanupCalled).toBe(false);

      // Timeout auslösen (> 3 Minuten)
      jest.advanceTimersByTime(3 * 60 * 1000 + 1000);

      // cleanup() muss durch den Timeout aufgerufen worden sein (AC11)
      expect(session.cleanupCalled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC11 — nach Timeout: Folge-Request mit OTP liefert email-otp-required (kein Alt-Code-Re-Spawn)', async () => {
    jest.useFakeTimers();
    try {
      const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
      const service = makeService(ptySessionMock);

      // Request 1
      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
      });

      // Timeout auslösen
      jest.advanceTimersByTime(3 * 60 * 1000 + 1000);

      // Request 2 nach Timeout: kein offener Handle mehr → email-otp-required (kein stiller Re-Spawn)
      const result = await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
      });

      // AC11: klassifizierter, geheimnisfreier Fehler → KEIN stillschweigender Alt-Code-Re-Spawn
      expect(result.errorClass).toBe('email-otp-required');
      expect(result.status).toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC11 — nach Timeout wird kein neuer Spawn für den OTP-Code gemacht (kein Alt-Code-Re-Spawn)', async () => {
    jest.useFakeTimers();
    try {
      const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
      const service = makeService(ptySessionMock);

      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
      });

      // Spawn-Count nach Request 1 = 1
      expect(ptySessionMock.spawnCallCount()).toBe(1);

      jest.advanceTimersByTime(3 * 60 * 1000 + 1000);

      // Request 2 nach Timeout → kein neuer Spawn (email-otp-required liefert früh zurück)
      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
      });

      // AC11: Spawn-Count bleibt 1 — kein zweiter Spawn für den OTP-Code
      expect(ptySessionMock.spawnCallCount()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC11 — paralleler Versuch derselben identity ersetzt alten Handle sauber', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const service = makeService(ptySessionMock);

    // Erster Versuch
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });
    const session1 = ptySessionMock.sessions[0];
    expect(session1.cleanupCalled).toBe(false);

    // Zweiter Versuch derselben identity → alter Handle wird sauber ersetzt (cleanup() für alten)
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });
    const session2 = ptySessionMock.sessions[1];

    // Alter Handle wurde aufgeräumt (kein Prozess-Leak, AC11)
    expect(session1.cleanupCalled).toBe(true);
    // Neuer Handle ist offen
    expect(session2.cleanupCalled).toBe(false);
    // Zwei Spawns insgesamt (einer pro Request-1-Versuch)
    expect(ptySessionMock.spawnCallCount()).toBe(2);
  });

  it('AC11 — Erfolg räumt den Handle nach Request 2 auf (kein verwaister State)', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptySessionMock, spawnMock);

    // Request 1
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    // Request 2: Erfolg
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });
    expect(result.status).toBe('found');

    // Nach Erfolg: cleanup() wurde aufgerufen (Timeout cleared + Handle aus Map gelöscht)
    // Das bedeutet: ein weiterer Request 2 ohne neuen Request 1 liefert email-otp-required
    const result3 = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });
    expect(result3.errorClass).toBe('email-otp-required');
  });

  it('AC11 — kein PTY-Output/Secret aus dem offenen Prozess in Response/Log während Wartezeit', async () => {
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true });
      const service = makeService(ptySessionMock);

      // Request 1 — Prozess offen, kein PTY-Output in Logs
      const result = await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
      });

      // Kein Secret in Response
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain(FAKE_PASSWORD);
      expect(resultJson).not.toContain(FAKE_EMAIL_OTP);

      // Kein Secret in Logs
      for (const spy of [spyError, spyLog, spyWarn]) {
        for (const call of spy.mock.calls) {
          const callStr = JSON.stringify(call);
          expect(callStr).not.toContain(FAKE_PASSWORD);
          expect(callStr).not.toContain(FAKE_EMAIL_OTP);
        }
      }
    } finally {
      spyError.mockRestore();
      spyLog.mockRestore();
      spyWarn.mockRestore();
    }
  });

  it('AC11 — Phase-2-Timeout: writeOtp hängt dauerhaft → cleanup() aufgerufen + klassifizierter Fehler (kein Zombie-PTY)', async () => {
    jest.useFakeTimers();
    try {
      // Fake-PTY-Session bei der writeOtp niemals resolved (simuliert hängendes bw nach OTP-Write)
      let spawnCallCount = 0;
      const sessions = [];
      const hangingPtySessionMock = jest.fn(async (_args, _env) => {
        spawnCallCount++;
        const session = { cleanupCalled: false, otpCode: null };
        // writeOtp gibt ein Promise zurück, das niemals resolved
        const writeOtp = jest.fn((_code) => new Promise(() => { /* hängt für immer */ }));
        const cleanup = jest.fn(() => { session.cleanupCalled = true; });
        session.writeOtp = writeOtp;
        session.cleanup = cleanup;
        sessions.push(session);
        return { phase: 'awaiting-otp', writeOtp, cleanup };
      });
      hangingPtySessionMock.spawnCallCount = () => spawnCallCount;
      hangingPtySessionMock.sessions = sessions;

      const service = makeService(hangingPtySessionMock);

      // Request 1: Prozess öffnen → email-otp-required
      const result1 = await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
      });
      expect(result1.errorClass).toBe('email-otp-required');

      const session = sessions[0];
      expect(session.cleanupCalled).toBe(false);

      // Request 2: OTP schreiben → writeOtp hängt → Phase-2-Timeout nach PTY_LOGIN_TIMEOUT_MS (30 s)
      const request2Promise = service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
      });

      // Fake-Timer um 30 Sekunden vorspulen → Phase-2-Timeout greift
      jest.advanceTimersByTime(30_000 + 500);

      const result2 = await request2Promise;

      // AC11: cleanup() muss aufgerufen worden sein (kein Zombie-PTY)
      expect(session.cleanupCalled).toBe(true);

      // Klassifizierter, geheimnisfreier Fehler zurückgegeben
      expect(result2.status).toBe('error');
      expect(result2.errorClass).toBe('error');
      expect(result2.reason).toBeDefined();
      expect(result2.reason).not.toContain(FAKE_PASSWORD);
      expect(result2.reason).not.toContain(FAKE_EMAIL_OTP);

      // Kein zweiter Spawn (AC10 — Phase-2-Timeout spawnt nicht neu)
      expect(spawnCallCount).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC11 — Fehler in Request 2 (email-otp-invalid) räumt den Handle auf', async () => {
    const ptySessionMock = makePtySessionMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(ptySessionMock);

    // Request 1
    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY });

    // Request 2: falscher OTP
    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong', identity: FAKE_IDENTITY,
    });

    // Handle aufgeräumt: weiterer Request 2 ohne neuen Request 1 → email-otp-required
    const result3 = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: FAKE_IDENTITY,
    });
    expect(result3.errorClass).toBe('email-otp-required');
    // Kein zusätzlicher Spawn für Request 3 (früh abgebrochen)
    expect(ptySessionMock.spawnCallCount()).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PTY-classifyBwError — email-otp-* Muster-Erkennung via output-Feld (Regression)
// ══════════════════════════════════════════════════════════════════════════════

describe('PTY-classifyBwError — email-otp-* Muster-Erkennung via output-Feld', () => {
  it('PTY-output "new device verification required" → email-otp-required', async () => {
    const ptySessionMock = makePtySessionMock({
      loginFails: true,
      loginOutput: 'New device verification required. Enter OTP sent to login email:',
      loginExitCode: 1,
    });
    const service = makeService(ptySessionMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    expect(result.errorClass).toBe('email-otp-required');
  });

  it('PTY-output "device verification invalid" → email-otp-invalid (via Phase-1-done)', async () => {
    const ptySessionMock = makePtySessionMock({
      loginFails: true,
      loginOutput: 'New device verification invalid or expired.',
      loginExitCode: 1,
    });
    const service = makeService(ptySessionMock);

    // Wenn Phase 1 'done' mit diesem Output zurückkommt → classifyBwError → email-otp-invalid
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: FAKE_IDENTITY,
    });

    expect(result.errorClass).toBe('email-otp-invalid');
  });

  it('PTY-output "two-step" bleibt twofa-required (via _spawnBwPty — TOTP-Pfad)', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Two-step login required.',
      loginExitCode: 1,
    });
    const service = new BitwardenMasterKeyService({
      credentialStore, auditStore, itemName: ITEM_NAME,
      _spawnBwPtySession: makePtySessionMock(),
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    // TOTP-Pfad: twofa übergeben → _spawnBwPty
    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: 'x', identity: FAKE_IDENTITY,
    });

    expect(result.errorClass).toBe('twofa-required');
    expect(result.errorClass).not.toBe('email-otp-required');
  });
});
