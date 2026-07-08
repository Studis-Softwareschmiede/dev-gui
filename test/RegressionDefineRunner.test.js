/**
 * @file RegressionDefineRunner.test.js — unit tests for the headless
 * Regressionstest-Definier-Runner + its pure parsers + default claude adapter
 * (docs/specs/regression-define-dialog.md).
 *
 * Covers (regression-define-dialog): AC1, AC2, AC3, AC4, AC5, AC9, AC12, AC14, AC15, AC16, AC17
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
 *         path additionally carries the server-side secret-filtered `raw_output`
 *         (stdout-Prosa, diagnosis-only); absent otherwise (no leak, no crash
 *         even when the filter empties the content).
 *   AC14 — the runner passes `ergebnis_datei=<absoluter-pfad>` to EVERY runClaude
 *         call (initial AND resume/uebersetzen round), pointing at
 *         `<projectPath>/board/runs/regression-define/<jobId>.json`
 *         (`ergebnisDateiPath()`, asserted directly, no real fs needed).
 *   AC15 — after process close, the runner reads the ergebnis file (via the
 *         injected `readFile` fake, NOT `res.output`/stdout) and parses ITS
 *         CONTENT with the unchanged `parseRegressionDefineOutcome()`; identical
 *         for both modes.
 *   AC16 — two distinguishable error_class:'parse-error' cases: the file is
 *         missing after the run ("Ergebnisdatei fehlt") vs. the file exists but
 *         is not valid JSON ("Ergebnisdatei kein gültiges JSON"); raw_output
 *         (sanitized stdout) still attached in both cases (AC12 unchanged).
 *   AC17 — after a successfully consumed outcome, the runner best-effort deletes
 *         the ergebnis file via the injected `unlink` fake (a delete failure is
 *         not a terminal error).
 *
 * The runner is exercised with an INJECTED runClaude adapter — no real `claude`
 * process (NFR „Entkopplung"). Since AC14-AC17 added real filesystem `await`s
 * to the production runner (mkdir/readFile/unlink), this file injects
 * SYNCHRONOUS IN-MEMORY FAKES for all three (`makeFakeFs()`, a `Map`-backed
 * fake) — NOT a real temp directory. A prior attempt exercised the REAL
 * filesystem in these tests (`mkdtemp` + real `mkdir`/`readFile`/`unlink`),
 * which was fast enough locally but non-deterministically too slow on the
 * GitHub-Actions-CI runner (parallel Jest workers contending for the libuv
 * threadpool), leaving the job visibly stuck on `running` even behind a
 * polling `flush()` helper. The in-memory fake removes all real I/O from the
 * test path entirely — no timing dependency, no polling needed; a single
 * microtask-flush after `start()`/`review()` is sufficient. The default
 * adapter's spawn/env/stdin/argv security properties are covered separately
 * via an injected spawnFn stub.
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
  ergebnisDateiPath,
  REGRESSION_DEFINE_COMMAND,
  AUTH_EXPIRED_MESSAGE,
  ERROR_CLASS_PARSE,
  ERROR_CLASS_NO_SESSION,
  ERROR_CLASS_AGENT_FAILED,
  ERROR_CLASS_TIMEOUT,
} from '../src/RegressionDefineRunner.js';
import { ProjectJobLock } from '../src/ProjectJobLock.js';

/** Resolve pending microtasks so a fire-and-forget #runRound settles. No real
 * I/O is involved once `mkdir`/`readFile`/`unlink` are faked (see `makeFakeFs`),
 * so a handful of ticks is enough — no polling/timeout budget needed. */
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * A synchronous, in-memory fake for the three injectable fs primitives the
 * runner uses (AC14/AC15/AC17) — deliberately NOT a real filesystem (see file
 * header). Each fake resolves on the next microtask (still a Promise, so the
 * runner's `await`s behave identically to the real fs/promises API), but never
 * touches disk or the libuv threadpool.
 *
 * @returns {{ mkdir: Function, readFile: Function, unlink: Function, files: Map<string,string> }}
 */
function makeFakeFs() {
  const files = new Map();
  const mkdir = jest.fn(async () => undefined);
  const readFile = jest.fn(async (filePath) => {
    if (!files.has(filePath)) {
      const err = new Error(`ENOENT: no such file, open '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return files.get(filePath);
  });
  const unlink = jest.fn(async (filePath) => {
    if (!files.has(filePath)) {
      const err = new Error(`ENOENT: no such file, unlink '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    }
    files.delete(filePath);
  });
  return { mkdir, readFile, unlink, files };
}

/**
 * A runClaude adapter that returns queued results in order and records the
 * arguments of each call (for resume/review assertions). AC14/AC15: each
 * queued result may carry `fileContent` (written into the fake fs's `files`
 * map at `params.ergebnisDatei`, simulating the agent-flow-skill's atomic
 * write) — if `fileContent` is `undefined`, NO file is written (AC16
 * "Ergebnisdatei fehlt" case). `output` remains the (secret-free-diagnostic-
 * only, AC12) stdout text.
 *
 * @param {Array} results
 * @param {Map<string,string>} [fakeFiles] - `makeFakeFs().files`; omit for
 *   tests that never reach the file-read step (e.g. auth-error/timeout paths).
 */
function makeSequencedRunClaude(results, fakeFiles) {
  const calls = [];
  const queue = [...results];
  const fn = jest.fn(async (params) => {
    calls.push(params);
    const next = queue.shift() ?? { exitCode: 0, fileContent: '{"status":"done"}', output: '', sessionId: undefined, authError: false };
    if (typeof next.fileContent === 'string' && params.ergebnisDatei && fakeFiles) {
      fakeFiles.set(params.ergebnisDatei, next.fileContent);
    }
    const rest = { ...next };
    delete rest.fileContent;
    return { output: '', ...rest };
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

  // Regression 2026-07-08 (Vertrags-Mismatch): das ECHTE agent-flow-Rückgabeformat
  // für modus=vorschlag hat KEIN `status`-Feld — es ist das nackte Vorschlags-Objekt
  // (projekt/ziel/quell_specs/vorschlag/hinweise/target_vorschlag). Der frühere
  // Parser verlangte status:'needs-review' und lehnte das reale Format als
  // "unknown status: undefined" ab (der GUI als "kein gültiges JSON" gemeldet,
  // obwohl valide). Dieser Test benutzt bewusst das reale Format OHNE status.
  it('parses the REAL agent Rückgabeformat WITHOUT a status field as needs-review', () => {
    const realAgentOutput = JSON.stringify({
      projekt: 'dev-gui',
      ziel: { typ: 'bereich', id: 'vps' },
      quell_specs: ['docs/specs/vps-create.md'],
      target_vorschlag: 'local',
      vorschlag: [
        {
          titel: 'Neuen Hetzner-VPS anlegen und in der Übersicht als vorhanden bestätigen',
          schritte: ['VPS-Ansicht öffnen', 'Server anlegen'],
          pruefpunkte: ['Server erscheint in der Übersicht'],
          beispieldaten: [{ typ: 'cx22' }],
        },
      ],
      hinweise: ['Das Löschen gehört fachlich zu „deployment", nicht „vps".'],
    });
    const out = parseRegressionDefineOutcome(realAgentOutput);
    expect(out.status).toBe('needs-review');
    expect(out.vorschlag.projekt).toBe('dev-gui');
    expect(out.vorschlag.vorschlag).toHaveLength(1);
    expect(out.vorschlag.vorschlag[0].titel).toContain('Hetzner-VPS');
  });

  it('unerwartete Struktur (kein status, kein vorschlag) → aussagekräftiger Fehler, nicht "kein JSON"', () => {
    expect(() => parseRegressionDefineOutcome('{"projekt":"x"}')).toThrow(/unerwartete Struktur/);
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
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, fileContent: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });

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
    // AC14: the initial round carries the deterministic ergebnis-datei path.
    expect(runClaude.calls[0].ergebnisDatei).toBe(ergebnisDateiPath('/workspace/proj', started.jobId));

    const reviewed = { vorschlag: [{ titel: 'redigiert', schritte: [], pruefpunkte: [], beispieldaten: [] }] };
    const result = runner.review(started.jobId, reviewed);
    expect(result.ok).toBe(true);
    await flush();

    // Resume round carried the session id + reviewed payload (AC3).
    expect(runClaude.calls[1].resumeSessionId).toBe('sess-1');
    expect(runClaude.calls[1].reviewed).toEqual(reviewed);
    // AC14: identical ergebnis-datei path for the resume/uebersetzen round too.
    expect(runClaude.calls[1].ergebnisDatei).toBe(ergebnisDateiPath('/workspace/proj', started.jobId));

    job = runner.getJob(started.jobId);
    expect(job.status).toBe('done');
    expect(job.vorschlag).toBeUndefined();
    expect(job.result).toBeTruthy();

    // AC17: the ergebnis-datei was cleaned up after a successful consume.
    expect(fakeFs.files.has(ergebnisDateiPath('/workspace/proj', started.jobId))).toBe(false);
  });

  it('AC4: includes stichworte in the initial promptArg when provided', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    runner.start('/workspace/proj', 'proj', { typ: 'verbund', id: 'ephemeral-infra' }, ['login', 'checkout']);
    await flush();
    expect(runClaude.calls[0].promptArg).toBe(
      `${REGRESSION_DEFINE_COMMAND} modus=vorschlag projekt=proj verbund=ephemeral-infra stichworte=login,checkout`,
    );
  });

  it('A1: Verbund-Ziel wird 1:1 durchgereicht (kein Sonderpfad im Runner)', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    runner.start('/workspace/proj', 'proj', { typ: 'verbund', id: 'infra-suite' });
    await flush();
    expect(runClaude.calls[0].promptArg).toContain('verbund=infra-suite');
  });
});

