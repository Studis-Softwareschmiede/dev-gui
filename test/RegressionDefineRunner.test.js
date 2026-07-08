/**
 * @file RegressionDefineRunner.test.js — unit tests for the headless
 * Regressionstest-Definier-Runner + its pure parsers + default claude adapter
 * (docs/specs/regression-define-dialog.md).
 *
 * Covers (regression-define-dialog): AC1, AC2, AC3, AC4, AC5, AC9, AC12
 *
 *   AC1 — start() runs headless via an OWN, isolated ProjectJobLock instance; a
 *         run round settles into a terminal `done`/`failed`/`auth-expired` OR the
 *         non-terminal interrupt `needs-review`. Lock held while running AND
 *         while a vorschlag is pending; released only on a terminal state (second
 *         start for the same project → locked; different project → not blocked).
 *   AC2 — needs-review exposes the machine-readable NL-vorschlag
 *         { projekt, ziel, quell_specs, vorschlag:[...], target_vorschlag }
 *         (markdown-fence-tolerant parse); an unparsable/broken outcome →
 *         `failed`, secret-free, no crash. E2 (Bereich ohne deckende Specs) →
 *         `failed` mit klarem Grund statt leerem/erfundenem Vorschlag.
 *   AC3 — review() resumes the run via STDIN (never argv) with `--resume <session-id>`;
 *         no new run is spawned; the job is addressed via jobId.
 *   AC4 — Eingabe-Vertrag: Projekt + Bereichs-id (aus board/areas.yaml) ODER
 *         Verbund-Name + optionale Stichworte werden an den Agenten durchgereicht
 *         (zielToArg/validateZiel).
 *   AC5 — Security floor: argv-array (no shell string), --dangerously-skip-permissions
 *         only in this headless path, ANTHROPIC_API_KEY/OPENAI_API_KEY blocked from
 *         child env, review payload via STDIN (never argv); getJob() view is
 *         secret-free (no projectPath/sessionId/identity); job-end/error audited
 *         with identity + action.
 *   AC9 — getJob() view carries `startedAt`/`lastActivityAt` (ISO-8601) always;
 *         `phase` best-effort from a fixed set (session-start/reading-specs/
 *         drafting/translating), absent when not determinable. Identical
 *         mechanism for the initial vorschlag round AND the resume/translate
 *         round (fresh `startedAt` + `phase:'translating'` on review()).
 *   AC12 — a terminal `failed` always carries `error_class` from a fixed set
 *         (parse-error/no-session/agent-failed/timeout). ONLY the parse-error
 *         path (parseRegressionDefineOutcome throws) additionally carries the
 *         server-side secret-filtered `raw_output`; absent otherwise (no leak,
 *         no crash even when the filter empties the content).
 *
 * The runner is exercised with an INJECTED runClaude adapter — no real `claude`
 * process (NFR „Entkopplung"). The default adapter's spawn/env/stdin/argv
 * security properties are covered separately via an injected spawnFn stub.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  RegressionDefineRunner,
  parseRegressionDefineOutcome,
  validateZiel,
  zielToArg,
  extractClaudeResult,
  defaultRunClaude,
  sanitizeRawOutput,
  REGRESSION_DEFINE_COMMAND,
  AUTH_EXPIRED_MESSAGE,
  ERROR_CLASS_PARSE,
  ERROR_CLASS_NO_SESSION,
  ERROR_CLASS_AGENT_FAILED,
  ERROR_CLASS_TIMEOUT,
} from '../src/RegressionDefineRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

/** Resolve pending microtasks so a fire-and-forget #runRound settles. */
function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * A runClaude adapter that returns queued results in order and records the
 * arguments of each call (for resume/review assertions).
 */
function makeSequencedRunClaude(results) {
  const calls = [];
  const queue = [...results];
  const fn = jest.fn(async (params) => {
    calls.push(params);
    return queue.shift() ?? { exitCode: 0, output: '{"status":"done"}', sessionId: undefined, authError: false };
  });
  fn.calls = calls;
  return fn;
}

