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
 *   AC3 — Debug-Artefakte kopiert, Grün+Rot, eigene Artefakt-Retention
 *          (S-327): beim `record()` mit `artifactsSourceDir` kopiert der
 *          Store `playwright-report/`+`test-results/` in seine eigene
 *          Lauf-Ablage — bei `status:"failed"` IMMER, bei `status:"passed"`
 *          per Default ebenfalls (abschaltbar via
 *          `REGRESSION_KEEP_ARTIFACTS_ON_PASS=false`). CTRF-Attachment-Pfade
 *          (absolut) werden relativ zur Lauf-Artefakt-Ablage umgeschrieben;
 *          Attachments außerhalb `artifactsSourceDir` werden nicht
 *          durchgereicht. Eine ZWEITE, engere Artefakt-Retention
 *          (`REGRESSION_ARTIFACT_RETENTION`, Default 10, gedeckelt auf
 *          `MAX_RUNS_PER_PROJECT`) entfernt bei jedem `record()` Artefakt-
 *          Ordner + `artifacts`-Referenz jenseits dieses Fensters (Datensatz
 *          bleibt). Wird ein Lauf komplett geprunt (Lauf-Retention), wird
 *          auch sein Artefakt-Ordner entfernt (keine verwaisten Ordner).
 *   AC4 — `list(projekt)` liefert absteigend nach `startedAt` (jüngster
 *          zuerst), OHNE Dateizugriff bei ungültigem Slug (leere Liste).
 *          `get(projekt, runId)` liefert den Einzel-Lauf inkl. `ctrf`
 *          (Testfall-Details) + `artifacts`-Referenz (sofern vorhanden), oder
 *          `null` wenn nicht gefunden/Slug ungültig. `resolveArtifactDir()`
 *          liefert den absoluten Pfad der Lauf-eigenen Artefakt-Ablage für
 *          den Artefakt-Endpunkt (`regressionRuns.js`), `null` bei
 *          ungültigem Slug/`runId` oder ohne CRED_STORE_DIR.
 *   AC5 — Keine Secrets/Tokens in Datensatz/Datei; `ctrf` wird inhaltlich
 *          unverändert übernommen — NUR Attachment-Pfade werden relativiert
 *          (keine absoluten Server-Pfade im persistierten Datensatz). HART
 *          (Review-Fix Iteration 2, Critical): die Relativierung läuft IMMER,
 *          sobald `artifactsSourceDir` vorliegt — UNABHÄNGIG von Status und
 *          `REGRESSION_KEEP_ARTIFACTS_ON_PASS`; auch wenn KEINE Artefakte
 *          kopiert werden (grüner Lauf + Flag aus), bleibt `ctrf` frei von
 *          absoluten Server-Pfaden (sonst Leak über GET .../:runId).
 *   AC1b (S-326) — Frühausfall-Datensatz: bei `status:"precondition-error"|
 *          "error"` wird `ctrf:null` (KEIN synthetisches Ersatz-CTRF, auch
 *          wenn der Aufrufer fälschlich eines mitgibt), `counts:{0,0,0}` und
 *          ein `reason` (secret-freie Kurzbegründung) abgelegt; bei `passed`/
 *          `failed` bleibt `reason` abwesend. Retention/Prune/Read-API sind
 *          identisch zu passed/failed (kein Sonderweg). `_normalizeRun` lädt
 *          Frühausfall-Datensätze nach einem Neustart korrekt zurück.
 *
 * Edge-Cases (spec):
 *   - Kein `artifactsSourceDir` übergeben → Datensatz ohne `artifacts`,
 *     kein Fehler.
 *   - Quellordner (`playwright-report`/`test-results`) fehlt im Klon →
 *     der jeweilige `artifacts`-Schlüssel fehlt, kein Fehler.
 *   - Gleichzeitiges Ablegen zweier Läufe verschiedener Projekte → getrennte
 *     Projekt-Buckets, keine Kollision.
 *   - Korruptes/teilweises Datei-Set beim Laden → betroffener Datensatz wird
 *     übersprungen, Rest bleibt lesbar.
 *   - Frühausfall-Datensatz ohne `reason` (S-326) → wird abgelegt, `reason`
 *     fehlt einfach (kein Crash).
 *
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test; je Test
 * eine frische RegressionResultStore-Instanz (der In-Memory-Cache ist
 * instanz-lokal, ein Neustart wird durch eine zweite Instanz simuliert).
 * Für AC3 zusätzlich ein echtes tmp-"Projekt-Klon"-Verzeichnis
 * (`makeSourceDir()`) mit echten `playwright-report/`/`test-results/`-Dateien
 * (Muster AreaWriter.test.js — kein Mock-fs für die Kopier-Logik).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  RegressionResultStore,
  resolveRegressionRunsDir,
  MAX_RUNS_PER_PROJECT,
  DEFAULT_ARTIFACT_RETENTION,
  HTML_REPORT_DIRNAME,
  TEST_RESULTS_DIRNAME,
} from '../src/RegressionResultStore.js';

