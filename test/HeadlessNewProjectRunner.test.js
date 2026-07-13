/**
 * @file HeadlessNewProjectRunner.test.js — Unit-Tests der headless `new-project`-
 * Scaffold-Ausführungs-Naht (docs/specs/per-app-gpg-passphrase-provisioning.md,
 * ADR-021 in docs/architecture.md, F-073/S-336).
 *
 * Covers (per-app-gpg-passphrase-provisioning.md, ADR-021):
 *   AC4 — `run(projectPath)` startet EIN `claude -p '/agent-flow:new-project'`
 *         (argv-Array, kein Shell-String), `cwd` = validierter Projekt-Pfad,
 *         über eine EIGENE `ProjectJobLock`-Instanz (getrennt von allen anderen
 *         headless-Runnern — zwei Instanzen blockieren sich NICHT beim selben
 *         Pfad). `close`-Event als einzige Fertig-Quelle; `run()` **resolved**
 *         bei Erfolg (`done`), **rejected** bei Fehlschlag (Non-Zero-Exit /
 *         `auth-expired` / Timeout / Start-Ablehnung `locked`).
 *   AC5/AC6 — `run(projectPath, { env })` reicht einen additiven Pro-Lauf-Env-
 *         Override (z.B. `GPG_PASS_FILE=<pfad>`) NUR für DIESEN Lauf durch
 *         (ADR-021-Erweiterung von `HeadlessRunnerCore`); der `GPG_PASS_FILE`-
 *         Pfad landet unverändert in der Child-Env, NIE im Argv.
 *   (Trust-Boundary) Env-Allowlist + `CLAUDE_CODE_OAUTH_TOKEN`; harter
 *         `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block bleibt auch mit Env-
 *         Override bestehen.
 *   (Audit) Per-Lauf-Audit bei Start/Ende/Fehler — je GENAU EIN `AuditEntry`,
 *         secret-frei (nur sanitisierter Repo-Slug, kein Host-Pfad/Token).
 *   AC4/AC15 — `runWithAutoProvisioning(app, projectPath, opts)`: die Naht
 *         INNERHALB des Runners (ADR-021 „Der Runner … ruft an seinem
 *         erfolgreichen Abschluss withScaffoldPassphrase … auf"). Komponiert
 *         den ECHTEN `run()`-Pfad (echter Fake-Child, kein reiner Mock-Stub)
 *         mit einem injizierten `provisioningService` — Scaffold-Erfolg löst
 *         GENAU EINEN `withScaffoldPassphrase`-Aufruf mit korrektem `app` +
 *         `GPG_PASS_FILE`-Env-Weiterreichung aus; Scaffold-Fehlschlag löst
 *         KEINEN Aufruf aus. Fehlender `provisioningService` → `{result:
 *         'failed'}` (Wiring-Fehler, kein Crash). **Scope-Hinweis:** kein
 *         Produktivcode-Aufrufer dieser Methode in dieser Story (S-336) — die
 *         Verdrahtung der drei Anlage-Wege ist die separate Folge-Story S-343
 *         (AC12-AC14, siehe Modul-Header-Scope-Hinweis).
 *
 * Pattern: injizierbare `spawnFn`, die ein Fake-Child (EventEmitter mit
 * stdout/stderr-Sub-Emittern + `kill()`-Spy) liefert — der ECHTE
 * `HeadlessRunnerCore`-Pfad wird so ohne echten `claude`-Prozess geprüft
 * (run()-Ebenen-Test, coder/R06 — nicht nur eine Helper-Funktion). Für
 * `runWithAutoProvisioning()` wird zusätzlich der ECHTE `run()`-Pfad (nicht
 * gemockt) mit einem gemockten `provisioningService` komponiert — verifiziert
 * die tatsächliche Naht zwischen Runner und Dienst, nicht nur je Seite isoliert.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import {
  HeadlessNewProjectRunner,
  NEW_PROJECT_COMMAND,
  DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS,
} from '../src/HeadlessNewProjectRunner.js';
import { DEFAULT_RECONCILE_TIMEOUT_MS } from '../src/HeadlessReconcileRunner.js';
import { DEFAULT_FLOW_HEADLESS_TIMEOUT_MS } from '../src/HeadlessFlowRunner.js';
import { DEFAULT_RETRO_HEADLESS_TIMEOUT_MS } from '../src/HeadlessRetroRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';
import { PerAppGpgProvisioningService } from '../src/PerAppGpgProvisioningService.js';

/**
 * Pollt bis `conditionFn()` wahr wird (statt eines einzelnen `tick()`) — nötig für
 * die End-zu-Ende-Komposition mit dem ECHTEN `PerAppGpgProvisioningService`, dessen
 * `withScaffoldPassphrase()` mehrere echte async I/O-Schritte (Audit, `openSession()`,
 * `itemExists()`, `mkdtemp`/`writeFile`/`chmod`) VOR dem `run()`-Aufruf durchläuft —
 * ein einzelner `setImmediate`-Tick reicht dafür nicht zuverlässig.
 */