const VORSCHLAG_OUTPUT = JSON.stringify({
  status: 'needs-review',
  projekt: 'dev-gui',
  ziel: { typ: 'bereich', id: 'fabrik-arbeiten' },
  quell_specs: ['docs/specs/regression-define-dialog.md'],
  vorschlag: [
    {
      titel: 'Regressionstest definieren startet Lauf',
      schritte: ['Dialog öffnen', 'Bereich wählen', 'Bestätigen'],
      pruefpunkte: ['Overlay zeigt Vorschlag'],
      beispieldaten: [{ bereich: 'fabrik-arbeiten' }],
    },
  ],
  target_vorschlag: null,
});

// ── Pure parser: parseRegressionDefineOutcome (AC2) ──────────────────────────

describe('parseRegressionDefineOutcome — AC2 machine-readable vorschlag', () => {
  it('parses status:"done"', () => {
    expect(parseRegressionDefineOutcome('{"status":"done"}')).toEqual({ status: 'done' });
  });

  it('parses a needs-review vorschlag and normalises fields', () => {
    const out = parseRegressionDefineOutcome(VORSCHLAG_OUTPUT);
    expect(out.status).toBe('needs-review');
    expect(out.vorschlag.projekt).toBe('dev-gui');
    expect(out.vorschlag.quell_specs).toEqual(['docs/specs/regression-define-dialog.md']);
    expect(out.vorschlag.vorschlag).toHaveLength(1);
    expect(out.vorschlag.vorschlag[0]).toEqual({
      titel: 'Regressionstest definieren startet Lauf',
      schritte: ['Dialog öffnen', 'Bereich wählen', 'Bestätigen'],
      pruefpunkte: ['Overlay zeigt Vorschlag'],
      beispieldaten: [{ bereich: 'fabrik-arbeiten' }],
    });
  });

  it('is markdown-fence tolerant (```json … ```)', () => {
    const fenced = '```json\n{"status":"done"}\n```';
    expect(parseRegressionDefineOutcome(fenced)).toEqual({ status: 'done' });
  });

  it('E2: parses status:"failed" with a reason (Bereich ohne deckende Specs)', () => {
    const out = parseRegressionDefineOutcome(
      JSON.stringify({ status: 'failed', reason: 'keine deckenden Specs im Bereich' }),
    );
    expect(out).toEqual({ status: 'failed', reason: 'keine deckenden Specs im Bereich' });
  });

  it('E2: status:"failed" without a reason falls back to a generic secret-free message', () => {
    const out = parseRegressionDefineOutcome(JSON.stringify({ status: 'failed' }));
    expect(out.status).toBe('failed');
    expect(out.reason).toBeTruthy();
  });

  it('throws on unparsable JSON (AC2)', () => {
    expect(() => parseRegressionDefineOutcome('not json at all')).toThrow();
  });

  it('throws on unknown status', () => {
    expect(() => parseRegressionDefineOutcome('{"status":"weird"}')).toThrow();
  });

  it('throws on needs-review with an empty/absent vorschlag', () => {
    expect(() => parseRegressionDefineOutcome('{"status":"needs-review","vorschlag":[]}')).toThrow();
    expect(() => parseRegressionDefineOutcome('{"status":"needs-review"}')).toThrow();
  });

  it('throws when a vorschlag entry misses titel', () => {
    expect(() =>
      parseRegressionDefineOutcome('{"status":"needs-review","vorschlag":[{"schritte":[]}]}'),
    ).toThrow();
  });
});

// ── Pure validators: validateZiel / zielToArg (AC4) ──────────────────────────

