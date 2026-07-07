/**
 * FeatureDrainFlowRunner.test.js — Unit-Tests für den Feature-Drain-
 * Ausführungsschritt (docs/specs/feature-aware-drain.md AC1, AC4, AC5, AC6).
 *
 * Covers (feature-aware-drain):
 *   AC1 — startRun() spawnt `bash <plugin-scripts-dir>/board-feature-drain.sh
 *          <F-###>` als Kindprozess (argv-Array), cwd=projectPath.
 *   AC4 — `F-###` wird gegen FEATURE_ID_RE validiert (kein Freitext, keine
 *          Argument-Injektion); Child-Env NIE ANTHROPIC_API_KEY/OPENAI_API_KEY
 *          (buildChildEnv-Allowlist); Audit-Start/-Ende/-Fehler je Lauf,
 *          secret-/pfad-frei (nur Projekt-Basename statt absolutem Pfad).
 *   AC5 — pluginRootResolver() liefert null (Skript in keiner Plugin-Version
 *          vorhanden) -> {ok:false, reason:'feature-drain-unavailable'}, KEIN
 *          Spawn-Versuch, kein Crash.
 *   AC6 — Cross-Boundary-Lock (S-317 Review-Iteration 2): ein injizierter
 *          `featureDrainLock` (DIESELBE Instanz wie der Feature-Umsetzen-
 *          Button-Router) blockiert einen zweiten `startRun()` für
 *          dasselbe `${projectSlug}:${featureId}` — gegenseitige Blockade in
 *          BEIDE Richtungen (Runner hält den Lock -> Router-artiger
 *          `tryAcquire()` schlägt fehl, und umgekehrt); Lock wird im
 *          close/error-Handler freigegeben (kein Dauer-Lock); ohne
 *          injizierten `featureDrainLock` bleibt startRun() unverändert
 *          (kein Regress an bestehenden Tests ohne dieses Feld).
 *   Exit-Code-Mapping (Modul-Doku): 0 und 3 -> awaitCompletion() 'done'
 *          (Exit 3 = "wartet", kein Runner-Fehler); alle anderen Codes sowie
 *          spawn-error -> 'failed'.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { FeatureDrainFlowRunner, FEATURE_ID_RE, DEFAULT_POLL_INTERVAL_MS } from '../src/FeatureDrainFlowRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeDeps({ pluginRoot = '/plugin' } = {}) {
  const spawned = { child: null, cmd: null, args: null, opts: null };
  const spawnFn = jest.fn((cmd, args, opts) => {
    spawned.cmd = cmd; spawned.args = args; spawned.opts = opts;
    spawned.child = makeChild();
    return spawned.child;
  });
  const pluginRootResolver = jest.fn(async () => pluginRoot);
  const auditStore = { record: jest.fn() };
  return { spawnFn, spawned, pluginRootResolver, auditStore };
}

describe('FeatureDrainFlowRunner', () => {
  it('FEATURE_ID_RE akzeptiert nur F-<Ziffern> (AC4)', () => {
    expect(FEATURE_ID_RE.test('F-042')).toBe(true);
    expect(FEATURE_ID_RE.test('F-1')).toBe(true);
    expect(FEATURE_ID_RE.test('S-042')).toBe(false);
    expect(FEATURE_ID_RE.test('F-abc')).toBe(false);
    expect(FEATURE_ID_RE.test('F-42; rm -rf /')).toBe(false);
  });

  it('startRun(): lehnt eine ungültige featureId ab, OHNE zu spawnen (AC4 — kein Freitext, keine Injektion)', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });

    const result = await runner.startRun({ projectPath: '/repo', featureId: 'not-a-feature', identity: null });

    expect(result).toEqual({ ok: false, reason: 'internal' });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(spawned.child).toBeNull();
  });

  it('startRun(): spawnt bash <scripts>/board-feature-drain.sh <F-###> als Array-argv, cwd=projectPath (AC1)', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps({ pluginRoot: '/plugin/agent-flow' });
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });

    const result = await runner.startRun({ projectPath: '/repo/dev-gui', featureId: 'F-042', identity: 'alex@example.com' });

    expect(result.ok).toBe(true);
    expect(typeof result.handle.jobId).toBe('string');
    expect(spawned.cmd).toBe('bash');
    expect(spawned.args).toEqual(['/plugin/agent-flow/scripts/board-feature-drain.sh', 'F-042']);
    expect(spawned.opts.cwd).toBe('/repo/dev-gui');
  });

  it('startRun(): Child-Env enthält NIE ANTHROPIC_API_KEY/OPENAI_API_KEY, auch wenn im Prozess-Env gesetzt (AC4-Floor)', async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevOpenAi = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    process.env.OPENAI_API_KEY = 'sk-secret-2';
    try {
      const { spawnFn, spawned, pluginRootResolver } = makeDeps();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });
      await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });

      expect(spawned.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawned.opts.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAi;
    }
  });

  it('startRun(): pluginRootResolver() liefert null -> {ok:false, reason:"feature-drain-unavailable"}, KEIN Spawn (AC5)', async () => {
    const { spawnFn, pluginRootResolver } = makeDeps({ pluginRoot: null });
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });

    const result = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });

    expect(result).toEqual({ ok: false, reason: 'feature-drain-unavailable' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('startRun(): pluginRootResolver() wirft -> {ok:false, reason:"feature-drain-unavailable"}, kein Crash (AC5)', async () => {
    const spawnFn = jest.fn();
    const pluginRootResolver = jest.fn(async () => { throw new Error('boom'); });
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });

    const result = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });

    expect(result).toEqual({ ok: false, reason: 'feature-drain-unavailable' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('startRun(): erzeugt genau einen Start-AuditEntry, secret-/pfad-frei (Projekt-Basename statt absolutem Pfad, AC4)', async () => {
    const { spawnFn, pluginRootResolver, auditStore } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, auditStore });

    await runner.startRun({ projectPath: '/home/node/workspace/dev-gui', featureId: 'F-042', identity: 'alex@example.com' });

    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const entry = auditStore.record.mock.calls[0][0];
    expect(entry.command).toContain('feature-drain-start');
    expect(entry.command).toContain('project=dev-gui');
    expect(entry.command).toContain('feature=F-042');
    expect(entry.command).not.toContain('/home/node/workspace');
  });

  it('awaitCompletion(): close(0) -> {status:"done"} + Ende-AuditEntry (Exit-Code-Mapping)', async () => {
    const { spawnFn, spawned, pluginRootResolver, auditStore } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, auditStore, sleepFn: async () => {} });

    const startResult = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });
    const completionPromise = runner.awaitCompletion(startResult.handle);
    spawned.child.emit('close', 0);

    await expect(completionPromise).resolves.toEqual({ status: 'done', error: undefined });
    expect(auditStore.record).toHaveBeenCalledTimes(2); // start + done
  });

  it('awaitCompletion(): close(3) ("wartet" — echte Blockade/Depends-Gate) -> {status:"done"}, KEIN Runner-Fehler (Modul-Doku Exit-Code-Mapping)', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, sleepFn: async () => {} });

    const startResult = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });
    const completionPromise = runner.awaitCompletion(startResult.handle);
    spawned.child.stdout.emit('data', Buffer.from('BLOCKIERT: S-901\n'));
    spawned.child.emit('close', 3);

    await expect(completionPromise).resolves.toEqual({ status: 'done', error: undefined });
  });

  it('awaitCompletion(): close(1) -> {status:"failed", error} generisch (kein Skript-Output-Leak)', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, sleepFn: async () => {} });

    const startResult = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });
    const completionPromise = runner.awaitCompletion(startResult.handle);
    spawned.child.emit('close', 1);

    const result = await completionPromise;
    expect(result.status).toBe('failed');
    expect(typeof result.error).toBe('string');
  });

  it('awaitCompletion(): spawn error-Event -> {status:"failed"}, kein Crash', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps();
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, sleepFn: async () => {} });

    const startResult = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });
    const completionPromise = runner.awaitCompletion(startResult.handle);
    spawned.child.emit('error', new Error('ENOENT'));

    const result = await completionPromise;
    expect(result.status).toBe('failed');
  });

  it('DEFAULT_POLL_INTERVAL_MS ist 2000 (Default-Poll-Intervall)', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(2000);
  });

  it('awaitCompletion(): pollt bis close-Event feuert (kein sofortiges "running", sleepFn wird injiziert genutzt)', async () => {
    const { spawnFn, spawned, pluginRootResolver } = makeDeps();
    let sleepCalls = 0;
    const sleepFn = async () => { sleepCalls += 1; };
    const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, sleepFn, pollIntervalMs: 10 });

    const startResult = await runner.startRun({ projectPath: '/repo', featureId: 'F-1', identity: null });
    const completionPromise = runner.awaitCompletion(startResult.handle);
    // Kurzes Zeitfenster, in dem der Job noch 'running' ist -> mind. ein Poll-Zyklus.
    await Promise.resolve();
    await Promise.resolve();
    spawned.child.emit('close', 0);
    await completionPromise;

    expect(sleepCalls).toBeGreaterThan(0);
  });

  describe('Cross-Boundary-Lock (AC6, S-317 Review-Iteration 2)', () => {
    it('startRun(): mit injiziertem featureDrainLock UND projectSlug lehnt einen zweiten startRun() für dasselbe Feature ab, OHNE zu spawnen', async () => {
      const { spawnFn, spawned, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock });

      const first = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(first.ok).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);

      const second = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(second).toEqual({ ok: false, reason: 'feature-drain-locked' });
      expect(spawnFn).toHaveBeenCalledTimes(1); // kein zweiter Kindprozess

      void spawned;
    });

    it('startRun(): DIESELBE featureDrainLock-Instanz wie der Feature-Umsetzen-Button-Router blockiert gegenseitig — Runner haelt den Lock -> Router-artiger tryAcquire() schlaegt fehl', async () => {
      const { spawnFn, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock });

      const result = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(result.ok).toBe(true);

      // Router-Verhalten (src/routers/featureDrain.js): lockKey = `${slug}:${featureId}`.
      const routerLockKey = 'my-project:F-042';
      expect(featureDrainLock.tryAcquire(routerLockKey)).toBe(false);
    });

    it('startRun(): umgekehrte Richtung — der Feature-Umsetzen-Button-Router haelt den Lock zuerst -> Runner-startRun() lehnt ab', async () => {
      const { spawnFn, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock });

      // Router haelt den Lock zuerst (Feature-Umsetzen-Button bereits gestartet).
      expect(featureDrainLock.tryAcquire('my-project:F-042')).toBe(true);

      const result = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(result).toEqual({ ok: false, reason: 'feature-drain-locked' });
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it('startRun(): gibt den Lock im close-Handler frei -> ein Folge-startRun() fuer dasselbe Feature ist danach wieder moeglich', async () => {
      const { spawnFn, spawned, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock, sleepFn: async () => {} });

      const first = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(first.ok).toBe(true);
      spawned.child.emit('close', 0);
      await runner.awaitCompletion(first.handle);

      expect(featureDrainLock.isHeld('my-project:F-042')).toBe(false);

      const second = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(second.ok).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it('startRun(): gibt den Lock auch im error-Handler frei (kein Dauer-Lock bei Spawn-Fehler)', async () => {
      const { spawnFn, spawned, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock, sleepFn: async () => {} });

      const result = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(result.ok).toBe(true);
      spawned.child.emit('error', new Error('ENOENT'));
      await runner.awaitCompletion(result.handle);

      expect(featureDrainLock.isHeld('my-project:F-042')).toBe(false);
    });

    it('startRun(): ohne injizierten featureDrainLock bleibt Verhalten unveraendert (kein Regress) — zwei aufeinanderfolgende Laeufe fuer dasselbe Feature sind beide ok', async () => {
      const { spawnFn, pluginRootResolver } = makeDeps();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn });

      const first = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      const second = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it('startRun(): ohne projectSlug (z.B. Board-Scan fehlgeschlagen) wird der Lock-Schritt uebersprungen, kein Crash', async () => {
      const { spawnFn, pluginRootResolver } = makeDeps();
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock });

      const result = await runner.startRun({ projectPath: '/repo', projectSlug: null, featureId: 'F-042', identity: null });
      expect(result.ok).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('startRun(): Skript unverfuegbar (feature-drain-unavailable) gibt einen bereits erworbenen Lock wieder frei (kein Dauer-Lock)', async () => {
      const { spawnFn, pluginRootResolver } = makeDeps({ pluginRoot: null });
      const featureDrainLock = new ProjectJobLock();
      const runner = new FeatureDrainFlowRunner({ pluginRootResolver, spawnFn, featureDrainLock });

      const result = await runner.startRun({ projectPath: '/repo', projectSlug: 'my-project', featureId: 'F-042', identity: null });
      expect(result).toEqual({ ok: false, reason: 'feature-drain-unavailable' });
      expect(featureDrainLock.isHeld('my-project:F-042')).toBe(false);
    });
  });
});