async function waitFor(conditionFn, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) throw new Error('[test] waitFor() Timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

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

const PROJECT_PATH = '/workspace/my-new-project';

describe('HeadlessNewProjectRunner — AC4: headless claude -p /agent-flow:new-project (argv-Array, cwd, close = Fertig-Quelle)', () => {
  it('spawnt claude mit /agent-flow:new-project als EIN -p argv-Element + cwd; run() resolved bei Exit 0', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', '/agent-flow:new-project', '--dangerously-skip-permissions']);
    expect(NEW_PROJECT_COMMAND).toBe('/agent-flow:new-project');
    expect(opts.cwd).toBe(PROJECT_PATH);
  });

  it('run() rejected bei Non-Zero-Exit (Scaffold-Fehler)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 1);

    await expect(p).rejects.toThrow(/fehlgeschlagen/);
  });

  it('run() rejected bei Timeout (SIGTERM → failed)', async () => {
    const child = makeFakeChild();
    const runner = new HeadlessNewProjectRunner({ spawnFn: () => child, timeoutMs: 5, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    // KEIN close — der Core-Timeout (5ms) terminiert den hängenden Prozess.
    await expect(p).rejects.toThrow(/fehlgeschlagen/i);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('eigene ProjectJobLock-Instanz per Default — zwei unabhängige Runner-Instanzen blockieren sich NICHT beim selben Pfad', async () => {
    const spawnFnA = jest.fn(() => makeFakeChild());
    const spawnFnB = jest.fn(() => makeFakeChild());
    const runnerA = new HeadlessNewProjectRunner({ spawnFn: spawnFnA, timeoutMs: 10_000, pollIntervalMs: 1 });
    const runnerB = new HeadlessNewProjectRunner({ spawnFn: spawnFnB, timeoutMs: 10_000, pollIntervalMs: 1 });

    // Beide Runner haben je eine EIGENE ProjectJobLock-Instanz (Konstruktor-Default) —
    // ein bereits laufender Lauf auf runnerA blockiert runnerB NICHT (kein `locked`-Reject).
    const pA = runnerA.run(PROJECT_PATH);
    const pB = runnerB.run(PROJECT_PATH);
    await tick();
    expect(spawnFnA).toHaveBeenCalledTimes(1);
    expect(spawnFnB).toHaveBeenCalledTimes(1);

    spawnFnA.mock.results[0].value.emit('close', 0);
    spawnFnB.mock.results[0].value.emit('close', 0);
    await expect(pA).resolves.toBeUndefined();
    await expect(pB).resolves.toBeUndefined();
  });

  it('EIN geteiltes externes Lock würde einen zweiten Lauf auf demselben Pfad ablehnen (Kontrast-Sanity zur Default-Isolation)', () => {
    const sharedLock = new ProjectJobLock();
    const runnerA = new HeadlessNewProjectRunner({ spawnFn: jest.fn(() => makeFakeChild()), timeoutMs: 10_000, lock: sharedLock });
    const runnerB = new HeadlessNewProjectRunner({ spawnFn: jest.fn(() => makeFakeChild()), timeoutMs: 10_000, lock: sharedLock });

    const pA = runnerA.run(PROJECT_PATH);
    pA.catch(() => {});
    expect(sharedLock.isHeld(PROJECT_PATH)).toBe(true);

    // runnerB teilt dasselbe Lock (explizit injiziert) — der zweite Start wird abgelehnt.
    const pB = runnerB.run(PROJECT_PATH);
    return expect(pB).rejects.toThrow(/abgelehnt/);
  });

  it('Timeout ist eigenständig, NICHT an Reconcile-/Flow-/Retro-Default gekoppelt', () => {
    expect(DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_RECONCILE_TIMEOUT_MS);
    expect(DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_FLOW_HEADLESS_TIMEOUT_MS);
    expect(DEFAULT_NEW_PROJECT_HEADLESS_TIMEOUT_MS).not.toBe(DEFAULT_RETRO_HEADLESS_TIMEOUT_MS);
  });
});

describe('HeadlessNewProjectRunner — AC5/AC6: Pro-Lauf-Env-Override (GPG_PASS_FILE)', () => {
  it('run(projectPath, { env }) reicht GPG_PASS_FILE additiv in die Child-Env durch — NIE im Argv', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH, { env: { GPG_PASS_FILE: '/tmp/gpg-pass-abc/gpg-pass' } });
    await tick();
    child.emit('close', 0);
    await p;

    const [, args, opts] = spawnFn.mock.calls[0];
    expect(opts.env.GPG_PASS_FILE).toBe('/tmp/gpg-pass-abc/gpg-pass');
    expect(args.join(' ')).not.toContain('gpg-pass');
  });

  it('run(projectPath) OHNE env-Override lässt GPG_PASS_FILE unverändert weg (Plugin-Fallback-Pfad)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await p;

    const [, , opts] = spawnFn.mock.calls[0];
    expect('GPG_PASS_FILE' in opts.env).toBe(false);
  });
});

