/**
 * SshPtyManager.test.js — Unit-Tests für die interaktive SSH-PTY-Bridge-Boundary.
 *
 * Covers (vps-ssh-terminal, docs/specs/vps-ssh-terminal.md):
 *   AC7  — Sitzungs-Lebenszyklus: close() killt den PTY + räumt die transiente
 *          Key-Datei auf; Idle-Timeout beendet die Sitzung genauso; Obergrenze
 *          paralleler Sitzungen wird durchgesetzt (Cap → geheimnisfreie Ablehnung,
 *          kein Spawn) — inkl. Regressionstest für parallele open()-Aufrufe
 *          (Promise.all) mit verzögertem resolveTarget: der Cap-Slot wird
 *          synchron reserviert, bevor irgendein await läuft (Race-Fix).
 *   AC8  — Private-Key bleibt store-intern + transient: nie im ssh-Argv (nur der
 *          Dateipfad), nie im Log/Konsole, nie in der Fehlermeldung; transiente
 *          Key-Datei ist mode 0600 und nach Sitzungsende (close + Idle-Timeout +
 *          Fehlerpfad) von der Platte verschwunden.
 *   AC10 — Host-Key-Policy: `StrictHostKeyChecking=accept-new` + persistierter
 *          `UserKnownHostsFile` sind im ssh-Aufruf sichtbar (kein pauschales
 *          StrictHostKeyChecking=no); ein Host-Key-Konflikt (aus dem PTY-Output
 *          erkannt) klassifiziert als `host-key-mismatch`, kein stiller Bypass.
 *   (AC6-Vorgriff, hier bewusst mitgetestet da die Boundary unabhängig vom
 *    WS-Aufrufer validiert) — User-Allowlist (nur root/alex), no-target bei
 *    nicht auflösbarem Ziel.
 *
 * Strategie:
 *   - `spawnFn` vollständig gemockt (EventEmitter-artiges Fake-PTY-Objekt mit
 *     steuerbaren onData/onExit-Callbacks) — es wird NIE ein echtes `ssh` gestartet.
 *   - `credentialStore` als schlanker Fake ({ getPlaintext }) — Store-Verschlüsselung
 *     selbst ist Gegenstand von CredentialStore.test.js, nicht dieser Datei.
 *   - `resolveTarget` als injizierte async Funktion (Adapter für resolveVpsTarget,
 *     docs/specs/vps-dynamic-ssh-targets.md — dessen Implementierung selbst ist
 *     nicht Gegenstand dieser Datei).
 *   - Kein Netzwerk-I/O; transiente Key-Dateien landen in einem Test-Tempdir
 *     (mkdtemp), das nach jedem Test aufgeräumt wird.
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SshPtyManager } from '../src/SshPtyManager.js';

// ── Test-Fixtures ────────────────────────────────────────────────────────────

const FAKE_PRIVATE_KEY = [
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' '),
  'FAKEPRIVATEKEYDATANOTREAL',
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' '),
].join('\n');

/** Baut ein steuerbares Fake-PTY-Objekt (node-pty IPty-Vertrag: onData/onExit/write/resize/kill). */
function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    onData: (cb) => dataListeners.push(cb),
    onExit: (cb) => exitListeners.push(cb),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    _emitData: (chunk) => dataListeners.forEach((cb) => cb(chunk)),
    _emitExit: (exitCode = 0) => exitListeners.forEach((cb) => cb({ exitCode })),
  };
}

/** Fake-CredentialStore — hinterlegt Private-Keys je user-Label im Speicher. */
function makeFakeCredentialStore(keys = {}) {
  return {
    getPlaintext: async (storeKey) => keys[storeKey] ?? null,
  };
}

