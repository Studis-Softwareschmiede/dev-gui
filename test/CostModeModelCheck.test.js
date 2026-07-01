/**
 * @file CostModeModelCheck.test.js — Unit-Tests der Cost-Mode-Modellprüfungs-
 * Boundary (docs/specs/cost-mode-model-check.md, Kern S-211).
 *
 * Covers (cost-mode-model-check): AC1, AC2, AC3, AC6, AC7
 *
 *   AC1 — Boot-Prüfung, still, READ-ONLY Frische-Signal-Lesen; degradiert still,
 *         wenn Plugin-Root nicht auflösbar / `model-tiers.md` fehlt (kein Crash,
 *         kein Curator-Anstoß). `start()` fährt den Boot-Check fire-and-forget an.
 *   AC2 — Frisches Signal (innerhalb Cooldown = aktueller Kalendermonat) →
 *         KEINERLEI Curator-Anstoß, KEIN Job-Eintrag, KEIN Audit (stiller Normalfall).
 *   AC3 — Drift (früherer Monat / `never` / leer) → kurze Meldung, Curator headless
 *         angestoßen (`/agent-flow:train model-tiers`), Job-Registry + Vorher/Nachher
 *         (`before`/`after`/`changed`); „keine Änderung" wird als solche geführt;
 *         Curator-Fehler → Job `failed` (nicht-blockierend).
 *   AC6 — Kein eigener Auswahlbarkeits-Filter / `Mythos`/`Fable`-Ausschluss in
 *         dev-gui; Delegation an den Curator. Grep-prüfbar: KEIN Schreibpfad auf
 *         `model-tiers.md` (nur `readFile`).
 *   AC7 — Eigene HeadlessFlowRunner-/ProjectJobLock-Instanz (Isolation); Audit-First
 *         (curator-start/-done/-failed); In-Memory-Job-Registry; Curator-läuft-bereits
 *         (Lock) → kein Doppel-Anstoß (still übersprungen).
 *
 * Kein echter `claude -p`-Lauf: der `flowRunner` ist ein Stub (Nicht-Ziel:
 * kein Live-Lauf im Test-Gate).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  CostModeModelCheck,
  parseLastCurated,
  isSignalFresh,
  CURATOR_COMMAND,
  CURATOR_ARGS,
} from '../src/CostModeModelCheck.js';

const JUNE_CONTENT = '# model-tiers\n\n> **last_curated:** 2026-06-10 — Frische-Signal + Cooldown-State.\n';
const JULY_CONTENT = '# model-tiers\n\n> **last_curated:** 2026-07-01 — Frische-Signal + Cooldown-State.\n';
const NEVER_CONTENT = '# model-tiers\n\n> **last_curated:** never — noch nie kuratiert.\n';
const NOW_JULY = () => new Date('2026-07-15T12:00:00Z');

/**
 * readFile-Stub: gibt die Inhalte der Reihe nach zurück (letzter wiederholt sich).
 * Ein Eintrag, der ein Error ist, wird geworfen (Datei-fehlt-Simulation).
 */
function makeReadFile(contents) {
  let i = 0;
  const readFile = jest.fn(async () => {
    const c = contents[Math.min(i, contents.length - 1)];
    i++;
    if (c instanceof Error) throw c;
    return c;
  });
  return readFile;
}

/**
 * Fake HeadlessFlowRunner: zeichnet den start()-Aufruf auf und liefert einen
 * Job, der SOFORT im Terminalzustand `terminalStatus` steht (waitForJob kehrt
 * beim ersten Poll zurück).
 */
function makeFakeRunner({ terminalStatus = 'done', startOk = true } = {}) {
  let jobId = null;
  return {
    startCalls: [],
    start(cwd, overrides) {
      this.startCalls.push({ cwd, overrides });
      if (!startOk) return { ok: false, reason: 'locked' };
      jobId = 'job-1';
      return { ok: true, jobId };
    },
    getJob(id) {
      if (id !== jobId) return undefined;
      return { status: terminalStatus };
    },
  };
}

function makeAudit() {
  const entries = [];
  return {
    entries,
    record: jest.fn(({ identity, command }) => { entries.push({ identity, command }); }),
  };
}