let storeDir;
let prevEnv;
let sourceDirs;

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'regression-runs-test-' + randomBytes(6).toString('hex'));
  await mkdir(storeDir, { recursive: true });
  process.env.CRED_STORE_DIR = storeDir;
  sourceDirs = [];
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.CRED_STORE_DIR;
  else process.env.CRED_STORE_DIR = prevEnv;
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
  await Promise.all(sourceDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
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

/**
 * Baut ein echtes tmp-"Projekt-Klon"-Verzeichnis mit `playwright-report/` +
 * `test-results/` (Muster der echten Playwright-Ausgabe) — für die
 * Kopier-Tests (AC3). Wird über `sourceDirs` am Testende aufgeräumt.
 *
 * @returns {Promise<string>}
 */
async function makeSourceDir() {
  const dir = await mkdtemp(join(tmpdir(), 'regression-source-test-'));
  await mkdir(join(dir, 'playwright-report'), { recursive: true });
  await writeFile(join(dir, 'playwright-report', 'index.html'), '<html>report</html>', 'utf8');
  await mkdir(join(dir, 'test-results', 'checkout-chromium'), { recursive: true });
  await writeFile(join(dir, 'test-results', 'checkout-chromium', 'test-failed-1.png'), 'png-bytes', 'utf8');
  return dir;
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

describe('RegressionResultStore — Artefakte kopieren, Grün+Rot (AC3, S-327)', () => {
  it('status:"failed" kopiert playwright-report/+test-results/ aus artifactsSourceDir + relativiert CTRF-Attachment-Pfade', async () => {
    const sourceDir = await makeSourceDir();
    sourceDirs.push(sourceDir);
    const attachmentAbs = join(sourceDir, 'test-results', 'checkout-chromium', 'test-failed-1.png');
    const outsideAbs = join(tmpdir(), 'regression-outside-leak.png');
    const ctrf = {
      results: {
        tests: [
          {
            name: 'a',
            status: 'failed',
            attachments: [
              { name: 'screenshot', contentType: 'image/png', path: attachmentAbs },
              { name: 'leak', contentType: 'image/png', path: outsideAbs },
            ],
          },
        ],
      },
    };
    const store = new RegressionResultStore();
    const run = await store.record(
      base({ status: 'failed', counts: { passed: 8, failed: 2, total: 10 }, ctrf, artifactsSourceDir: sourceDir }),
    );

    expect(run.artifacts).toEqual({ htmlReport: HTML_REPORT_DIRNAME, testResults: TEST_RESULTS_DIRNAME });
    // Nur das Attachment INNERHALB des Klons wird durchgereicht, relativ zur Lauf-Artefakt-Ablage.
    expect(run.ctrf.results.tests[0].attachments).toEqual([
      { name: 'screenshot', contentType: 'image/png', path: join('test-results', 'checkout-chromium', 'test-failed-1.png') },
    ]);
    // Security-Floor: kein absoluter Server-Pfad im persistierten Datensatz.
    expect(JSON.stringify(run.ctrf)).not.toContain(sourceDir);

    const artifactDir = join(storeDir, 'regression-runs', 'proj-a', run.runId);
    expect(await readFile(join(artifactDir, 'playwright-report', 'index.html'), 'utf8')).toContain('report');
    expect(await readFile(join(artifactDir, 'test-results', 'checkout-chromium', 'test-failed-1.png'), 'utf8')).toBe(
      'png-bytes',
    );
  });

  it('status:"passed" kopiert Artefakte per Default ebenfalls (AC3 NEU, Owner-Entscheidung 2026-07-16)', async () => {
    const sourceDir = await makeSourceDir();
    sourceDirs.push(sourceDir);
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'passed', artifactsSourceDir: sourceDir }));
    expect(run.artifacts).toEqual({ htmlReport: HTML_REPORT_DIRNAME, testResults: TEST_RESULTS_DIRNAME });

    const [fetched] = (await store.list('proj-a')).filter((r) => r.runId === run.runId);
    expect(fetched.artifacts).toEqual({ htmlReport: HTML_REPORT_DIRNAME, testResults: TEST_RESULTS_DIRNAME });
  });

  it('REGRESSION_KEEP_ARTIFACTS_ON_PASS=false → grüner Lauf hält KEINE Artefakte, roter weiterhin', async () => {
    process.env.REGRESSION_KEEP_ARTIFACTS_ON_PASS = 'false';
    try {
      const sourceDir = await makeSourceDir();
      sourceDirs.push(sourceDir);
      const store = new RegressionResultStore();
      const green = await store.record(base({ status: 'passed', artifactsSourceDir: sourceDir }));
      expect(green.artifacts).toBeUndefined();
      const red = await store.record(base({ status: 'failed', suite: 'red', artifactsSourceDir: sourceDir }));
      expect(red.artifacts).toEqual({ htmlReport: HTML_REPORT_DIRNAME, testResults: TEST_RESULTS_DIRNAME });
    } finally {
      delete process.env.REGRESSION_KEEP_ARTIFACTS_ON_PASS;
    }
  });

  it('REGRESSION_KEEP_ARTIFACTS_ON_PASS=false + grüner Lauf → ctrf-Attachment-Pfade trotzdem relativiert (Security-Floor AC5, Review-Fix Iteration 2)', async () => {
    process.env.REGRESSION_KEEP_ARTIFACTS_ON_PASS = 'false';
    try {
      const sourceDir = await makeSourceDir();
      sourceDirs.push(sourceDir);
      const attachmentAbs = join(sourceDir, 'test-results', 'checkout-chromium', 'test-failed-1.png');
      const ctrf = {
        results: {
          tests: [
            { name: 'a', status: 'passed', attachments: [{ name: 'shot', contentType: 'image/png', path: attachmentAbs }] },
          ],
        },
      };
      const store = new RegressionResultStore();
      const green = await store.record(base({ status: 'passed', ctrf, artifactsSourceDir: sourceDir }));

      // Keine Artefakte kopiert (Flag aus) — aber die Pfad-Relativierung lief
      // trotzdem: KEIN führendes "/", KEIN absoluter Klon-Pfad im Ergebnis.
      expect(green.artifacts).toBeUndefined();
      const path = green.ctrf.results.tests[0].attachments[0].path;
      expect(path).toBe(join('test-results', 'checkout-chromium', 'test-failed-1.png'));
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toContain(sourceDir);
      expect(JSON.stringify(green.ctrf)).not.toContain(sourceDir);

      // Auch über get()/list() (Read-API) bleibt der Pfad relativ (kein Leak).
      const fetched = await store.get('proj-a', green.runId);
      expect(fetched.ctrf.results.tests[0].attachments[0].path).toBe(path);
    } finally {
      delete process.env.REGRESSION_KEEP_ARTIFACTS_ON_PASS;
    }
  });

  it('ohne artifactsSourceDir → Datensatz ohne artifacts, kein Fehler (Edge-Case)', async () => {
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'failed' }));
    expect(run.artifacts).toBeUndefined();
    expect(await store.get('proj-a', run.runId)).not.toBeNull();
  });

  it('fehlt nur playwright-report/ im Klon → artifacts hat nur testResults, kein Fehler', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'regression-source-partial-'));
    sourceDirs.push(sourceDir);
    await mkdir(join(sourceDir, 'test-results'), { recursive: true });
    await writeFile(join(sourceDir, 'test-results', 'results.json'), '{}', 'utf8');
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'failed', artifactsSourceDir: sourceDir }));
    expect(run.artifacts).toEqual({ testResults: TEST_RESULTS_DIRNAME });
  });

  it('fehlen BEIDE Ordner im Klon → kein artifacts-Feld, kein Fehler', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'regression-source-empty-'));
    sourceDirs.push(sourceDir);
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'failed', artifactsSourceDir: sourceDir }));
    expect(run.artifacts).toBeUndefined();
  });

  it('geprunte Läufe (Lauf-Retention) entfernen Datensatz UND Artefakt-Ordner (keine verwaisten Ordner)', async () => {
    const sourceDir = await makeSourceDir();
    sourceDirs.push(sourceDir);
    const store = new RegressionResultStore();
    const first = await store.record(base({ status: 'failed', artifactsSourceDir: sourceDir }));

    const projectDir = join(storeDir, 'regression-runs', 'proj-a');
    const firstFile = join(projectDir, `${first.runId}.json`);
    const firstArtifactIndex = join(projectDir, first.runId, 'playwright-report', 'index.html');
    expect(await readFile(firstFile, 'utf8')).toBeTruthy();
    expect(await readFile(firstArtifactIndex, 'utf8')).toBeTruthy();

    for (let i = 0; i < MAX_RUNS_PER_PROJECT; i++) {
      await store.record(base({ suite: `s${i}` }));
    }

    // Der erste (älteste) Lauf ist jetzt geprunt — Datei UND Artefakt-Ordner müssen weg sein.
    await expect(readFile(firstFile, 'utf8')).rejects.toThrow();
    await expect(readFile(firstArtifactIndex, 'utf8')).rejects.toThrow();
    expect(await store.get('proj-a', first.runId)).toBeNull();
  });
});

