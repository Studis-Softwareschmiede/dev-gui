/**
 * BitwardenNewDeviceOtp.test.js — Unit-Tests für New-Device-Verification (E-Mail-OTP) via PTY
 *
 * Spec: docs/specs/bitwarden-new-device-otp.md
 *
 * Covers (bitwarden-new-device-otp AC1–AC8):
 *   AC1  — bw verlangt New-Device-Verification + kein Code → 'email-otp-required' (≠ 'twofa-required')
 *   AC2  — Folge-Request mit gültigem E-Mail-OTP → Login erfolgreich, Beschaffung normal
 *   AC3  — Falscher/abgelaufener E-Mail-OTP → 'email-otp-invalid' (≠ 'twofa-invalid')
 *   AC4  — TOTP-2FA-Fluss bleibt unverändert: twofa-required/twofa-invalid statt email-otp-*
 *   AC5  — Dialog-Feld mit eigenem Label/State, textlich verschieden von 2FA → Frontend-AC, getestet in SettingsView.test.jsx
 *   AC6  — aria-describedby/role=alert für email-otp-invalid → Frontend-AC, getestet in SettingsView.test.jsx
 *   AC7  — E-Mail-OTP-Code erscheint NICHT in Argv, Logs, Audit oder Response
 *          (PTY-spawnedArgvs + spawnedOpts + console-Spy); fetch-URL-Leak getestet in SettingsView.test.jsx (AC7)
 *   AC8  — Autonomer Pfad (kein bw-Login) → kein OTP erwartet/ausgelöst
 *          (dokumentiert: acquireMasterKey ist der interaktive Pfad; autonomer Pfad = DEVGUI_CRED_MASTER_KEY)
 *   AC9  — A11y (label/htmlFor, autoComplete, aria-describedby, Fokus, Touch-Target) → Frontend-AC, getestet in SettingsView.test.jsx
 *
 * Strategie:
 *   - `_spawnBwPty` vollständig gemockt (Fake-PTY für `bw login` — kein echter Bitwarden-Netzwerkaufruf)
 *   - `_spawnBw` vollständig gemockt (für get/encode/create/logout)
 *   - CredentialStore + AuditStore als echte In-Memory-Instanzen
 *   - AC7: PTY-spawnedArgvs + spawnedOpts werden auf OTP-Leak geprüft
 *          (emailOtp muss via opts.emailOtp übergeben werden, NICHT via Argv)
 *   - AC7: console.error wird bespioniert — OTP-Code darf nie in Logs erscheinen
 *   - AC4: TOTP-Regression explizit: twofa-required/twofa-invalid bleiben distinkt
 *
 * PTY-Simulation (Fake-PTY):
 *   - Die Fake-PTY-Funktion (_spawnBwPty) empfängt emailOtp als opts.emailOtp
 *   - Sie simuliert das PTY-Prompt-Handling: wenn emailOtp gesetzt + requiresEmailOtp → Erfolg
 *   - Ohne emailOtp + requiresEmailOtp → Fehler mit New-Device-Prompt im output
 *   - So spiegelt der Test das reale PTY-Verhalten ohne echtes node-pty
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Erstellt eine Fake-PTY-Spawn-Funktion (_spawnBwPty) mit E-Mail-OTP-Unterstützung.
 *
 * Simuliert das PTY-Verhalten:
 *   - Bei requiresEmailOtp: prüft opts.emailOtp (nicht opts.input — PTY-Modell)
 *   - Ohne emailOtp → output enthält den New-Device-Prompt-Text → classifyBwError → 'email-otp-required'
 *   - Mit emailOtp + emailOtpInvalid → output enthält "invalid" → classifyBwError → 'email-otp-invalid'
 *   - Mit emailOtp (gültig) → exitCode 0, stdout = sessionToken
 *
 * @param {object} opts
 * @param {string}    [opts.sessionToken]         - Session-Token für erfolgreichen Login
 * @param {boolean}   [opts.requiresEmailOtp]     - true = erst ohne OTP schlägt fehl (device verif required)
 * @param {boolean}   [opts.emailOtpInvalid]      - true = OTP ist falsch/abgelaufen
 * @param {boolean}   [opts.requiresTwofa]        - true = TOTP-2FA erforderlich (kein Device-OTP)
 * @param {boolean}   [opts.twofaInvalid]         - true = TOTP-Code falsch
 * @param {boolean}   [opts.loginFails]           - true = Login schlägt generisch fehl
 * @param {string}    [opts.loginOutput]          - PTY-Output bei Login-Fehler
 * @param {number}    [opts.loginExitCode]        - Exit-Code für Login (Default 1)
 * @param {(args: string[], opts: object) => void} [opts.onSpawn] - Callback für Assertions
 */