describe('validateZiel / zielToArg — AC4 Eingabe-Vertrag', () => {
  it('accepts a bereich ziel', () => {
    const r = validateZiel({ typ: 'bereich', id: 'fabrik-arbeiten' });
    expect(r).toEqual({ ok: true, ziel: { typ: 'bereich', id: 'fabrik-arbeiten' } });
    expect(zielToArg(r.ziel)).toBe('bereich=fabrik-arbeiten');
  });

  it('accepts a verbund ziel (A1 — Infra-/Verbund-Suite)', () => {
    const r = validateZiel({ typ: 'verbund', id: 'ephemeral-infra' });
    expect(r).toEqual({ ok: true, ziel: { typ: 'verbund', id: 'ephemeral-infra' } });
    expect(zielToArg(r.ziel)).toBe('verbund=ephemeral-infra');
  });

  it('rejects a missing/invalid typ', () => {
    expect(validateZiel({ typ: 'unknown', id: 'x' })).toEqual({ ok: false, reason: 'invalid-typ' });
    expect(validateZiel(null)).toEqual({ ok: false, reason: 'invalid' });
    expect(validateZiel('x')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a missing/blank id', () => {
    expect(validateZiel({ typ: 'bereich', id: '' })).toEqual({ ok: false, reason: 'missing-id' });
    expect(validateZiel({ typ: 'bereich' })).toEqual({ ok: false, reason: 'missing-id' });
  });

  it('zielToArg throws on an unvalidated bad ziel (defensive)', () => {
    expect(() => zielToArg({ typ: 'nope', id: 'x' })).toThrow();
  });
});

// ── extractClaudeResult ──────────────────────────────────────────────────────

describe('extractClaudeResult', () => {
  it('extracts result + session_id from the --output-format json wrapper', () => {
    const wrapper = JSON.stringify({ type: 'result', result: '{"status":"done"}', session_id: 'sess-9' });
    expect(extractClaudeResult(wrapper)).toEqual({ resultText: '{"status":"done"}', sessionId: 'sess-9' });
  });

  it('falls back to raw stdout when it is not a json wrapper', () => {
    expect(extractClaudeResult('raw text')).toEqual({ resultText: 'raw text', sessionId: undefined });
  });
});

// ── Runner state machine (AC1, AC2, AC3, AC4) ────────────────────────────────

describe('RegressionDefineRunner — start → needs-review → resume(review) → done', () => {
  it('AC1/AC2/AC3: exposes the vorschlag on needs-review and reaches done after review', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });

    const started = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'fabrik-arbeiten' }, [], { identity: 'alex@x' });
    expect(started.ok).toBe(true);
    await flush();

    let job = runner.getJob(started.jobId);
    expect(job.status).toBe('needs-review');
    expect(job.vorschlag.vorschlag).toHaveLength(1);
    // secret-free public view — no internal fields leaked (AC5).
    expect(job).not.toHaveProperty('projectPath');
    expect(job).not.toHaveProperty('sessionId');
    expect(job).not.toHaveProperty('identity');

    // First round used the regression-define command with the eingabe-vertrag (AC1/AC4).
    expect(runClaude.calls[0].promptArg).toBe(
      `${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=proj bereich=fabrik-arbeiten`,
    );
    expect(runClaude.calls[0].resumeSessionId).toBeUndefined();

    const reviewed = { vorschlag: [{ titel: 'redigiert', schritte: [], pruefpunkte: [], beispieldaten: [] }] };
    const result = runner.review(started.jobId, reviewed);
    expect(result.ok).toBe(true);
    await flush();

    // Resume round carried the session id + reviewed payload (AC3).
    expect(runClaude.calls[1].resumeSessionId).toBe('sess-1');
    expect(runClaude.calls[1].reviewed).toEqual(reviewed);

    job = runner.getJob(started.jobId);
    expect(job.status).toBe('done');
    expect(job.vorschlag).toBeUndefined();
    expect(job.result).toBeTruthy();
  });

  it('AC4: includes stichworte in the initial promptArg when provided', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: '{"status":"done"}', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    runner.start('/workspace/proj', 'proj', { typ: 'verbund', id: 'ephemeral-infra' }, ['login', 'checkout']);
    await flush();
    expect(runClaude.calls[0].promptArg).toBe(
      `${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=proj verbund=ephemeral-infra stichworte=login,checkout`,
    );
  });

  it('A1: Verbund-Ziel wird 1:1 durchgereicht (kein Sonderpfad im Runner)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    runner.start('/workspace/proj', 'proj', { typ: 'verbund', id: 'infra-suite' });
    await flush();
    expect(runClaude.calls[0].promptArg).toContain('verbund=infra-suite');
  });
});

describe('RegressionDefineRunner — lock lifecycle (AC1)', () => {
  it('holds the project lock while a vorschlag is pending; releases on terminal done', async () => {
    const lock = new ProjectJobLock();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude, lock });

    const first = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(first.jobId).status).toBe('needs-review');

    // Lock still held during needs-review → a second start for the SAME project is rejected.
    const second = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    expect(second).toEqual({ ok: false, reason: 'locked' });

    // A DIFFERENT project is not blocked (per-project lock, AC1).
    const other = runner.start('/workspace/other', 'other', { typ: 'bereich', id: 'x' });
    expect(other.ok).toBe(true);

    // Resume to done → lock released → same project can start again.
    runner.review(first.jobId, { vorschlag: [] });
    await flush();
    expect(runner.getJob(first.jobId).status).toBe('done');
    expect(runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' }).ok).toBe(true);
  });
});

