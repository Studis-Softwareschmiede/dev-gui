/**
 * DrainJobRegistry.test.js — Unit-Tests der Drain-Job-Registry
 * (docs/specs/headless-manual-drain.md AC4; datei-basiert persistiert seit
 * docs/specs/drain-restart-robustness.md AC1/AC2).
 *
 * Covers (headless-manual-drain):
 *   AC4 — Registry-Verhalten (register→running, markDone→done+Ergebnis-
 *          Zusammenfassung, markFailed→failed+generischer Text, getJob→undefined
 *          für unbekannte drainId). Die HTTP-Naht (GET/POST, Status-Codes) ist
 *          zusätzlich in test/projectDrainRouter.test.js abgedeckt.
 *
 * Covers (drain-completion-report):
 *   AC7 — markDone() reicht `completed`/`blocked` (AC1-Felder aus
 *          `ProjectDrain.drainProject()`) unverändert im `result` durch, damit
 *          die manuelle Inline-Status-Fläche (CockpitView) sie ohne
 *          Zusatz-Request zeigen kann; fehlend/ungültig → `[]` (kein Crash).
 *
 * Covers (drain-restart-robustness):
 *   AC1 — Datei-Persistenz unter `${CRED_STORE_DIR}/drain-jobs.json`, Format
 *          `{ jobs: [...] }`, atomares Schreiben (tmp+rename, kein .tmp-Rest),
 *          Rechte `0600`; sekret-/pfad-freies Eintrag-Schema. Ohne
 *          `CRED_STORE_DIR` reiner In-Memory-Betrieb (kein Crash, keine Datei).
 *          Korrupte/unlesbare Datei → leerer Cache (kein Crash). Einträge
 *          überstehen einen Neustart (zweite Instanz auf demselben Store-Dir).
 *   AC2 — `register(drainId,{project,trigger,args?,startedAt})` persistiert
 *          `running`; `markDone`/`markFailed` persistieren den terminalen
 *          Status; `getJob()` liest weiterhin nur `{status,result?,error?}`
 *          (Vertragsformat unverändert, s. auch test/projectDrainRouter.test.js).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, chmod, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  DrainJobRegistry,
  DRAIN_FAILURE_MESSAGE,
  resolveDrainJobsFilePath,
} from '../src/DrainJobRegistry.js';

describe('DrainJobRegistry (headless-manual-drain AC4)', () => {
  it('register() → status "running"', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    expect(reg.getJob('d1')).toEqual({ status: 'running' });
  });

  it('getJob() → undefined für unbekannte drainId (→ 404 auf HTTP-Ebene)', () => {
    const reg = new DrainJobRegistry();
    expect(reg.getJob('nope')).toBeUndefined();
  });

  it('markDone() → status "done" mit secret-freier Ergebnis-Zusammenfassung', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', { stopped: true, reason: 'no-drain-target', flowRuns: 3, escalated: ['S-7'] });
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'no-drain-target', flowRuns: 3, escalated: ['S-7'], completed: [], blocked: [] },
    });
  });

  it('markDone() normalisiert fehlende/ungültige Felder defensiv', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', {});
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'stopped', flowRuns: 0, escalated: [], completed: [], blocked: [] },
    });
  });

  it('markDone() ohne Argument (undefined) crasht nicht', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1');
    expect(reg.getJob('d1')).toEqual({
      status: 'done',
      result: { reason: 'stopped', flowRuns: 0, escalated: [], completed: [], blocked: [] },
    });
  });

  // ── drain-completion-report AC7: completed/blocked durchgereicht ───────────

  it('markDone() reicht completed/blocked (drain-completion-report AC1) unverändert durch', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', {
      reason: 'no-drain-target',
      flowRuns: 2,
      escalated: [],
      completed: [{ id: 'S-1', title: 'Eins' }],
      blocked: [{ id: 'S-9', title: 'Neun' }],
    });
    expect(reg.getJob('d1').result.completed).toEqual([{ id: 'S-1', title: 'Eins' }]);
    expect(reg.getJob('d1').result.blocked).toEqual([{ id: 'S-9', title: 'Neun' }]);
  });

  it('markDone() normalisiert ungültige completed/blocked (kein Array) auf []', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markDone('d1', { reason: 'x', flowRuns: 0, completed: 'not-an-array', blocked: null });
    expect(reg.getJob('d1').result.completed).toEqual([]);
    expect(reg.getJob('d1').result.blocked).toEqual([]);
  });

  it('markFailed() → status "failed" mit generischem Default-Text (kein Roh-Fehler)', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    reg.markFailed('d1');
    expect(reg.getJob('d1')).toEqual({ status: 'failed', error: DRAIN_FAILURE_MESSAGE });
  });

  it('markDone()/markFailed() auf unbekannte drainId ist ein No-op (kein Eintrag entsteht)', () => {
    const reg = new DrainJobRegistry();
    reg.markDone('ghost', { reason: 'x' });
    reg.markFailed('ghost2');
    expect(reg.getJob('ghost')).toBeUndefined();
    expect(reg.getJob('ghost2')).toBeUndefined();
  });

  it('terminaler Zustand überschreibt running (running → done)', () => {
    const reg = new DrainJobRegistry();
    reg.register('d1');
    expect(reg.getJob('d1').status).toBe('running');
    reg.markDone('d1', { reason: 'no-drain-target', flowRuns: 1, escalated: [] });
    expect(reg.getJob('d1').status).toBe('done');
  });
});

// ── drain-restart-robustness AC1/AC2: Datei-Persistenz ───────────────────────

describe('DrainJobRegistry — Persistenz (drain-restart-robustness AC1/AC2)', () => {
  let storeDir;
  let prevEnv;

  beforeEach(async () => {
    prevEnv = process.env.CRED_STORE_DIR;
    storeDir = join(tmpdir(), 'drain-jobs-test-' + randomBytes(6).toString('hex'));
    await mkdir(storeDir, { recursive: true });
    process.env.CRED_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CRED_STORE_DIR;
    else process.env.CRED_STORE_DIR = prevEnv;
    await rm(storeDir, { recursive: true, force: true }).catch(() => {});
  });

  it('register() schreibt einen running-Eintrag atomar (kein .tmp-Rest), Rechte 0600', async () => {
    const reg = new DrainJobRegistry();
    await reg.register('d1', { project: 'proj-a', trigger: 'manual', args: ['--cost', 'low-cost'], startedAt: '2026-07-03T10:00:00.000Z' });

    const filePath = resolveDrainJobsFilePath();
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0]).toMatchObject({
      drainId: 'd1',
      project: 'proj-a',
      trigger: 'manual',
      status: 'running',
      args: ['--cost', 'low-cost'],
      startedAt: '2026-07-03T10:00:00.000Z',
    });

    const files = await readdir(storeDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);

    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('markDone()/markFailed() persistieren den terminalen Status + finishedAt', async () => {
    const reg = new DrainJobRegistry();
    await reg.register('d1', { project: 'proj-a', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' });
    await reg.markDone('d1', { reason: 'no-drain-target', flowRuns: 2, escalated: [] });

    const reg2 = new DrainJobRegistry(); // simuliert Neustart: frische Instanz, gleiche Datei
    const job = reg2.getJob('d1');
    expect(job.status).toBe('done');
    expect(job.result.flowRuns).toBe(2);

    const raw = await readFile(resolveDrainJobsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.jobs[0].finishedAt).toEqual(expect.any(String));
    expect(parsed.jobs[0].finishedAt.length).toBeGreaterThan(0);
  });

  it('Einträge überstehen einen Neustart (zweite Instanz liest dieselbe Datei) — GET-Vertragsformat unverändert', async () => {
    const reg1 = new DrainJobRegistry();
    await reg1.register('d1', { project: 'dev-gui', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' });

    const reg2 = new DrainJobRegistry();
    expect(reg2.getJob('d1')).toEqual({ status: 'running' });
  });

  it('ohne CRED_STORE_DIR degradiert die Registry auf reinen In-Memory-Betrieb (kein Crash, keine Datei)', async () => {
    delete process.env.CRED_STORE_DIR;
    expect(resolveDrainJobsFilePath()).toBeNull();

    const reg = new DrainJobRegistry();
    await reg.register('d1', { project: 'proj-a', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' });
    expect(reg.getJob('d1')).toEqual({ status: 'running' });

    // Kein Store-Dir gesetzt → keine Datei irgendwo unter storeDir (das Test-Tmp-Dir bleibt leer).
    const files = await readdir(storeDir);
    expect(files).toEqual([]);
  });

  it('korrupte/unlesbare Datei → leerer Cache beim Laden (kein Crash)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(storeDir, 'drain-jobs.json'), '{ not valid json', 'utf8');

    const reg = new DrainJobRegistry();
    expect(reg.getJob('anything')).toBeUndefined();

    // Die Registry bleibt funktionsfähig (neuer Eintrag lässt sich registrieren).
    await reg.register('d1', { project: 'proj-a', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' });
    expect(reg.getJob('d1').status).toBe('running');
  });

  it('unlesbare Datei-Rechte (chmod 000) → leerer Cache beim Laden (kein Crash)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const filePath = join(storeDir, 'drain-jobs.json');
    await writeFile(filePath, JSON.stringify({ jobs: [] }), 'utf8');
    await chmod(filePath, 0o000);

    let reg;
    expect(() => { reg = new DrainJobRegistry(); }).not.toThrow();
    expect(reg.getJob('anything')).toBeUndefined();

    await chmod(filePath, 0o600).catch(() => {}); // Aufräumen für rm()
  });

  it('einzelner korrupter Eintrag (ungültiger project-Slug) wird beim Laden übersprungen, valide Einträge bleiben', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(storeDir, 'drain-jobs.json'),
      JSON.stringify({
        jobs: [
          { drainId: 'bad', project: '../etc/passwd', trigger: 'manual', status: 'running', startedAt: '2026-07-03T10:00:00.000Z' },
          { drainId: 'good', project: 'proj-a', trigger: 'manual', status: 'done', startedAt: '2026-07-03T10:00:00.000Z', finishedAt: '2026-07-03T10:05:00.000Z', result: { reason: 'x', flowRuns: 1, escalated: [], completed: [], blocked: [] } },
        ],
      }),
      'utf8',
    );

    const reg = new DrainJobRegistry();
    expect(reg.getJob('bad')).toBeUndefined();
    expect(reg.getJob('good')).toEqual({ status: 'done', result: { reason: 'x', flowRuns: 1, escalated: [], completed: [], blocked: [] } });
  });

  it('mehrere aufeinanderfolgende Schreibzugriffe serialisieren sich (kein korruptes JSON am Ende)', async () => {
    const reg = new DrainJobRegistry();
    await Promise.all([
      reg.register('d1', { project: 'proj-a', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' }),
      reg.register('d2', { project: 'proj-b', trigger: 'night', startedAt: '2026-07-03T10:00:01.000Z' }),
      reg.register('d3', { project: 'proj-c', trigger: 'manual', startedAt: '2026-07-03T10:00:02.000Z' }),
    ]);

    const raw = await readFile(resolveDrainJobsFilePath(), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.jobs.map((j) => j.drainId).sort()).toEqual(['d1', 'd2', 'd3']);
  });

  it('ein Store-Schreibfehler ist non-fatal (register()/markDone() werfen nicht)', async () => {
    // CRED_STORE_DIR zeigt auf einen Pfad, der nicht als Verzeichnis anlegbar ist
    // (Datei existiert bereits mit dem Zielnamen) → mkdir(dir,{recursive:true}) scheitert.
    const { writeFile } = await import('node:fs/promises');
    const blockedDir = join(storeDir, 'blocked');
    await writeFile(blockedDir, 'i am a file, not a dir', 'utf8'); // Verzeichnisname bereits als Datei belegt
    process.env.CRED_STORE_DIR = blockedDir;

    const reg = new DrainJobRegistry();
    await expect(reg.register('d1', { project: 'proj-a', trigger: 'manual', startedAt: '2026-07-03T10:00:00.000Z' })).resolves.not.toThrow();
    // In-Memory bleibt trotz Schreibfehler korrekt.
    expect(reg.getJob('d1')).toEqual({ status: 'running' });
  });
});