// Reale Timer-Referenz (unabhängig von jest.useFakeTimers() in anderen Tests) —
// echte Filesystem-I/O (unlink) braucht einen echten Event-Loop-Tick, keine
// gemockte Zeit; zwei bloße `await Promise.resolve()`-Microtask-Hops reichen
// dafür NICHT zuverlässig (Race-Risiko in CI).
const realSetTimeout = globalThis.setTimeout;
function sleep(ms) {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Pollt eine Bedingung mit echten Timern, bis sie wahr wird oder ein Timeout greift. */
async function waitUntil(conditionFn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!conditionFn()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: Timeout beim Warten auf die Bedingung');
    }
    await sleep(intervalMs);
  }
}

async function collectHandlers() {
  const events = { output: [], state: [], error: [] };
  return {
    events,
    onOutput: (d) => events.output.push(d),
    onState: (s) => events.state.push(s),
    onError: (c, r) => events.error.push({ errorClass: c, reason: r }),
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tmpKeyDir;
let knownHostsPath;

beforeEach(async () => {
  tmpKeyDir = await mkdtemp(join(tmpdir(), 'ssh-pty-mgr-test-'));
  knownHostsPath = join(tmpKeyDir, 'known_hosts-dir', 'known_hosts');
});

afterEach(async () => {
  await rm(tmpKeyDir, { recursive: true, force: true });
});

function makeManager({ spawnFn, resolveTarget, credentialStore, cap, idleTimeoutMs } = {}) {
  return new SshPtyManager({
    credentialStore: credentialStore ?? makeFakeCredentialStore({
      'ssh/root/private_key': FAKE_PRIVATE_KEY,
      'ssh/alex/private_key': FAKE_PRIVATE_KEY,
    }),
    resolveTarget: resolveTarget ?? (async () => ({ host: '198.51.100.10', port: 22 })),
    spawnFn: spawnFn ?? jest.fn(() => makeFakePty()),
    cap: cap ?? 5,
    idleTimeoutMs: idleTimeoutMs ?? 60_000,
    knownHostsPath,
    tmpKeyDir,
  });
}

// ── Konstruktor ──────────────────────────────────────────────────────────────

describe('SshPtyManager — Konstruktor', () => {
  it('wirft ohne credentialStore', () => {
    expect(() => new SshPtyManager({ resolveTarget: async () => null })).toThrow(/credentialStore/i);
  });

  it('wirft ohne resolveTarget', () => {
    expect(() => new SshPtyManager({ credentialStore: makeFakeCredentialStore() })).toThrow(/resolveTarget/i);
  });
});

// ── AC6-Vorgriff: User-Allowlist ─────────────────────────────────────────────

describe('User-Allowlist (AC6-Vorgriff) — kein Spawn bei ungültigem User', () => {
  it('lehnt einen unbekannten user ab, ohne zu spawnen', async () => {
    const spawnFn = jest.fn();
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'bob', ...h });

    expect(session).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0].reason).not.toMatch(/bob/); // geheimnisfrei/kein Echo nötig
  });

  it('lehnt leeren/fehlenden user ab, ohne zu spawnen', async () => {
    const spawnFn = jest.fn();
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: '', ...h });

    expect(session).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('akzeptiert "root" und "alex"', async () => {
    for (const user of ['root', 'alex']) {
      const spawnFn = jest.fn(() => makeFakePty());
      const mgr = makeManager({ spawnFn });
      const h = await collectHandlers();
      const session = await mgr.open({ provider: 'hetzner', serverId: '1', user, ...h });
      expect(session).not.toBeNull();
      expect(spawnFn).toHaveBeenCalledTimes(1);
      await session.close();
    }
  });
});

// ── no-target ─────────────────────────────────────────────────────────────────

describe('Ziel-Auflösung — no-target', () => {
  it('resolveTarget liefert null → errorClass no-target, kein Spawn', async () => {
    const spawnFn = jest.fn();
    const mgr = makeManager({ spawnFn, resolveTarget: async () => null });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: 'unknown', user: 'root', ...h });

    expect(session).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(h.events.error).toEqual([{ errorClass: 'no-target', reason: expect.any(String) }]);
  });

  it('resolveTarget wirft → wird wie no-target behandelt (kein Crash)', async () => {
    const spawnFn = jest.fn();
    const mgr = makeManager({ spawnFn, resolveTarget: async () => { throw new Error('boom'); } });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: 'x', user: 'root', ...h });

    expect(session).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(h.events.error[0].errorClass).toBe('no-target');
  });
});