describe('HeadlessNewProjectRunner — Trust-Boundary: Env-Allowlist + harter API-Key-Block (auch mit Env-Override)', () => {
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

  it('CLAUDE_CODE_OAUTH_TOKEN wird durchgereicht, ANTHROPIC_API_KEY/OPENAI_API_KEY NIE — auch nicht via env-Override', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-live-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak';

    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH, {
      env: { GPG_PASS_FILE: '/tmp/gpg-pass-xyz/gpg-pass', ANTHROPIC_API_KEY: 'sk-smuggled-in-override' },
    });
    await tick();
    child.emit('close', 0);
    await p;

    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-live-test');
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.env.OPENAI_API_KEY).toBeUndefined();
    expect(opts.env.GPG_PASS_FILE).toBe('/tmp/gpg-pass-xyz/gpg-pass');
  });
});

describe('HeadlessNewProjectRunner — Audit (Start/Ende/Fehler, secret-frei)', () => {
  it('Erfolg → genau zwei Audit-Einträge (Start, Ende) mit sanitisiertem Repo-Slug, ohne Host-Pfad/Token', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const auditCalls = [];
    const auditStore = { record: (e) => auditCalls.push(e) };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, auditStore });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await p;

    expect(auditCalls.length).toBe(2);
    expect(auditCalls[0].command).toMatch(/^new-project-headless:run-start repo=my-new-project$/);
    expect(auditCalls[1].command).toMatch(/^new-project-headless:run-done repo=my-new-project$/);
    // Kein voller Host-Pfad im Audit (nur der sanitisierte Basename-Slug).
    for (const call of auditCalls) {
      expect(call.command).not.toContain('/workspace/');
    }
  });

  it('Fehlschlag → Start- + Fehler-Audit (kein Ende-Audit)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const auditCalls = [];
    const auditStore = { record: (e) => auditCalls.push(e) };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, auditStore });

    const p = runner.run(PROJECT_PATH);
    p.catch(() => {});
    await tick();
    child.emit('close', 1);
    await p.catch(() => {});

    expect(auditCalls.map((c) => c.command.split(' ')[0])).toEqual([
      'new-project-headless:run-start',
      'new-project-headless:run-failed',
    ]);
  });

  it('ein Audit-Fehler crasht den Lauf nicht (best-effort)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const auditStore = { record: () => { throw new Error('audit down'); } };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, auditStore });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('ohne auditStore (Default null) — kein Crash, kein Aufruf', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const p = runner.run(PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('HeadlessNewProjectRunner — runWithAutoProvisioning() — AC4/AC15 Naht INNERHALB des Runners (ADR-021)', () => {
  it('Scaffold-Erfolg → withScaffoldPassphrase GENAU EINMAL mit korrektem app-Slug; fn reicht GPG_PASS_FILE additiv an den ECHTEN run()/spawnFn-Pfad durch', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const withScaffoldPassphrase = jest.fn(async (app, fn) => {
      await fn({ gpgPassFilePath: '/tmp/gpg-pass-xyz/gpg-pass' });
      return { result: 'created' };
    });
    const provisioningService = { withScaffoldPassphrase };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, provisioningService });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    const result = await p;

    expect(result).toEqual({ result: 'created' });
    expect(withScaffoldPassphrase).toHaveBeenCalledTimes(1);
    expect(withScaffoldPassphrase.mock.calls[0][0]).toBe('myapp');
    expect(typeof withScaffoldPassphrase.mock.calls[0][1]).toBe('function');

    // Der ECHTE run()-Pfad (kein Mock) hat GPG_PASS_FILE tatsächlich in die Child-Env gereicht.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.env.GPG_PASS_FILE).toBe('/tmp/gpg-pass-xyz/gpg-pass');
    expect(opts.cwd).toBe(PROJECT_PATH);
  });

  it('Scaffold-Fehlschlag (Non-Zero-Exit) → der ECHTE run()-Reject propagiert bis zum provisioningService-Aufrufer, KEIN Erfolgs-Ergebnis', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    let fnRejected = false;
    const withScaffoldPassphrase = jest.fn(async (app, fn) => {
      try {
        await fn({ gpgPassFilePath: '/tmp/gpg-pass-fail/gpg-pass' });
        return { result: 'created' };
      } catch {
        fnRejected = true;
        return { result: 'failed', reason: 'Projekt-Scaffold fehlgeschlagen — keine Provisionierung.' };
      }
    });
    const provisioningService = { withScaffoldPassphrase };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, provisioningService });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH);
    await tick();
    child.emit('close', 1);
    const result = await p;

    expect(fnRejected).toBe(true);
    expect(result.result).toBe('failed');
  });

  it('fn({}) OHNE gpgPassFilePath (Plugin-Fallback-Zweig von withScaffoldPassphrase, z.B. access-not-ready) — KEIN GPG_PASS_FILE in der Child-Env des ECHTEN run()-Laufs', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const withScaffoldPassphrase = jest.fn(async (app, fn) => {
      await fn({});
      return { result: 'access-not-ready', reason: 'Bitte zuerst den Deploy-Zugang hinterlegen.' };
    });
    const provisioningService = { withScaffoldPassphrase };
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, provisioningService });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    const result = await p;

    expect(result.result).toBe('access-not-ready');
    const [, , opts] = spawnFn.mock.calls[0];
    expect('GPG_PASS_FILE' in opts.env).toBe(false);
  });

  it('ohne provisioningService konfiguriert → { result: "failed" }, KEIN run()/spawnFn-Aufruf (Wiring-Fehler, kein Crash)', async () => {
    const spawnFn = jest.fn();
    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1 });

    const result = await runner.runWithAutoProvisioning('myapp', PROJECT_PATH);

    expect(result).toEqual({ result: 'failed', reason: expect.any(String) });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('identity wird an withScaffoldPassphrase durchgereicht — Default: Runner-eigene identity aus dem Konstruktor', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const withScaffoldPassphrase = jest.fn(async (app, fn) => {
      await fn({});
      return { result: 'created' };
    });
    const provisioningService = { withScaffoldPassphrase };
    const runner = new HeadlessNewProjectRunner({
      spawnFn,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      provisioningService,
      identity: 'owner@example.ch',
    });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH);
    await tick();
    child.emit('close', 0);
    await p;

    expect(withScaffoldPassphrase.mock.calls[0][2]).toEqual({ identity: 'owner@example.ch' });
  });

  it('per-Aufruf-Override der identity gewinnt gegen die Runner-eigene identity', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const withScaffoldPassphrase = jest.fn(async (app, fn) => {
      await fn({});
      return { result: 'created' };
    });
    const provisioningService = { withScaffoldPassphrase };
    const runner = new HeadlessNewProjectRunner({
      spawnFn,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      provisioningService,
      identity: 'default@example.ch',
    });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH, { identity: 'override@example.ch' });
    await tick();
    child.emit('close', 0);
    await p;

    expect(withScaffoldPassphrase.mock.calls[0][2]).toEqual({ identity: 'override@example.ch' });
  });
});