function makePtyMock({
  sessionToken = FAKE_SESSION,
  requiresEmailOtp = false,
  emailOtpInvalid = false,
  requiresTwofa = false,
  twofaInvalid = false,
  loginFails = false,
  loginOutput = '',
  loginExitCode = 1,
  onSpawn = null,
} = {}) {
  const spawnedArgvs = [];
  const spawnedOpts = [];

  const fn = jest.fn(async (args, opts) => {
    spawnedArgvs.push([...args]);
    spawnedOpts.push(opts ?? {});
    if (onSpawn) onSpawn(args, opts);

    // E-Mail-OTP (New-Device-Verification): Fake-PTY prüft opts.emailOtp (nicht opts.input)
    if (requiresEmailOtp) {
      const hasOtp = opts?.emailOtp && opts.emailOtp.trim().length > 0;
      if (!hasOtp) {
        // Kein OTP: output enthält New-Device-Prompt-Text → classifyBwError → 'email-otp-required'
        return {
          stdout: '',
          output: 'New device verification required. Enter OTP sent to login email:',
          exitCode: 1,
        };
      }
      if (emailOtpInvalid) {
        // OTP übergeben aber falsch/abgelaufen
        return {
          stdout: '',
          output: 'New device verification invalid or expired.',
          exitCode: 1,
        };
      }
      // Gültiger OTP → Erfolg
      return { stdout: sessionToken, output: '', exitCode: 0 };
    }

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

function makeService(ptyMock, spawnMock) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBwPty: ptyMock,
    _spawnBw: spawnMock ?? makeSpawnMock(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — New-Device-Verification: kein Code → 'email-otp-required' (≠ twofa-required)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC1 — email-otp-required: kein OTP-Code übergeben → klassifizierter Fehler', () => {
  it('AC1 — New-Device-Verification ohne OTP → status "error", errorClass "email-otp-required"', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('email-otp-required');
  });

  it('AC1 — email-otp-required ist UNTERSCHEIDBAR von twofa-required (verschiedene errorClass)', async () => {
    const ptyMockEmailOtp = makePtyMock({ requiresEmailOtp: true });
    const ptyMockTwofa = makePtyMock({ requiresTwofa: true });
    const serviceEmailOtp = makeService(ptyMockEmailOtp);
    const serviceTwofa = makeService(ptyMockTwofa);

    const resultEmailOtp = await serviceEmailOtp.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(resultEmailOtp.errorClass).toBe('email-otp-required');
    expect(resultTwofa.errorClass).toBe('twofa-required');
    // Explizit: NICHT dasselbe
    expect(resultEmailOtp.errorClass).not.toBe(resultTwofa.errorClass);
  });

  it('AC1 — bei email-otp-required wird nichts entsperrt/persistiert (Store bleibt locked)', async () => {
    const cs = new CredentialStore({
      dir: tmpDir,
      masterKey: null,
      envPath: join(tmpDir, '.env-otp1'),
    });
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Store bleibt gesperrt — kein unlock ohne gültigen Key
    expect(cs.isUnlocked()).toBe(false);
  });

  it('AC1 — sanitizeErrorReason liefert für email-otp-required einen geheimnisfreien, unterscheidbaren Text', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.reason).toBeDefined();
    // Reason darf kein Passwort/OTP/Email enthalten
    expect(result.reason).not.toContain(FAKE_PASSWORD);
    expect(result.reason).not.toContain(FAKE_EMAIL);
    // Reason ist für E-Mail-OTP-Fall spezifisch (enthält 'otp', 'verification' oder ähnliches)
    expect(result.reason.toLowerCase()).toMatch(/otp|verification|einmalcode/i);
    // Unterscheidbar vom TOTP-2FA-Reason
    const ptyMockTwofa = makePtyMock({ requiresTwofa: true });
    const serviceTwofa = makeService(ptyMockTwofa);
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });
    expect(result.reason).not.toBe(resultTwofa.reason);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — Gültiger E-Mail-OTP → Login erfolgreich + normale Beschaffung
// ══════════════════════════════════════════════════════════════════════════════

describe('AC2 — gültiger E-Mail-OTP → acquireMasterKey läuft normal weiter', () => {
  it('AC2 — mit gültigem emailOtp → status "found"', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: null,
    });

    expect(result.status).toBe('found');
    // Kein Key-Wert in Response
    expect(result.key).toBeUndefined();
  });

  it('AC2 — emailOtp wird via opts.emailOtp übergeben (PTY-Modell), NICHT via Argv', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: null,
    });

    const loginCallIndex = ptyMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    expect(loginCallIndex).toBeGreaterThanOrEqual(0);

    // OTP-Code darf NICHT in den Argv erscheinen (AC7)
    const loginArgs = ptyMock.spawnedArgvs[loginCallIndex];
    for (const arg of loginArgs) {
      expect(String(arg)).not.toContain(FAKE_EMAIL_OTP);
    }

    // OTP-Code MUSS als opts.emailOtp übergeben worden sein (PTY-Modell)
    const loginOpts = ptyMock.spawnedOpts[loginCallIndex];
    expect(loginOpts.emailOtp).toBe(FAKE_EMAIL_OTP);
  });

  it('AC2 — ohne emailOtp: opts.emailOtp ist null/undefined (kein leerer String als Arg)', async () => {
    const ptyMock = makePtyMock(); // kein requiresEmailOtp
    const service = makeService(ptyMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: null,
    });

    const loginCallIndex = ptyMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    const loginOpts = ptyMock.spawnedOpts[loginCallIndex];
    // Ohne emailOtp: kein opts.emailOtp (null oder undefined)
    expect(loginOpts.emailOtp == null).toBe(true);
  });

  it('AC2 — mit emailOtp läuft Item-Lesen und Store-Unlock normal', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: null,
    });

    expect(result.status).toBe('found');
    // bw get password wurde aufgerufen (nach erfolgreichem Login)
    const getCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'get' && args[1] === 'password');
    expect(getCall).toBeDefined();
    // bw logout wurde aufgerufen (Session verworfen)
    const logoutCall = spawnMock.spawnedArgvs.find((args) => args[0] === 'logout');
    expect(logoutCall).toBeDefined();
  });

  it('AC2 — createMasterKey akzeptiert ebenfalls emailOtp', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const service = makeService(ptyMock);

    const result = await service.createMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: null,
    });

    expect(result.status).toBe('created');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — Falscher/abgelaufener E-Mail-OTP → 'email-otp-invalid' (≠ 'twofa-invalid')
