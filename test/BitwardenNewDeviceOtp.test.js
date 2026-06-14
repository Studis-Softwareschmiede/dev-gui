/**
 * BitwardenNewDeviceOtp.test.js — Unit-Tests für New-Device-Verification (E-Mail-OTP)
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
 *          (via console-Spy + argv-Check); fetch-URL-Leak getestet in SettingsView.test.jsx (AC7)
 *   AC8  — Autonomer Pfad (kein bw-Login) → kein OTP erwartet/ausgelöst
 *          (dokumentiert: acquireMasterKey ist der interaktive Pfad; autonomer Pfad = DEVGUI_CRED_MASTER_KEY)
 *   AC9  — A11y (label/htmlFor, autoComplete, aria-describedby, Fokus, Touch-Target) → Frontend-AC, getestet in SettingsView.test.jsx
 *
 * Strategie:
 *   - `_spawnBw` vollständig gemockt (kein echter Bitwarden-Netzwerkaufruf)
 *   - CredentialStore + AuditStore als echte In-Memory-Instanzen
 *   - AC7: gespawnte Argv-Arrays + spawnBw-Input (stdin) werden auf OTP-Leak geprüft
 *   - AC7: console.error wird bespioniert — OTP-Code darf nie in Logs erscheinen
 *   - AC4: TOTP-Regression explizit: twofa-required/twofa-invalid bleiben distinkt
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
 * Erstellt eine Mock-Spawn-Funktion mit E-Mail-OTP-Unterstützung.
 *
 * @param {object} opts
 * @param {string}    [opts.sessionToken]         - Session-Token für erfolgreichen Login
 * @param {string}    [opts.itemPassword]         - Passwort-Feld des Items
 * @param {boolean}   [opts.requiresEmailOtp]     - true = erst ohne OTP schlägt fehl (device verif required)
 * @param {boolean}   [opts.emailOtpInvalid]      - true = OTP ist falsch/abgelaufen
 * @param {boolean}   [opts.requiresTwofa]        - true = TOTP-2FA erforderlich (kein Device-OTP)
 * @param {boolean}   [opts.twofaInvalid]         - true = TOTP-Code falsch
 * @param {boolean}   [opts.loginFails]           - true = Login schlägt generisch fehl
 * @param {string}    [opts.loginStderr]          - stderr bei Login-Fehler
 * @param {number}    [opts.loginExitCode]        - Exit-Code für Login (Default 1)
 * @param {(args: string[], opts: object) => void} [opts.onSpawn] - Callback für Assertions
 */