describe('RegressionDefineRunner — lock lifecycle (AC1)', () => {
  it('holds the project lock while a vorschlag is pending; releases on terminal done', async () => {
    const lock = new ProjectJobLock();
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, fileContent: '{"status":"done"}', sessionId: 'sess-1', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, lock, ...fakeFs });

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
    const runner = new RegressionDefineRunner({ runClaude, lock, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('auth-expired');
    expect(job.error).toBe(AUTH_EXPIRED_MESSAGE);
    expect(lock.isHeld('/workspace/proj')).toBe(false);
  });

  it('failed (secret-free) on a non-zero exit', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/secret-path', 'secret-path', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).not.toMatch(/\/workspace\//);
  });

  it('failed on a missing ergebnis-datei (no file written, AC15/AC16)', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'this is not a vorschlag', authError: false },
    ]);
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Ergebnisdatei fehlt');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
  });

  it('E2: failed with the agent-provided reason (Bereich ohne deckende Specs)', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: JSON.stringify({ status: 'failed', reason: 'keine deckenden Specs im Bereich' }), authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'leerer-bereich' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('keine deckenden Specs im Bereich');
  });

  it('failed (claude nicht verfügbar) on a spawn error', async () => {
    const runClaude = makeSequencedRunClaude([{ spawnError: true, exitCode: -1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (Timeout) when the adapter reports timedOut', async () => {
    const runClaude = makeSequencedRunClaude([{ timedOut: true, exitCode: -1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toMatch(/Timeout/);
  });

  it('failed when the runClaude adapter itself throws (no crash)', async () => {
    const runClaude = jest.fn(async () => { throw new Error('boom'); });
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
  });

  it('failed (secret-free) on resume when no claude session-id is known (no silent loss of the reviewed payload)', async () => {
    const lock = new ProjectJobLock();
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: undefined, authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, lock, ...fakeFs });
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
    const runner = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([]), ...makeFakeFs() });
    expect(runner.review('nope', { vorschlag: [] })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('not-waiting when the job is not in needs-review', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, fileContent: '{"status":"done"}', authError: false }], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
    expect(runner.review(jobId, { vorschlag: [] })).toEqual({ ok: false, reason: 'not-waiting' });
  });

  it('invalid for a missing/null reviewed payload', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.review(jobId, null)).toEqual({ ok: false, reason: 'invalid' });
    expect(runner.review(jobId, undefined)).toEqual({ ok: false, reason: 'invalid' });
    // Job stays in needs-review after a rejected submission (no state change).
    expect(runner.getJob(jobId).status).toBe('needs-review');
  });

  it('edge-case: redigierte Fassung ohne Beispieldaten wird 1:1 durchgereicht (kein dev-gui-Fehler)', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 's', authError: false },
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
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
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, fileContent: '{"status":"done"}', authError: false }], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, auditStore: { record }, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' }, [], { identity: 'alex@x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'alex@x', command: expect.stringContaining('regression-define:done') }),
    );
  });

  it('records a job-error audit on failed and never crashes on an audit throw', async () => {
    const record = jest.fn(() => { throw new Error('audit down'); });
    const runClaude = makeSequencedRunClaude([{ exitCode: 1, output: '', authError: false }]);
    const runner = new RegressionDefineRunner({ runClaude, auditStore: { record }, ...makeFakeFs() });
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
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
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
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(['session-start', 'reading-specs', 'drafting']).toContain(job.phase);
  });

  it('needs-review: lastActivityAt advances past startedAt, phase entfällt (kein Rateergebnis)', async () => {
    let tick = 1000;
    const now = () => { tick += 10; return tick; };
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, now, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('needs-review');
    expect(job.phase).toBeUndefined();
    expect(new Date(job.lastActivityAt).getTime()).toBeGreaterThanOrEqual(new Date(job.startedAt).getTime());
  });

  it('AC9/AC10 consistency: review() resets startedAt + sets phase:translating for the resume round (identical mechanism as the initial round)', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    let tick = 5000;
    const now = () => { tick += 10; return tick; };
    const runner = new RegressionDefineRunner({ runClaude, now, ...fakeFs });
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
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
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

describe('RegressionDefineRunner — AC12/AC16 error_class + raw_output', () => {
  it('parse-error (AC16 "Datei kein gültiges JSON"): error_class + sanitized raw_output', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: 'this is not json at all, no fence either', output: 'this is not json at all, no fence either', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Ergebnisdatei kein gültiges JSON');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
    expect(job.raw_output).toContain('this is not json at all');
  });

  it('parse-error (AC16 "Datei fehlt"): differenzierte Kurzdiagnose + raw_output aus stdout', async () => {
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, output: 'oops sk-ant-api03-abcdefghijklmnop at /Users/alex/secret/repo', authError: false },
    ]); // no fileContent → no file written (AC16 "Ergebnisdatei fehlt")
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Ergebnisdatei fehlt');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
    // raw_output is secret-filtered (no token/host-path leak).
    expect(job.raw_output).not.toMatch(/sk-ant-/);
    expect(job.raw_output).not.toMatch(/\/Users\/alex/);
  });

  it('raw_output entfällt (kein Leak, kein Crash) when the filter empties the content entirely', async () => {
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '', authError: false }]); // no file written
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Ergebnisdatei fehlt');
    expect(job.error_class).toBe(ERROR_CLASS_PARSE);
    expect(job.raw_output).toBeUndefined();
  });

  it('no-session: error_class no-session, no raw_output', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: undefined, authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
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
    const runner = new RegressionDefineRunner({ runClaude, ...makeFakeFs() });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const job = runner.getJob(jobId);
    expect(job.error_class).toBe(ERROR_CLASS_TIMEOUT);
    expect(job.raw_output).toBeUndefined();
  });

  it('agent-failed: error_class agent-failed on a generic non-zero exit / E2 / spawn error, no raw_output', async () => {
    const runner1 = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([{ exitCode: 2, output: '', authError: false }]), ...makeFakeFs() });
    const j1 = runner1.start('/workspace/p1', 'p1', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner1.getJob(j1.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);
    expect(runner1.getJob(j1.jobId).raw_output).toBeUndefined();

    const fakeFs2 = makeFakeFs();
    const runner2 = new RegressionDefineRunner({
      runClaude: makeSequencedRunClaude([{ exitCode: 0, fileContent: JSON.stringify({ status: 'failed', reason: 'keine deckenden Specs im Bereich' }), authError: false }], fakeFs2.files),
      ...fakeFs2,
    });
    const j2 = runner2.start('/workspace/p2', 'p2', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner2.getJob(j2.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);

    const runner3 = new RegressionDefineRunner({ runClaude: makeSequencedRunClaude([{ spawnError: true, exitCode: -1, output: '', authError: false }]), ...makeFakeFs() });
    const j3 = runner3.start('/workspace/p3', 'p3', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner3.getJob(j3.jobId).error_class).toBe(ERROR_CLASS_AGENT_FAILED);
  });
});

