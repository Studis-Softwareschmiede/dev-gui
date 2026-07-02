/**
 * @file HeadlessRetroRunner.test.js — Unit-Tests der headless Retro-Ausführungs-
 * Naht hinter der `RetroAutoQueue` (docs/specs/retro-auto-queue.md, S-257).
 *
 * Covers (retro-auto-queue): AC5, AC6
 *
 *   AC5 — Headless-Ausführung: `run(projectPath)` startet einen `claude -p`-
 *         Kindprozess mit Befehl `/agent-flow:retro` + Arg `--force` (argv-Array,
 *         kein Shell-String), `cwd` = validierter Repo-Pfad, über eine EIGENE
 *         `HeadlessFlowRunner`- + `ProjectJobLock`-Instanz (getrennt von allen
 *         anderen Runnern — zwei Instanzen blockieren sich NICHT beim selben
 *         Repo). Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`; HARTER
 *         `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block; `close`-Event als einzige
 *         Fertig-Quelle; eigener Timeout → SIGTERM/`failed`. `run()` **resolved**
 *         bei Erfolg (`done`), **rejected** bei Fehlschlag (Non-Zero /
 *         `auth-expired` / Timeout / `locked`). Gemockte `spawnFn`/Runner —
 *         KEIN echter `claude -p`-Live-Lauf.
 *   AC6 — Audit je Lauf bei **Start**, **Ende (Erfolg)**, **Fehler** — je GENAU
 *         EIN `AuditEntry`; KEINE Secrets/Token/absoluten Host-Pfade (nur
 *         sanitisierter Repo-Slug). Audit ist best-effort (ein Audit-Fehler
 *         crasht den Lauf nicht).
 *
 * Pattern: injizierbare `spawnFn`, die ein Fake-Child (EventEmitter mit
 * stdout/stderr-Sub-Emittern + `kill()`-Spy) liefert — der ECHTE
 * `HeadlessFlowRunner`-Default-Pfad wird so ohne echten `claude`-Prozess geprüft
 * (run()-Ebenen-Test, coder/R06 — nicht nur eine Helper-Funktion). Für den
 * `locked`-Pfad wird ein reiner Fake-Runner injiziert.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  HeadlessRetroRunner,
  RETRO_COMMAND,
  RETRO_FORCE_ARG,
  DEFAULT_RETRO_HEADLESS_TIMEOUT_MS,
} from '../src/HeadlessRetroRunner.js';
import { DEFAULT_RECONCILE_TIMEOUT_MS } from '../src/HeadlessReconcileRunner.js';
import { DEFAULT_FLOW_HEADLESS_TIMEOUT_MS } from '../src/HeadlessFlowRunner.js';

/** Fake-Child: EventEmitter mit stdout/stderr-Sub-Emittern + kill()-Spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Ein Makrotask-Tick — lässt start()/den ersten Poll-Park laufen. */
const tick = () => new Promise((r) => setImmediate(r));

const PROJECT_PATH = '/workspace/my-project';

describe('HeadlessRetroRunner — AC5: headless claude -p /agent-flow:retro --force (argv-Array, cwd)', () => {
  it('spawnt claude mit /agent-flow:retro --force als EIN -p argv-Element + cwd', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRetroRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    // `claude -p` nimmt nur EIN Prompt-Argument — command + args sind EIN argv-
    // Element (headless-arg-finalize-safety AC1), Array-Übergabe (kein Shell-String).
    expect(args).toEqual(['-p', '/agent-flow:retro --force', '--dangerously-skip-permissions']);
    expect(RETRO_COMMAND).toBe('/agent-flow:retro');
    expect(RETRO_FORCE_ARG).toBe('--force');
    expect(opts.cwd).toBe(PROJECT_PATH);
    expect(typeof opts.env).toBe('object');
  });

  it('Timeout ist eigenständig, NICHT an Reconcile-/Flow-Default gekoppelt', () => {
    expect(DEFAULT_RETRO_HEADLESS_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_RETRO_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_RECONCILE_TIMEOUT_MS);
    expect(DEFAULT_RETRO_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_FLOW_HEADLESS_TIMEOUT_MS);
  });
});

describe('HeadlessRetroRunner — AC5: Env-Allowlist + Trust-Boundary (API-Key-Block)', () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedOpenai = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenai;
  });

  it('CLAUDE_CODE_OAUTH_TOKEN wird durchgereicht, ANTHROPIC_API_KEY/OPENAI_API_KEY NIE', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-live-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak';

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessRetroRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await p;

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-live-test');
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('HeadlessRetroRunner — AC5: eigene HeadlessFlowRunner-/ProjectJobLock-Instanz', () => {
  it('zwei Instanzen blockieren sich NICHT beim selben Repo (eigene Lock-Instanz je Runner)', async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    const spawnA = jest.fn(() => childA);
    const spawnB = jest.fn(() => childB);
    const runnerA = new HeadlessRetroRunner({ spawnFn: spawnA, timeoutMs: 10_000, pollIntervalMs: 1 });
    const runnerB = new HeadlessRetroRunner({ spawnFn: spawnB, timeoutMs: 10_000, pollIntervalMs: 1 });

    // Beide starten gleichzeitig einen Lauf für DASSELBE Repo — mit getrennten
    // Lock-Instanzen darf KEINER als `locked` abgewiesen werden.
    const pA = runnerA.run(PROJECT_PATH);
    const pB = runnerB.run(PROJECT_PATH);
    await tick();
    childA.emit('close', 0);
    childB.emit('close', 0);
    await Promise.all([pA, pB]);

    expect(spawnA).toHaveBeenCalledTimes(1);
    expect(spawnB).toHaveBeenCalledTimes(1);
  });
});

