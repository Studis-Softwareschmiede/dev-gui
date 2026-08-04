/**
 * DrainReportStore.test.js — Unit-Tests für die persistente, größenbegrenzte
 * Drain-Abschlussbericht-Ablage (docs/specs/drain-completion-report.md AC3).
 *
 * Covers (drain-completion-report):
 *   AC3 — `record({project,trigger,startedAt,finishedAt,reason,flowRuns,completed,
 *          blocked})` legt einen Bericht mit generierter, eindeutiger `reportId`
 *          an, schreibt die Datei atomar (tmp+rename → gültiges JSON, kein
 *          .tmp-Rest) und hält je Projekt-Slug HÖCHSTENS 30 Berichte (älteste
 *          fallen automatisch heraus; die Grenze ist PRO Slug — andere Projekte
 *          bleiben unberührt). `list({project?})` liefert absteigend nach
 *          `finishedAt`, optional per Slug gefiltert. `trigger` ∈ {night,manual}
 *          und `project` als Slug werden validiert (ungültig → record wirft,
 *          list liefert []). Berichte überstehen einen Neustart (neue Instanz
 *          liest dieselbe Datei). Security-Floor: `completed`/`blocked` werden
 *          auf `{id,title}` reduziert (kein Durchreichen von Pfaden/Extra-
 *          Feldern); kein absoluter Pfad in der Datei. Degradiert ohne
 *          CRED_STORE_DIR auf reinen In-Memory-Betrieb (kein Crash).
 *
 * Covers (night-budget-guard):
 *   AC12 — `record()` nimmt additiv `budgetPauses:[{from,to,reason}]` entgegen,
 *          persistiert sie (Neustart-fest, tmp+rename) und `list()` reicht sie
 *          durch. Fehlendes Feld (Alt-Bericht) → `[]` (rückwärtskompatibel).
 *          Ein Eintrag mit ungültigem `reason` wird verworfen (Security-/
 *          Daten-Hygiene, kein Durchreichen beliebiger Felder).
 *
 * Covers (drain-completion-report, v2):
 *   AC8 — `record()` eines Leerlauf-Berichts (`flowRuns:0`,
 *          `reason:'no-drain-target'`) verschmilzt mit dem unmittelbar
 *          vorhergehenden Bericht DESSELBEN Projekts, sofern dieser ebenfalls
 *          ein Leerlauf-Bericht ist (`lastAt` aktualisiert, `count` erhöht,
 *          `firstAt` unverändert, `reportId` bleibt); ein nicht-leerer
 *          Vorgänger (oder keiner) → neuer Eintrag mit `count:1`. Ein
 *          nicht-leerer Bericht beendet die Serie — der nächste Leerlauf-
 *          Bericht startet eine neue Serie. Der 30er-Rückschnitt (AC3) greift
 *          nach dem Merge (eine Serie belegt nur einen Slot).
 *   AC9 — beim Laden werden bestehende zusammenhängende Leerlauf-Serien je
 *          Projekt einmalig zu je einem Eintrag verschmolzen (`firstAt`/
 *          `lastAt`/`count:N`); idempotent (zweiter Lauf ändert nichts);
 *          nicht-leere Berichte bleiben unangetastet, kein Datenverlust.
 *
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test; je Test
 * eine frische DrainReportStore-Instanz (der In-Memory-Cache ist instanz-lokal,
 * ein Neustart wird durch eine zweite Instanz simuliert).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  DrainReportStore,
  resolveReportFilePath,
  MAX_REPORTS_PER_PROJECT,
} from '../src/DrainReportStore.js';

let storeDir;
let prevEnv;

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'drain-reports-test-' + randomBytes(6).toString('hex'));
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
    project: 'proj-a',
    trigger: 'manual',
    startedAt: '2026-07-02T22:00:00.000Z',
    finishedAt: '2026-07-02T22:05:00.000Z',
    reason: 'no-drain-target',
    flowRuns: 2,
    completed: [{ id: 'S-1', title: 'Eins' }],
    blocked: [],
    ...overrides,
  };
}

describe('DrainReportStore.record() + list() (AC3)', () => {
  it('legt einen Bericht mit generierter reportId an und liefert ihn über list()', async () => {
    const store = new DrainReportStore();
    const written = await store.record(base());

    expect(typeof written.reportId).toBe('string');
    expect(written.reportId.length).toBeGreaterThan(0);

    const reports = await store.list();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      project: 'proj-a',
      trigger: 'manual',
      reason: 'no-drain-target',
      flowRuns: 2,
      completed: [{ id: 'S-1', title: 'Eins' }],
      blocked: [],
    });
    expect(reports[0].reportId).toBe(written.reportId);
  });

  it('generiert eindeutige reportIds', async () => {
    const store = new DrainReportStore();
    await store.record(base());
    await store.record(base());
    const reports = await store.list();
    expect(reports).toHaveLength(2);
    expect(reports[0].reportId).not.toBe(reports[1].reportId);
  });

  it('list() sortiert absteigend nach finishedAt (jüngster zuerst)', async () => {
    const store = new DrainReportStore();
    await store.record(base({ reason: 'a', finishedAt: '2026-07-02T10:00:00.000Z' }));
    await store.record(base({ reason: 'c', finishedAt: '2026-07-02T12:00:00.000Z' }));
    await store.record(base({ reason: 'b', finishedAt: '2026-07-02T11:00:00.000Z' }));

    const reasons = (await store.list()).map((r) => r.reason);
    expect(reasons).toEqual(['c', 'b', 'a']);
  });

  it('list({project}) filtert auf den Slug; andere Projekte erscheinen nicht', async () => {
    const store = new DrainReportStore();
    await store.record(base({ project: 'proj-a' }));
    await store.record(base({ project: 'proj-b' }));

    const onlyA = await store.list({ project: 'proj-a' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].project).toBe('proj-a');
  });

  it('ein ungültiger/traversierender Slug in list() → leere Liste (kein Wurf)', async () => {
    const store = new DrainReportStore();
    await store.record(base());
    expect(await store.list({ project: '../etc' })).toEqual([]);
    expect(await store.list({ project: 'a/b' })).toEqual([]);
  });

  it('record() wirft bei ungültigem project-Slug und bei ungültigem trigger', async () => {
    const store = new DrainReportStore();
    await expect(store.record(base({ project: '../etc/passwd' }))).rejects.toThrow();
    await expect(store.record(base({ project: '' }))).rejects.toThrow();
    await expect(store.record(base({ trigger: 'weekly' }))).rejects.toThrow();
    // Nach den Fehlern ist nichts geschrieben.
    expect(await store.list()).toEqual([]);
  });

  it('reduziert completed/blocked auf {id,title} (kein Durchreichen von Extra-/Pfad-Feldern)', async () => {
    const store = new DrainReportStore();
    await store.record(
      base({
        completed: [{ id: 'S-1', title: 'Eins', repo_path: '/workspace/secret', token: 'abc' }],
        blocked: [{ id: 'S-2', title: 'Zwei', extra: 'x' }],
      }),
    );
    const [r] = await store.list();
    expect(r.completed).toEqual([{ id: 'S-1', title: 'Eins' }]);
    expect(r.blocked).toEqual([{ id: 'S-2', title: 'Zwei' }]);

    // Und auch in der persistierten Datei taucht kein Pfad/Secret auf.
    const raw = await readFile(resolveReportFilePath(), 'utf8');
    expect(raw).not.toContain('/workspace/secret');
    expect(raw).not.toContain('abc');
  });
});

describe('DrainReportStore — Pro-Projekt-Grenze (AC3)', () => {
  it('hält je Projekt höchstens MAX_REPORTS_PER_PROJECT (30) — älteste fallen heraus', async () => {
    const store = new DrainReportStore();
    const total = MAX_REPORTS_PER_PROJECT + 5; // 35
    for (let i = 0; i < total; i++) {
      // Rückschnitt erfolgt nach Einfüge-Reihenfolge (nicht nach finishedAt) —
      // die 5 ältesten (r0..r4) fallen heraus.
      await store.record(base({ reason: `r${i}` }));
    }
    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(MAX_REPORTS_PER_PROJECT);
    const reasons = reports.map((r) => r.reason);
    expect(reasons).not.toContain('r0');
    expect(reasons).not.toContain('r4');
    expect(reasons).toContain('r5');
    expect(reasons).toContain(`r${total - 1}`);
  });

  it('die Grenze ist PRO Slug — andere Projekte bleiben unberührt', async () => {
    const store = new DrainReportStore();
    for (let i = 0; i < MAX_REPORTS_PER_PROJECT + 3; i++) {
      await store.record(base({ project: 'proj-a', reason: `a${i}` }));
    }
    await store.record(base({ project: 'proj-b', reason: 'b0' }));

    expect(await store.list({ project: 'proj-a' })).toHaveLength(MAX_REPORTS_PER_PROJECT);
    expect(await store.list({ project: 'proj-b' })).toHaveLength(1);
  });
});

describe('DrainReportStore — Persistenz + atomares Schreiben (AC3)', () => {
  it('schreibt gültiges JSON ohne .tmp-Rest', async () => {
    const store = new DrainReportStore();
    await store.record(base());

    const filePath = resolveReportFilePath();
    const raw = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).reports).toHaveLength(1);

    const files = await readdir(storeDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });

  it('Berichte überstehen einen Neustart (zweite Instanz liest dieselbe Datei)', async () => {
    const store1 = new DrainReportStore();
    await store1.record(base({ reason: 'persisted' }));

    const store2 = new DrainReportStore();
    const reports = await store2.list();
    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toBe('persisted');
  });
});

describe('DrainReportStore — Degradation ohne CRED_STORE_DIR', () => {
  it('record/list funktionieren In-Memory, ohne zu werfen und ohne Datei', async () => {
    delete process.env.CRED_STORE_DIR;
    expect(resolveReportFilePath()).toBeNull();

    const store = new DrainReportStore();
    await expect(store.record(base())).resolves.toBeTruthy();
    const reports = await store.list();
    expect(reports).toHaveLength(1);
  });
});

describe('DrainReportStore — budgetPauses (night-budget-guard AC12)', () => {
  it('record() persistiert budgetPauses und list() reicht sie durch', async () => {
    const store = new DrainReportStore();
    const budgetPauses = [
      { from: 1000, to: 2000, reason: 'reactive-limit' },
      { from: 3000, to: null, reason: 'proactive-threshold' },
    ];
    await store.record(base({ budgetPauses }));

    const [report] = await store.list();
    expect(report.budgetPauses).toEqual(budgetPauses);
  });

  it('fehlendes budgetPauses-Feld (Alt-Bericht) → [] (rückwärtskompatibel)', async () => {
    const store = new DrainReportStore();
    await store.record(base()); // kein budgetPauses im Input

    const [report] = await store.list();
    expect(report.budgetPauses).toEqual([]);
  });

  it('ein Eintrag mit ungültigem reason wird verworfen (Security-/Daten-Hygiene)', async () => {
    const store = new DrainReportStore();
    await store.record(
      base({
        budgetPauses: [
          { from: 1000, to: 2000, reason: 'reactive-limit' },
          { from: 4000, to: null, reason: 'weekly-quota' }, // ungültig
        ],
      }),
    );

    const [report] = await store.list();
    expect(report.budgetPauses).toEqual([{ from: 1000, to: 2000, reason: 'reactive-limit' }]);
  });

  it('budgetPauses übersteht einen Neustart (Persistenz, tmp+rename)', async () => {
    const store1 = new DrainReportStore();
    await store1.record(base({ budgetPauses: [{ from: 5000, to: null, reason: 'proactive-threshold' }] }));

    const store2 = new DrainReportStore();
    const [report] = await store2.list();
    expect(report.budgetPauses).toEqual([{ from: 5000, to: null, reason: 'proactive-threshold' }]);
  });

  it('eine Alt-Bericht-Datei OHNE budgetPauses-Feld lädt sauber auf [] (rückwärtskompatibel)', async () => {
    // Simuliert eine vor S-275 geschriebene Bericht-Datei — kein budgetPauses-Feld.
    const filePath = resolveReportFilePath();
    await writeFile(
      filePath,
      JSON.stringify({
        reports: [
          {
            reportId: 'legacy-1',
            project: 'proj-a',
            trigger: 'manual',
            startedAt: '2026-06-01T00:00:00.000Z',
            finishedAt: '2026-06-01T00:05:00.000Z',
            reason: 'no-drain-target',
            flowRuns: 1,
            completed: [],
            blocked: [],
            // KEIN budgetPauses-Feld.
          },
        ],
      }),
      'utf8',
    );

    const store = new DrainReportStore();
    const [report] = await store.list();
    expect(report.budgetPauses).toEqual([]);
  });

  it('kein Regress an den bestehenden Report-Feldern durch die budgetPauses-Erweiterung', async () => {
    const store = new DrainReportStore();
    const written = await store.record(base({ budgetPauses: [{ from: 1, to: 2, reason: 'reactive-limit' }] }));
    expect(written).toMatchObject({
      project: 'proj-a',
      trigger: 'manual',
      reason: 'no-drain-target',
      flowRuns: 2,
      completed: [{ id: 'S-1', title: 'Eins' }],
      blocked: [],
    });
  });
});

function idle(overrides = {}) {
  return base({
    trigger: 'night',
    reason: 'no-drain-target',
    flowRuns: 0,
    completed: [],
    blocked: [],
    ...overrides,
  });
}

function nonEmpty(overrides = {}) {
  return base({
    trigger: 'night',
    reason: 'converged',
    flowRuns: 1,
    completed: [{ id: 'S-1', title: 'Eins' }],
    blocked: [],
    ...overrides,
  });
}

describe('DrainReportStore — Leerlauf-Merge beim Schreiben (v2, AC8)', () => {
  it('zwei aufeinanderfolgende Leerlauf-Berichte desselben Projekts verschmelzen zu einem Eintrag', async () => {
    const store = new DrainReportStore();
    const first = await store.record(
      idle({ startedAt: '2026-07-12T22:00:00.000Z', finishedAt: '2026-07-12T22:01:00.000Z' }),
    );
    const second = await store.record(
      idle({ startedAt: '2026-07-13T22:00:00.000Z', finishedAt: '2026-07-13T22:01:00.000Z' }),
    );

    expect(second.reportId).toBe(first.reportId);
    expect(second.count).toBe(2);
    expect(second.firstAt).toBe('2026-07-12T22:00:00.000Z');
    expect(second.lastAt).toBe('2026-07-13T22:01:00.000Z');

    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(1);
    expect(reports[0].count).toBe(2);
  });

  it('drei aufeinanderfolgende Leerlauf-Berichte → count wächst schrittweise auf 3, firstAt bleibt fix', async () => {
    const store = new DrainReportStore();
    await store.record(idle({ startedAt: '2026-07-01T22:00:00.000Z', finishedAt: '2026-07-01T22:01:00.000Z' }));
    await store.record(idle({ finishedAt: '2026-07-02T22:01:00.000Z' }));
    const third = await store.record(idle({ finishedAt: '2026-07-03T22:01:00.000Z' }));

    expect(third.count).toBe(3);
    expect(third.firstAt).toBe('2026-07-01T22:00:00.000Z');
    expect(third.lastAt).toBe('2026-07-03T22:01:00.000Z');
    expect(await store.list({ project: 'proj-a' })).toHaveLength(1);
  });

  it('kein leerer Vorgänger → neuer Eintrag mit count:1, firstAt=startedAt, lastAt=finishedAt', async () => {
    const store = new DrainReportStore();
    const written = await store.record(
      idle({ startedAt: '2026-07-12T22:00:00.000Z', finishedAt: '2026-07-12T22:01:00.000Z' }),
    );
    expect(written.count).toBe(1);
    expect(written.firstAt).toBe('2026-07-12T22:00:00.000Z');
    expect(written.lastAt).toBe('2026-07-12T22:01:00.000Z');
  });

  it('ein nicht-leerer Bericht zwischen zwei Leerläufen beendet die Serie — neue Serie startet danach', async () => {
    const store = new DrainReportStore();
    await store.record(idle({ finishedAt: '2026-07-12T22:01:00.000Z' }));
    await store.record(idle({ finishedAt: '2026-07-13T22:01:00.000Z' })); // count 2
    await store.record(nonEmpty({ finishedAt: '2026-07-14T22:01:00.000Z' })); // beendet Serie
    const third = await store.record(idle({ finishedAt: '2026-07-15T22:01:00.000Z' })); // neue Serie

    expect(third.count).toBe(1);
    expect(third.firstAt).toBe(third.startedAt);

    const reports = await store.list({ project: 'proj-a' });
    // 3 Einträge: die verschmolzene erste Serie (count:2), der nicht-leere
    // Bericht, und die neue Serie (count:1).
    expect(reports).toHaveLength(3);
    const counts = reports.map((r) => r.count).sort();
    expect(counts).toEqual([1, 1, 2]);
  });

  it('ein nicht-leerer Vorgänger (kein Leerlauf davor) → neuer Eintrag statt Merge', async () => {
    const store = new DrainReportStore();
    await store.record(nonEmpty());
    const written = await store.record(idle({ finishedAt: '2026-07-13T22:01:00.000Z' }));

    expect(written.count).toBe(1);
    expect(await store.list({ project: 'proj-a' })).toHaveLength(2);
  });

  it('die Merge-Serie belegt nur EINEN Slot der 30er-Pro-Projekt-Grenze', async () => {
    const store = new DrainReportStore();
    for (let i = 0; i < MAX_REPORTS_PER_PROJECT + 5; i++) {
      await store.record(idle({ finishedAt: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T22:0${i % 6}:00.000Z` }));
    }
    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(1);
    expect(reports[0].count).toBe(MAX_REPORTS_PER_PROJECT + 5);
  });

  it('bestehende Felder (project, trigger, reason, flowRuns) bleiben bei Merge unverändert', async () => {
    const store = new DrainReportStore();
    await store.record(idle());
    const merged = await store.record(idle());
    expect(merged.project).toBe('proj-a');
    expect(merged.trigger).toBe('night');
    expect(merged.reason).toBe('no-drain-target');
    expect(merged.flowRuns).toBe(0);
  });

  it('die Merge-Serie ist PRO Projekt — ein Leerlauf-Bericht eines anderen Projekts merged nicht mit', async () => {
    const store = new DrainReportStore();
    await store.record(idle({ project: 'proj-a' }));
    await store.record(idle({ project: 'proj-b' }));

    expect(await store.list({ project: 'proj-a' })).toHaveLength(1);
    expect(await store.list({ project: 'proj-b' })).toHaveLength(1);
  });
});

describe('DrainReportStore — einmalige Kompaktion beim Laden (v2, AC9)', () => {
  async function writeRawFile(reports) {
    const filePath = resolveReportFilePath();
    await writeFile(filePath, JSON.stringify({ reports }), 'utf8');
  }

  function rawIdle(overrides = {}) {
    return {
      reportId: 'legacy-' + Math.random().toString(36).slice(2),
      project: 'proj-a',
      trigger: 'night',
      startedAt: '2026-07-01T22:00:00.000Z',
      finishedAt: '2026-07-01T22:01:00.000Z',
      reason: 'no-drain-target',
      flowRuns: 0,
      completed: [],
      blocked: [],
      ...overrides,
    };
  }

  it('N zusammenhängende Alt-Leerlauf-Berichte → 1 Eintrag mit firstAt/lastAt/count:N', async () => {
    const raw = [];
    for (let i = 0; i < 30; i++) {
      raw.push(
        rawIdle({
          reportId: `legacy-${i}`,
          startedAt: `2026-07-${String(1 + i).padStart(2, '0')}T22:00:00.000Z`,
          finishedAt: `2026-07-${String(1 + i).padStart(2, '0')}T22:01:00.000Z`,
        }),
      );
    }
    await writeRawFile(raw);

    const store = new DrainReportStore();
    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(1);
    expect(reports[0].count).toBe(30);
    expect(reports[0].firstAt).toBe('2026-07-01T22:00:00.000Z');
    expect(reports[0].lastAt).toBe('2026-07-30T22:01:00.000Z');
  });

  it('nicht-leere Berichte bleiben unangetastet (kein Datenverlust)', async () => {
    const raw = [
      { ...rawIdle({ reportId: 'legacy-1', finishedAt: '2026-07-01T22:01:00.000Z' }) },
      {
        reportId: 'legacy-nonempty',
        project: 'proj-a',
        trigger: 'night',
        startedAt: '2026-07-02T22:00:00.000Z',
        finishedAt: '2026-07-02T22:05:00.000Z',
        reason: 'converged',
        flowRuns: 3,
        completed: [{ id: 'S-1', title: 'Eins' }],
        blocked: [{ id: 'S-2', title: 'Zwei' }],
      },
    ];
    await writeRawFile(raw);

    const store = new DrainReportStore();
    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(2);
    const nonEmptyReport = reports.find((r) => r.reportId === 'legacy-nonempty');
    expect(nonEmptyReport).toMatchObject({
      reason: 'converged',
      flowRuns: 3,
      completed: [{ id: 'S-1', title: 'Eins' }],
      blocked: [{ id: 'S-2', title: 'Zwei' }],
    });
  });

  it('zwei getrennte Leerlauf-Serien (unterbrochen von einem nicht-leeren Bericht) bleiben getrennt', async () => {
    const raw = [
      rawIdle({ reportId: 'a1', finishedAt: '2026-07-01T22:01:00.000Z' }),
      rawIdle({ reportId: 'a2', finishedAt: '2026-07-02T22:01:00.000Z' }),
      {
        reportId: 'mid',
        project: 'proj-a',
        trigger: 'night',
        startedAt: '2026-07-03T22:00:00.000Z',
        finishedAt: '2026-07-03T22:05:00.000Z',
        reason: 'converged',
        flowRuns: 1,
        completed: [],
        blocked: [],
      },
      rawIdle({ reportId: 'b1', finishedAt: '2026-07-04T22:01:00.000Z' }),
      rawIdle({ reportId: 'b2', finishedAt: '2026-07-05T22:01:00.000Z' }),
    ];
    await writeRawFile(raw);

    const store = new DrainReportStore();
    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(3); // Serie A (count:2), mid, Serie B (count:2)
    const counts = reports.map((r) => r.count).sort();
    expect(counts).toEqual([1, 2, 2]);
  });

  it('idempotent: ein zweiter Ladevorgang (neue Instanz) ändert nichts weiter', async () => {
    const raw = [];
    for (let i = 0; i < 5; i++) {
      raw.push(rawIdle({ reportId: `legacy-${i}`, finishedAt: `2026-07-0${1 + i}T22:01:00.000Z` }));
    }
    await writeRawFile(raw);

    const store1 = new DrainReportStore();
    const first = await store1.list({ project: 'proj-a' });
    expect(first).toHaveLength(1);
    expect(first[0].count).toBe(5);

    // Zweite, frische Instanz liest dieselbe (noch nicht neu geschriebene)
    // Rohdatei erneut — die Kompaktion beim Laden ist idempotent.
    const store2 = new DrainReportStore();
    const second = await store2.list({ project: 'proj-a' });
    expect(second).toHaveLength(1);
    expect(second[0].count).toBe(5);
  });

  it('ein weiterer Leerlauf-Bericht nach der Kompaktion merged in die geladene Serie', async () => {
    const raw = [];
    for (let i = 0; i < 3; i++) {
      raw.push(rawIdle({ reportId: `legacy-${i}`, finishedAt: `2026-07-0${1 + i}T22:01:00.000Z` }));
    }
    await writeRawFile(raw);

    const store = new DrainReportStore();
    await store.record(idle({ finishedAt: '2026-07-10T22:01:00.000Z' }));

    const reports = await store.list({ project: 'proj-a' });
    expect(reports).toHaveLength(1);
    expect(reports[0].count).toBe(4);
    expect(reports[0].lastAt).toBe('2026-07-10T22:01:00.000Z');
  });
});
