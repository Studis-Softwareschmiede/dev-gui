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
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test; je Test
 * eine frische DrainReportStore-Instanz (der In-Memory-Cache ist instanz-lokal,
 * ein Neustart wird durch eine zweite Instanz simuliert).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
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