/** Baut eine Boundary mit den üblichen Test-Defaults (Timer/Sleep no-op). */
function makeCheck({ contents, runner, audit, now = NOW_JULY, pluginRoot = '/fake/plugin/root' } = {}) {
  return new CostModeModelCheck({
    pluginRootResolver: async () => pluginRoot,
    flowRunner: runner,
    auditStore: audit,
    curatorCwd: '/fake/cwd',
    fsDeps: { readFile: makeReadFile(contents ?? [JUNE_CONTENT]) },
    now,
    sleepFn: async () => {},
    pollIntervalMs: 1,
    intervalMs: 60_000,
    // Timer no-op — kein periodischer Tick im Test.
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
}

// ── Pure Helpers ──────────────────────────────────────────────────────────────

describe('parseLastCurated — Frische-Signal-Parsing', () => {
  it('extrahiert das Datum aus dem Header-Blockquote (`> **last_curated:** …`)', () => {
    expect(parseLastCurated(JUNE_CONTENT)).toBe('2026-06-10');
  });

  it('extrahiert das Datum aus der YAML-artigen Form (`last_curated: …`)', () => {
    expect(parseLastCurated('last_curated: 2026-05-01')).toBe('2026-05-01');
  });

  it('liefert null für `never`', () => {
    expect(parseLastCurated(NEVER_CONTENT)).toBeNull();
  });

  it('liefert null, wenn das Feld fehlt oder der Input kein String ist', () => {
    expect(parseLastCurated('# nur ein Titel')).toBeNull();
    expect(parseLastCurated(null)).toBeNull();
    expect(parseLastCurated(undefined)).toBeNull();
  });
});

describe('isSignalFresh — Cooldown (aktueller Kalendermonat)', () => {
  it('frisch, wenn last_curated im aktuellen Kalendermonat liegt', () => {
    expect(isSignalFresh('2026-07-01', NOW_JULY())).toBe(true);
    expect(isSignalFresh('2026-07-31', NOW_JULY())).toBe(true);
  });

  it('Drift, wenn last_curated in einem früheren Monat liegt', () => {
    expect(isSignalFresh('2026-06-30', NOW_JULY())).toBe(false);
    expect(isSignalFresh('2025-07-01', NOW_JULY())).toBe(false);
  });

  it('Drift für null / unparsebar', () => {
    expect(isSignalFresh(null, NOW_JULY())).toBe(false);
    expect(isSignalFresh('irgendwas', NOW_JULY())).toBe(false);
  });
});

// ── AC1: Boot / Degradation ─────────────────────────────────────────────────

describe('AC1 — Boot-Prüfung + stille Degradation (READ-ONLY)', () => {
  it('degradiert still, wenn der Plugin-Root nicht auflösbar ist (null) — kein Curator-Anstoß', async () => {
    const runner = makeFakeRunner();
    const audit = makeAudit();
    const check = makeCheck({ runner, audit, pluginRoot: null });

    const res = await check.runCheck('boot');
    expect(res).toEqual({ drift: false, reason: 'unavailable' });
    expect(runner.startCalls).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('degradiert still, wenn `model-tiers.md` fehlt/unlesbar (readFile wirft)', async () => {
    const runner = makeFakeRunner();
    const check = makeCheck({ runner, contents: [new Error('ENOENT')] });

    const res = await check.runCheck('boot');
    expect(res).toEqual({ drift: false, reason: 'unavailable' });
    expect(runner.startCalls).toHaveLength(0);
  });

  it('start() ist nicht-blockierend + löst einen Boot-Check aus (fire-and-forget)', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const check = makeCheck({ runner, contents: [JUNE_CONTENT, JULY_CONTENT] });

    // start() kehrt synchron zurück (blockiert nicht).
    expect(check.start()).toBeUndefined();
    // Der Boot-Check läuft asynchron — nach Mikro-/Makrotasks ist der Curator angestoßen.
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.startCalls).toHaveLength(1);
    check.stop();
  });
});

// ── AC2: Normalfall = keinerlei Meldung ──────────────────────────────────────

describe('AC2 — frisches Signal: keinerlei Anstoß/Job/Audit', () => {
  it('frisch (aktueller Monat) → kein Curator-Anstoß, kein Job, kein Audit', async () => {
    const runner = makeFakeRunner();
    const audit = makeAudit();
    const check = makeCheck({ runner, audit, contents: [JULY_CONTENT] });

    const res = await check.runCheck('periodic');
    expect(res).toEqual({ drift: false, reason: 'fresh' });
    expect(runner.startCalls).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

// ── AC3: Drift → Anstoß + Vorher/Nachher ─────────────────────────────────────

describe('AC3 — Drift: Curator-Anstoß + Vorher/Nachher-Registry', () => {
  it('stößt den Curator mit `/agent-flow:train model-tiers` an (eigener Runner)', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const check = makeCheck({ runner, contents: [JUNE_CONTENT, JULY_CONTENT] });

    const res = await check.runCheck('periodic');
    expect(res.drift).toBe(true);
    expect(typeof res.checkId).toBe('string');
    expect(runner.startCalls).toHaveLength(1);
    expect(runner.startCalls[0].cwd).toBe('/fake/cwd');
    expect(runner.startCalls[0].overrides.command).toBe(CURATOR_COMMAND);
    expect(runner.startCalls[0].overrides.args).toEqual(CURATOR_ARGS);
    expect(CURATOR_COMMAND).toBe('/agent-flow:train');
    expect(CURATOR_ARGS).toEqual(['model-tiers']);
  });

  it('nach erfolgreichem Curator-Lauf: done + changed=true + before/after', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const audit = makeAudit();
    const check = makeCheck({ runner, audit, contents: [JUNE_CONTENT, JULY_CONTENT] });

    const res = await check.runCheck('periodic');
    await res.done; // Curator-Zyklus abwarten (im Test deterministisch)

    const job = check.getCheck(res.checkId);
    expect(job.status).toBe('done');
    expect(job.changed).toBe(true);
    expect(job.before).toEqual({ lastCurated: '2026-06-10' });
    expect(job.after).toEqual({ lastCurated: '2026-07-01' });

    const cmds = audit.entries.map((e) => e.command);
    expect(cmds.some((c) => c.startsWith('cost-mode-check:curator-start'))).toBe(true);
    expect(cmds).toContain('cost-mode-check:curator-done changed=true');
  });

  it('Curator ohne Änderung → done + changed=false', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const check = makeCheck({ runner, contents: [JUNE_CONTENT, JUNE_CONTENT] });

    const res = await check.runCheck('periodic');
    await res.done;

    const job = check.getCheck(res.checkId);
    expect(job.status).toBe('done');
    expect(job.changed).toBe(false);
    expect(job.before).toEqual({ lastCurated: '2026-06-10' });
    expect(job.after).toEqual({ lastCurated: '2026-06-10' });
  });

  it('`never` (leeres Signal) gilt ebenfalls als Drift und stößt an', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const check = makeCheck({ runner, contents: [NEVER_CONTENT, JULY_CONTENT] });

    const res = await check.runCheck('boot');
    expect(res.drift).toBe(true);
    expect(runner.startCalls).toHaveLength(1);
    await res.done;
    const job = check.getCheck(res.checkId);
    expect(job.before).toEqual({ lastCurated: null });
  });

  it('Curator-Fehler → Job failed (nicht-blockierend), before bleibt erhalten', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'failed' });
    const audit = makeAudit();
    const check = makeCheck({ runner, audit, contents: [JUNE_CONTENT] });

    const res = await check.runCheck('periodic');
    await res.done;

    const job = check.getCheck(res.checkId);
    expect(job.status).toBe('failed');
    expect(job.before).toEqual({ lastCurated: '2026-06-10' });
    expect(audit.entries.map((e) => e.command)).toContain('cost-mode-check:curator-failed');
  });
});