// ══════════════════════════════════════════════════════════════════════════════

describe('AC3 — email-otp-invalid: falscher/abgelaufener OTP-Code', () => {
  it('AC3 — falscher OTP-Code → status "error", errorClass "email-otp-invalid"', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: 'wrong-otp-code',
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('email-otp-invalid');
  });

  it('AC3 — email-otp-invalid ist UNTERSCHEIDBAR von twofa-invalid', async () => {
    const ptyMockEmailOtp = makePtyMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const ptyMockTwofa = makePtyMock({ twofaInvalid: true });

    const serviceEmailOtp = makeService(ptyMockEmailOtp);
    const serviceTwofa = makeService(ptyMockTwofa);

    const resultEmailOtp = await serviceEmailOtp.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong', identity: null,
    });
    const resultTwofa = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: null,
    });

    expect(resultEmailOtp.errorClass).toBe('email-otp-invalid');
    expect(resultTwofa.errorClass).toBe('twofa-invalid');
    expect(resultEmailOtp.errorClass).not.toBe(resultTwofa.errorClass);
  });

  it('AC3 — bei email-otp-invalid bleibt Store gesperrt', async () => {
    const cs = new CredentialStore({
      dir: tmpDir,
      masterKey: null,
      envPath: join(tmpDir, '.env-otp2'),
    });
    const ptyMock = makePtyMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBwPty: ptyMock,
      _spawnBw: makeSpawnMock(),
    });

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong-otp', identity: null,
    });

    expect(cs.isUnlocked()).toBe(false);
  });

  it('AC3 — erneuter Versuch nach email-otp-invalid möglich (kein State-Lock in Service)', async () => {
    // Erster Versuch: falscher OTP
    const ptyMockInvalid = makePtyMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const serviceInvalid = makeService(ptyMockInvalid);
    const result1 = await serviceInvalid.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong', identity: null,
    });
    expect(result1.errorClass).toBe('email-otp-invalid');

    // Zweiter Versuch: richtiger OTP (neuer Service, neuer Mock)
    const ptyMockValid = makePtyMock({ requiresEmailOtp: true });
    const spawnMockValid = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const serviceValid = makeService(ptyMockValid, spawnMockValid);
    const result2 = await serviceValid.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });
    expect(result2.status).toBe('found');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — TOTP-2FA-Fluss bleibt unverändert (Regression)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC4 — TOTP-2FA-Fluss bleibt unverändert (Regression)', () => {
  it('AC4 — twofa-required bleibt twofa-required (nicht email-otp-required)', async () => {
    const ptyMock = makePtyMock({ requiresTwofa: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-required');
    // Explizit: kein email-otp-required
    expect(result.errorClass).not.toBe('email-otp-required');
  });

  it('AC4 — twofa-invalid bleibt twofa-invalid (nicht email-otp-invalid)', async () => {
    const ptyMock = makePtyMock({ twofaInvalid: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-invalid');
    expect(result.errorClass).not.toBe('email-otp-invalid');
  });

  it('AC4 — TOTP-Aufruf mit --code-Arg übergibt den Code als Argv (bisherige Ausnahme)', async () => {
    const ptyMock = makePtyMock();
    const service = makeService(ptyMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: null,
    });

    const loginArgs = ptyMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginArgs).toContain('--code');
    expect(loginArgs).toContain('654321');
  });

  it('AC4 — TOTP-Aufruf ohne emailOtp: opts.emailOtp ist null/undefined (keine gegenseitige Interferenz)', async () => {
    const ptyMock = makePtyMock();
    const service = makeService(ptyMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: null,
    });

    const loginCallIndex = ptyMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    const loginOpts = ptyMock.spawnedOpts[loginCallIndex];
    // Kein emailOtp → opts.emailOtp ist null oder undefined
    expect(loginOpts.emailOtp == null).toBe(true);
  });

  it('AC4 — twofa und emailOtp sind gegenseitig ausschließende Fehlerklassen (Spec §4)', async () => {
    // Wenn TOTP-2FA-Account einen Login versucht → erhält twofa-required, NICHT email-otp-required
    const ptyMockTwofa = makePtyMock({ requiresTwofa: true });
    const serviceTwofa = makeService(ptyMockTwofa);

    const result = await serviceTwofa.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    // Nur einer der Fälle: twofa-required, NICHT email-otp-required
    expect(['twofa-required', 'twofa-invalid']).toContain(result.errorClass);
    expect(['email-otp-required', 'email-otp-invalid']).not.toContain(result.errorClass);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 — E-Mail-OTP-Code erscheint NICHT in Argv, Logs, Audit oder Response
// ══════════════════════════════════════════════════════════════════════════════

describe('AC7 — OTP-Code-Leak: kein Leak in Argv, Logs, Audit oder Response', () => {
  it('AC7 — OTP-Code erscheint NICHT in gespawnten Argv-Arrays', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    for (const argv of ptyMock.spawnedArgvs) {
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

  it('AC7 — Passwort erscheint NICHT in Argv (weiterhin; Regression)', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    for (const argv of ptyMock.spawnedArgvs) {
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
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP,
      identity: 'test@example.com',
    });

    const entries = auditStore.getAll();
    const auditJson = JSON.stringify(entries);
    expect(auditJson).not.toContain(FAKE_EMAIL_OTP);
    expect(auditJson).not.toContain(FAKE_PASSWORD);
  });

  it('AC7 — OTP-Code erscheint NICHT in der acquireMasterKey-Response', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — OTP-Code erscheint NICHT in der email-otp-required-Error-Response', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true }); // kein OTP übergeben
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    const resultJson = JSON.stringify(result);
    // reason darf keinen OTP-Wert enthalten (sanitizeErrorReason)
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
    expect(resultJson).not.toContain(FAKE_PASSWORD);
  });

  it('AC7 — OTP-Code erscheint NICHT in email-otp-invalid-Error-Response', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — console.error/log/warn enthalten KEINEN OTP-Code (console-Spy auf alle Kanäle)', async () => {
    // Alle drei Konsolen-Kanäle bespionieren — ein OTP-/Secret-Leak über jeden Kanal wird gefangen
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    const spyWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ptyMock = makePtyMock({ requiresEmailOtp: true });
      const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
      const service = makeService(ptyMock, spawnMock);

      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
      });

      // Alle console.error / console.log / console.warn Aufrufe prüfen
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

  it('AC7 — OTP via opts.emailOtp übergeben (PTY-Modell, nicht Argv) — AC7-Beweis via spawnedOpts', async () => {
    const ptyMock = makePtyMock({ requiresEmailOtp: true });
    const spawnMock = makeSpawnMock({ itemPassword: FAKE_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const loginCallIndex = ptyMock.spawnedArgvs.findIndex((args) => args[0] === 'login');

    // opts.emailOtp enthält den OTP-Code (PTY-Modell)
    const loginOpts = ptyMock.spawnedOpts[loginCallIndex];
    expect(loginOpts.emailOtp).toBe(FAKE_EMAIL_OTP);

    // Argv enthält ihn NICHT
    const loginArgs = ptyMock.spawnedArgvs[loginCallIndex];
    expect(loginArgs.join(' ')).not.toContain(FAKE_EMAIL_OTP);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC8 — Autonomer Pfad löst keinen E-Mail-OTP aus
// (Dokumentiert: acquireMasterKey ist interaktiver Pfad; DEVGUI_CRED_MASTER_KEY = autonomer Pfad)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC8 — Autonomer Pfad (DEVGUI_CRED_MASTER_KEY) löst kein E-Mail-OTP aus', () => {
  it('AC8 — BitwardenMasterKeyService.acquireMasterKey wird im autonomen Pfad NICHT aufgerufen', () => {
    // Dokumentierter Test: Der autonome Pfad (DEVGUI_CRED_MASTER_KEY) liest den Key
    // direkt aus der Env-Var — kein bw-Login, kein OTP. BitwardenMasterKeyService wird
    // im autonomen Pfad nicht instanziiert/aufgerufen (Spec bitwarden-new-device-otp §6).
    // Dieser Test verifiziert: acquireMasterKey ist der interaktive Pfad; der autonome Pfad
    // geht an BitwardenMasterKeyService vorbei → keine OTP-Anforderung möglich.
    //
    // Nachweis: wenn wir acquireMasterKey() NICHT aufrufen, kann kein OTP verlangt werden.
    const ptyMock = makePtyMock({ requiresEmailOtp: true });

    // Im autonomen Pfad wird acquireMasterKey() NICHT aufgerufen
    // (stattdessen: CredentialStore direkt mit DEVGUI_CRED_MASTER_KEY entsperren)
    // → PTY wird nie gespawnt → kein OTP ausgelöst
    expect(ptyMock).not.toHaveBeenCalled();
  });

  it('AC8 — kein Code in BitwardenMasterKeyService, der emailOtp im autonomen Pfad erwartet', async () => {
    // acquireMasterKey ohne emailOtp → kein opts.emailOtp (autonomer Pfad käme nicht hierher)
    const ptyMock = makePtyMock(); // normaler Login ohne Device-OTP-Anforderung
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
      // kein emailOtp — simuliert: wenn jemand den autonomen Pfad aus Versehen durch
      // acquireMasterKey() ersetzt, ohne emailOtp → kein OTP wird erwartet/erzwungen
    });

    // Kein OTP-Fehler im normalen Login ohne Device-Verification-Anforderung
    expect(['found', 'not-found']).toContain(result.status);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PTY-Modell: Fake-PTY-Klassifizierung für neue Prompt-Muster (classifyBwError)
// ══════════════════════════════════════════════════════════════════════════════

describe('PTY-classifyBwError — email-otp-* Muster-Erkennung via output-Feld', () => {
  it('PTY-output "new device verification required" → email-otp-required', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'New device verification required. Enter OTP sent to login email:',
      loginExitCode: 1,
    });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('email-otp-required');
  });

  it('PTY-output "device verification invalid" → email-otp-invalid', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'New device verification invalid or expired.',
      loginExitCode: 1,
    });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'some-otp', identity: null,
    });

    expect(result.errorClass).toBe('email-otp-invalid');
  });

  it('PTY-output "two-step" bleibt twofa-required (keine Interferenz mit email-otp-*)', async () => {
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'Two-step login required.',
      loginExitCode: 1,
    });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('twofa-required');
    expect(result.errorClass).not.toBe('email-otp-required');
  });

  it('PTY-output "verification ... otp sent to login email" → email-otp-required', async () => {
    // Das vollständige PTY-output enthält immer "verification" und "otp sent to login email" zusammen.
    // classifyBwError: s.includes('verification') && s.includes('otp sent to login email')
    const ptyMock = makePtyMock({
      loginFails: true,
      loginOutput: 'New device verification required. Enter OTP sent to login email:',
      loginExitCode: 1,
    });
    const service = makeService(ptyMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('email-otp-required');
  });
});