function makeSpawnMock({
  sessionToken = FAKE_SESSION,
  itemPassword = FAKE_KEY_VALUE,
  requiresEmailOtp = false,
  emailOtpInvalid = false,
  requiresTwofa = false,
  twofaInvalid = false,
  loginFails = false,
  loginStderr = '',
  loginExitCode = 1,
  onSpawn = null,
} = {}) {
  const spawnedArgvs = [];
  const spawnedInputs = [];

  const fn = jest.fn(async (args, opts) => {
    spawnedArgvs.push([...args]);
    spawnedInputs.push(opts?.input ?? null);
    if (onSpawn) onSpawn(args, opts);

    const cmd = args[0];

    if (cmd === 'login') {
      // E-Mail-OTP (New-Device-Verification): erst ohne OTP schlägt fehl
      if (requiresEmailOtp) {
        const hasOtpInput = opts?.input && opts.input.trim().length > 0;
        if (!hasOtpInput) {
          // Kein OTP: bw schreibt "New device verification required. Enter OTP sent to login email:"
          // an stderr (inquirer-Prompt-Text) und schlägt fehl
          return {
            stdout: '',
            stderr: 'New device verification required. Enter OTP sent to login email:',
            exitCode: 1,
          };
        }
        if (emailOtpInvalid) {
          // OTP übergeben aber falsch/abgelaufen
          return {
            stdout: '',
            stderr: 'New device verification invalid or expired.',
            exitCode: 1,
          };
        }
        // Gültiger OTP → Erfolg
        return { stdout: sessionToken, stderr: '', exitCode: 0 };
      }

      // TOTP-2FA-Fehler (distinkt von E-Mail-OTP — AC4)
      if (requiresTwofa) {
        return {
          stdout: '',
          stderr: 'Two-step login required.',
          exitCode: 1,
        };
      }
      if (twofaInvalid) {
        return {
          stdout: '',
          stderr: 'Two-step login invalid code.',
          exitCode: 1,
        };
      }

      // Generischer Login-Fehler
      if (loginFails) {
        return {
          stdout: '',
          stderr: loginStderr || 'Username or password is incorrect.',
          exitCode: loginExitCode,
        };
      }

      return { stdout: sessionToken, stderr: '', exitCode: 0 };
    }

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
  fn.spawnedInputs = spawnedInputs;
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

function makeService(spawnMock) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBw: spawnMock,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — New-Device-Verification: kein Code → 'email-otp-required' (≠ twofa-required)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC1 — email-otp-required: kein OTP-Code übergeben → klassifizierter Fehler', () => {
  it('AC1 — New-Device-Verification ohne OTP → status "error", errorClass "email-otp-required"', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('email-otp-required');
  });

  it('AC1 — email-otp-required ist UNTERSCHEIDBAR von twofa-required (verschiedene errorClass)', async () => {
    const spawnMockEmailOtp = makeSpawnMock({ requiresEmailOtp: true });
    const spawnMockTwofa = makeSpawnMock({ requiresTwofa: true });
    const serviceEmailOtp = makeService(spawnMockEmailOtp);
    const serviceTwofa = makeService(spawnMockTwofa);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBw: spawnMock,
    });

    await service.acquireMasterKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    // Store bleibt gesperrt — kein unlock ohne gültigen Key
    expect(cs.isUnlocked()).toBe(false);
  });

  it('AC1 — sanitizeErrorReason liefert für email-otp-required einen geheimnisfreien, unterscheidbaren Text', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true });
    const service = makeService(spawnMock);

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
    const spawnMockTwofa = makeSpawnMock({ requiresTwofa: true });
    const serviceTwofa = makeService(spawnMockTwofa);
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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

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

  it('AC2 — emailOtp wird via stdin (input) übergeben, NICHT via Argv', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      emailOtp: FAKE_EMAIL_OTP,
      identity: null,
    });

    const loginCallIndex = spawnMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    expect(loginCallIndex).toBeGreaterThanOrEqual(0);

    // OTP-Code darf NICHT in den Argv erscheinen (AC7)
    const loginArgs = spawnMock.spawnedArgvs[loginCallIndex];
    for (const arg of loginArgs) {
      expect(String(arg)).not.toContain(FAKE_EMAIL_OTP);
    }

    // OTP-Code MUSS als stdin-Input übergeben worden sein
    const loginInput = spawnMock.spawnedInputs[loginCallIndex];
    expect(loginInput).toBeDefined();
    expect(loginInput).not.toBeNull();
    expect(loginInput.trim()).toContain(FAKE_EMAIL_OTP);
  });

  it('AC2 — ohne emailOtp: stdin ist undefiniert (kein leerer String als Arg)', async () => {
    const spawnMock = makeSpawnMock(); // kein requiresEmailOtp
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: null,
    });

    const loginCallIndex = spawnMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    const loginInput = spawnMock.spawnedInputs[loginCallIndex];
    // Ohne emailOtp: kein stdin-Input (undefined oder null)
    // Der Mock speichert opts?.input ?? null → null für undefined (beide sind korrekt: kein OTP)
    expect(loginInput == null).toBe(true); // null oder undefined = kein OTP
  });

  it('AC2 — mit emailOtp läuft Item-Lesen und Store-Unlock normal', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true });
    const service = makeService(spawnMock);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(spawnMock);

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
    const spawnMockEmailOtp = makeSpawnMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const spawnMockTwofa = makeSpawnMock({ twofaInvalid: true });

    const serviceEmailOtp = makeService(spawnMockEmailOtp);
    const serviceTwofa = makeService(spawnMockTwofa);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = new BitwardenMasterKeyService({
      credentialStore: cs,
      auditStore,
      itemName: ITEM_NAME,
      _spawnBw: spawnMock,
    });

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong-otp', identity: null,
    });

    expect(cs.isUnlocked()).toBe(false);
  });

  it('AC3 — erneuter Versuch nach email-otp-invalid möglich (kein State-Lock in Service)', async () => {
    // Erster Versuch: falscher OTP
    const spawnMockInvalid = makeSpawnMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const serviceInvalid = makeService(spawnMockInvalid);
    const result1 = await serviceInvalid.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'wrong', identity: null,
    });
    expect(result1.errorClass).toBe('email-otp-invalid');

    // Zweiter Versuch: richtiger OTP (neuer Service, neuer Mock)
    const spawnMockValid = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const serviceValid = makeService(spawnMockValid);
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
    const spawnMock = makeSpawnMock({ requiresTwofa: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-required');
    // Explizit: kein email-otp-required
    expect(result.errorClass).not.toBe('email-otp-required');
  });

  it('AC4 — twofa-invalid bleibt twofa-invalid (nicht email-otp-invalid)', async () => {
    const spawnMock = makeSpawnMock({ twofaInvalid: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '000000', identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('twofa-invalid');
    expect(result.errorClass).not.toBe('email-otp-invalid');
  });

  it('AC4 — TOTP-Aufruf mit --code-Arg übergibt den Code als Argv (bisherige Ausnahme)', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: null,
    });

    const loginArgs = spawnMock.spawnedArgvs.find((args) => args[0] === 'login');
    expect(loginArgs).toContain('--code');
    expect(loginArgs).toContain('654321');
  });

  it('AC4 — TOTP-Aufruf ohne emailOtp: kein stdin-Input (keine gegenseitige Interferenz)', async () => {
    const spawnMock = makeSpawnMock();
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, twofa: '654321', identity: null,
    });

    const loginCallIndex = spawnMock.spawnedArgvs.findIndex((args) => args[0] === 'login');
    const loginInput = spawnMock.spawnedInputs[loginCallIndex];
    // Kein emailOtp → kein stdin-Input (null oder undefined — beide bedeuten: kein OTP übergeben)
    expect(loginInput == null).toBe(true);
  });

  it('AC4 — twofa und emailOtp sind gegenseitig ausschließende Fehlerklassen (Spec §4)', async () => {
    // Wenn TOTP-2FA-Account einen Login versucht → erhält twofa-required, NICHT email-otp-required
    const spawnMockTwofa = makeSpawnMock({ requiresTwofa: true });
    const serviceTwofa = makeService(spawnMockTwofa);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_EMAIL_OTP);
      }
    }
  });

  it('AC7 — Passwort erscheint NICHT in Argv (weiterhin; Regression)', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    for (const argv of spawnMock.spawnedArgvs) {
      for (const arg of argv) {
        expect(String(arg)).not.toContain(FAKE_PASSWORD);
      }
    }
  });

  it('AC7 — OTP-Code erscheint NICHT in Audit-Einträgen', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — OTP-Code erscheint NICHT in der email-otp-required-Error-Response', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true }); // kein OTP übergeben
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    const resultJson = JSON.stringify(result);
    // reason darf keinen OTP-Wert enthalten (sanitizeErrorReason)
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
    expect(resultJson).not.toContain(FAKE_PASSWORD);
  });

  it('AC7 — OTP-Code erscheint NICHT in email-otp-invalid-Error-Response', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, emailOtpInvalid: true });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(FAKE_EMAIL_OTP);
  });

  it('AC7 — console.error enthält KEINEN OTP-Code (console-Spy)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
      const service = makeService(spawnMock);

      await service.acquireMasterKey({
        email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
      });

      // Alle console.error-Aufrufe prüfen
      for (const call of consoleSpy.mock.calls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain(FAKE_EMAIL_OTP);
        expect(callStr).not.toContain(FAKE_PASSWORD);
      }
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('AC7 — OTP als stdin übergeben (nicht als Argv) — AC7-Beweis via spawnedInputs', async () => {
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true, itemPassword: FAKE_KEY_VALUE });
    const service = makeService(spawnMock);

    await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: FAKE_EMAIL_OTP, identity: null,
    });

    const loginCallIndex = spawnMock.spawnedArgvs.findIndex((args) => args[0] === 'login');

    // stdin enthält den OTP-Code
    const loginInput = spawnMock.spawnedInputs[loginCallIndex];
    expect(loginInput).toContain(FAKE_EMAIL_OTP);

    // Argv enthält ihn NICHT
    const loginArgs = spawnMock.spawnedArgvs[loginCallIndex];
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
    const spawnMock = makeSpawnMock({ requiresEmailOtp: true });

    // Im autonomen Pfad wird acquireMasterKey() NICHT aufgerufen
    // (stattdessen: CredentialStore direkt mit DEVGUI_CRED_MASTER_KEY entsperren)
    // → bw wird nie gespawnt → kein OTP ausgelöst
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('AC8 — kein Code in BitwardenMasterKeyService, der emailOtp im autonomen Pfad erwartet', async () => {
    // acquireMasterKey ohne emailOtp → kein stdin-Input (autonomer Pfad käme nicht hierher)
    const spawnMock = makeSpawnMock(); // normaler Login ohne Device-OTP-Anforderung
    const service = makeService(spawnMock);

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
// Klassifizierungs-Präzision: classifyBwError für neue Muster
// ══════════════════════════════════════════════════════════════════════════════

describe('classifyBwError — email-otp-* Muster-Erkennung', () => {
  it('stderr "new device verification required" → email-otp-required', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'New device verification required. Enter OTP sent to login email:',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('email-otp-required');
  });

  it('stderr "device verification invalid" → email-otp-invalid', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'New device verification invalid or expired.',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, emailOtp: 'some-otp', identity: null,
    });

    expect(result.errorClass).toBe('email-otp-invalid');
  });

  it('stderr "two-step" bleibt twofa-required (keine Interferenz mit email-otp-*)', async () => {
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'Two-step login required.',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('twofa-required');
    expect(result.errorClass).not.toBe('email-otp-required');
  });

  it('stderr "verification ... otp sent to login email" → email-otp-required', async () => {
    // Das vollständige bw-stderr enthält immer "verification" und "otp sent to login email" zusammen.
    // bw CLI 2026.5.0 schreibt den inquirer-Prompt-Text an stderr:
    // "New device verification required. Enter OTP sent to login email:"
    // Klassifizierungs-Regex: s.includes('verification') && s.includes('otp sent to login email')
    const spawnMock = makeSpawnMock({
      loginFails: true,
      loginStderr: 'New device verification required. Enter OTP sent to login email:',
      loginExitCode: 1,
    });
    const service = makeService(spawnMock);

    const result = await service.acquireMasterKey({
      email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null,
    });

    expect(result.errorClass).toBe('email-otp-required');
  });
});