describe('RegressionDefineRunner — terminal error paths (AC2)', () => {
  it('auth-expired on a 401 signature, lock released', async () => {
    const lock = new ProjectJobLock();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 1, output: '', sessionId: undefined, authError: true },
    ]);
    const runner = new RegressionDefineRunner({ runClaude, lock });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.error).toBe(AUTH_EXPIRED_MESSAGE);
    expect(lock.isHeld('/workspace/proj')).toBe(false);
  });

  it('failed (secret-free) on a non-zero exit', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/secret-path', 'secret-path', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).not.toMatch(/\/workspace\//);
  });

  it('failed on an unparsable vorschlag outcome (AC2)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'this is not a vorschlag', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toBeTruthy();
  });

  it('E2: failed with the agent-provided reason (Bereich ohne deckende Specs)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: JSON.stringify({ status: 'failed', reason: 'keine deckenden Specs im Bereich' }), authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'leerer-bereich' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('keine deckenden Specs im Bereich');
  });

  it('failed (claude nicht verfügbar) on a spawn error', async () => {
    const runClaude = makeSequencedRunClaude([{ spawnError: true, exitCode: -1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (Timeout) when the adapter reports timedOut', async () => {
    const runClaude = makeSequencedRunClaude([{ timedOut: true, exitCode: -1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toMatch(/Timeout/);
  });

  it('failed when the runClaude adapter itself throws (no crash)', async () => {
    const runClaude = jest.fn(async () => { throw new Error('boom'); });
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (secret-free) on resume when no claude session-id is known (no silent loss of the reviewed payload)', async () => {
    const lock = new ProjectJobLock();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: undefined, authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude, lock });
    const { jobId } = runner.start('/workspace/secret-path', 'secret-path', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('needs-review');

    const res = runner.review(jobId, { vorschlag: [] });
    expect(res.ok).toBe(true); // accepted; the failure surfaces in the resume round
    await flush();

    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
    expect(job.error).not.toMatch(/\/workspace\//);
    // exactly one runClaude call — the resume round never spawned.
    expect(runClaude.calls).toHaveLength(1);
    // terminal → lock released.
    expect(lock.isHeld('/workspace/secret-path')).toBe(false);
  });
});

describe('RegressionDefineRunner — review() guards (AC3)', () => {
  it('not-found for an unknown jobId', () => {
    const runner = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([]) });
    expect(runner.review('nope', { vorschlag: [] })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('not-waiting when the job is not in needs-review', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
    expect(runner.review(jobId, { vorschlag: [] })).toEqual({ ok: false, reason: 'not-waiting' });
  });

  it('invalid for a missing/null reviewed payload', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.review(jobId, null)).toEqual({ ok: false, reason: 'invalid' });
    expect(runner.review(jobId, undefined)).toEqual({ ok: false, reason: 'invalid' });
    // Job stays in needs-review after a rejected submission (no state change).
    expect(runner.getJob(jobId).status).toBe('needs-review');
  });

  it('edge-case: redigierte Fassung ohne Beispieldaten wird 1:1 durchgereicht (kein dev-gui-Fehler)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 's', authError: false },
      { exitCode: 0, output: '{"status":"done"}', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const reviewed = { vorschlag: [{ titel: 't', schritte: [], pruefpunkte: [], beispieldaten: [] }] };
    expect(runner.review(jobId, reviewed).ok).toBe(true);
    await flush();
    expect(runClaude.calls[1].reviewed).toEqual(reviewed);
    expect(runner.getJob(jobId).status).toBe('done');
  });
});

describe('RegressionDefineRunner — audit (AC5)', () => {
  it('records a job-end audit with identity + action on done', async () => {
    const record = jest.fn();
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '{"status":"done"}', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, auditStore: { record } });
    runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' }, [], { identity: 'alex@x' });
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'alex@x', command: expect.stringContaining('regression-define:done') }),
    );
  });

  it('records a job-error audit on failed and never crashes on an audit throw', async () => {
    const record = jest.fn(() => { throw new Error('audit down'); });
    const runClaude = makeSequencedRunClaude([{ exitCode: 1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, auditStore: { record } });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' }, [], { identity: 'alex@x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed'); // no crash despite audit throw
    expect(record).toHaveBeenCalled();
  });
});