// ── Ergebnis-Übergabe per Datei statt stdout (AC14-AC17) ─────────────────────

describe('RegressionDefineRunner — AC14/AC15/AC16/AC17 ergebnis-datei-Vertrag', () => {
  it('AC14: creates the target directory (mkdir) before the round starts, identical path for both modes', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: VORSCHLAG_OUTPUT, sessionId: 'sess-1', authError: false },
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    const expectedPath = ergebnisDateiPath('/workspace/proj', jobId);
    expect(fakeFs.mkdir).toHaveBeenCalledWith(
      expectedPath.slice(0, expectedPath.lastIndexOf('/')),
      expect.objectContaining({ recursive: true }),
    );

    runner.review(jobId, { vorschlag: [] });
    await flush();
    // AC14: identical target directory for the resume round too.
    expect(fakeFs.mkdir).toHaveBeenCalledTimes(2);
  });

  it('AC15: parses the ERGEBNIS-DATEI content, not res.output (stdout carries unrelated prosa)', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: '{"status":"done"}', output: 'orchestrating session prosa summary, no JSON here', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    // parsed from the file (done), NOT from the prosa stdout (which would have failed to parse).
    expect(runner.getJob(jobId).status).toBe('done');
  });

  it('AC16: "Ergebnisdatei fehlt" vs. "Ergebnisdatei kein gültiges JSON" are distinguishable', async () => {
    const missingRunner = new RegressionDefineRunner({
      runClaude: makeSequencedRunClaude([{ exitCode: 0, output: '', authError: false }]), // no file written
      ...makeFakeFs(),
    });
    const missing = missingRunner.start('/workspace/p1', 'p1', { typ: 'bereich', id: 'x' });
    await flush();
    expect(missingRunner.getJob(missing.jobId).error).toBe('Ergebnisdatei fehlt');

    const fakeFs2 = makeFakeFs();
    const invalidRunner = new RegressionDefineRunner({
      runClaude: makeSequencedRunClaude([{ exitCode: 0, fileContent: 'not valid json {{{', authError: false }], fakeFs2.files),
      ...fakeFs2,
    });
    const invalid = invalidRunner.start('/workspace/p2', 'p2', { typ: 'bereich', id: 'x' });
    await flush();
    expect(invalidRunner.getJob(invalid.jobId).error).toBe('Ergebnisdatei kein gültiges JSON');

    // Both share error_class:'parse-error' (fixed set, AC12 unchanged).
    expect(missingRunner.getJob(missing.jobId).error_class).toBe(ERROR_CLASS_PARSE);
    expect(invalidRunner.getJob(invalid.jobId).error_class).toBe(ERROR_CLASS_PARSE);
  });

  it('AC17: cleans up (unlinks) the ergebnis-datei after a successfully consumed done outcome', async () => {
    const fakeFs = makeFakeFs();
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('done');
    const expectedPath = ergebnisDateiPath('/workspace/proj', jobId);
    expect(fakeFs.unlink).toHaveBeenCalledWith(expectedPath);
    expect(fakeFs.files.has(expectedPath)).toBe(false);
  });

  it('AC17: a cleanup failure is best-effort, not a terminal error (job stays done)', async () => {
    const fakeFs = makeFakeFs();
    fakeFs.unlink.mockImplementation(async () => { throw new Error('already gone'); });
    const runClaude = makeSequencedRunClaude([
      { exitCode: 0, fileContent: '{"status":"done"}', authError: false },
    ], fakeFs.files);
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('done'); // no crash, no terminal failure from the unlink throw
  });

  it('AC14: mkdir failure does not crash — the run continues (later "Ergebnisdatei fehlt" if unwritten)', async () => {
    const fakeFs = makeFakeFs();
    fakeFs.mkdir.mockImplementation(async () => { throw new Error('EACCES'); });
    const runClaude = makeSequencedRunClaude([{ exitCode: 0, output: '', authError: false }]); // no file written
    const runner = new RegressionDefineRunner({ runClaude, ...fakeFs });
    const { jobId } = runner.start('/workspace/proj', 'proj', { typ: 'bereich', id: 'x' });
    await flush();
    expect(runner.getJob(jobId).status).toBe('failed');
    expect(runner.getJob(jobId).error).toBe('Ergebnisdatei fehlt');
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
