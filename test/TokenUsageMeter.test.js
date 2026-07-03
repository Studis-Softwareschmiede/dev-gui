/**
 * TokenUsageMeter.test.js — Unit-Tests für die proaktive Output-Token-
 * Verbrauchsmessung aus Claude-Session-Transcripts (token-usage-meter AC1–AC6).
 *
 * Covers (token-usage-meter):
 *   AC1 — getUsage({sinceMs}) liest rekursiv *.jsonl unter baseDir, summiert
 *         message.usage.output_tokens über Zeilen mit timestamp ≥ sinceMs,
 *         liefert {outputTokens, filesScanned, entriesCounted}; baseDir
 *         injizierbar (Default-Konstruktor separat, home-confined)
 *   AC2 — sinceMs-Filter: timestamp < sinceMs und nicht-parsebarer Zeitstempel
 *         zählen nicht; sinceMs null/undefined zählt alle Events; nur
 *         output_tokens wird summiert (Input-/Cache-Tokens nie)
 *   AC3 — konto-weit: Aggregation über mehrere Projekt-Unterordner
 *   AC4 — Robustheit: nicht-JSON-Zeile, Zeile ohne usage/output_tokens,
 *         unlesbare Datei, fehlendes Basis-Verzeichnis → nie Crash, 0-Beitrag
 *   AC5 — read-only + größenbegrenzt: zeilenweise Verarbeitung (Streaming
 *         über große Datei geprüft), Rückgabe enthält ausschließlich Zahlen,
 *         kein Symlink-Ausbruch aus baseDir, keine Traversierung oberhalb baseDir
 *   AC6 — Gate: Tests laufen ausschließlich gegen ein temporäres, injiziertes
 *         Basis-Verzeichnis mit synthetischen *.jsonl-Fixtures (kein echtes
 *         ~/.claude); baseDir ist über den Konstruktor injizierbar
 *
 * Strategie:
 *   - Echtes tmpdir (mkdtemp) je Test mit synthetischen *.jsonl-Fixtures
 *     (keine gemockten fs-Primitive nötig — TokenUsageMeter liest read-only,
 *     kein Schreibrisiko gegen das reale FS außerhalb des tmpdir).
 *   - defaultBaseDir() wird separat (ohne echte FS-Operation) auf
 *     ${HOME}/.claude/projects/ geprüft, ohne dagegen zu lesen.
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { TokenUsageMeter, defaultBaseDir } from '../src/TokenUsageMeter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function assistantLine({ timestamp, outputTokens }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      usage:
        outputTokens === undefined
          ? undefined
          : { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: outputTokens },
    },
  });
}

let baseDir;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'token-usage-meter-test-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// ── AC1 — Basis-Scan + Rückgabeform ─────────────────────────────────────────

describe('TokenUsageMeter — AC1 basic scan', () => {
  it('sums output_tokens across all assistant lines in a single project file', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      [
        assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 40 }),
        assistantLine({ timestamp: '2026-07-03T10:05:00.000Z', outputTokens: 60 }),
      ].join('\n') + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 100, filesScanned: 1, entriesCounted: 2 });
  });

  it('default constructor (no baseDir) points at ${HOME}/.claude/projects/', () => {
    const meter = new TokenUsageMeter();
    expect(meter).toBeInstanceOf(TokenUsageMeter);
    expect(defaultBaseDir()).toBe(join(homedir(), '.claude', 'projects'));
  });
});

// ── AC2 — sinceMs-Filter ────────────────────────────────────────────────────

describe('TokenUsageMeter — AC2 sinceMs filtering', () => {
  it('excludes events with timestamp before sinceMs', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      [
        assistantLine({ timestamp: '2026-07-03T09:00:00.000Z', outputTokens: 10 }), // before window
        assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 20 }), // in window
      ].join('\n') + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const sinceMs = Date.parse('2026-07-03T09:30:00.000Z');
    const result = await meter.getUsage({ sinceMs });

    expect(result).toEqual({ outputTokens: 20, filesScanned: 1, entriesCounted: 1 });
  });

  it('counts an event with timestamp exactly equal to sinceMs (>=)', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    const ts = '2026-07-03T10:00:00.000Z';
    await writeFile(join(projectDir, 'session1.jsonl'), assistantLine({ timestamp: ts, outputTokens: 5 }) + '\n');

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: Date.parse(ts) });

    expect(result).toEqual({ outputTokens: 5, filesScanned: 1, entriesCounted: 1 });
  });

  it('excludes events with an unparsable timestamp when sinceMs is set', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      assistantLine({ timestamp: 'not-a-date', outputTokens: 99 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: Date.parse('2026-07-03T00:00:00.000Z') });

    expect(result).toEqual({ outputTokens: 0, filesScanned: 1, entriesCounted: 0 });
  });

  it('counts all events, including unparsable timestamps, when sinceMs is null/undefined', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      [
        assistantLine({ timestamp: 'not-a-date', outputTokens: 7 }),
        assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 3 }),
      ].join('\n') + '\n',
    );

    const meterNull = new TokenUsageMeter({ baseDir });
    expect(await meterNull.getUsage({ sinceMs: null })).toEqual({
      outputTokens: 10,
      filesScanned: 1,
      entriesCounted: 2,
    });

    const meterUndefined = new TokenUsageMeter({ baseDir });
    expect(await meterUndefined.getUsage()).toEqual({ outputTokens: 10, filesScanned: 1, entriesCounted: 2 });
  });

  it('never sums input_tokens/cache_read_input_tokens, only output_tokens', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-03T10:00:00.000Z',
        message: { usage: { input_tokens: 99999, cache_read_input_tokens: 88888, output_tokens: 12 } },
      }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result.outputTokens).toBe(12);
  });
});

// ── AC3 — konto-weite Aggregation ───────────────────────────────────────────

describe('TokenUsageMeter — AC3 account-wide aggregation', () => {
  it('aggregates output_tokens across multiple project subfolders', async () => {
    const projA = join(baseDir, 'proj-a');
    const projB = join(baseDir, 'proj-b');
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    await writeFile(
      join(projA, 'sessA.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 30 }) + '\n',
    );
    await writeFile(
      join(projB, 'sessB.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 70 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 100, filesScanned: 2, entriesCounted: 2 });
  });

  it('aggregates multiple session files within the same project folder', async () => {
    const projA = join(baseDir, 'proj-a');
    await mkdir(projA, { recursive: true });
    await writeFile(
      join(projA, 'session1.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 15 }) + '\n',
    );
    await writeFile(
      join(projA, 'session2.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 25 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 40, filesScanned: 2, entriesCounted: 2 });
  });
});

// ── AC4 — Robustheit ─────────────────────────────────────────────────────────

describe('TokenUsageMeter — AC4 robustness against corrupt/missing data', () => {
  it('skips a non-JSON-parsable line without crashing, contributes 0', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      ['not valid json {{{', assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 5 })].join('\n') +
        '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 5, filesScanned: 1, entriesCounted: 1 });
  });

  it('treats a line without usage/output_tokens as a 0-contribution, no NaN', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      [
        JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T10:00:00.000Z', message: {} }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T10:00:01.000Z' }),
      ].join('\n') + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result.outputTokens).toBe(0);
    expect(Number.isNaN(result.outputTokens)).toBe(false);
    expect(result.entriesCounted).toBe(2);
  });

  it('ignores non-assistant events (e.g. user/system) even if they carry a usage-shaped field', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-07-03T10:00:00.000Z',
          message: { usage: { output_tokens: 500 } },
        }),
        assistantLine({ timestamp: '2026-07-03T10:00:01.000Z', outputTokens: 8 }),
      ].join('\n') + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 8, filesScanned: 1, entriesCounted: 1 });
  });

  it('skips empty lines / whitespace-only lines', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      ['', '   ', assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 9 }), ''].join('\n') + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 9, filesScanned: 1, entriesCounted: 1 });
  });

  it('skips an unreadable file (permission denied) without crashing, still scans siblings', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    const unreadablePath = join(projectDir, 'unreadable.jsonl');
    await writeFile(unreadablePath, assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 999 }));
    await makeUnreadable(unreadablePath);

    await writeFile(
      join(projectDir, 'readable.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 11 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    // unreadable.jsonl skipped entirely (AC4); readable.jsonl still counted.
    expect(result.outputTokens).toBe(11);
    expect(result.filesScanned).toBe(1);
    expect(result.entriesCounted).toBe(1);
  });

  it('returns {outputTokens:0, filesScanned:0, entriesCounted:0} when baseDir does not exist', async () => {
    const meter = new TokenUsageMeter({ baseDir: join(baseDir, 'does-not-exist') });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 0, filesScanned: 0, entriesCounted: 0 });
  });

  it('returns the empty result when baseDir points at a file, not a directory', async () => {
    const filePath = join(baseDir, 'not-a-dir');
    await writeFile(filePath, 'irrelevant');

    const meter = new TokenUsageMeter({ baseDir: filePath });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 0, filesScanned: 0, entriesCounted: 0 });
  });
});

// Helper: platform-portable "make unreadable" via chmod 0 (skip gracefully if
// the test runner has elevated privileges that bypass POSIX permissions, e.g.
// root in CI — in that case the file remains readable and the assertions
// above degrade to "readable.jsonl still counted", which still holds).
async function makeUnreadable(path) {
  const { chmod } = await import('node:fs/promises');
  try {
    await chmod(path, 0o000);
  } catch {
    // ignore — best-effort
  }
}

// ── AC5 — read-only, streaming, no traversal above baseDir ────────────────

describe('TokenUsageMeter — AC5 read-only + size/traversal guards', () => {
  it('streams a large file line-by-line rather than crashing on many entries', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    const lineCount = 5000;
    const lines = [];
    for (let i = 0; i < lineCount; i += 1) {
      lines.push(assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 1 }));
    }
    await writeFile(join(projectDir, 'big.jsonl'), lines.join('\n') + '\n');

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: lineCount, filesScanned: 1, entriesCounted: lineCount });
  });

  it('never writes anything under baseDir (read-only) — fixtures remain byte-identical after getUsage()', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, 'session1.jsonl');
    const content = assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 4 }) + '\n';
    await writeFile(filePath, content);

    const meter = new TokenUsageMeter({ baseDir });
    await meter.getUsage({ sinceMs: null });

    const { readFile } = await import('node:fs/promises');
    const after = await readFile(filePath, 'utf8');
    expect(after).toBe(content);
  });

  it('does not follow a symlinked directory pointing outside baseDir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'token-usage-meter-outside-'));
    try {
      await writeFile(
        join(outsideDir, 'secret.jsonl'),
        assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 12345 }) + '\n',
      );

      const projectDir = join(baseDir, 'proj-a');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session1.jsonl'),
        assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 6 }) + '\n',
      );

      try {
        await symlink(outsideDir, join(baseDir, 'escape-link'), 'dir');
      } catch {
        // symlink creation unsupported in this environment — skip this scenario gracefully
        return;
      }

      const meter = new TokenUsageMeter({ baseDir });
      const result = await meter.getUsage({ sinceMs: null });

      // Only proj-a/session1.jsonl counted — the symlinked outside dir must
      // never be traversed (no 12345 contribution from secret.jsonl).
      expect(result.outputTokens).toBe(6);
      expect(result.filesScanned).toBe(1);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked file pointing outside baseDir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'token-usage-meter-outside-file-'));
    try {
      const outsideFile = join(outsideDir, 'secret.jsonl');
      await writeFile(outsideFile, assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 54321 }) + '\n');

      const projectDir = join(baseDir, 'proj-a');
      await mkdir(projectDir, { recursive: true });

      try {
        await symlink(outsideFile, join(projectDir, 'linked.jsonl'), 'file');
      } catch {
        return;
      }

      const meter = new TokenUsageMeter({ baseDir });
      const result = await meter.getUsage({ sinceMs: null });

      expect(result.outputTokens).toBe(0);
      expect(result.filesScanned).toBe(0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('return shape contains only numbers (no paths/content leakage, AC5 NFR)', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 3 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    for (const value of Object.values(result)) {
      expect(typeof value).toBe('number');
    }
    expect(Object.keys(result).sort()).toEqual(['entriesCounted', 'filesScanned', 'outputTokens']);
  });

  it('ignores non-.jsonl files in the same directory', async () => {
    const projectDir = join(baseDir, 'proj-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'notes.txt'), 'not a transcript');
    await writeFile(
      join(projectDir, 'session1.jsonl'),
      assistantLine({ timestamp: '2026-07-03T10:00:00.000Z', outputTokens: 2 }) + '\n',
    );

    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });

    expect(result).toEqual({ outputTokens: 2, filesScanned: 1, entriesCounted: 1 });
  });
});

// ── AC6 — Gate: alle Tests dieser Datei gegen injiziertes tmpdir ───────────

describe('TokenUsageMeter — AC6 injected baseDir gate', () => {
  it('constructor accepts an injected baseDir distinct from the default', () => {
    const meter = new TokenUsageMeter({ baseDir });
    expect(meter).toBeInstanceOf(TokenUsageMeter);
    expect(baseDir).not.toBe(defaultBaseDir());
  });

  it('empty baseDir directory (no project subfolders yet) yields the zero result without crashing', async () => {
    const meter = new TokenUsageMeter({ baseDir });
    const result = await meter.getUsage({ sinceMs: null });
    expect(result).toEqual({ outputTokens: 0, filesScanned: 0, entriesCounted: 0 });
  });
});