// ── no-private-key ────────────────────────────────────────────────────────────

describe('Key-Vorhandensein — no-private-key', () => {
  it('kein Key im Store hinterlegt → errorClass no-private-key, kein Spawn', async () => {
    const spawnFn = jest.fn();
    const mgr = makeManager({ spawnFn, credentialStore: makeFakeCredentialStore({}) });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });

    expect(session).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(h.events.error).toEqual([{ errorClass: 'no-private-key', reason: expect.any(String) }]);
  });
});

// ── AC7: Sitzungs-Cap ─────────────────────────────────────────────────────────

describe('AC7 — Obergrenze paralleler Sitzungen (Cap)', () => {
  it('lehnt eine Sitzung über dem Cap ab, ohne zu spawnen — bestehende laufen weiter', async () => {
    const spawnFn = jest.fn(() => makeFakePty());
    const mgr = makeManager({ spawnFn, cap: 2 });

    const h1 = await collectHandlers();
    const h2 = await collectHandlers();
    const h3 = await collectHandlers();

    const s1 = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h1 });
    const s2 = await mgr.open({ provider: 'hetzner', serverId: '2', user: 'root', ...h2 });
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(mgr.activeSessionCount).toBe(2);

    const s3 = await mgr.open({ provider: 'hetzner', serverId: '3', user: 'root', ...h3 });
    expect(s3).toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(2); // nur s1+s2 haben tatsächlich gespawnt
    expect(h3.events.error).toEqual([{ errorClass: 'error', reason: expect.any(String) }]);

    // Bestehende Sitzungen unberührt
    expect(mgr.activeSessionCount).toBe(2);

    await s1.close();
    await s2.close();
  });

  it('nach close() einer Sitzung ist wieder Platz unter dem Cap', async () => {
    const spawnFn = jest.fn(() => makeFakePty());
    const mgr = makeManager({ spawnFn, cap: 1 });

    const h1 = await collectHandlers();
    const s1 = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h1 });
    expect(s1).not.toBeNull();

    const h2 = await collectHandlers();
    const rejected = await mgr.open({ provider: 'hetzner', serverId: '2', user: 'root', ...h2 });
    expect(rejected).toBeNull();

    await s1.close();
    expect(mgr.activeSessionCount).toBe(0);

    const h3 = await collectHandlers();
    const s3 = await mgr.open({ provider: 'hetzner', serverId: '3', user: 'root', ...h3 });
    expect(s3).not.toBeNull();
    await s3.close();
  });

  it('REGRESSION (Important 2, live reproduziert): parallele open()-Aufrufe via Promise.all überschreiten den Cap nicht', async () => {
    // resolveTarget mit einer echten (kurzen) Verzögerung — bildet das reale
    // await-Fenster (resolveTarget/getPlaintext/mkdir/writeTransientFile) nach,
    // in dem der frühere Code den Sitzungs-Slot noch NICHT reserviert hatte.
    const spawnFn = jest.fn(() => makeFakePty());
    const resolveTarget = () => new Promise((resolve) => {
      realSetTimeout(() => resolve({ host: '198.51.100.20', port: 22 }), 5);
    });
    const mgr = makeManager({ spawnFn, resolveTarget, cap: 2 });

    const handlerBundles = await Promise.all(
      Array.from({ length: 10 }, () => collectHandlers()),
    );

    const openPromises = handlerBundles.map((h, i) => mgr.open({
      provider: 'hetzner',
      serverId: String(i),
      user: 'root',
      ...h,
    }));

    const sessions = await Promise.all(openPromises);
    const opened = sessions.filter((s) => s !== null);
    const rejected = sessions.filter((s) => s === null);

    expect(opened).toHaveLength(2); // exakt der Cap — nicht mehr
    expect(rejected).toHaveLength(8);
    expect(spawnFn).toHaveBeenCalledTimes(2); // nur die 2 zugelassenen Sitzungen spawnen
    expect(mgr.activeSessionCount).toBe(2);

    await Promise.all(opened.map((s) => s.close()));
    expect(mgr.activeSessionCount).toBe(0);
  });
});