describe('HeadlessRetroRunner — AC5: Terminalstatus → resolve/reject', () => {
  it('Exit 0 → run() resolved (Erfolg)', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, timeoutMs: 10_000, pollIntervalMs: 1 });
    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('Non-Zero-Exit → run() rejected (Fehlschlag), secret-freie Meldung', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, timeoutMs: 10_000, pollIntervalMs: 1 });
    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/fehlgeschlagen/i);
    // Keine absoluten Host-Pfade in der Fehlermeldung.
    await p.catch((err) => expect(err.message).not.toContain('/workspace'));
  });

  it('401 in der Ausgabe → auth-expired → run() rejected', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, timeoutMs: 10_000, pollIntervalMs: 1 });
    const p = runner.run(PROJECT_PATH);
    await tick();
    child.stderr.emit('data', 'HTTP 401 Invalid authentication credentials');
    child.emit('close', 1);
    await expect(p).rejects.toThrow(/status=auth-expired/);
  });

  it('Timeout → SIGTERM (kill) → failed → run() rejected', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, timeoutMs: 5, pollIntervalMs: 1 });
    const p = runner.run(PROJECT_PATH);
    // KEIN close — der Core-Timeout (5ms) terminiert den hängenden Prozess.
    await expect(p).rejects.toThrow(/fehlgeschlagen/i);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('Runner meldet `locked` → run() rejected (defensiv, Queue fährt fort)', async () => {
    const lockedRunner = {
      start: jest.fn(() => ({ ok: false, reason: 'locked' })),
      getJob: jest.fn(),
    };
    const runner = new HeadlessRetroRunner({ runner: lockedRunner });
    await expect(runner.run(PROJECT_PATH)).rejects.toThrow(/locked/);
    expect(lockedRunner.getJob).not.toHaveBeenCalled();
  });

  it('leerer/ungültiger projectPath → synchron abgelehnt (Vertrag)', async () => {
    const runner = new HeadlessRetroRunner({ runner: { start: jest.fn(), getJob: jest.fn() } });
    await expect(runner.run('')).rejects.toThrow(/nicht-leeren String/);
    await expect(runner.run(undefined)).rejects.toThrow(/nicht-leeren String/);
  });
});

describe('HeadlessRetroRunner — AC6: Audit bei Start / Ende / Fehler (je genau EINS, secret-frei)', () => {
  it('Erfolg → GENAU zwei Audit-Einträge (Start + Ende), nur Repo-Slug (kein Host-Pfad)', async () => {
    const child = makeFakeChild();
    const auditStore = { record: jest.fn() };
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, auditStore, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await p;

    expect(auditStore.record).toHaveBeenCalledTimes(2);
    const commands = auditStore.record.mock.calls.map(([e]) => e.command);
    expect(commands[0]).toBe('retro-auto:run-start repo=my-project');
    expect(commands[1]).toBe('retro-auto:run-done repo=my-project');
    // Secret-frei: kein absoluter Host-Pfad, keine Token.
    for (const [entry] of auditStore.record.mock.calls) {
      expect(entry.command).not.toContain('/workspace');
      expect(entry.command).toContain('repo=my-project');
      expect(entry.identity).toBeNull();
    }
  });

  it('Fehlschlag → GENAU zwei Audit-Einträge (Start + Fehler)', async () => {
    const child = makeFakeChild();
    const auditStore = { record: jest.fn() };
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, auditStore, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 1);
    await p.catch(() => {});

    expect(auditStore.record).toHaveBeenCalledTimes(2);
    const commands = auditStore.record.mock.calls.map(([e]) => e.command);
    expect(commands[0]).toBe('retro-auto:run-start repo=my-project');
    expect(commands[1]).toBe('retro-auto:run-failed repo=my-project');
  });

  it('`locked` → GENAU zwei Audit-Einträge (Start + Fehler)', async () => {
    const auditStore = { record: jest.fn() };
    const runner = new HeadlessRetroRunner({
      runner: { start: () => ({ ok: false, reason: 'locked' }), getJob: jest.fn() },
      auditStore,
    });
    await runner.run(PROJECT_PATH).catch(() => {});
    expect(auditStore.record).toHaveBeenCalledTimes(2);
    expect(auditStore.record.mock.calls[0][0].command).toBe('retro-auto:run-start repo=my-project');
    expect(auditStore.record.mock.calls[1][0].command).toBe('retro-auto:run-failed repo=my-project');
  });

  it('Audit ist best-effort: wirft `record()`, crasht der Lauf NICHT (Erfolg bleibt Erfolg)', async () => {
    const child = makeFakeChild();
    const auditStore = { record: jest.fn(() => { throw new Error('audit down'); }) };
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, auditStore, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('ohne auditStore läuft run() ebenfalls durch (Audit optional)', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessRetroRunner({ spawnFn: () => child, timeoutMs: 10_000, pollIntervalMs: 1 });
    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });
});
