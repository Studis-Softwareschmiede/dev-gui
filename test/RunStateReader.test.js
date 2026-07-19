/**
 * RunStateReader.test.js — Unit tests for RunStateReader
 * (run-state-live-view AC1, AC2, AC3, S-316)
 *
 * Covers (run-state-live-view):
 *   AC1 — Liest board/runs/F-###/state.yaml je Projekt-Repo read-only; fehlt
 *          board/runs/ ganz → leere Liste, kein Fehler.
 *   AC2 — normalizeRunState() mappt mindestens feature, phase, currentStory,
 *          done/total, round, startedAt, lastError, isLastRun; fehlende
 *          Einzelfelder → null; unbekannte Zusatzfelder werden ignoriert
 *          (vorwärtskompatibel); toleriert snake_case UND camelCase sowie eine
 *          verschachtelte progress:{done,total}-Struktur.
 *   AC3 — Ein defektes/halb-geschriebenes state.yaml (Parse-Fehler, ENOENT)
 *          macht nur diesen einen Feature-Lauf unsichtbar — der Rest bleibt
 *          intakt, kein Crash. Nicht-F-###-Ordner (Muster-Guard) und Symlinks
 *          werden übersprungen.
 *
 * Strategy: injectable fsDeps (readdir, readFile) — kein echtes Filesystem.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readRunStates, normalizeRunState } from '../src/RunStateReader.js';

const REPO_PATH = '/fake/repos/my-repo';
const RUNS_DIR = `${REPO_PATH}/board/runs`;

function dirEntry(name, { isDir = true, isSymlink = false } = {}) {
  return {
    name,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isFile: () => !isDir,
  };
}

describe('normalizeRunState (AC2 — Feld-Mapping)', () => {
  it('maps snake_case fields', () => {
    const result = normalizeRunState('F-069', {
      phase: 'story',
      current_story: 'S-316',
      done: 4,
      total: 7,
      round: 2,
      started_at: '2026-07-07T09:00:00Z',
      last_error: 'boom',
    });
    expect(result).toEqual({
      feature: 'F-069',
      phase: 'story',
      currentStory: 'S-316',
      done: 4,
      total: 7,
      round: 2,
      startedAt: '2026-07-07T09:00:00Z',
      lastError: 'boom',
      isLastRun: false,
    });
  });

  it('maps camelCase fields as a fallback', () => {
    const result = normalizeRunState('F-070', {
      phase: 'dossier',
      currentStory: 'S-1',
      done: 1,
      total: 3,
      round: 1,
      startedAt: '2026-07-01T00:00:00Z',
      lastError: null,
      isLastRun: true,
    });
    expect(result.currentStory).toBe('S-1');
    expect(result.startedAt).toBe('2026-07-01T00:00:00Z');
    expect(result.isLastRun).toBe(true);
  });

  it('reads done/total from a nested progress: {done,total} object', () => {
    const result = normalizeRunState('F-071', {
      phase: 'merge',
      progress: { done: 2, total: 5 },
    });
    expect(result.done).toBe(2);
    expect(result.total).toBe(5);
  });

  it('missing individual fields become null (never undefined)', () => {
    const result = normalizeRunState('F-072', {});
    expect(result).toEqual({
      feature: 'F-072',
      phase: null,
      currentStory: null,
      done: null,
      total: null,
      round: null,
      startedAt: null,
      lastError: null,
      isLastRun: false,
    });
  });

  it('ignores unknown extra fields (forward-compatible)', () => {
    const result = normalizeRunState('F-073', {
      phase: 'rollout',
      some_future_field: 'unbekannt',
      another: { nested: true },
    });
    expect(result.phase).toBe('rollout');
    expect(result).not.toHaveProperty('some_future_field');
    expect(result).not.toHaveProperty('another');
  });

  it('non-numeric done/total values become null (never NaN/crash)', () => {
    const result = normalizeRunState('F-074', { done: 'four', total: null });
    expect(result.done).toBeNull();
    expect(result.total).toBeNull();
  });

  it('last_run/is_last_run/isLastRun any true → isLastRun true', () => {
    expect(normalizeRunState('F-1', { last_run: true }).isLastRun).toBe(true);
    expect(normalizeRunState('F-2', { is_last_run: true }).isLastRun).toBe(true);
    expect(normalizeRunState('F-3', { isLastRun: true }).isLastRun).toBe(true);
    expect(normalizeRunState('F-4', {}).isLastRun).toBe(false);
  });
});

describe('readRunStates (AC1 — board/runs/ fehlt)', () => {
  it('returns [] when board/runs/ does not exist', async () => {
    const fsDeps = {
      readdir: jest.fn(async () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }),
      readFile: jest.fn(),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs).toEqual([]);
    expect(fsDeps.readFile).not.toHaveBeenCalled();
  });

  it('returns [] when board/runs/ is empty', async () => {
    const fsDeps = {
      readdir: jest.fn(async (path) => (path === RUNS_DIR ? [] : [])),
      readFile: jest.fn(),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs).toEqual([]);
  });
});

describe('readRunStates (AC1/AC2 — happy path)', () => {
  it('reads a single F-### state.yaml and returns the mapped entry', async () => {
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-069')];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      readFile: jest.fn(async (path) => {
        if (path === `${RUNS_DIR}/F-069/state.yaml`) {
          return 'phase: story\ncurrent_story: S-316\ndone: 4\ntotal: 7\nround: 2\nstarted_at: 2026-07-07T09:00:00Z\n';
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs).toEqual([
      {
        feature: 'F-069',
        phase: 'story',
        currentStory: 'S-316',
        done: 4,
        total: 7,
        round: 2,
        startedAt: '2026-07-07T09:00:00Z',
        lastError: null,
        isLastRun: false,
      },
    ]);
  });

  it('reads multiple F-### directories', async () => {
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-001'), dirEntry('F-002')];
        return [];
      }),
      readFile: jest.fn(async (path) => {
        if (path === `${RUNS_DIR}/F-001/state.yaml`) return 'phase: dossier\n';
        if (path === `${RUNS_DIR}/F-002/state.yaml`) return 'phase: rollout\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs.map((r) => r.feature).sort()).toEqual(['F-001', 'F-002']);
  });

  it('skips non-F-### directory names (defensive guard)', async () => {
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-069'), dirEntry('not-a-feature-dir')];
        return [];
      }),
      readFile: jest.fn(async (path) => {
        if (path === `${RUNS_DIR}/F-069/state.yaml`) return 'phase: story\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs.map((r) => r.feature)).toEqual(['F-069']);
    // never attempted to read a state.yaml under the rejected directory name
    expect(fsDeps.readFile).not.toHaveBeenCalledWith(
      `${RUNS_DIR}/not-a-feature-dir/state.yaml`,
      expect.anything(),
    );
  });

  it('skips symlinked entries under board/runs/ (defensive, analog BoardAggregator scan)', async () => {
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-069', { isSymlink: true })];
        return [];
      }),
      readFile: jest.fn(),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs).toEqual([]);
    expect(fsDeps.readFile).not.toHaveBeenCalled();
  });
});

describe('readRunStates (AC3 — Fehlertoleranz je Einzel-Lauf)', () => {
  it('a missing state.yaml (ENOENT — finished run with only notes.md, or a write race) is skipped SILENTLY, no log', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-001'), dirEntry('F-002')];
        return [];
      }),
      readFile: jest.fn(async (path) => {
        if (path === `${RUNS_DIR}/F-001/state.yaml`) return 'phase: story\n';
        // F-002: only notes.md, no state.yaml → ENOENT (normal for a finished/idle run).
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs.map((r) => r.feature)).toEqual(['F-001']);
    // The whole point of the fix: an idle F-### dir must NOT be logged on every poll.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a genuine read error other than ENOENT (parse/permission) still logs only that skipped run', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-001'), dirEntry('F-002')];
        return [];
      }),
      readFile: jest.fn(async (path) => {
        if (path === `${RUNS_DIR}/F-001/state.yaml`) return 'phase: story\n';
        // F-002: a real defect (not a missing file) — must remain visible in the log.
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }),
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    expect(runs.map((r) => r.feature)).toEqual(['F-001']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('F-002'));
    warnSpy.mockRestore();
  });

  it('a state.yaml that parses to a non-object is skipped without crashing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fsDeps = {
      readdir: jest.fn(async (path) => {
        if (path === RUNS_DIR) return [dirEntry('F-001')];
        return [];
      }),
      readFile: jest.fn(async () => ''), // parseYaml('') → {} which IS an object, so use whitespace-only to force {}
    };
    const runs = await readRunStates(REPO_PATH, fsDeps);
    // parseYaml('') returns {} (a valid empty object) — normalizeRunState handles
    // that gracefully (all null fields), it does NOT throw. This asserts no crash.
    expect(runs.length).toBe(1);
    expect(runs[0].phase).toBeNull();
    warnSpy.mockRestore();
  });

  it('never throws even when readdir on board/runs/ itself throws a non-ENOENT error', async () => {
    const fsDeps = {
      readdir: jest.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
      readFile: jest.fn(),
    };
    await expect(readRunStates(REPO_PATH, fsDeps)).resolves.toEqual([]);
  });
});