// ── AC7 + AC8: Lifecycle — close() killt PTY + räumt Key-Datei auf ───────────

describe('AC7/AC8 — close() beendet den PTY und räumt die transiente Key-Datei auf', () => {
  it('close() ruft pty.kill() und entfernt die Key-Datei', async () => {
    let fakePty;
    const spawnFn = jest.fn((cmd, args) => {
      fakePty = makeFakePty();
      fakePty._argv = args;
      return fakePty;
    });
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    expect(session).not.toBeNull();
    expect(h.events.state).toContain('connecting');
    expect(h.events.state).toContain('connected');

    // Key-Datei existiert während der Sitzung
    const keyFiles = await readdir(tmpKeyDir);
    expect(keyFiles.some((f) => f.endsWith('.key'))).toBe(true);

    await session.close();

    expect(fakePty.kill).toHaveBeenCalledTimes(1);
    expect(h.events.state).toContain('disconnected');
    expect(mgr.activeSessionCount).toBe(0);

    // Key-Datei ist weg
    const afterFiles = await readdir(tmpKeyDir);
    expect(afterFiles.some((f) => f.endsWith('.key'))).toBe(false);
  });

  it('close() ist idempotent (zweiter Aufruf killt nicht erneut)', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    await session.close();
    await session.close();

    expect(fakePty.kill).toHaveBeenCalledTimes(1);
  });

  it('natürlicher PTY-Exit (exitCode 0) räumt ebenfalls die Key-Datei auf, ohne onError', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });

    fakePty._emitExit(0);
    // Cleanup (inkl. echtem fs.unlink) ist async — auf das disconnected-Event warten
    // statt auf eine feste Anzahl Microtask-Hops zu vertrauen (Race-Risiko).
    await waitUntil(() => h.events.state.includes('disconnected'));

    expect(h.events.error).toHaveLength(0);
    expect(mgr.activeSessionCount).toBe(0);

    const afterFiles = await readdir(tmpKeyDir);
    expect(afterFiles.some((f) => f.endsWith('.key'))).toBe(false);
  });
});

// ── AC7: Idle-Timeout ─────────────────────────────────────────────────────────

describe('AC7 — Idle-Timeout beendet die Sitzung + räumt Key-Material auf', () => {
  // Echte (kurze) Timer statt jest.useFakeTimers(): der Cleanup-Pfad nutzt echtes
  // fs.unlink (Node-I/O), das mit gemockter Zeit nicht deterministisch abwartbar
  // ist. waitUntil() pollt mit echten Timern bis zum tatsächlichen Zustand.

  it('ohne Aktivität killt der Idle-Timeout den PTY nach Ablauf', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty), idleTimeoutMs: 30 });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    expect(mgr.activeSessionCount).toBe(1);

    await waitUntil(() => fakePty.kill.mock.calls.length > 0);

    expect(mgr.activeSessionCount).toBe(0);
    const afterFiles = await readdir(tmpKeyDir);
    expect(afterFiles.some((f) => f.endsWith('.key'))).toBe(false);
  });

  it('Aktivität (write) setzt den Idle-Timer zurück — keine vorzeitige Beendigung', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty), idleTimeoutMs: 400 });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });

    await sleep(150);
    session.write('ls\n'); // setzt den Idle-Timer zurück
    await sleep(150); // insgesamt ~300ms seit Start, aber nur ~150ms seit der letzten Aktivität

    expect(fakePty.kill).not.toHaveBeenCalled();
    expect(mgr.activeSessionCount).toBe(1);

    await session.close();
  });
});