// ── AC7: Isolation + kein Doppel-Anstoß ──────────────────────────────────────

describe('AC7 — Isolation + kein Doppel-Anstoß', () => {
  it('Curator läuft bereits (Runner-Lock) → kein Doppel-Anstoß, kein Job-Eintrag', async () => {
    const runner = makeFakeRunner({ startOk: false });
    const check = makeCheck({ runner, contents: [JUNE_CONTENT] });

    const res = await check.runCheck('periodic');
    expect(res).toEqual({ drift: true, skipped: 'locked' });
  });

  it('skip-if-running: überlappende runCheck-Aufrufe stoßen nicht doppelt an', async () => {
    const runner = makeFakeRunner({ terminalStatus: 'done' });
    const check = makeCheck({ runner, contents: [JUNE_CONTENT, JULY_CONTENT] });

    const [r1, r2] = await Promise.all([check.runCheck('boot'), check.runCheck('periodic')]);
    const skippedBusy = [r1, r2].filter((r) => r.skipped === 'busy');
    expect(skippedBusy).toHaveLength(1);
    // Nur EIN echter Anstoß.
    expect(runner.startCalls).toHaveLength(1);
    const withCheckId = [r1, r2].find((r) => r.checkId);
    if (withCheckId) await withCheckId.done;
  });
});

// ── AC6: kein Schreibpfad (Security-Floor, Grep-prüfbar) ─────────────────────

describe('AC6/NFR — READ-ONLY: kein Schreibpfad auf model-tiers.md', () => {
  it('das Modul importiert/nutzt keinen writeFile-Pfad (Grep über die Quelle)', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '..', 'src', 'CostModeModelCheck.js'), 'utf8');
    // Kein Schreib-CALL (Prosa/JSDoc, die das Wort „writeFile" erwähnt, ist erlaubt —
    // geprüft wird der tatsächliche Aufruf/Import eines Schreibpfads).
    expect(src).not.toMatch(/writeFile\s*\(/);
    expect(src).not.toMatch(/writeFileSync/);
    expect(src).not.toMatch(/\.write\s*\(/);
    // Positiv: liest ausschliesslich (readFile).
    expect(src).toMatch(/readFile/);
  });
});