describe('HeadlessNewProjectRunner — runWithAutoProvisioning() — End-zu-Ende mit dem ECHTEN PerAppGpgProvisioningService (AC4/AC5/AC6/AC15, keine Doppel-Mocks)', () => {
  it('Scaffold-Erfolg: echter withScaffoldPassphrase() + echter run() — Passphrasen-Identität (AC6) über die komponierte Naht, temp-Datei 0600 (AC5) + danach entfernt', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn();
    let observedGpgPassFilePath;
    let observedContentDuringSpawn;
    let observedModeDuringSpawn;
    spawnFn.mockImplementation((cmd, args, opts) => {
      observedGpgPassFilePath = opts.env.GPG_PASS_FILE;
      observedContentDuringSpawn = readFileSync(observedGpgPassFilePath, 'utf8');
      observedModeDuringSpawn = statSync(observedGpgPassFilePath).mode & 0o777;
      return child;
    });

    const calls = { itemExists: [], createItem: [] };
    const session = {
      itemExists: jest.fn(async (name) => {
        calls.itemExists.push(name);
        return false;
      }),
      createItem: jest.fn(async (name, pass) => {
        calls.createItem.push({ name, pass });
      }),
      close: jest.fn(async () => {}),
    };
    const deployLoginService = { openSession: jest.fn(async () => session) };
    const auditStore = { record: jest.fn() };
    const provisioningService = new PerAppGpgProvisioningService({ deployLoginService, auditStore });

    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, provisioningService });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH, { identity: 'a@b.ch' });
    await waitFor(() => spawnFn.mock.calls.length > 0);
    child.emit('close', 0);
    const result = await p;

    expect(result).toEqual({ result: 'created' });
    // AC5: 0600, existierte WÄHREND des Scaffold-Laufs (Beobachtung im spawnFn-Callback).
    expect(observedModeDuringSpawn).toBe(0o600);
    // AC6: dieselbe Passphrase, mit der der Scaffold lief, steht im Bitwarden-createItem.
    expect(calls.itemExists).toEqual(['env.gpg-passphrase-myapp']);
    expect(calls.createItem.length).toBe(1);
    expect(calls.createItem[0].name).toBe('env.gpg-passphrase-myapp');
    expect(calls.createItem[0].pass).toBe(observedContentDuringSpawn);
    // AC5: nach Abschluss (Erfolg) ist die temp-Datei garantiert entfernt.
    expect(() => statSync(observedGpgPassFilePath)).toThrow();
  });

  it('Scaffold-Fehlschlag (Non-Zero-Exit): echter withScaffoldPassphrase() + echter run() — KEIN Bitwarden-Item, temp-Datei trotzdem entfernt (kein Teil-Zustand)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn();
    let observedGpgPassFilePath;
    spawnFn.mockImplementation((cmd, args, opts) => {
      observedGpgPassFilePath = opts.env.GPG_PASS_FILE;
      return child;
    });

    const calls = { itemExists: [], createItem: [] };
    const session = {
      itemExists: jest.fn(async (name) => {
        calls.itemExists.push(name);
        return false;
      }),
      createItem: jest.fn(async (name, pass) => {
        calls.createItem.push({ name, pass });
      }),
      close: jest.fn(async () => {}),
    };
    const deployLoginService = { openSession: jest.fn(async () => session) };
    const auditStore = { record: jest.fn() };
    const provisioningService = new PerAppGpgProvisioningService({ deployLoginService, auditStore });

    const runner = new HeadlessNewProjectRunner({ spawnFn, timeoutMs: 10_000, pollIntervalMs: 1, provisioningService });

    const p = runner.runWithAutoProvisioning('myapp', PROJECT_PATH);
    await waitFor(() => spawnFn.mock.calls.length > 0);
    child.emit('close', 1);
    const result = await p;

    expect(result.result).toBe('failed');
    expect(calls.createItem.length).toBe(0);
    expect(() => statSync(observedGpgPassFilePath)).toThrow();
  });
});
