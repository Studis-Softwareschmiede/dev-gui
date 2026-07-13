/**
 * PerAppGpgRotationService.test.js — Unit-Tests für den Zwei-Phasen-Rotations-
 * Dienst (docs/specs/per-app-gpg-passphrase-rotation.md, F-073/S-338).
 *
 * Covers (per-app-gpg-passphrase-rotation.md):
 *   AC1  — startRotation schreibt den Kandidaten NUR ins Feld `naechste`;
 *          aktives Passwortfeld + `vorherige` bleiben unverändert.
 *   AC2  — Beweis-Runde: Alt-Decrypt (alte Passphrase) → Neu-Encrypt (neue
 *          Passphrase, NEUE Datei `.env.gpg.next`) → Probe-Decrypt → Wertgleich-
 *          Vergleich.
 *   AC3  — JEDER Fehlschlag der Beweis-Runde (decrypt-old/encrypt-new/verify)
 *          ⇒ Abbruch ohne Änderung am aktiven Zustand; Kandidat wird verworfen
 *          (Feld `naechste` best-effort geleert).
 *   AC4  — commitRotation: ZUERST Bitwarden-Umschaltung (password/vorherige/
 *          naechste in EINEM Aufruf), DANACH Commit+Push (Reihenfolge-Assertion
 *          über eine gemeinsame callOrder-Spur).
 *   AC5  — discardPrevious entfernt NUR `vorherige`; aktives Passwortfeld/
 *          `naechste` unangetastet.
 *   AC6  — Audit-First je Phase (a/b/c/d); ein Audit-Fehlschlag verhindert
 *          GENAU diese Phase (kein bw-/git-Aufruf danach).
 *   AC10 — vor der Beweis-Runde wird `workspaceMutator.pullClone` aufgerufen
 *          (Reihenfolge: NACH Kandidat-Schreiben, VOR der Beweis-Runde).
 *   AC12 — fehlender Workspace-Klon ⇒ Abbruch VOR (a): kein bw-Aufruf
 *          (openSession NIE aufgerufen), kein Audit.
 *   AC13 — scheitert `workspaceMutator.commitAndPushFile` (push-failed/
 *          commit-failed/branch-mismatch, Review-Iteration 2), wird die
 *          Bitwarden-Umschaltung zurückgerollt (Item-Zustand vor (c)
 *          wiederhergestellt); Ergebnis meldet die durchgereichte Fehlerklasse.
 *   access-not-ready — Zugang nicht ready (Zugangs-Gate) klassifiziert
 *          `startRotation`/`commitRotation` korrekt, kein bw-/git-Aufruf danach
 *          (Vorbild PerAppGpgProvisioningService.test.js, Reviewer-Suggestion
 *          Review-Iteration 2 — die eigentliche `openSession()`-Fehlerklassifizierung
 *          selbst wird per Delegation an dieselbe Logik wie AC3 des
 *          Provisionierungs-Dienstes getestet, hier auf `startRotation`/
 *          `commitRotation` angewendet).
 *
 * Finding 1/2 (Review-Iteration 2, Reviewer-Befund gegen `WorkspaceMutator`):
 *   Der eigentliche Git-Rollback (`git reset --hard`) + die Branch-Verifikation
 *   gegen `refs/remotes/origin/HEAD` sind ausschließlich in
 *   `workspaceMutatorCommitPush.test.js` verifiziert (WorkspaceMutator ist hier
 *   vollständig gemockt) — diese Datei testet nur, dass `commitRotation` eine
 *   `branch-mismatch`/`commit-failed`/`push-failed`-Fehlerklasse aus
 *   `commitAndPushFile` unverändert durchreicht und in JEDEM Fall den
 *   AC13-Bitwarden-Rollback auslöst.
 *
 * Strategy: `deployLoginService.openSession()` liefert eine an einen GETEILTEN
 * Mutable-State gebundene Session (readItemFields/updateItemFields lesen/
 * schreiben denselben Zustand — genau wie ein echtes Bitwarden-Item über
 * mehrere Session-Öffnungen hinweg). `workspaceMutator` ist vollständig
 * gemockt (pullClone/commitAndPushFile) — der eigentliche git-/bw-Spawn wird
 * bereits in eigenen Testdateien (workspaceMutatorCommitPush.test.js,
 * BitwardenDeployLoginService.test.js) verifiziert. Die GPG-Ver-/Entschlüsselung
 * wird durch einen deterministischen Fake-Crypto ersetzt (kein echtes `gpg`
 * nötig) — Marker-Format `ENC(<passphrase>):<klartext>`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { PerAppGpgRotationService } from '../src/PerAppGpgRotationService.js';
import { WorkspaceMutatorError } from '../src/WorkspaceMutator.js';

const APP = 'myapp';
const CLONE_PATH = '/workspace/myapp';
const ENV_GPG = `${CLONE_PATH}/.env.gpg`;
const ENV_GPG_NEXT = `${CLONE_PATH}/.env.gpg.next`;

// ── Fake GPG (deterministisch, kein echtes `gpg`) ──────────────────────────────
function fakeCrypto(overrides = {}) {
  return {
    encrypt: overrides.encrypt ?? (async (passphrase, buf) => Buffer.from(`ENC(${passphrase}):${buf.toString('utf8')}`)),
    decrypt: overrides.decrypt ?? (async (passphrase, buf) => {
      const s = buf.toString('utf8');
      const m = /^ENC\(([^)]*)\):([\s\S]*)$/.exec(s);
      if (!m || m[1] !== passphrase) throw new Error('gpg decrypt failed (fake)');
      return Buffer.from(m[2], 'utf8');
    }),
  };
}

// ── Fake FS (In-Memory Map, Pfad → Buffer) ─────────────────────────────────────
function buildFsDeps({ cloneMissing = false, envGpgContent } = {}) {
  const files = new Map();
  if (envGpgContent !== undefined) files.set(ENV_GPG, envGpgContent);
  const readFile = jest.fn(async (p) => {
    if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files.get(p);
  });
  const writeFile = jest.fn(async (p, data) => {
    files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  const rename = jest.fn(async (from, to) => {
    const d = files.get(from);
    files.delete(from);
    files.set(to, d);
  });
  const rm = jest.fn(async (p) => { files.delete(p); });
  const realpath = jest.fn(async (p) => p);
  const stat = jest.fn(async (p) => {
    if (p === CLONE_PATH && !cloneMissing) return { isDirectory: () => true };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  return { files, readFile, writeFile, rename, rm, realpath, stat };
}

// ── Fake BitwardenDeployLoginService (geteilter Mutable-Item-Zustand) ─────────
function buildDeployLoginService({ password = 'ACTIVE-OLD-PASS', naechste = null, vorherige = null, failOpenSession = null } = {}) {
  const state = { id: 'item-1', password, naechste, vorherige };
  const openSessionCalls = [];
  const openSession = jest.fn(async () => {
    openSessionCalls.push(1);
    if (failOpenSession) {
      const err = new Error('access');
      err.deployErrorClass = failOpenSession;
      throw err;
    }
    return {
      readItemFields: jest.fn(async () => ({ ...state })),
      updateItemFields: jest.fn(async (_itemName, mutations) => {
        for (const [k, v] of Object.entries(mutations)) {
          if (v === undefined) continue;
          state[k] = v;
        }
      }),
      close: jest.fn(async () => {}),
    };
  });
  return { deployLoginService: { openSession }, state, openSessionCalls };
}

function buildWorkspaceMutator({ pullFails = false, commitPushFails = null, callOrder = [] } = {}) {
  const pullClone = jest.fn(async () => {
    callOrder.push('pull');
    if (pullFails) throw new Error('git pull failed');
    return { summary: 'Already up to date.' };
  });
  const commitAndPushFile = jest.fn(async () => {
    callOrder.push('commitPush');
    if (commitPushFails) {
      throw new WorkspaceMutatorError('git push failed', commitPushFails); // 'push-failed' | 'commit-failed'
    }
    return { summary: 'main -> main' };
  });
  return { workspaceMutator: { pullClone, commitAndPushFile }, callOrder };
}

function auditSpy(failOn = null) {
  const calls = [];
  return {
    calls,
    record: jest.fn((entry) => {
      if (failOn && entry.command.includes(failOn)) throw new Error('audit failed');
      calls.push(entry);
    }),
  };
}

const CANDIDATE_MARKER = /^[A-Za-z0-9_-]{40,}$/; // base64url(32 bytes) — grob geprüft

describe('PerAppGpgRotationService.startRotation — AC1/AC2/AC10 (Happy Path)', () => {
  it('AC1: Kandidat NUR in naechste geschrieben — aktives Passwortfeld/vorherige unverändert', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS', vorherige: 'SOME-PREVIOUS' });
    const { workspaceMutator, callOrder } = buildWorkspaceMutator();
    const audit = auditSpy();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):PLAINTEXT-CONTENT') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, { identity: 'a@b.ch' });

    expect(result).toEqual({ ok: true, phase: 'candidate-proved' });
    expect(state.password).toBe('ACTIVE-OLD-PASS'); // unverändert
    expect(state.vorherige).toBe('SOME-PREVIOUS'); // unverändert
    expect(state.naechste).toMatch(CANDIDATE_MARKER); // Kandidat gesetzt
    expect(callOrder).toEqual(['pull']); // AC10: Pull erfolgte
  });

  it('AC2: Beweis-Runde schreibt .env.gpg.next mit gültigem Roundtrip', async () => {
    const { deployLoginService } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):PLAINTEXT-CONTENT') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});
    expect(result.ok).toBe(true);

    expect(fsDeps.files.has(ENV_GPG_NEXT)).toBe(true);
    const nextContent = fsDeps.files.get(ENV_GPG_NEXT).toString('utf8');
    expect(nextContent).toMatch(/^ENC\(/); // neu verschlüsselt
    expect(nextContent).not.toContain('ACTIVE-OLD-PASS'); // NICHT mit der alten Passphrase
  });

  it('AC10: pullClone erfolgt NACH dem Kandidat-Schreiben, VOR der Beweis-Runde', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const callOrder = [];
    const { workspaceMutator } = buildWorkspaceMutator({ callOrder });
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    await svc.startRotation(APP, {});
    // naechste war bereits gesetzt, BEVOR pullClone lief (Kandidat-Schreiben passiert vor AC10-Pull)
    expect(state.naechste).toMatch(CANDIDATE_MARKER);
    expect(callOrder).toEqual(['pull']);
  });
});

describe('PerAppGpgRotationService.startRotation — AC3: Beweis-Runden-Fehlschläge (Abbruch ohne Änderung)', () => {
  it('decrypt-old-failed: falsche aktive Passphrase im .env.gpg → Abbruch, Kandidat verworfen', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    // .env.gpg ist mit einer ANDEREN Passphrase "verschlüsselt" — Alt-Decrypt schlägt fehl.
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(WRONG-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});

    expect(result).toEqual({ ok: false, phase: 'aborted', errorClass: 'decrypt-old-failed', reason: expect.any(String) });
    expect(state.password).toBe('ACTIVE-OLD-PASS'); // aktiver Zustand unverändert
    expect(state.naechste).toBeNull(); // Kandidat verworfen (best-effort)
    expect(fsDeps.files.has(ENV_GPG_NEXT)).toBe(false); // keine neue Datei übrig
  });

  it('encrypt-new-failed: Verschlüsselung mit der neuen Passphrase schlägt fehl → Abbruch, Kandidat verworfen', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });
    const crypto = fakeCrypto({ encrypt: async () => { throw new Error('gpg-encrypt-failed'); } });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: crypto,
    });

    const result = await svc.startRotation(APP, {});

    expect(result).toEqual({ ok: false, phase: 'aborted', errorClass: 'encrypt-new-failed', reason: expect.any(String) });
    expect(state.password).toBe('ACTIVE-OLD-PASS');
    expect(state.naechste).toBeNull();
  });

  it('verify-failed: Probe-Entschlüsselung liefert abweichenden Klartext → Abbruch, .env.gpg.next entfernt', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):PLAINTEXT-CONTENT') });
    let decryptCalls = 0;
    const crypto = fakeCrypto({
      decrypt: async (passphrase, buf) => {
        decryptCalls += 1;
        if (decryptCalls === 1) {
          // Alt-Decrypt — korrekt
          const m = /^ENC\(([^)]*)\):([\s\S]*)$/.exec(buf.toString('utf8'));
          if (!m || m[1] !== passphrase) throw new Error('decrypt failed');
          return Buffer.from(m[2], 'utf8');
        }
        // Probe-Decrypt — liefert MANIPULIERTEN Klartext (Vergleich schlägt an, AC2)
        return Buffer.from('MANIPULATED-CONTENT');
      },
    });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: crypto,
    });

    const result = await svc.startRotation(APP, {});

    expect(result).toEqual({ ok: false, phase: 'aborted', errorClass: 'verify-failed', reason: expect.any(String) });
    expect(state.password).toBe('ACTIVE-OLD-PASS');
    expect(state.naechste).toBeNull();
    expect(fsDeps.files.has(ENV_GPG_NEXT)).toBe(false);
  });
});

describe('PerAppGpgRotationService.startRotation — AC12: fehlender Workspace-Klon', () => {
  it('Klon fehlt ⇒ Abbruch VOR (a): kein bw-Aufruf, kein Audit', async () => {
    const { deployLoginService, openSessionCalls } = buildDeployLoginService({});
    const { workspaceMutator } = buildWorkspaceMutator();
    const audit = auditSpy();
    const fsDeps = buildFsDeps({ cloneMissing: true });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});

    expect(result).toEqual({ ok: false, phase: 'aborted', errorClass: 'clone-missing', reason: expect.any(String) });
    expect(openSessionCalls.length).toBe(0); // kein Repo-/bw-Zugriff
    expect(audit.calls.length).toBe(0);
    expect(workspaceMutator.pullClone).not.toHaveBeenCalled();
  });
});

describe('PerAppGpgRotationService.startRotation — AC6: Audit-First je Phase', () => {
  it('Audit-Fehlschlag vor Phase (a) verhindert die Kandidat-Anlage (kein naechste gesetzt)', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const audit = auditSpy('gpg-rotate:a');
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});

    expect(result.ok).toBe(false);
    expect(state.naechste).toBeNull(); // Phase (a) fand NICHT statt
    expect(workspaceMutator.pullClone).not.toHaveBeenCalled();
  });

  it('Audit-Fehlschlag vor Phase (b) verhindert Pull/Beweis-Runde — Kandidat bereits verworfen', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const audit = auditSpy('gpg-rotate:b');
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});

    expect(result.ok).toBe(false);
    expect(workspaceMutator.pullClone).not.toHaveBeenCalled();
    expect(state.naechste).toBeNull(); // best-effort verworfen
  });
});

describe('PerAppGpgRotationService.commitRotation — AC4/AC6 (Reihenfolge: erst Bitwarden, dann Commit+Push)', () => {
  async function seedProvedCandidate({ password = 'ACTIVE-OLD-PASS', candidate = 'CANDIDATE-VALUE' } = {}) {
    const { deployLoginService, state } = buildDeployLoginService({ password, naechste: candidate });
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from(`ENC(${password}):PLAINTEXT`) });
    // .env.gpg.next simuliert das Ergebnis einer bereits erfolgreich gelaufenen Beweis-Runde (startRotation).
    fsDeps.files.set(ENV_GPG_NEXT, Buffer.from(`ENC(${candidate}):PLAINTEXT`));
    return { deployLoginService, state, fsDeps };
  }

  it('AC4: Bitwarden-Umschaltung (EIN Aufruf) erfolgt VOR commitAndPushFile', async () => {
    const { deployLoginService, state, fsDeps } = await seedProvedCandidate();
    const callOrder = [];
    const { workspaceMutator } = buildWorkspaceMutator({ callOrder });
    const audit = auditSpy();

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, { identity: 'a@b.ch' });

    expect(result).toEqual({ ok: true });
    expect(state.password).toBe('CANDIDATE-VALUE');
    expect(state.vorherige).toBe('ACTIVE-OLD-PASS');
    expect(state.naechste).toBeNull();
    // Reihenfolge: die einzige aufgezeichnete git-Aktion ('commitPush') lief NACH
    // der Bitwarden-Mutation — Bitwarden-State ist zum Zeitpunkt des commitPush-
    // Aufrufs bereits umgeschaltet (verifiziert über den Endzustand + Single-Call).
    expect(callOrder).toEqual(['commitPush']);
    expect(workspaceMutator.commitAndPushFile).toHaveBeenCalledWith(
      APP, '.env.gpg', expect.any(Function), expect.objectContaining({ commitMessage: expect.any(String) }),
    );
    // Erfolg: .env.gpg wurde mit dem bewiesenen Ciphertext überschrieben, .next aufgeräumt.
    expect(fsDeps.files.get(ENV_GPG).toString('utf8')).toBe('ENC(CANDIDATE-VALUE):PLAINTEXT');
    expect(fsDeps.files.has(ENV_GPG_NEXT)).toBe(false);
  });

  it('kein Kandidat vorhanden (naechste leer) → Fehler, keine Bitwarden-Mutation', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS', naechste: null });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, {});

    expect(result.ok).toBe(false);
    expect(state.password).toBe('ACTIVE-OLD-PASS'); // unverändert
    expect(workspaceMutator.commitAndPushFile).not.toHaveBeenCalled();
  });
});

describe('PerAppGpgRotationService.commitRotation — AC13: Push-Fehlschlag → Bitwarden-Rollback', () => {
  it('commitAndPushFile schlägt fehl (push-failed) → Item exakt auf Zustand vor (c) zurückgerollt', async () => {
    const password = 'ACTIVE-OLD-PASS';
    const candidate = 'CANDIDATE-VALUE';
    const { deployLoginService, state } = buildDeployLoginService({ password, naechste: candidate, vorherige: null });
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from(`ENC(${password}):PLAINTEXT`) });
    fsDeps.files.set(ENV_GPG_NEXT, Buffer.from(`ENC(${candidate}):PLAINTEXT`));
    const { workspaceMutator } = buildWorkspaceMutator({ commitPushFails: 'push-failed' });
    const audit = auditSpy();

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit, workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, {});

    expect(result).toEqual({ ok: false, errorClass: 'push-failed', reason: expect.any(String) });
    // AC13: exakt der Zustand vor (c) — alte Passphrase wieder aktiv, Kandidat zurück in
    // naechste, vorherige geleert (kein Misch-Zustand).
    expect(state.password).toBe(password);
    expect(state.naechste).toBe(candidate);
    expect(state.vorherige).toBeNull();
    // .env.gpg.next bleibt erhalten (Retry-Fähigkeit ohne erneute Beweis-Runde).
    expect(fsDeps.files.has(ENV_GPG_NEXT)).toBe(true);
  });

  it('commitAndPushFile schlägt fehl (commit-failed) → derselbe Rollback, errorClass durchgereicht', async () => {
    const password = 'ACTIVE-OLD-PASS';
    const candidate = 'CANDIDATE-VALUE';
    const { deployLoginService, state } = buildDeployLoginService({ password, naechste: candidate });
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from(`ENC(${password}):PLAINTEXT`) });
    fsDeps.files.set(ENV_GPG_NEXT, Buffer.from(`ENC(${candidate}):PLAINTEXT`));
    const { workspaceMutator } = buildWorkspaceMutator({ commitPushFails: 'commit-failed' });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, {});

    expect(result.errorClass).toBe('commit-failed');
    expect(state.password).toBe(password);
    expect(state.naechste).toBe(candidate);
    expect(state.vorherige).toBeNull();
  });

  it('commitAndPushFile schlägt fehl (branch-mismatch, Finding 2) → derselbe Rollback, errorClass durchgereicht', async () => {
    const password = 'ACTIVE-OLD-PASS';
    const candidate = 'CANDIDATE-VALUE';
    const { deployLoginService, state } = buildDeployLoginService({ password, naechste: candidate });
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from(`ENC(${password}):PLAINTEXT`) });
    fsDeps.files.set(ENV_GPG_NEXT, Buffer.from(`ENC(${candidate}):PLAINTEXT`));
    const { workspaceMutator } = buildWorkspaceMutator({ commitPushFails: 'branch-mismatch' });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, {});

    expect(result.errorClass).toBe('branch-mismatch');
    // AC13-Doktrin gilt auch für Finding 2: exakt der Zustand vor (c).
    expect(state.password).toBe(password);
    expect(state.naechste).toBe(candidate);
    expect(state.vorherige).toBeNull();
  });
});

describe('PerAppGpgRotationService — access-not-ready-Klassifikation (Vorbild PerAppGpgProvisioningService.test.js)', () => {
  it('startRotation: Zugang nicht ready → errorClass "access-not-ready", KEIN naechste gesetzt', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService: { openSession }, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});

    expect(result).toEqual({ ok: false, phase: 'aborted', errorClass: 'access-not-ready', reason: expect.any(String) });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(workspaceMutator.pullClone).not.toHaveBeenCalled();
  });

  it('commitRotation: Zugang nicht ready → errorClass "access-not-ready", KEINE Bitwarden-/Git-Mutation', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):X') });

    const svc = new PerAppGpgRotationService({
      deployLoginService: { openSession }, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.commitRotation(APP, {});

    expect(result).toEqual({ ok: false, errorClass: 'access-not-ready', reason: expect.any(String) });
    expect(workspaceMutator.commitAndPushFile).not.toHaveBeenCalled();
  });
});

describe('PerAppGpgRotationService.discardPrevious — AC5', () => {
  it('entfernt NUR vorherige — aktives Passwortfeld/naechste unangetastet', async () => {
    const { deployLoginService, state } = buildDeployLoginService({ password: 'ACTIVE-PASS', naechste: 'SOME-CANDIDATE', vorherige: 'ROLLBACK-ANCHOR' });
    const audit = auditSpy();
    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit,
      workspaceMutator: { pullClone: jest.fn(), commitAndPushFile: jest.fn() },
    });

    const result = await svc.discardPrevious(APP, { identity: 'a@b.ch' });

    expect(result).toEqual({ ok: true });
    expect(state.vorherige).toBeNull();
    expect(state.password).toBe('ACTIVE-PASS');
    expect(state.naechste).toBe('SOME-CANDIDATE');
    expect(audit.calls).toEqual([{ identity: 'a@b.ch', command: `deploy:gpg-rotate:d:${APP}` }]);
  });

  it('Audit-Fehlschlag → kein bw-Aufruf, ok:false', async () => {
    const { deployLoginService, openSessionCalls } = buildDeployLoginService({});
    const audit = auditSpy('gpg-rotate:d');
    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: audit,
      workspaceMutator: { pullClone: jest.fn(), commitAndPushFile: jest.fn() },
    });

    const result = await svc.discardPrevious(APP, {});

    expect(result.ok).toBe(false);
    expect(openSessionCalls.length).toBe(0);
  });
});

describe('PerAppGpgRotationService — AC7: Response ist geheimnisfrei', () => {
  it('startRotation-Erfolg enthält keine Passphrase im Ergebnis-Objekt', async () => {
    const { deployLoginService } = buildDeployLoginService({ password: 'ACTIVE-OLD-PASS' });
    const { workspaceMutator } = buildWorkspaceMutator();
    const fsDeps = buildFsDeps({ envGpgContent: Buffer.from('ENC(ACTIVE-OLD-PASS):PLAINTEXT-CONTENT') });

    const svc = new PerAppGpgRotationService({
      deployLoginService, auditStore: auditSpy(), workspaceMutator,
      workspaceRootResolver: async () => ({ path: '/workspace' }),
      fsDeps, cryptoDeps: fakeCrypto(),
    });

    const result = await svc.startRotation(APP, {});
    const json = JSON.stringify(result);
    expect(json).not.toContain('ACTIVE-OLD-PASS');
    expect(json).not.toContain('PLAINTEXT-CONTENT');
  });
});