describe('RegressionResultStore — Artefakt-Retention (AC3, NEU, Owner-Entscheidung 2026-07-16)', () => {
  it('hält Artefakte nur für die DEFAULT_ARTIFACT_RETENTION jüngsten Läufe — ältere behalten den Datensatz, verlieren aber artifacts + Ordner', async () => {
    const sourceDir = await makeSourceDir();
    sourceDirs.push(sourceDir);
    const store = new RegressionResultStore();
    const projectDir = join(storeDir, 'regression-runs', 'proj-a');

    const first = await store.record(base({ status: 'failed', artifactsSourceDir: sourceDir }));
    for (let i = 0; i < DEFAULT_ARTIFACT_RETENTION; i++) {
      await store.record(base({ suite: `s${i}`, status: 'failed', artifactsSourceDir: sourceDir }));
    }

    const found = await store.get('proj-a', first.runId);
    expect(found).not.toBeNull(); // Datensatz bleibt (Lauf-Retention 50 nicht erreicht).
    expect(found.artifacts).toBeUndefined(); // Artefakte gepruned (Artefakt-Retention 10 überschritten).
    await expect(
      readFile(join(projectDir, first.runId, 'playwright-report', 'index.html'), 'utf8'),
    ).rejects.toThrow();
    expect(await readFile(join(projectDir, `${first.runId}.json`), 'utf8')).toBeTruthy();
  });

  it('REGRESSION_ARTIFACT_RETENTION überschreibt den Default', async () => {
    process.env.REGRESSION_ARTIFACT_RETENTION = '2';
    try {
      const sourceDir = await makeSourceDir();
      sourceDirs.push(sourceDir);
      const store = new RegressionResultStore();
      const first = await store.record(base({ status: 'failed', artifactsSourceDir: sourceDir }));
      await store.record(base({ suite: 's1', status: 'failed', artifactsSourceDir: sourceDir }));
      await store.record(base({ suite: 's2', status: 'failed', artifactsSourceDir: sourceDir }));

      const found = await store.get('proj-a', first.runId);
      expect(found.artifacts).toBeUndefined();
    } finally {
      delete process.env.REGRESSION_ARTIFACT_RETENTION;
    }
  });

  it('Deckel: eine Artefakt-Retention grösser als die Lauf-Retention wird auf MAX_RUNS_PER_PROJECT begrenzt', async () => {
    process.env.REGRESSION_ARTIFACT_RETENTION = String(MAX_RUNS_PER_PROJECT + 20);
    try {
      const sourceDir = await makeSourceDir();
      sourceDirs.push(sourceDir);
      const store = new RegressionResultStore();
      for (let i = 0; i < MAX_RUNS_PER_PROJECT + 5; i++) {
        await store.record(base({ suite: `s${i}`, status: 'failed', artifactsSourceDir: sourceDir }));
      }
      const runs = await store.list('proj-a');
      expect(runs).toHaveLength(MAX_RUNS_PER_PROJECT);
      expect(runs.every((r) => r.artifacts)).toBe(true);
    } finally {
      delete process.env.REGRESSION_ARTIFACT_RETENTION;
    }
  });
});

