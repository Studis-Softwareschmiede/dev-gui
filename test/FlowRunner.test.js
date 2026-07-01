/**
 * @file FlowRunner.test.js — Unit tests for the injectable `FlowRunner`
 * interface + its two adapters (docs/specs/headless-parallel-drain.md).
 *
 * Covers (headless-parallel-drain):
 *   AC4 — `FlowRunner`-Interface mit zwei Operationen (`startRun`/
 *         `awaitCompletion`), zwei Implementierungen:
 *     - `InteractiveFlowRunner`: kapselt `CommandService.tryRun()` +
 *       Idle-Completion-Poll (`getStatus()` bis nicht mehr `'running'`),
 *       heutiges Verhalten (reasons `locked`/`busy`/`invalid`/`session-cap`/
 *       `internal` 1:1 durchgereicht; ein werfendes `tryRun()` wird als
 *       `internal` behandelt, kein Crash).
 *     - `HeadlessFlowRunnerAdapter`: kapselt `HeadlessFlowRunner.start()` +
 *       Poll auf `getJob()` bis das ECHTE `close`-Event-Ergebnis vorliegt
 *       (`'done'|'failed'|'auth-expired'`, kein PTY-Idle-Raten); defensiver
 *       `/agent-flow:`-Allowlist-Guard (Security-Hygiene, S-204-Review-
 *       Suggestion) und `locked`-reason-Passthrough (per-Projekt-Lock, AC8).
 *   AC13 — Gate = Unit-Tests mit gemockten `commandService`/`headlessRunner`
 *         Kollaborateuren (kein echter `claude -p`-Lauf, kein echtes PTY).
 *
 * Der ProjectDrain-Injections-/Konvergenz-Nachweis mit beiden Adaptern
 * (AC5/AC6) lebt in test/ProjectDrain.test.js (describe-Block "FlowRunner-
 * Injection").
 *
 * Covers (headless-parallel-drain, S-213):
 *   AC11 — `HeadlessFlowRunnerAdapter` erzeugt bei injiziertem `auditStore`
 *          je headless-Lauf genau EINEN Start- (`startRun`, ok:true) und
 *          genau EINEN Ende(Erfolg)/Fehler-`AuditEntry` (`awaitCompletion`,
 *          Korrelation über `jobId`); secret-/pfad-frei (Basename statt
 *          absolutem `projectPath`); ohne `auditStore` unverändert kein
 *          Audit, kein Crash (Rückwärtskompatibilität S-212). Die ECHTE
 *          Naht (ProjectDrain + HeadlessFlowRunner, echte Parallelität,
 *          Selbst-Blockade-Vermeidung, Sanftes Fensterende) lebt in
 *          test/headless-night-drain.integration.test.js.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { InteractiveFlowRunner, HeadlessFlowRunnerAdapter } from '../src/FlowRunner.js';

const PROJECT_PATH = '/workspace/my-project';

describe('InteractiveFlowRunner (AC4 — interactive adapter, bit-identical to today)', () => {
  it('startRun() forwards command/identity/projectPath to commandService.tryRun() and wraps the ok result', () => {
    const commandService = {
      tryRun: jest.fn(() => ({ ok: true, commandId: 'cmd-1', status: 'running' })),
      getStatus: () => ({ commandId: null, status: null }),
    };
    const runner = new InteractiveFlowRunner({ commandService });

    const result = runner.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow', identity: 'alex@example.com' });

    expect(commandService.tryRun).toHaveBeenCalledWith({
      command: '/agent-flow:flow',
      identity: 'alex@example.com',
      projectPath: PROJECT_PATH,
    });
    expect(result).toEqual({ ok: true, handle: { commandId: 'cmd-1' } });
  });

  it('defaults identity to null when omitted', () => {
    const commandService = {
      tryRun: jest.fn(() => ({ ok: true, commandId: 'cmd-1', status: 'running' })),
      getStatus: () => ({ commandId: null, status: null }),
    };
    const runner = new InteractiveFlowRunner({ commandService });

    runner.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });

    expect(commandService.tryRun).toHaveBeenCalledWith({
      command: '/agent-flow:flow',
      identity: null,
      projectPath: PROJECT_PATH,
    });
  });

  it.each(['locked', 'busy', 'invalid', 'session-cap', 'internal'])(
    'passes through commandService reason %s unchanged (no ok:true wrapping)',
    (reason) => {
      const commandService = {
        tryRun: () => ({ ok: false, reason }),
        getStatus: () => ({ commandId: null, status: null }),
      };
      const runner = new InteractiveFlowRunner({ commandService });

      const result = runner.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });

      expect(result).toEqual({ ok: false, reason });
    },
  );

  it('a throwing commandService.tryRun() is caught and mapped to reason "internal" (no crash)', () => {
    const commandService = {
      tryRun: () => {
        throw new Error('PTY exploded');
      },
      getStatus: () => ({ commandId: null, status: null }),
    };
    const runner = new InteractiveFlowRunner({ commandService });

    const result = runner.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });

    expect(result).toEqual({ ok: false, reason: 'internal' });
  });

  it('awaitCompletion() polls getStatus() via the injected sleepFn until status leaves "running" (idle-completion, no real close-event)', async () => {
    const statuses = ['running', 'running', 'done'];
    let pollCount = 0;
    const commandService = {
      tryRun: () => ({ ok: true, commandId: 'cmd-1', status: 'running' }),
      getStatus: () => ({ commandId: 'cmd-1', status: statuses[Math.min(pollCount, statuses.length - 1)] }),
    };
    const sleepCalls = [];
    const sleepFn = async (ms) => {
      sleepCalls.push(ms);
      pollCount += 1;
    };
    const runner = new InteractiveFlowRunner({ commandService, sleepFn, pollIntervalMs: 50 });

    const result = await runner.awaitCompletion({ commandId: 'cmd-1' });

    expect(sleepCalls).toEqual([50, 50]);
    expect(result).toEqual({ status: 'done' });
  });

  it('awaitCompletion() resolves immediately (no sleep) when getStatus() already reports non-running', async () => {
    const commandService = {
      tryRun: () => ({ ok: true, commandId: 'cmd-1', status: 'running' }),
      getStatus: () => ({ commandId: 'cmd-1', status: 'done' }),
    };
    const sleepFn = jest.fn(async () => {});
    const runner = new InteractiveFlowRunner({ commandService, sleepFn });

    const result = await runner.awaitCompletion({ commandId: 'cmd-1' });

    expect(sleepFn).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'done' });
  });
});

describe('HeadlessFlowRunnerAdapter (AC4 — headless adapter, real close-event instead of idle-poll)', () => {
  it('startRun() calls headlessRunner.start(projectPath, {command, args}) and wraps the jobId into a handle', () => {
    const headlessRunner = {
      start: jest.fn(() => ({ ok: true, jobId: 'job-1' })),
      getJob: () => undefined,
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner });

    const result = adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow', args: ['--cost', 'balanced'] });

    expect(headlessRunner.start).toHaveBeenCalledWith(PROJECT_PATH, {
      command: '/agent-flow:flow',
      args: ['--cost', 'balanced'],
    });
    expect(result).toEqual({ ok: true, handle: { jobId: 'job-1' } });
  });

  it('passes through headlessRunner reason "locked" unchanged (per-project ProjectJobLock, AC8 — no global bottleneck)', () => {
    const headlessRunner = {
      start: () => ({ ok: false, reason: 'locked' }),
      getJob: () => undefined,
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner });

    const result = adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });

    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('a throwing headlessRunner.start() is caught and mapped to reason "internal" (no crash)', () => {
    const headlessRunner = {
      start: () => {
        throw new Error('spawn exploded');
      },
      getJob: () => undefined,
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner });

    const result = adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });

    expect(result).toEqual({ ok: false, reason: 'internal' });
  });

  it.each(['/flow', '/agent-flow', 'rm -rf /', ''])(
    'security-hygiene: rejects a non-"/agent-flow:"-prefixed command %j defensively (reason internal, no spawn attempt)',
    (command) => {
      const headlessRunner = { start: jest.fn(), getJob: () => undefined };
      const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner });

      const result = adapter.startRun({ projectPath: PROJECT_PATH, command });

      expect(result).toEqual({ ok: false, reason: 'internal' });
      expect(headlessRunner.start).not.toHaveBeenCalled();
    },
  );

  it('awaitCompletion() polls getJob() via the injected sleepFn until the real close-event result is terminal ("done")', async () => {
    const jobStates = [
      { status: 'running' },
      { status: 'running' },
      { status: 'done', result: 'Flow abgeschlossen', prHint: '#42' },
    ];
    let pollCount = 0;
    const headlessRunner = {
      start: () => ({ ok: true, jobId: 'job-1' }),
      getJob: () => jobStates[Math.min(pollCount, jobStates.length - 1)],
    };
    const sleepCalls = [];
    const sleepFn = async (ms) => {
      sleepCalls.push(ms);
      pollCount += 1;
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn, pollIntervalMs: 2000 });

    const result = await adapter.awaitCompletion({ jobId: 'job-1' });

    expect(sleepCalls).toEqual([2000, 2000]);
    expect(result).toEqual({ status: 'done', result: 'Flow abgeschlossen', error: undefined, prHint: '#42' });
  });

  it('awaitCompletion() maps a "failed" terminal job (timeout/non-zero exit) through unchanged', async () => {
    const headlessRunner = {
      start: () => ({ ok: true, jobId: 'job-1' }),
      getJob: () => ({ status: 'failed', error: 'Flow-Lauf abgebrochen (Timeout)' }),
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });

    const result = await adapter.awaitCompletion({ jobId: 'job-1' });

    expect(result).toEqual({ status: 'failed', result: undefined, error: 'Flow-Lauf abgebrochen (Timeout)', prHint: undefined });
  });

  it('awaitCompletion() maps an "auth-expired" terminal job (401-Vorrang) through unchanged', async () => {
    const headlessRunner = {
      start: () => ({ ok: true, jobId: 'job-1' }),
      getJob: () => ({ status: 'auth-expired', error: 'Claude-Anmeldung abgelaufen' }),
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });

    const result = await adapter.awaitCompletion({ jobId: 'job-1' });

    expect(result.status).toBe('auth-expired');
  });

  it('awaitCompletion() treats a vanished job (getJob returns undefined) as "failed" (defensive, no hang)', async () => {
    const headlessRunner = {
      start: () => ({ ok: true, jobId: 'job-1' }),
      getJob: () => undefined,
    };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });

    const result = await adapter.awaitCompletion({ jobId: 'job-1' });

    expect(result.status).toBe('failed');
  });
});

describe('HeadlessFlowRunnerAdapter — Audit je headless-Lauf (headless-parallel-drain AC11)', () => {
  it('startRun() ok:true → genau EIN Start-AuditEntry (identity durchgereicht, secret-/pfad-frei)', () => {
    const headlessRunner = { start: () => ({ ok: true, jobId: 'job-1' }), getJob: () => undefined };
    const auditStore = { record: jest.fn() };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, auditStore });

    adapter.startRun({ projectPath: '/workspace/my-project', command: '/agent-flow:flow', identity: 'alex@example.com' });

    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const entry = auditStore.record.mock.calls[0][0];
    expect(entry.identity).toBe('alex@example.com');
    expect(entry.command).toContain('taktgeber:headless-flow-start');
    expect(entry.command).toContain('jobId=job-1');
    expect(entry.command).toContain('project=my-project');
    expect(entry.command).not.toContain('/workspace/my-project');
  });

  it('startRun() ok:false (locked/internal/rejected command) → KEIN Audit-Eintrag (kein Lauf hat stattgefunden)', () => {
    const headlessRunner = { start: () => ({ ok: false, reason: 'locked' }), getJob: () => undefined };
    const auditStore = { record: jest.fn() };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, auditStore });

    adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });
    adapter.startRun({ projectPath: PROJECT_PATH, command: 'rm -rf /' }); // Allowlist-Reject

    expect(auditStore.record).not.toHaveBeenCalled();
  });

  it('awaitCompletion() status "done" → genau EIN Ende(Erfolg)-AuditEntry, korreliert über jobId (nicht "start")', async () => {
    const headlessRunner = {
      start: () => ({ ok: true, jobId: 'job-1' }),
      getJob: () => ({ status: 'done', result: 'Flow abgeschlossen' }),
    };
    const auditStore = { record: jest.fn() };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, auditStore, sleepFn: async () => {} });

    const { handle } = adapter.startRun({ projectPath: '/workspace/my-project', command: '/agent-flow:flow', identity: 'a@b.c' });
    auditStore.record.mockClear(); // nur das awaitCompletion()-Audit prüfen
    await adapter.awaitCompletion(handle);

    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const entry = auditStore.record.mock.calls[0][0];
    expect(entry.identity).toBe('a@b.c');
    expect(entry.command).toContain('taktgeber:headless-flow-done');
    expect(entry.command).toContain('jobId=job-1');
  });

  it('awaitCompletion() status "failed"/"auth-expired" → genau EIN Fehler-AuditEntry mit status im Text', async () => {
    for (const status of ['failed', 'auth-expired']) {
      const headlessRunner = { start: () => ({ ok: true, jobId: `job-${status}` }), getJob: () => ({ status }) };
      const auditStore = { record: jest.fn() };
      const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, auditStore, sleepFn: async () => {} });

      const { handle } = adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });
      auditStore.record.mockClear();
      await adapter.awaitCompletion(handle);

      expect(auditStore.record).toHaveBeenCalledTimes(1);
      const entry = auditStore.record.mock.calls[0][0];
      expect(entry.command).toContain('taktgeber:headless-flow-failed');
      expect(entry.command).toContain(`status=${status}`);
    }
  });

  it('ohne injizierten auditStore: kein Crash, kein Audit-Aufruf (Rückwärtskompatibilität S-212)', async () => {
    const headlessRunner = { start: () => ({ ok: true, jobId: 'job-1' }), getJob: () => ({ status: 'done' }) };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, sleepFn: async () => {} });

    const { handle } = adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' });
    await expect(adapter.awaitCompletion(handle)).resolves.toEqual(
      expect.objectContaining({ status: 'done' }),
    );
  });

  it('ein werfender auditStore.record() crasht den Lauf nicht (best-effort, analog ProjectDrain#auditRecord)', () => {
    const headlessRunner = { start: () => ({ ok: true, jobId: 'job-1' }), getJob: () => undefined };
    const auditStore = { record: () => { throw new Error('audit down'); } };
    const adapter = new HeadlessFlowRunnerAdapter({ headlessRunner, auditStore });

    expect(() =>
      adapter.startRun({ projectPath: PROJECT_PATH, command: '/agent-flow:flow' }),
    ).not.toThrow();
  });
});