// ── Lebendigkeits-Felder (AC9) ────────────────────────────────────────────────

describe('RegressionDefineRunner — AC9 Lebendigkeits-Felder (startedAt/lastActivityAt/phase)', () => {
  it('exposes startedAt + lastActivityAt (ISO-8601) immediately after start(), while running', async () => {
    const runClaude = jest.fn(() => new Promise(() => {})); // never resolves — stays "running"
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    const job = runner.getJob(jobId);
    expect(job.status).toBe('running');
    expect(job.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(job.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // no internal fields leaked alongside the new v2 fields.
    expect(job).not.toHaveProperty('projectPath');
    expect(job).not.toHaveProperty('sessionId');
  });

  it('carries a phase from the fixed set while running the initial round, absent once terminal', async () => {
    const runClaude = jest.fn(() => new Promise(() => {}));
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(['session-start', 'reading-specs', 'drafting']).toContain(job.phase);
  });

  it('needs-review: lastActivityAt advances past startedAt, phase entfällt (kein Rateergebnis)', async () => {
    let tick = 1000;
    const now = () => { tick += 10; return tick; };
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude, now });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('needs-review');
    expect(job.phase).toBeUndefined();
    expect(new Date(job.lastActivityAt).getTime()).toBeGreaterThanOrEqual(new Date(job.startedAt).getTime());
  });

  it('AC9/AC10 consistency: review() resets startedAt + sets phase:translating for the resume round (identical mechanism as the initial round)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, output: '{"status":"done"}', authError: false },
    ]);
    let tick = 5000;
    const now = () => { tick += 10; return tick; };
    const runner = new RegressionDefineRunner({ runClaude, now });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const startedAtBeforeReview = runner.getJob(jobId).startedAt;

    runner.review(jobId, { vorschlag: [] });
    // Immediately after review() (before the round settles): running, fresh
    // startedAt, phase:'translating' — the SAME mechanism as the initial round.
    const midJob = runner.getJob(jobId);
    expect(midJob.status).toBe('running');
    expect(midJob.phase).toBe('translating');
    expect(typeof midJob.startedAt).toBe('string');
    // "fresh" startedAt (AC9/AC10): the resume round re-stamps startedAt —
    // it is NOT simply carried over unchanged from the initial round.
    expect(new Date(midJob.startedAt).getTime()).toBeGreaterThan(new Date(startedAtBeforeReview).getTime());

    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
  });

  it('startedAt/lastActivityAt are exposed on a terminal failed job too (no crash, no leak)', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/secret-path', 'secret-path', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.startedAt).toBeTruthy();
    expect(job.lastActivityAt).toBeTruthy();
    expect(job.phase).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/\/workspace\//);
  });
});

// ── Fehlerklasse + sanitisierte Roh-Ausgabe (AC12) ───────────────────────────

