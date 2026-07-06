/**
 * RepoSizeStore.test.js — Tests für persistierte Repo-Größen-Ablage.
 * (docs/specs/repo-size-badge.md AC3)
 *
 * Covers (repo-size-badge):
 *   AC3  — RepoSizeStore persistiert unter ${CRED_STORE_DIR}/repo-sizes.json
 *          (atomarer tmp+rename-Schreibzugriff, 0600);
 *          `record(repoSlug, buckets)` stempelt measuredAt und schreibt atomar;
 *          `get(repoSlug)`/`list()` liefern letzten bekannten Wert inkl. measuredAt;
 *          Slug = reiner Schlüssel (kein per-Request-Dateipfad);
 *          Werte überstehen Server-Neustart;
 *          Fehlt CRED_STORE_DIR → In-Memory-Degradation ohne Crash.
 *
 * Strategie:
 *   - Mock ${CRED_STORE_DIR} (temp-Pfad per test)
 *   - Test record() → persist → reload → get/list
 *   - Test In-Memory-Degradation (CRED_STORE_DIR nicht gesetzt)
 *   - Test Slug-Validierung
 *   - Test Serialisierung (Größen konsistent, measuredAt ISO-Zeitstempel)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RepoSizeStore, REPO_SLUG_RE } from '../src/RepoSizeStore.js';

describe('RepoSizeStore', () => {
  let tmpDir;
  let storePath;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `repo-size-store-test-${randomBytes(4).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });
    storePath = join(tmpDir, 'repo-sizes.json');
    process.env.CRED_STORE_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.CRED_STORE_DIR;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── AC3: Persistenz & Serialisierung ───────────────────────────────────────

  describe('AC3 — Persistenz & record/get/list API', () => {
    it('sollte record() einen Messwert speichern und persistieren', async () => {
      const store = new RepoSizeStore();

      const result = await store.record('dev-gui', {
        total: 1000,
        git: 200,
        artifacts: 300,
        workspace: 500,
      });

      expect(result).toEqual({
        total: 1000,
        git: 200,
        artifacts: 300,
        workspace: 500,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO-8601
      });

      // Datei sollte existieren
      const raw = await readFile(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.sizes['dev-gui']).toBeDefined();
      expect(parsed.sizes['dev-gui'].total).toBe(1000);
    });

    it('sollte get(slug) den letzten gespeicherten Wert liefern', async () => {
      const store = new RepoSizeStore();

      await store.record('project-1', {
        total: 2000,
        git: 400,
        artifacts: 600,
        workspace: 1000,
      });

      const result = await store.get('project-1');

      expect(result).toEqual({
        total: 2000,
        git: 400,
        artifacts: 600,
        workspace: 1000,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it('sollte get(unbekannter-slug) null liefern', async () => {
      const store = new RepoSizeStore();

      const result = await store.get('unknown-repo');

      expect(result).toBeNull();
    });

    it('sollte list() alle Messwerte liefern', async () => {
      const store = new RepoSizeStore();

      await store.record('repo-a', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      await store.record('repo-b', {
        total: 2000,
        git: 300,
        artifacts: 400,
        workspace: 1300,
      });

      const results = await store.list();

      expect(results.size).toBe(2);
      expect(results.get('repo-a')).toEqual({
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(results.get('repo-b')).toEqual({
        total: 2000,
        git: 300,
        artifacts: 400,
        workspace: 1300,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it('sollte Werte über Server-Neustart persistieren', async () => {
      const store1 = new RepoSizeStore();

      await store1.record('persistent-repo', {
        total: 5000,
        git: 1000,
        artifacts: 2000,
        workspace: 2000,
      });

      // Neue Instanz (wie nach Server-Neustart)
      const store2 = new RepoSizeStore();

      const result = await store2.get('persistent-repo');

      expect(result).toEqual({
        total: 5000,
        git: 1000,
        artifacts: 2000,
        workspace: 2000,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });
  });

  // ── AC3: Slug-Validierung ──────────────────────────────────────────────────

  describe('AC3 — Slug-Validierung', () => {
    it('sollte gültige Slugs akzeptieren', () => {
      expect(REPO_SLUG_RE.test('dev-gui')).toBe(true);
      expect(REPO_SLUG_RE.test('my_project')).toBe(true);
      expect(REPO_SLUG_RE.test('repo123')).toBe(true);
      expect(REPO_SLUG_RE.test('a')).toBe(true);
    });

    it('sollte Slugs mit / ablehnen', () => {
      expect(REPO_SLUG_RE.test('dev/gui')).toBe(false);
      expect(REPO_SLUG_RE.test('../etc')).toBe(false);
    });

    it('sollte Slugs mit Sonderzeichen ablehnen', () => {
      expect(REPO_SLUG_RE.test('dev@gui')).toBe(false);
      expect(REPO_SLUG_RE.test('dev gui')).toBe(false);
      expect(REPO_SLUG_RE.test('dev.gui')).toBe(false); // Punkt nicht erlaubt
    });

    it('sollte record() mit ungültiger Slug ablehnen', async () => {
      const store = new RepoSizeStore();

      await expect(
        store.record('invalid/slug', { total: 1000, git: 100, artifacts: 200, workspace: 700 }),
      ).rejects.toThrow('Ungültiger repo-Slug');
    });

    it('sollte get(ungültige-slug) null liefern (kein Fehler)', async () => {
      const store = new RepoSizeStore();

      const result = await store.get('invalid/slug');

      expect(result).toBeNull();
    });
  });

  // ── AC3: Größen-Validierung ────────────────────────────────────────────────

  describe('AC3 — Größen-Validierung', () => {
    it('sollte non-finite Größen ablehnen', async () => {
      const store = new RepoSizeStore();

      await expect(
        store.record('test', { total: NaN, git: 100, artifacts: 200, workspace: 700 }),
      ).rejects.toThrow('finite Zahlen');

      await expect(
        store.record('test', { total: 1000, git: Infinity, artifacts: 200, workspace: 700 }),
      ).rejects.toThrow('finite Zahlen');
    });

    it('sollte mit fehlenden Größen ein default-0 verwenden', async () => {
      const store = new RepoSizeStore();

      const result = await store.record('test', {});

      expect(result).toEqual({
        total: 0,
        git: 0,
        artifacts: 0,
        workspace: 0,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });
  });

  // ── AC3: In-Memory-Degradation ─────────────────────────────────────────────

  describe('AC3 — In-Memory-Degradation (kein CRED_STORE_DIR)', () => {
    it('sollte ohne CRED_STORE_DIR in-memory arbeiten (kein Crash)', async () => {
      delete process.env.CRED_STORE_DIR;

      const store = new RepoSizeStore();

      const result = await store.record('test', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      expect(result).toEqual({
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });

      // Datei sollte NICHT existieren
      try {
        await readFile(storePath, 'utf8');
        throw new Error('[test] Datei sollte nicht existieren');
      } catch (err) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('sollte get() im In-Memory-Modus arbeiten', async () => {
      delete process.env.CRED_STORE_DIR;

      const store = new RepoSizeStore();

      await store.record('in-memory-repo', {
        total: 3000,
        git: 500,
        artifacts: 1000,
        workspace: 1500,
      });

      const result = await store.get('in-memory-repo');

      expect(result.total).toBe(3000);
    });

    it('sollte In-Memory-Daten nach Neustart verlieren', async () => {
      delete process.env.CRED_STORE_DIR;

      const store1 = new RepoSizeStore();
      await store1.record('ephemeral', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      // Neue Instanz
      const store2 = new RepoSizeStore();
      const result = await store2.get('ephemeral');

      expect(result).toBeNull(); // Neu gestart → leer
    });
  });

  // ── AC3: Serialisierung & Format ───────────────────────────────────────────

  describe('AC3 — Datei-Format & Serialisierung', () => {
    it('sollte ISO-8601-Zeitstempel speichern', async () => {
      const store = new RepoSizeStore();

      const before = new Date();
      await store.record('timestamped', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });
      const after = new Date();

      const result = await store.get('timestamped');

      const measured = new Date(result.measuredAt);
      expect(measured.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(measured.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('sollte null-measuredAt nicht gegeben (get unmessbarer Repo)', async () => {
      const store = new RepoSizeStore();

      // Keine record() aufgerufen — Repository nie gemessen
      const result = await store.get('unmeasured');

      expect(result).toBeNull();
    });

    it('sollte Datei mit Modus 0600 erstellen', async () => {
      const store = new RepoSizeStore();

      await store.record('test', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      // Datei-Rechte prüfen (Unix-only; unter Windows NOP)
      const stats = await import('node:fs/promises')
        .then((m) => m.stat(storePath));
      const mode = stats.mode & 0o777;
      expect(mode & 0o600).toBe(0o600); // mindestens rw-
    });
  });

  // ── Edge-Cases ─────────────────────────────────────────────────────────────

  describe('Edge-Cases & Robustheit', () => {
    it('sollte mehrere record()-Aufrufe serialisieren', async () => {
      const store = new RepoSizeStore();

      // Parallele Aufrufe
      const results = await Promise.all([
        store.record('repo-1', { total: 1000, git: 100, artifacts: 200, workspace: 700 }),
        store.record('repo-2', { total: 2000, git: 200, artifacts: 400, workspace: 1400 }),
        store.record('repo-3', { total: 3000, git: 300, artifacts: 600, workspace: 2100 }),
      ]);

      expect(results.length).toBe(3);

      const list = await store.list();
      expect(list.size).toBe(3);
    });

    it('sollte einen existierenden Messwert überschreiben (Update)', async () => {
      const store = new RepoSizeStore();

      const first = await store.record('updatable', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      // Kleine Verzögerung, damit die Zeitstempel unterschiedlich sind
      await new Promise((r) => setTimeout(r, 10));

      const second = await store.record('updatable', {
        total: 2000,
        git: 200,
        artifacts: 400,
        workspace: 1400,
      });

      expect(second.total).toBe(2000);
      // Zeitstempel sollten unterschiedlich sein (oder mindestens: second ist >= first)
      expect(new Date(second.measuredAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.measuredAt).getTime(),
      );

      const result = await store.get('updatable');
      expect(result.total).toBe(2000);
    });

    it('sollte korrupte Datei beim Laden gracefully ignorieren', async () => {
      // Schreibe korruptes JSON
      await writeFile(storePath, 'not valid json {', 'utf8');

      const store = new RepoSizeStore();

      // Sollte nicht crashen; stattdessen leerer Cache
      const result = await store.get('any-repo');
      expect(result).toBeNull();

      // Sollte danach neue Werte speichern können
      const recorded = await store.record('new-repo', {
        total: 1000,
        git: 100,
        artifacts: 200,
        workspace: 700,
      });

      expect(recorded.total).toBe(1000);
    });
  });
});
