/**
 * BoardWriter.test.js — Unit-/Integrationstests für BoardWriter (S-191).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC8 — Schmale Schreib-Boundary in board/stories/<id>.yaml: setzt
 *          AUSSCHLIESSLICH status (→ Blocked), blocked_reason und updated_at,
 *          atomar (tmp+rename), lässt alle übrigen Felder (inkl. mehrzeiliger
 *          notes, Kommentare, Schlüssel-Reihenfolge) unverändert — inkl. einer
 *          Leerzeile UNMITTELBAR NACH einem gepatchten Feld (gehört zur
 *          Formatierung zwischen Feldern, nicht zum Feld-Segment). Pfad-
 *          Sicherheit: projectSlug/storyId werden nie direkt als Pfad
 *          interpoliert, sondern gegen BOARD_ROOTS realpath-validiert
 *          (Traversal-/Symlink-Schutz); ambige/unbekannte Story → kein
 *          Schreiben; Fehlerfälle (Projekt/Story fehlt) sauber typisiert ohne
 *          Crash. Defense-in-Depth: ein doppelt vorkommender Top-Level-
 *          Schlüssel wird NICHT still doppelt gepatcht, sondern abgelehnt
 *          (`duplicate-key`); JEDER Feldwert (nicht nur blocked_reason) wird
 *          auf der `patchTopLevelFields`-API-Grenze gegen eingebettete
 *          Steuerzeichen/Zeilenumbrüche geprüft (YAML-Line-Injection-Schutz).
 *
 * Strategy:
 *   - `patchTopLevelFields` (reine Funktion, kein IO) wird direkt mit String-
 *     Fixtures getestet — deckt Quoting, Block-Skalare, Schlüssel-Reihenfolge,
 *     fehlende Felder, Leerzeilen-Erhalt, Duplicate-Key-Ablehnung und
 *     Steuerzeichen-Injection-Ablehnung. Eine Fixture ist 1:1 aus einer
 *     echten Story-Datei dieses Repos (`board/stories/S-190-*.yaml`,
 *     `notes: '...'`-Single-Quoted-Flow-Scalar mit eingebetteten Leerzeilen
 *     als Absatz-Trenner) abgeleitet, um das reale Dateiformat zu beweisen.
 *   - `BoardWriter` selbst wird gegen ein echtes tmp-Verzeichnis getestet (real
 *     fs, kein Mock) — die Pfad-Sicherheits-Logik (realpath-Containment,
 *     Symlink-Flucht) ist nur gegen ein echtes Filesystem aussagekräftig
 *     prüfbar (analog der bestehenden Symlink-Lessons in coder.md).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import {
  BoardWriter,
  BoardWriterError,
  patchTopLevelFields,
  ALLOWED_FIELDS,
} from '../src/BoardWriter.js';

// ── patchTopLevelFields (pure, no IO) ─────────────────────────────────────────

describe('AC8 — patchTopLevelFields (pure)', () => {
  const FIXTURE = [
    'id: S-191',
    'parent: F-029',
    "title: 'BoardWriter: schmaler Schreibpfad'",
    'status: To Do',
    'priority: P1',
    'implements:',
    '  - AC8',
    'depends: []',
    'blocked_reason: null',
    "created_at: '2026-06-30T20:09:55Z'",
    "updated_at: '2026-06-30T20:09:55Z'",
    'done_at: null',
    'notes: |',
    '  Erste Zeile der Notes.',
    '',
    '  Zweite Zeile nach Leerzeile (Absatz).',
    '',
  ].join('\n');

  it('ersetzt status/blocked_reason/updated_at und lässt alle anderen Zeilen byte-genau erhalten', () => {
    const out = patchTopLevelFields(FIXTURE, {
      status: 'Blocked',
      blocked_reason: 'Taktgeber: 3x kein Fortschritt',
      updated_at: '2026-06-30T22:00:00Z',
    });

    const lines = out.split('\n');
    expect(lines).toContain('status: Blocked');
    expect(lines).toContain("blocked_reason: 'Taktgeber: 3x kein Fortschritt'");
    expect(lines).toContain("updated_at: '2026-06-30T22:00:00Z'");

    // Unveränderte Felder bit-genau erhalten
    expect(lines).toContain('id: S-191');
    expect(lines).toContain('parent: F-029');
    expect(lines).toContain("title: 'BoardWriter: schmaler Schreibpfad'");
    expect(lines).toContain('priority: P1');
    expect(lines).toContain('  - AC8');
    expect(lines).toContain('depends: []');
    expect(lines).toContain("created_at: '2026-06-30T20:09:55Z'");
    expect(lines).toContain('done_at: null');

    // Mehrzeiliger Block-Skalar (notes) inkl. Leerzeile-Absatz bleibt vollständig erhalten
    expect(out).toContain('notes: |\n  Erste Zeile der Notes.\n\n  Zweite Zeile nach Leerzeile (Absatz).');
  });

  it('erhält Schlüssel-Reihenfolge (keine Felder werden ans Ende verschoben)', () => {
    const out = patchTopLevelFields(FIXTURE, { status: 'Blocked' });
    const keys = out
      .split('\n')
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_-]*:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual([
      'id',
      'parent',
      'title',
      'status',
      'priority',
      'implements',
      'depends',
      'blocked_reason',
      'created_at',
      'updated_at',
      'done_at',
      'notes',
    ]);
  });

  it('erhält Trailing-Newline-Konvention des Originals (mit Newline)', () => {
    const withNl = 'status: To Do\nblocked_reason: null\n';
    const out = patchTopLevelFields(withNl, { status: 'Blocked' });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('erhält Trailing-Newline-Konvention des Originals (ohne Newline)', () => {
    const noNl = 'status: To Do\nblocked_reason: null';
    const out = patchTopLevelFields(noNl, { status: 'Blocked' });
    expect(out.endsWith('\n')).toBe(false);
  });

  it('escaped eingebettete Single-Quotes in blocked_reason (YAML-Standard-Escaping)', () => {
    const out = patchTopLevelFields('status: To Do\nblocked_reason: null\n', {
      blocked_reason: "kann's nicht — Owner's Entscheidung",
    });
    expect(out).toContain("blocked_reason: 'kann''s nicht — Owner''s Entscheidung'");
  });

  it('lehnt nicht-erlaubtes Feld ab (field-not-allowed)', () => {
    expect(() => patchTopLevelFields('status: To Do\n', { title: 'Hack' })).toThrow(BoardWriterError);
    try {
      patchTopLevelFields('status: To Do\n', { title: 'Hack' });
    } catch (err) {
      expect(err.errorClass).toBe('field-not-allowed');
    }
  });

  it('wirft field-not-found wenn der Top-Level-Schlüssel in der Datei fehlt', () => {
    try {
      patchTopLevelFields('id: S-1\ntitle: X\n', { status: 'Blocked' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('field-not-found');
    }
  });

  it('ALLOWED_FIELDS enthält exakt status, blocked_reason, updated_at', () => {
    expect(ALLOWED_FIELDS).toEqual(['status', 'blocked_reason', 'updated_at']);
  });

  it('erhält eine Leerzeile unmittelbar nach dem gepatchten Feld (gehört zur Formatierung, nicht zum Feld-Segment)', () => {
    const withBlankAfterField = 'status: To Do\n\npriority: P1\nblocked_reason: null\n';
    const out = patchTopLevelFields(withBlankAfterField, { status: 'Blocked' });
    expect(out).toBe('status: Blocked\n\npriority: P1\nblocked_reason: null\n');
  });

  it('erhält mehrere Leerzeilen unmittelbar nach dem gepatchten Feld', () => {
    const withMultipleBlanks = 'status: To Do\n\n\npriority: P1\n';
    const out = patchTopLevelFields(withMultipleBlanks, { status: 'Blocked' });
    expect(out).toBe('status: Blocked\n\n\npriority: P1\n');
  });

  it('wirft duplicate-key wenn ein zu patchender Top-Level-Schlüssel mehrfach vorkommt (statt beide Vorkommen still zu ersetzen)', () => {
    const withDuplicateKey = 'status: To Do\nstatus: Also Here\nblocked_reason: null\n';
    try {
      patchTopLevelFields(withDuplicateKey, { status: 'Blocked' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('duplicate-key');
    }
  });

  it('lehnt eingebettete Zeilenumbrüche in JEDEM Feldwert ab (nicht nur blocked_reason) — YAML-Line-Injection-Schutz', () => {
    const fixture = 'status: To Do\nblocked_reason: null\n';
    try {
      patchTopLevelFields(fixture, { status: 'Evil\nblocked_reason: HACKED' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-field-value');
    }
    // Kein injizierter Zweitschlüssel entsteht — die Funktion wirft, statt zu schreiben.
    expect(() => patchTopLevelFields(fixture, { status: 'Evil\nblocked_reason: HACKED' })).toThrow(
      BoardWriterError,
    );
  });

  it('lehnt eingebettete Steuerzeichen in updated_at ab', () => {
    const fixture = "status: To Do\nupdated_at: '2026-01-01T00:00:00Z'\n";
    expect(() =>
      patchTopLevelFields(fixture, { updated_at: '2026-01-01T00:00:00Z\x00evil' }),
    ).toThrow(BoardWriterError);
  });

  it('reale Fixture aus board/stories/S-190-*.yaml: notes als single-quoted Flow-Scalar mit eingebetteten Leerzeilen (Absatz-Trenner) bleibt byte-genau erhalten', async () => {
    const realPath = new URL(
      '../board/stories/S-190-projektweise-locks-busy-erkennung.yaml',
      import.meta.url,
    );
    const REAL_FIXTURE = await readFile(realPath, 'utf8');
    const notesBlock = REAL_FIXTURE.slice(REAL_FIXTURE.indexOf('notes:'));
    expect(notesBlock).toContain('\n\n'); // Beleg: enthält eingebettete Leerzeile(n) als Absatz-Trenner

    const out = patchTopLevelFields(REAL_FIXTURE, {
      status: 'Blocked',
      blocked_reason: 'Taktgeber: 3x kein Fortschritt',
      updated_at: '2026-06-30T22:00:00Z',
    });

    expect(out).toContain('status: Blocked');
    expect(out).toContain("blocked_reason: 'Taktgeber: 3x kein Fortschritt'");
    expect(out).toContain("updated_at: '2026-06-30T22:00:00Z'");
    // notes-Block (inkl. eingebetteter Leerzeilen als Absatz-Trenner im
    // single-quoted Flow-Scalar) bleibt byte-genau erhalten — nicht das
    // gepatchte Feld, daher unverändert durchgereicht.
    expect(out).toContain(notesBlock);
  });
});

// ── BoardWriter (real fs, tmp-Verzeichnis) ────────────────────────────────────

describe('AC8 — BoardWriter.setBlocked (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let storiesDir;

  const STORY_S1 = [
    'id: S-1',
    'parent: F-001',
    "title: 'Beispiel-Story'",
    'status: To Do',
    'priority: P1',
    'depends: []',
    'blocked_reason: null',
    "created_at: '2026-01-01T00:00:00Z'",
    "updated_at: '2026-01-01T00:00:00Z'",
    'notes: |',
    '  Mehrzeilige Notiz.',
    '  Zweite Zeile.',
    '',
  ].join('\n');

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    storiesDir = join(projectDir, 'board', 'stories');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(join(storiesDir, 'S-1-beispiel-story.yaml'), STORY_S1, 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  it('happy path: setzt status=Blocked + blocked_reason + updated_at, lässt Rest unverändert', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.setBlocked({
      projectSlug: 'myproject',
      storyId: 'S-1',
      blockedReason: 'Taktgeber: 3x kein Fortschritt',
      now: '2026-06-30T23:00:00Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('status: Blocked');
    expect(raw).toContain("blocked_reason: 'Taktgeber: 3x kein Fortschritt'");
    expect(raw).toContain("updated_at: '2026-06-30T23:00:00Z'");
    // unveränderte Felder
    expect(raw).toContain('id: S-1');
    expect(raw).toContain("title: 'Beispiel-Story'");
    expect(raw).toContain('priority: P1');
    expect(raw).toContain("created_at: '2026-01-01T00:00:00Z'");
    expect(raw).toContain('notes: |\n  Mehrzeilige Notiz.\n  Zweite Zeile.');
  });

  it('default now: setzt updated_at auf einen plausiblen ISO-Zeitstempel wenn now nicht übergeben wird', async () => {
    const writer = makeWriter();
    const before = Date.now();
    const { filePath } = await writer.setBlocked({
      projectSlug: 'myproject',
      storyId: 'S-1',
      blockedReason: 'Taktgeber: 3x kein Fortschritt',
    });
    const after = Date.now();

    const raw = await readFile(filePath, 'utf8');
    const m = raw.match(/^updated_at: '([^']+)'$/m);
    expect(m).not.toBeNull();
    const ts = Date.parse(m[1]);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  it('atomar: keine .tmp-Datei bleibt nach erfolgreichem Schreiben im Stories-Verzeichnis zurück', async () => {
    const writer = makeWriter();
    await writer.setBlocked({
      projectSlug: 'myproject',
      storyId: 'S-1',
      blockedReason: 'Taktgeber: 3x kein Fortschritt',
      now: '2026-06-30T23:00:00Z',
    });

    const entries = await readdir(storiesDir);
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect(entries).toEqual(['S-1-beispiel-story.yaml']);
  });

  it('restriktive Permissions: finale Datei hat Mode 0600', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.setBlocked({
      projectSlug: 'myproject',
      storyId: 'S-1',
      blockedReason: 'Taktgeber: 3x kein Fortschritt',
      now: '2026-06-30T23:00:00Z',
    });

    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('leerer blockedReason → invalid-value, keine Datei verändert', async () => {
    const writer = makeWriter();
    const before = await readFile(join(storiesDir, 'S-1-beispiel-story.yaml'), 'utf8');

    await expect(
      writer.setBlocked({ projectSlug: 'myproject', storyId: 'S-1', blockedReason: '   ' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-value' });

    const after = await readFile(join(storiesDir, 'S-1-beispiel-story.yaml'), 'utf8');
    expect(after).toBe(before);
  });

  it('blockedReason mit Zeilenumbruch → invalid-value', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({
        projectSlug: 'myproject',
        storyId: 'S-1',
        blockedReason: 'Zeile1\nZeile2',
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid-value' });
  });

  it('unbekannte storyId → story-not-found, kein Crash', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: 'myproject', storyId: 'S-999', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'story-not-found' });
  });

  it('ungültiges storyId-Format (Pfad-Zeichen) → invalid-story-id, kein FS-Zugriff über Konvention hinaus', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: 'myproject', storyId: '../../etc/passwd', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-story-id' });
  });

  it('unbekanntes projectSlug → project-not-found, kein Crash', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: 'does-not-exist', storyId: 'S-1', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'project-not-found' });
  });

  it('Pfad-Traversal im projectSlug ("..") → invalid-slug, keine Auflösung außerhalb BOARD_ROOTS', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: '../../etc', storyId: 'S-1', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-slug' });
  });

  it('projectSlug mit Slash → invalid-slug', async () => {
    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: 'foo/bar', storyId: 'S-1', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-slug' });
  });

  it('Symlink-Flucht: projectSlug zeigt via Symlink aus BOARD_ROOTS heraus → project-not-found (kein Schreiben außerhalb der Schranke)', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'boardwriter-outside-'));
    try {
      const outsideStories = join(outsideDir, 'board', 'stories');
      await mkdir(outsideStories, { recursive: true });
      await writeFile(join(outsideStories, 'S-9-x.yaml'), 'id: S-9\nstatus: To Do\nblocked_reason: null\n', 'utf8');

      const linkPath = join(boardRootsDir, 'evil-link');
      await symlink(outsideDir, linkPath, 'dir');

      const writer = makeWriter();
      await expect(
        writer.setBlocked({ projectSlug: 'evil-link', storyId: 'S-9', blockedReason: 'x' }),
      ).rejects.toMatchObject({ errorClass: 'project-not-found' });

      // Sicherstellen: Datei außerhalb der Schranke wurde NICHT verändert
      const outsideRaw = await readFile(join(outsideStories, 'S-9-x.yaml'), 'utf8');
      expect(outsideRaw).toContain('status: To Do');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('ambige Story-ID (zwei Dateien mit gleichem id:) → ambiguous-story, kein Schreiben', async () => {
    await writeFile(
      join(storiesDir, 'S-1-duplikat.yaml'),
      'id: S-1\nstatus: To Do\nblocked_reason: null\n',
      'utf8',
    );

    const writer = makeWriter();
    await expect(
      writer.setBlocked({ projectSlug: 'myproject', storyId: 'S-1', blockedReason: 'x' }),
    ).rejects.toMatchObject({ errorClass: 'ambiguous-story' });

    const original = await readFile(join(storiesDir, 'S-1-beispiel-story.yaml'), 'utf8');
    expect(original).toContain('status: To Do'); // unverändert, kein Teil-Schreiben
  });

  it('BoardAggregator bleibt read-only: BoardWriter importiert nur die reine parseBoardRoots-Hilfsfunktion, keine BoardAggregator-Instanz', async () => {
    // Statischer Beleg: BoardWriter.js exportiert keine Schreibmethode auf BoardAggregator
    // und instanziiert keine BoardAggregator-Klasse — geprüft per Quelltext-Scan.
    const src = await readFile(new URL('../src/BoardWriter.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/new BoardAggregator/);
    expect(src).toMatch(/import \{ parseBoardRoots \} from '\.\/BoardAggregator\.js'/);
  });
});