// ── AC8: Key-Leak-Floor ───────────────────────────────────────────────────────

describe('AC8 — Private-Key leakt nie (Argv/Konsole/Fehler), Key-Datei mode 0600', () => {
  it('ssh-Argv enthält den Key-INHALT nicht — nur den Dateipfad (-i <path>)', async () => {
    let capturedArgv;
    const spawnFn = jest.fn((cmd, args) => {
      capturedArgv = args;
      return makeFakePty();
    });
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    expect(session).not.toBeNull();

    const argvJoined = capturedArgv.join(' ');
    expect(argvJoined).not.toContain('FAKEPRIVATEKEYDATANOTREAL');
    expect(argvJoined).not.toContain('BEGIN OPENSSH');

    // -i <path> ist vorhanden und verweist auf eine reale, existierende Datei
    const iIndex = capturedArgv.indexOf('-i');
    expect(iIndex).toBeGreaterThan(-1);
    const keyPath = capturedArgv[iIndex + 1];
    expect(keyPath).toMatch(/\.key$/);

    await session.close();
  });

  it('transiente Key-Datei ist mode 0600', async () => {
    let capturedArgv;
    const spawnFn = jest.fn((cmd, args) => {
      capturedArgv = args;
      return makeFakePty();
    });
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    const keyPath = capturedArgv[capturedArgv.indexOf('-i') + 1];

    const st = await stat(keyPath);
    // Nur User-RW erlaubt (0600) — keine Group-/Other-Rechte
    expect(st.mode & 0o777).toBe(0o600);

    await session.close();
  });

  it('kein Key-Leak über console.log/warn/error während einer vollen Sitzung (open→data→close)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const fakePty = makeFakePty();
      const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
      const h = await collectHandlers();

      const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
      fakePty._emitData('some shell output\n');
      await session.close();

      for (const spy of [logSpy, warnSpy, errSpy]) {
        for (const call of spy.mock.calls) {
          const joined = call.map(String).join(' ');
          expect(joined).not.toContain('FAKEPRIVATEKEYDATANOTREAL');
          expect(joined).not.toContain('BEGIN OPENSSH');
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('no-private-key-Fehlermeldung enthält keinen Key-Inhalt (Store ist ohnehin leer)', async () => {
    const mgr = makeManager({ credentialStore: makeFakeCredentialStore({}) });
    const h = await collectHandlers();
    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    expect(h.events.error[0].reason).not.toContain('FAKEPRIVATEKEYDATANOTREAL');
  });

  it('Key-Datei ist auch bei einer geleakten spawnFn-Exception aufgeräumt', async () => {
    const spawnFn = jest.fn(() => { throw new Error('spawn kaputt'); });
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });

    expect(session).toBeNull();
    expect(h.events.error).toEqual([{ errorClass: 'error', reason: expect.any(String) }]);

    const files = await readdir(tmpKeyDir);
    expect(files.some((f) => f.endsWith('.key'))).toBe(false);
  });
});

// ── AC10: Host-Key-Policy ──────────────────────────────────────────────────────

describe('AC10 — Host-Key-Policy: accept-new + persistierter known_hosts, kein pauschales Ignorieren', () => {
  it('ssh-Argv enthält StrictHostKeyChecking=accept-new + UserKnownHostsFile=<persistiert> — NICHT StrictHostKeyChecking=no', async () => {
    let capturedArgv;
    const spawnFn = jest.fn((cmd, args) => {
      capturedArgv = args;
      return makeFakePty();
    });
    const mgr = makeManager({ spawnFn });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    expect(session).not.toBeNull();

    const argvJoined = capturedArgv.join(' ');
    expect(argvJoined).toContain('StrictHostKeyChecking=accept-new');
    expect(argvJoined).toContain(`UserKnownHostsFile=${knownHostsPath}`);
    expect(argvJoined).not.toContain('StrictHostKeyChecking=no');

    await session.close();
  });

  it('Host-Key-Konflikt im PTY-Output (exit != 0) → errorClass host-key-mismatch, kein Auto-Accept', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });

    fakePty._emitData('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n');
    fakePty._emitData('REMOTE HOST IDENTIFICATION HAS CHANGED!\n');
    fakePty._emitExit(255);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events.error).toEqual([{ errorClass: 'host-key-mismatch', reason: expect.any(String) }]);
    expect(fakePty.kill).not.toHaveBeenCalled(); // natürlicher Exit — kein zusätzlicher kill() nötig
    expect(mgr.activeSessionCount).toBe(0);
  });

  it('Auth-Fehlschlag (Permission denied) → errorClass auth-failed', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    fakePty._emitData('root@198.51.100.10: Permission denied (publickey).\n');
    fakePty._emitExit(255);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events.error).toEqual([{ errorClass: 'auth-failed', reason: expect.any(String) }]);
  });

  it('unerreichbares Ziel (Connection refused) → errorClass unreachable', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    fakePty._emitData('ssh: connect to host 198.51.100.10 port 22: Connection refused\n');
    fakePty._emitExit(255);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events.error).toEqual([{ errorClass: 'unreachable', reason: expect.any(String) }]);
  });

  it('unbekannter Fehlertext bei nicht-null exit → generische errorClass error (kein false-positive host-key-mismatch)', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    fakePty._emitData('irgendein unbekannter Absturz\n');
    fakePty._emitExit(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events.error).toEqual([{ errorClass: 'error', reason: expect.any(String) }]);
  });
});

