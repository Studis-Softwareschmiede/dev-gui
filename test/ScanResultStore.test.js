/**
 * @file ScanResultStore.test.js — Unit-Tests für die persistente,
 * größenbegrenzte Scan-Verlaufs-Ablage pro App
 * (docs/specs/red-team-scan-per-container.md AC7, AC8, AC9).
 *
 * Covers (red-team-scan-per-container):
 *   AC7 — `record({app,scanId?,startedAt,finishedAt,findings,reportRef,boardItemIds})`
 *         legt einen Verlaufseintrag an (generierte `scanId` falls fehlend), schreibt
 *         die Datei atomar (tmp+rename → gültiges JSON, kein .tmp-Rest, Rechte 0600) und
 *         hält je App-Slug HÖCHSTENS 30 Einträge (älteste fallen automatisch heraus, die
 *         Grenze ist PRO App — andere Apps bleiben unberührt). Ohne CRED_STORE_DIR
 *         degradiert der Store auf reinen In-Memory-Betrieb (kein Crash). Ein ungültiger
 *         `app`-Wert lässt `record()` werfen bzw. `list()`/`getByScanId()` leer/null
 *         liefern (kein Dateizugriff). Findings werden auf `{id,severity,kind,testort,
 *         titel}` normalisiert (kein Durchreichen beliebiger Felder); ein Eintrag mit
 *         ungültiger/fehlender severity/testort wird defensiv normalisiert statt zu crashen.
 *   AC8 — `list(app)` liefert die KOMPAKTE Verlaufs-Form (`scanId,startedAt,ampel,
 *         findingCount,boardItemIds` — OHNE `findings`/`reportRef`), absteigend nach
 *         `startedAt`. `getByScanId(scanId)`/`getByJobId(jobId)` (Alias, s. Modul-Doku
 *         "scanId ≡ jobId") liefern den VOLLEN Datensatz inkl. `findings`+`reportRef`.
 *   AC9 — `deriveAmpel(findings)` ist deterministisch: `gruen` ohne Befunde, `gelb` nur
 *         low/medium, `rot` bei mindestens einem high/critical-Befund. `record()` leitet
 *         `ampel`/`findingCount` IMMER aus `findings` ab — ein mitgegebenes `input.ampel`
 *         wird ignoriert (single source of truth, kein zweiter driftender Wert).
 *   AC16/AC17 (S-405) — Schema-Erweiterung: `record()` akzeptiert optional `repoSlug`
 *         (Scan-Ebene, `null` falls nicht mitgegeben); jedes Finding trägt zusätzlich
 *         `boardId` (`null` bis übertragen). `recordBoardTransfer({scanId,transfers})`
 *         setzt `boardId` je passendem, noch nicht übertragenem Finding (Idempotenz — ein
 *         bereits gesetztes `boardId` wird nie überschrieben), ergänzt `boardItemIds`
 *         dedupliziert um die neu entstandenen IDs, schreibt atomar, und liefert `null`
 *         bei unbekannter `scanId` (kein Wurf). Unbekannte `findingId`s in `transfers`
 *         werden still ignoriert.
 *
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test (Muster
 * `DrainReportStore.test.js`); je Test eine frische ScanResultStore-Instanz (der
 * In-Memory-Cache ist instanz-lokal, ein Neustart wird durch eine zweite Instanz simuliert).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  ScanResultStore,
  resolveScanResultsFilePath,
  deriveAmpel,
  MAX_SCANS_PER_APP,
} from '../src/ScanResultStore.js';

let storeDir;
let prevEnv;

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'scan-results-test-' + randomBytes(6).toString('hex'));
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
    app: 'dev-gui.example.com',
    startedAt: '2026-07-22T10:00:00.000Z',
    finishedAt: '2026-07-22T10:05:00.000Z',
    findings: [],
    reportRef: 'report-1',
    ...overrides,
  };
}

// ── AC9 — deriveAmpel() ────────────────────────────────────────────────────────

describe('deriveAmpel() (AC9)', () => {
  it('gruen ohne Befunde', () => {
    expect(deriveAmpel([])).toBe('gruen');
  });

  it('gelb bei ausschliesslich low/medium-Befunden', () => {
    expect(deriveAmpel([{ severity: 'low' }, { severity: 'medium' }])).toBe('gelb');
  });

  it('rot bei mindestens einem high-Befund', () => {
    expect(deriveAmpel([{ severity: 'low' }, { severity: 'high' }])).toBe('rot');
  });

  it('rot bei mindestens einem critical-Befund', () => {
    expect(deriveAmpel([{ severity: 'critical' }])).toBe('rot');
  });
});

// ── AC7 — record() + Normalisierung ────────────────────────────────────────────

describe('ScanResultStore.record() (AC7)', () => {
  it('legt einen Eintrag mit generierter scanId an', async () => {
    const store = new ScanResultStore();
    const written = await store.record(base());

    expect(typeof written.scanId).toBe('string');
    expect(written.scanId.length).toBeGreaterThan(0);
    expect(written.app).toBe('dev-gui.example.com');
    expect(written.reportRef).toBe('report-1');
    expect(written.boardItemIds).toEqual([]);
  });

  it('übernimmt eine mitgegebene scanId (Konvention: Runner-jobId)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(base({ scanId: 'job-abc' }));
    expect(written.scanId).toBe('job-abc');
  });

  it('leitet ampel/findingCount IMMER aus findings ab — ein mitgegebenes ampel wird ignoriert (AC9)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(
      base({ ampel: 'gruen', findings: [{ id: 'f1', severity: 'critical', kind: 'xss', testort: 'direkt', titel: 'XSS' }] }),
    );
    expect(written.ampel).toBe('rot');
    expect(written.findingCount).toBe(1);
  });

  it('normalisiert findings auf {id,severity,kind,testort,titel,boardId} (kein Durchreichen von Extra-Feldern)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(
      base({
        findings: [
          { id: 'f1', severity: 'high', kind: 'ssrf', testort: 'öffentlich', titel: 'SSRF', internalDebug: '/etc/passwd' },
        ],
      }),
    );
    expect(written.findings).toEqual([
      { id: 'f1', severity: 'high', kind: 'ssrf', testort: 'öffentlich', titel: 'SSRF', boardId: null },
    ]);
  });

  it('leitet repoSlug/boardId als null, falls nicht mitgegeben (AC16/AC17, S-405)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(base());
    expect(written.repoSlug).toBeNull();
  });

  it('übernimmt eine mitgegebene repoSlug (AC16/AC17, S-405)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(base({ repoSlug: 'dev-gui' }));
    expect(written.repoSlug).toBe('dev-gui');
  });

  it('normalisiert ungültige/fehlende severity/testort defensiv (kein Crash)', async () => {
    const store = new ScanResultStore();
    const written = await store.record(
      base({ findings: [{ id: 'f1', severity: 'unbekannt', testort: 'irgendwo', titel: 'X' }] }),
    );
    expect(written.findings[0].severity).toBe('medium');
    expect(written.findings[0].testort).toBe('direkt');
  });

  it('wirft bei ungültigem/fehlendem app-Wert', async () => {
    const store = new ScanResultStore();
    await expect(store.record(base({ app: '' }))).rejects.toThrow();
    await expect(store.record(base({ app: undefined }))).rejects.toThrow();
    expect(await store.list('dev-gui.example.com')).toEqual([]);
  });
});

// ── AC8 — list() (kompakt) + getByScanId()/getByJobId() (Detail) ──────────────

describe('ScanResultStore.list() + getByScanId()/getByJobId() (AC8)', () => {
  it('list() liefert die kompakte Form OHNE findings/reportRef, absteigend nach startedAt', async () => {
    const store = new ScanResultStore();
    await store.record(base({ scanId: 'scan-1', startedAt: '2026-07-22T09:00:00.000Z' }));
    await store.record(base({ scanId: 'scan-2', startedAt: '2026-07-22T11:00:00.000Z' }));

    const list = await store.list('dev-gui.example.com');
    expect(list).toHaveLength(2);
    expect(list[0].scanId).toBe('scan-2'); // jüngster zuerst
    expect(list[1].scanId).toBe('scan-1');
    for (const entry of list) {
      expect(entry).not.toHaveProperty('findings');
      expect(entry).not.toHaveProperty('reportRef');
      expect(entry).toEqual(
        expect.objectContaining({ scanId: expect.any(String), startedAt: expect.any(String), ampel: expect.any(String), findingCount: expect.any(Number), boardItemIds: expect.any(Array) }),
      );
    }
  });

  it('list() filtert auf die App — andere Apps erscheinen nicht', async () => {
    const store = new ScanResultStore();
    await store.record(base({ app: 'app-a.example.com' }));
    await store.record(base({ app: 'app-b.example.com' }));

    const onlyA = await store.list('app-a.example.com');
    expect(onlyA).toHaveLength(1);
  });

  it('ein ungültiger app-Wert in list() → leere Liste (kein Wurf)', async () => {
    const store = new ScanResultStore();
    await store.record(base());
    expect(await store.list('')).toEqual([]);
  });

  it('getByScanId() liefert den VOLLEN Datensatz inkl. findings + reportRef', async () => {
    const store = new ScanResultStore();
    await store.record(
      base({ scanId: 'scan-1', findings: [{ id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' }] }),
    );

    const full = await store.getByScanId('scan-1');
    expect(full.findings).toEqual([
      { id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS', boardId: null },
    ]);
    expect(full.reportRef).toBe('report-1');
    expect(full.ampel).toBe('rot');
  });

  it('getByJobId() ist ein Alias auf getByScanId() (scanId ≡ jobId)', async () => {
    const store = new ScanResultStore();
    await store.record(base({ scanId: 'job-xyz' }));
    const viaJobId = await store.getByJobId('job-xyz');
    const viaScanId = await store.getByScanId('job-xyz');
    expect(viaJobId).toEqual(viaScanId);
    expect(viaJobId.scanId).toBe('job-xyz');
  });

  it('unbekannte scanId → null (kein Wurf)', async () => {
    const store = new ScanResultStore();
    expect(await store.getByScanId('does-not-exist')).toBeNull();
    expect(await store.getByJobId('does-not-exist')).toBeNull();
  });
});

// ── AC7 — Pro-App-Grenze ────────────────────────────────────────────────────────

describe('ScanResultStore — Pro-App-Grenze (AC7)', () => {
  it('hält je App höchstens MAX_SCANS_PER_APP (30) — älteste fallen heraus', async () => {
    const store = new ScanResultStore();
    const total = MAX_SCANS_PER_APP + 5; // 35
    for (let i = 0; i < total; i++) {
      await store.record(base({ scanId: `scan-${i}` }));
    }
    const list = await store.list('dev-gui.example.com');
    expect(list).toHaveLength(MAX_SCANS_PER_APP);
    const ids = list.map((s) => s.scanId);
    expect(ids).not.toContain('scan-0');
    expect(ids).not.toContain('scan-4');
    expect(ids).toContain('scan-5');
    expect(ids).toContain(`scan-${total - 1}`);
  });

  it('die Grenze ist PRO App — andere Apps bleiben unberührt', async () => {
    const store = new ScanResultStore();
    for (let i = 0; i < MAX_SCANS_PER_APP + 3; i++) {
      await store.record(base({ app: 'app-a.example.com', scanId: `a-${i}` }));
    }
    await store.record(base({ app: 'app-b.example.com', scanId: 'b-0' }));

    expect(await store.list('app-a.example.com')).toHaveLength(MAX_SCANS_PER_APP);
    expect(await store.list('app-b.example.com')).toHaveLength(1);
  });
});

// ── AC7 — Persistenz + atomares Schreiben + 0600 ────────────────────────────────

describe('ScanResultStore — Persistenz + atomares Schreiben (AC7)', () => {
  it('schreibt gültiges JSON ohne .tmp-Rest, Rechte 0600', async () => {
    const store = new ScanResultStore();
    await store.record(base());

    const filePath = resolveScanResultsFilePath();
    const raw = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).scans).toHaveLength(1);

    const files = await readdir(storeDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);

    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('Verlaufseinträge überstehen einen Neustart (zweite Instanz liest dieselbe Datei)', async () => {
    const store1 = new ScanResultStore();
    await store1.record(base({ scanId: 'persisted-1' }));

    const store2 = new ScanResultStore();
    const list = await store2.list('dev-gui.example.com');
    expect(list).toHaveLength(1);
    expect(list[0].scanId).toBe('persisted-1');
  });
});

// ── AC16/AC17 (S-405) — recordBoardTransfer() ───────────────────────────────────

describe('ScanResultStore.recordBoardTransfer() (AC16/AC17)', () => {
  it('setzt boardId je passendem Finding und ergänzt boardItemIds', async () => {
    const store = new ScanResultStore();
    await store.record(
      base({
        scanId: 'scan-1',
        findings: [
          { id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' },
          { id: 'f2', severity: 'low', kind: 'info', testort: 'direkt', titel: 'Info' },
        ],
      }),
    );

    const updated = await store.recordBoardTransfer({
      scanId: 'scan-1',
      transfers: [{ findingId: 'f1', boardId: 'S-500' }],
    });

    expect(updated.findings.find((f) => f.id === 'f1').boardId).toBe('S-500');
    expect(updated.findings.find((f) => f.id === 'f2').boardId).toBeNull();
    expect(updated.boardItemIds).toEqual(['S-500']);

    // persistiert — zweite Instanz liest denselben Stand.
    const store2 = new ScanResultStore();
    const reloaded = await store2.getByScanId('scan-1');
    expect(reloaded.findings.find((f) => f.id === 'f1').boardId).toBe('S-500');
    expect(reloaded.boardItemIds).toEqual(['S-500']);
  });

  it('idempotent: ein bereits gesetztes boardId wird NIE überschrieben', async () => {
    const store = new ScanResultStore();
    await store.record(
      base({ scanId: 'scan-1', findings: [{ id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' }] }),
    );
    await store.recordBoardTransfer({ scanId: 'scan-1', transfers: [{ findingId: 'f1', boardId: 'S-500' }] });

    const second = await store.recordBoardTransfer({
      scanId: 'scan-1',
      transfers: [{ findingId: 'f1', boardId: 'S-999' }],
    });

    expect(second.findings.find((f) => f.id === 'f1').boardId).toBe('S-500');
    expect(second.boardItemIds).toEqual(['S-500']);
  });

  it('dedupliziert boardItemIds bei mehreren Findings mit derselben Board-ID', async () => {
    const store = new ScanResultStore();
    await store.record(
      base({
        scanId: 'scan-1',
        findings: [
          { id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' },
          { id: 'f2', severity: 'high', kind: 'xss', testort: 'öffentlich', titel: 'XSS (edge)' },
        ],
      }),
    );

    const updated = await store.recordBoardTransfer({
      scanId: 'scan-1',
      transfers: [
        { findingId: 'f1', boardId: 'S-500' },
        { findingId: 'f2', boardId: 'S-500' },
      ],
    });

    expect(updated.boardItemIds).toEqual(['S-500']);
  });

  it('unbekannte scanId → null (kein Wurf)', async () => {
    const store = new ScanResultStore();
    const result = await store.recordBoardTransfer({ scanId: 'does-not-exist', transfers: [{ findingId: 'f1', boardId: 'S-500' }] });
    expect(result).toBeNull();
  });

  it('unbekannte findingId in transfers wird still ignoriert', async () => {
    const store = new ScanResultStore();
    await store.record(
      base({ scanId: 'scan-1', findings: [{ id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS' }] }),
    );
    const updated = await store.recordBoardTransfer({
      scanId: 'scan-1',
      transfers: [{ findingId: 'does-not-exist', boardId: 'S-500' }],
    });
    expect(updated.findings[0].boardId).toBeNull();
    expect(updated.boardItemIds).toEqual([]);
  });
});

// ── AC7 — Degradation ohne CRED_STORE_DIR ───────────────────────────────────────

describe('ScanResultStore — Degradation ohne CRED_STORE_DIR', () => {
  it('record/list/getByScanId funktionieren In-Memory, ohne zu werfen und ohne Datei', async () => {
    delete process.env.CRED_STORE_DIR;
    expect(resolveScanResultsFilePath()).toBeNull();

    const store = new ScanResultStore();
    const written = await store.record(base());
    expect(written).toBeTruthy();
    const list = await store.list('dev-gui.example.com');
    expect(list).toHaveLength(1);
    expect(await store.getByScanId(written.scanId)).toBeTruthy();
  });
});
