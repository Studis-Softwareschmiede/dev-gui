/**
 * RegressionResultStore.test.js — Unit-Tests für die persistente,
 * größenbegrenzte Regressionslauf-Ablage
 * (docs/specs/regression-result-store.md AC1-AC5).
 *
 * Covers (regression-result-store):
 *   AC1 — `record({projekt,suite,scopeTyp,status,startedAt,durationMs,counts,
 *          ctrf,artifacts?})` legt einen Lauf-Datensatz an (generierte `runId`
 *          falls fehlend), schreibt die Datei atomar (tmp+rename → gültiges
 *          JSON, kein .tmp-Rest) unter
 *          `${CRED_STORE_DIR}/regression-runs/<projekt>/<runId>.json`.
 *          Degradiert ohne CRED_STORE_DIR auf reinen In-Memory-Betrieb
 *          (kein Crash). `projekt` als Slug und `scopeTyp`/`status` werden
 *          validiert (ungültig → record() wirft).
 *   AC2 — Retention: pro Projekt-Slug werden höchstens
 *          `MAX_RUNS_PER_PROJECT` (50) Läufe behalten — beim `record()`
 *          fallen ältere automatisch heraus (Auto-Prune, idempotent); die
 *          Grenze ist PRO Projekt (andere Projekte bleiben unberührt).
 *   AC3 — Debug-Artefakte (`artifacts`) werden NUR bei `status:"failed"`
 *          gehalten; bei `status:"passed"` fehlt das Feld vollständig, auch
 *          wenn im Input mitgegeben. Wird ein Lauf geprunt, wird seine Datei
 *          mitentfernt (keine verwaisten Dateien).
 *   AC4 — `list(projekt)` liefert absteigend nach `startedAt` (jüngster
 *          zuerst), OHNE Dateizugriff bei ungültigem Slug (leere Liste).
 *          `get(projekt, runId)` liefert den Einzel-Lauf inkl. `ctrf`
 *          (Testfall-Details) + `artifacts`-Referenz bei roten Läufen, oder
 *          `null` wenn nicht gefunden/Slug ungültig.
 *   AC5 — Keine Secrets/Tokens in Datensatz/Datei; `ctrf` wird unverändert
 *          (deep) übernommen.
 *
 * Edge-Cases (spec):
 *   - Artefakte fehlen bei einem roten Lauf → Datensatz ohne `artifacts`,
 *     kein Fehler.
 *   - Gleichzeitiges Ablegen zweier Läufe verschiedener Projekte → getrennte
 *     Projekt-Buckets, keine Kollision.
 *   - Korruptes/teilweises Datei-Set beim Laden → betroffener Datensatz wird
 *     übersprungen, Rest bleibt lesbar.
 *
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test; je Test
 * eine frische RegressionResultStore-Instanz (der In-Memory-Cache ist
 * instanz-lokal, ein Neustart wird durch eine zweite Instanz simuliert).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  RegressionResultStore,
  resolveRegressionRunsDir,
  MAX_RUNS_PER_PROJECT,
} from '../src/RegressionResultStore.js';

let storeDir;
let prevEnv;

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'regression-runs-test-' + randomBytes(6).toString('hex'));
  await mkdir(storeDir, { recursive: true });
  process.env.CRED_STORE_DIR = storeDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.CRED_STORE_DIR;
  else process.env.CRED_STORE_DIR = prevEnv;
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
});

function base(overrides = {}) {
  return {
    projekt: 'proj-a',
    suite: 'checkout',
    scopeTyp: 'bereich',
    status: 'passed',
    startedAt: '2026-07-02T22:00:00.000Z',
    durationMs: 4200,
    counts: { passed: 10, failed: 0, total: 10 },
    ctrf: { results: { tool: { name: 'playwright' }, tests: [{ name: 'a', status: 'passed' }] } },
    ...overrides,
  };
}

describe('RegressionResultStore.record() + list()/get() (AC1)', () => {
  it('legt einen Lauf mit generierter runId an und liefert ihn über list()', async () => {
    const store = new RegressionResultStore();
    const written = await store.record(base());

    expect(typeof written.runId).toBe('string');
    expect(written.runId.length).toBeGreaterThan(0);

    const runs = await store.list('proj-a');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      projekt: 'proj-a',
      suite: 'checkout',
      scopeTyp: 'bereich',
      status: 'passed',
      durationMs: 4200,
      counts: { passed: 10, failed: 0, total: 10 },
    });
    expect(runs[0].runId).toBe(written.runId);
  });

  it('übernimmt eine mitgegebene runId statt eine neue zu generieren', async () => {
    const store = new RegressionResultStore();
    const written = await store.record(base({ runId: 'run-fixed-1' }));
    expect(written.runId).toBe('run-fixed-1');
  });

  it('generiert eindeutige runIds ohne explizite runId', async () => {
    const store = new RegressionResultStore();
    await store.record(base());
    await store.record(base());
    const runs = await store.list('proj-a');
    expect(runs).toHaveLength(2);
    expect(runs[0].runId).not.toBe(runs[1].runId);
  });

  it('list() sortiert absteigend nach startedAt (jüngster zuerst)', async () => {
    const store = new RegressionResultStore();
    await store.record(base({ suite: 'a', startedAt: '2026-07-02T10:00:00.000Z' }));
    await store.record(base({ suite: 'c', startedAt: '2026-07-02T12:00:00.000Z' }));
    await store.record(base({ suite: 'b', startedAt: '2026-07-02T11:00:00.000Z' }));

    const suites = (await store.list('proj-a')).map((r) => r.suite);
    expect(suites).toEqual(['c', 'b', 'a']);
  });

  it('list() filtert auf den Slug; andere Projekte erscheinen nicht (getrennte Projekt-Buckets)', async () => {
    const store = new RegressionResultStore();
    await store.record(base({ projekt: 'proj-a' }));
    await store.record(base({ projekt: 'proj-b' }));

    const onlyA = await store.list('proj-a');
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].projekt).toBe('proj-a');

    const onlyB = await store.list('proj-b');
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].projekt).toBe('proj-b');
  });

  it('ein ungültiger/traversierender Slug in list() → leere Liste (kein Wurf, kein Dateizugriff)', async () => {
    const store = new RegressionResultStore();
    await store.record(base());
    expect(await store.list('../etc')).toEqual([]);
    expect(await store.list('a/b')).toEqual([]);
  });

  it('record() wirft bei ungültigem projekt-Slug, scopeTyp und status', async () => {
    const store = new RegressionResultStore();
    await expect(store.record(base({ projekt: '../etc/passwd' }))).rejects.toThrow();
    await expect(store.record(base({ projekt: '' }))).rejects.toThrow();
    await expect(store.record(base({ scopeTyp: 'sonstwas' }))).rejects.toThrow();
    await expect(store.record(base({ status: 'yellow' }))).rejects.toThrow();
    // Nach den Fehlern ist nichts geschrieben.
    expect(await store.list('proj-a')).toEqual([]);
  });

  it('get() liefert den Einzel-Lauf inkl. ctrf (Testfall-Details, AC4)', async () => {
    const store = new RegressionResultStore();
    const written = await store.record(base());
    const found = await store.get('proj-a', written.runId);
    expect(found).not.toBeNull();
    expect(found.runId).toBe(written.runId);
    expect(found.ctrf).toEqual(base().ctrf);
  });

  it('get() liefert null bei unbekannter runId oder ungültigem Slug', async () => {
    const store = new RegressionResultStore();
    await store.record(base());
    expect(await store.get('proj-a', 'unknown-run')).toBeNull();
    expect(await store.get('../etc', 'x')).toBeNull();
  });
});

describe('RegressionResultStore — Debug-Artefakte nur bei Rot (AC3)', () => {
  it('status:"failed" hält artifacts; status:"passed" hält KEINE artifacts (auch wenn mitgegeben)', async () => {
    const store = new RegressionResultStore();
    const redRun = await store.record(
      base({
        status: 'failed',
        counts: { passed: 8, failed: 2, total: 10 },
        artifacts: { htmlReport: 'report.html', traces: 'traces.zip' },
      }),
    );
    expect(redRun.artifacts).toEqual({ htmlReport: 'report.html', traces: 'traces.zip' });

    const greenRun = await store.record(
      base({
        status: 'passed',
        artifacts: { htmlReport: 'should-not-appear.html' },
      }),
    );
    expect(greenRun.artifacts).toBeUndefined();

    const [fetchedGreen] = (await store.list('proj-a')).filter((r) => r.runId === greenRun.runId);
    expect(fetchedGreen.artifacts).toBeUndefined();
  });

  it('Artefakte fehlen bei einem roten Lauf → Datensatz ohne artifacts, kein Fehler (Edge-Case)', async () => {
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'failed', artifacts: undefined }));
    expect(run.artifacts).toBeUndefined();
    expect(await store.get('proj-a', run.runId)).not.toBeNull();
  });

  it('geprunte Läufe entfernen ihre Datei mit (keine verwaisten Artefakte/Dateien)', async () => {
    const store = new RegressionResultStore();
    const first = await store.record(base({ status: 'failed', artifacts: { htmlReport: 'r0.html' } }));

    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    const firstFile = join(projectDir, `${first.runId}.json`);
    expect(await readFile(firstFile, 'utf8')).toBeTruthy();

    for (let i = 0; i < MAX_RUNS_PER_PROJECT; i++) {
      await store.record(base({ suite: `s${i}` }));
    }

    // Der erste (älteste) Lauf ist jetzt geprunt — seine Datei muss weg sein.
    await expect(readFile(firstFile, 'utf8')).rejects.toThrow();
    expect(await store.get('proj-a', first.runId)).toBeNull();
  });
});

describe('RegressionResultStore — Retention (AC2)', () => {
  it('hält je Projekt höchstens MAX_RUNS_PER_PROJECT (50) — älteste fallen heraus', async () => {
    const store = new RegressionResultStore();
    const total = MAX_RUNS_PER_PROJECT + 5; // 55
    for (let i = 0; i < total; i++) {
      await store.record(base({ suite: `r${i}` }));
    }
    const runs = await store.list('proj-a');
    expect(runs).toHaveLength(MAX_RUNS_PER_PROJECT);
    const suites = runs.map((r) => r.suite);
    expect(suites).not.toContain('r0');
    expect(suites).not.toContain('r4');
    expect(suites).toContain('r5');
    expect(suites).toContain(`r${total - 1}`);
  });

  it('die Grenze ist PRO Projekt-Slug — andere Projekte bleiben unberührt', async () => {
    const store = new RegressionResultStore();
    for (let i = 0; i < MAX_RUNS_PER_PROJECT + 3; i++) {
      await store.record(base({ projekt: 'proj-a', suite: `a${i}` }));
    }
    await store.record(base({ projekt: 'proj-b', suite: 'b0' }));

    expect(await store.list('proj-a')).toHaveLength(MAX_RUNS_PER_PROJECT);
    expect(await store.list('proj-b')).toHaveLength(1);
  });
});

describe('RegressionResultStore — Persistenz + atomares Schreiben (AC1)', () => {
  it('schreibt gültiges JSON je Lauf ohne .tmp-Rest', async () => {
    const store = new RegressionResultStore();
    const written = await store.record(base());

    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    const filePath = join(projectDir, `${written.runId}.json`);
    const raw = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).runId).toBe(written.runId);

    const files = await readdir(projectDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });

  it('Läufe überstehen einen Neustart (zweite Instanz liest dieselben Dateien)', async () => {
    const store1 = new RegressionResultStore();
    await store1.record(base({ suite: 'persisted' }));

    const store2 = new RegressionResultStore();
    const runs = await store2.list('proj-a');
    expect(runs).toHaveLength(1);
    expect(runs[0].suite).toBe('persisted');
  });

  it('resolveRegressionRunsDir() liefert null ohne CRED_STORE_DIR, sonst den erwarteten Pfad', async () => {
    expect(resolveRegressionRunsDir()).toBe(join(storeDir, 'regression-runs'));
    delete process.env.CRED_STORE_DIR;
    expect(resolveRegressionRunsDir()).toBeNull();
  });
});

describe('RegressionResultStore — Degradation ohne CRED_STORE_DIR', () => {
  it('record/list/get funktionieren In-Memory, ohne zu werfen und ohne Datei', async () => {
    delete process.env.CRED_STORE_DIR;
    expect(resolveRegressionRunsDir()).toBeNull();

    const store = new RegressionResultStore();
    const written = await store.record(base());
    const runs = await store.list('proj-a');
    expect(runs).toHaveLength(1);
    expect(await store.get('proj-a', written.runId)).not.toBeNull();
  });
});

describe('RegressionResultStore — korruptes/teilweises Datei-Set (Edge-Case)', () => {
  it('ein korrupter Lauf-Datensatz wird übersprungen, der Rest bleibt lesbar', async () => {
    const store1 = new RegressionResultStore();
    await store1.record(base({ suite: 'gut-1' }));
    await store1.record(base({ suite: 'gut-2' }));

    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    await writeFile(join(projectDir, 'kaputt.json'), '{ this is not valid json', 'utf8');

    const store2 = new RegressionResultStore();
    const runs = await store2.list('proj-a');
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.suite).sort()).toEqual(['gut-1', 'gut-2']);
  });

  it('ein Datensatz ohne Pflichtfeld (status) wird beim Laden übersprungen', async () => {
    const store1 = new RegressionResultStore();
    await store1.record(base({ suite: 'gut' }));

    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    await writeFile(
      join(projectDir, 'ungueltig.json'),
      JSON.stringify({ runId: 'no-status-run', projekt: 'proj-a', suite: 'x' }),
      'utf8',
    );

    const store2 = new RegressionResultStore();
    const runs = await store2.list('proj-a');
    expect(runs).toHaveLength(1);
    expect(runs[0].suite).toBe('gut');
  });
});

describe('RegressionResultStore — keine Secrets, ctrf unverändert (AC5)', () => {
  it('das CTRF-JSON wird unverändert (deep) übernommen', async () => {
    const ctrf = {
      results: {
        tool: { name: 'playwright' },
        summary: { tests: 3, passed: 3, failed: 0 },
        tests: [
          { name: 'login', status: 'passed', duration: 120 },
          { name: 'logout', status: 'passed', duration: 80 },
        ],
      },
    };
    const store = new RegressionResultStore();
    const written = await store.record(base({ ctrf }));
    const found = await store.get('proj-a', written.runId);
    expect(found.ctrf).toEqual(ctrf);
  });

  it('kein Klartext-Secret erscheint in der persistierten Datei, wenn keines eingegeben wurde', async () => {
    const store = new RegressionResultStore();
    await store.record(base());
    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    const [filename] = await readdir(projectDir);
    const raw = await readFile(join(projectDir, filename), 'utf8');
    expect(raw).not.toMatch(/token|secret|password/i);
  });
});