describe('RegressionResultStore.resolveArtifactDir() (AC3/AC4 — Router-Naht regressionRuns.js)', () => {
  it('liefert den erwarteten Pfad für einen gültigen projekt-/runId-Slug', () => {
    const store = new RegressionResultStore();
    expect(store.resolveArtifactDir('proj-a', 'run-1')).toBe(join(storeDir, 'regression-runs', 'proj-a', 'run-1'));
  });

  it('liefert null bei ungültigem projekt- oder runId-Slug (kein Dateizugriff)', () => {
    const store = new RegressionResultStore();
    expect(store.resolveArtifactDir('../etc', 'run-1')).toBeNull();
    expect(store.resolveArtifactDir('proj-a', '../../etc')).toBeNull();
    expect(store.resolveArtifactDir('proj-a', 'a/b')).toBeNull();
  });

  it('liefert null ohne CRED_STORE_DIR', () => {
    delete process.env.CRED_STORE_DIR;
    const store = new RegressionResultStore();
    expect(store.resolveArtifactDir('proj-a', 'run-1')).toBeNull();
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

describe('RegressionResultStore — Frühausfall-Datensatz (AC1b, S-326)', () => {
  it('akzeptiert status:"precondition-error"/"error" — ctrf:null, counts:{0,0,0}, reason gesetzt', async () => {
    const store = new RegressionResultStore();
    const precon = await store.record(
      base({ status: 'precondition-error', ctrf: undefined, counts: undefined, reason: 'Applikation lokal nicht gestartet' }),
    );
    expect(precon.status).toBe('precondition-error');
    expect(precon.ctrf).toBeNull();
    expect(precon.counts).toEqual({ passed: 0, failed: 0, total: 0 });
    expect(precon.reason).toBe('Applikation lokal nicht gestartet');

    const err = await store.record(
      base({ status: 'error', ctrf: undefined, counts: undefined, reason: 'kein Regressions-Grundgerüst' }),
    );
    expect(err.status).toBe('error');
    expect(err.ctrf).toBeNull();
    expect(err.reason).toBe('kein Regressions-Grundgerüst');
  });

  it('ctrf bleibt null bei precondition-error/error, SELBST wenn der Aufrufer fälschlich eines mitgibt (kein synthetisches Ersatz-CTRF)', async () => {
    const store = new RegressionResultStore();
    const run = await store.record(
      base({ status: 'error', ctrf: { results: { summary: { tests: 1, passed: 1, failed: 0 } } }, reason: 'kein CTRF' }),
    );
    expect(run.ctrf).toBeNull();
  });

  it('reason ist bei status:"passed"/"failed" abwesend (auch wenn mitgegeben)', async () => {
    const store = new RegressionResultStore();
    const passedRun = await store.record(base({ status: 'passed', reason: 'sollte-nicht-erscheinen' }));
    expect(passedRun.reason).toBeUndefined();
    const failedRun = await store.record(base({ status: 'failed', reason: 'sollte-nicht-erscheinen' }));
    expect(failedRun.reason).toBeUndefined();
  });

  it('Frühausfall-Datensatz ohne reason → wird abgelegt, reason fehlt (kein Crash, Edge-Case)', async () => {
    const store = new RegressionResultStore();
    const run = await store.record(base({ status: 'error', ctrf: undefined, counts: undefined, reason: undefined }));
    expect(run.reason).toBeUndefined();
    expect(await store.get('proj-a', run.runId)).not.toBeNull();
  });

  it('artifacts bleibt abwesend bei precondition-error/error (AC3 gilt nur für failed)', async () => {
    const store = new RegressionResultStore();
    const run = await store.record(
      base({ status: 'precondition-error', ctrf: undefined, counts: undefined, artifacts: { htmlReport: 'x.html' } }),
    );
    expect(run.artifacts).toBeUndefined();
  });

  it('_normalizeRun lädt einen Frühausfall-Datensatz nach einem Neustart korrekt zurück (ctrf:null, reason erhalten)', async () => {
    const store1 = new RegressionResultStore();
    await store1.record(
      base({ status: 'precondition-error', ctrf: undefined, counts: undefined, reason: 'Applikation lokal nicht gestartet' }),
    );

    const store2 = new RegressionResultStore();
    const runs = await store2.list('proj-a');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('precondition-error');
    expect(runs[0].ctrf).toBeNull();
    expect(runs[0].reason).toBe('Applikation lokal nicht gestartet');
    expect(runs[0].counts).toEqual({ passed: 0, failed: 0, total: 0 });
  });

  it('Retention/Prune (AC2) behandelt Frühausfall-Datensätze identisch zu passed/failed (kein Sonderweg)', async () => {
    const store = new RegressionResultStore();
    const first = await store.record(base({ status: 'error', ctrf: undefined, counts: undefined, reason: 'x', suite: 'r0' }));
    for (let i = 1; i <= MAX_RUNS_PER_PROJECT; i++) {
      await store.record(base({ suite: `r${i}` }));
    }
    const runs = await store.list('proj-a');
    expect(runs).toHaveLength(MAX_RUNS_PER_PROJECT);
    expect(await store.get('proj-a', first.runId)).toBeNull(); // geprunt wie jeder andere Lauf
  });

  it('record() lehnt weiterhin unbekannte status-Werte ab (Vokabular bleibt geschlossen)', async () => {
    const store = new RegressionResultStore();
    await expect(store.record(base({ status: 'not-run' }))).rejects.toThrow();
    await expect(store.record(base({ status: 'running' }))).rejects.toThrow();
  });
});