describe('RegressionDefineRunner — AC12 error_class + raw_output', () => {
  it('parse-error: error_class + sanitized raw_output on an unparsable outcome', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'this is not json at all, no fence either', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
    expect(job.raw_output).toContain('this is not json at all');
  });

  it('parse-error: raw_output is secret-filtered (no token/host-path leak)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'oops sk-ant-api03-abcdefghijklmnop at /Users/alex/secret/repo', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.raw_output).not.toMatch(/sk-ant-/);
    expect(job.raw_output).not.toMatch(/\/Users\/alex/);
  });

  it('raw_output entfällt (kein Leak, kein Crash) when the filter empties the content entirely', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
    expect(job.raw_output).toBeUndefined();
  });

  it('no-session: error_class no-session, no raw_output', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: VORSCHLAG_OUTPUT, sessionId: undefined, authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    runner.review(jobId, { vorschlag: [] });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error_class).toBe(ERROR_CLASS_NO_SESSION);
    expect(job.raw_output).toBeUndefined();
  });

  it('timeout: error_class timeout, no raw_output', async () => {
    const runClaude = makeSequencedRunClaude([{ timedOut: true, exitCode: -1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.error_class).toBe(ERROR_CLASS_TIMEOUT);
    expect(job.raw_output).toBeUndefined();
  });

  it('agent-failed: error_class agent-failed on a generic non-zero exit / E2 / spawn error, no raw_output', async () => {
    const runner1 = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]) });
    const j1 = runner1.start('/workspace/p1', 'p1', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner1.getJob(j1.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);
    expect(runner1.getJob(j1.jobId).raw_output).toBeUndefined();

    const runner2 = new RegressionDefineRunner({
      runClaude: makeSequencedRunClaude([{ exitCode: 0, output: JSON.stringify({ status: 'failed', reason: 'keine deckenden Specs im Bereich' }), authError: false }]),
    });
    const j2 = runner2.start('/workspace/p2', 'p2', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner2.getJob(j2.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);

    const runner3 = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([{ spawnError: true, exitCode: -1, output: '', authError: false }]) });
    const j3 = runner3.start('/workspace/p3', 'p3', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner3.getJob(j3.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);
  });
});

// ── sanitizeRawOutput (pure, AC12) ───────────────────────────────────────────

describe('sanitizeRawOutput — AC12 Trust-Boundary', () => {
  it('redacts common token/secret shapes and host paths', () => {
    const out = sanitizeRawOutput(
      'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_ABCDEFGHIJ1234567890ABCDEFGHIJ1234 at /home/node/.secret and /Users/alex/repo',
    );
    expect(out).not.toMatch(/sk-ant-/);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/\/home\/node/);
    expect(out).not.toMatch(/\/Users\/alex/);
  });

  it('handles non-string input gracefully (no crash)', () => {
    expect(sanitizeRawOutput(undefined)).toBe('');
    expect(sanitizeRawOutput(null)).toBe('');
  });
});

// ── Default adapter security floor (AC5) ─────────────────────────────────────

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  return child;
}

describe('defaultRunClaude — security floor (AC5)', () => {
  it('spawns an argv-array with --dangerously-skip-permissions + --output-format json, API keys blocked from env', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const child = makeFakeChild();
      const spawnFn = jest.fn(() => child);
      const promise = defaultRunClaude({
        projectPath: '/workspace/proj',
        promptArg: `${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=proj bereich=x`,
        spawnFn,
      });

      const [cmd, argv, opts] = spawnFn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain('-p');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
      // The prompt is one argv element (no shell string), and no API key in child env.
      expect(argv).toContain(`${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=proj bereich=x`);
      expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(opts.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(opts.cwd).toBe('/workspace/proj');

      // finish the process so the promise resolves.
      child.stdout.emit('data', JSON.stringify({ result: '{"status":"done"}', session_id: 's1' }));
      child.emit('close', 0);
      const res = await promise;
      expect(res).toMatchObject({ exitCode: 0, sessionId: 's1' });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('resume passes the reviewed payload via STDIN (never argv) with --resume <session-id>', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const reviewed = { vorschlag: [{ titel: 'geheim-fachlich', schritte: [], pruefpunkte: [], beispieldaten: [] }] };
    const promise = defaultRunClaude({
      projectPath: '/workspace/proj',
      resumeSessionId: 'sess-77',
      reviewed,
      spawnFn,
    });

    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'sess-77']));
    // The reviewed payload text is NOT in argv — it goes via stdin (AC3/AC5).
    expect(argv.join(' ')).not.toContain('geheim-fachlich');
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify(reviewed), 'utf8');

    child.stdout.emit('data', JSON.stringify({ result: '{"status":"done"}', session_id: 'sess-77' }));
    child.emit('close', 0);
    await promise;
  });

  it('reports authError on a 401 stderr signature and never returns stderr text', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultRunClaude({ projectPath: '/workspace/proj', promptArg: 'x', spawnFn });
    child.stderr.emit('data', 'Invalid authentication credentials at /Users/secret/path');
    child.emit('close', 1);
    const res = await promise;
    expect(res.authError).toBe(true);
    expect(res.output).not.toMatch(/secret\/path/);
  });
});