// ── BatchMode / ConnectTimeout im Argv sichtbar (dokumentierte Policy) ────────

describe('ssh-Argv — dokumentierte Optionen sichtbar (BatchMode, ConnectTimeout, -p, User@Host)', () => {
  it('Argv enthält BatchMode=yes, ConnectTimeout, Port und user@host', async () => {
    let capturedArgv;
    const spawnFn = jest.fn((cmd, args) => {
      capturedArgv = args;
      return makeFakePty();
    });
    const mgr = makeManager({
      spawnFn,
      resolveTarget: async () => ({ host: '203.0.113.5', port: 2222 }),
    });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'alex', ...h });
    expect(session).not.toBeNull();

    const argvJoined = capturedArgv.join(' ');
    expect(argvJoined).toContain('BatchMode=yes');
    expect(argvJoined).toContain('ConnectTimeout=');
    expect(capturedArgv).toContain('-p');
    expect(capturedArgv).toContain('2222');
    expect(capturedArgv).toContain('alex@203.0.113.5');

    await session.close();
  });
});

// ── session.write / session.resize durchreichen ──────────────────────────────

describe('session.write / session.resize reichen an den PTY durch', () => {
  it('write() leitet an pty.write() weiter', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    session.write('ls -la\n');
    expect(fakePty.write).toHaveBeenCalledWith('ls -la\n');

    await session.close();
  });

  it('resize() validiert positive Ganzzahlen und leitet gültige Werte an pty.resize() weiter', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    session.resize(120, 40);
    expect(fakePty.resize).toHaveBeenCalledWith(120, 40);

    fakePty.resize.mockClear();
    session.resize(-1, 40);
    session.resize(0, 40);
    session.resize(1.5, 40);
    expect(fakePty.resize).not.toHaveBeenCalled();

    await session.close();
  });

  it('onOutput erhält den rohen PTY-Output byteweise (ANSI-Bytes erhalten)', async () => {
    const fakePty = makeFakePty();
    const mgr = makeManager({ spawnFn: jest.fn(() => fakePty) });
    const h = await collectHandlers();

    const session = await mgr.open({ provider: 'hetzner', serverId: '1', user: 'root', ...h });
    fakePty._emitData('[32mgreen[0m\n');
    expect(h.events.output).toEqual(['[32mgreen[0m\n']);

    await session.close();
  });
});
