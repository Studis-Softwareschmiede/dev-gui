/**
 * BoardWriter.test.js — Unit-/Integrationstests für BoardWriter (S-191, erweitert S-199, S-200, S-216, S-236, S-293).
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
 * Covers (ideen-inbox):
 *   AC3 — `createIdea()`: Quick-Capture-Create-Pfad legt `board/stories/S-<n>.yaml`
 *          mit `status: Idee`, `title`, optional `notes` an — OHNE `spec`, OHNE
 *          `implements`. Story-ID wird atomar aus `board/board.yaml`
 *          (`next_story_id`) allokiert + hochgezählt (inkl. paralleler Aufrufe,
 *          In-Process-Mutex). Validierung: leerer/zu langer Titel, Titel/Body mit
 *          Steuerzeichen → `invalid-title`/`invalid-body` (kein Schreiben).
 *   AC7 — Audit ist Router-Verantwortung (`ideasRouter.test.js`), hier nicht
 *          direkt testbar (BoardWriter kennt keinen AuditStore) — Note only.
 *   AC8 — Atomarer Write (tmp+rename, 0600) für Story-Datei UND board.yaml-
 *          Zähler-Update; Pfad-/Slug-Sicherheit (kein Traversal, gleiche
 *          `_resolveProjectPath`-Schranke wie `setBlocked`); kein anderer
 *          Board-Schreibpfad (BoardAggregator bleibt read-only, s.u. Test).
 *
 * Covers (ideen-inbox, S-200 — Resolve-Pfad):
 *   AC6 — `resolveIdea()`: patcht eine bestehende `status: Idee`-Story-Datei auf
 *          `status: Done` + `resolved_at` (+ optional resolved_story_ids/
 *          resolved_note) — Felder existieren in einer frisch angelegten
 *          Idee-Datei NICHT und werden ans Dateiende angehängt (`allowAppend`).
 *          Bereits `Done`/nicht-`Idee` → `not-resolvable` (kein zweites `Done`,
 *          idempotenz-tolerant). `validateResolveInput()`: Story-ID-Format,
 *          Längenlimit resolved_story_ids/resolved_note, Steuerzeichen-Ablehnung.
 *   AC8 — Atomarer Write (tmp+rename); übrige Felder byte-genau erhalten;
 *          `patchTopLevelFields({ allowAppend: true })`-Pfad getrennt von
 *          `setBlocked()`s striktem Default-Verhalten (field-not-found) getestet.
 *
 * Covers (idea-specify-chat, S-216 — Sicherheitsnetz-Archivierung):
 *   AC9 — `archiveSupersededIdea()`: 1:1-Patch-Muster von `resolveIdea()`
 *          (gleicher Guard: nur `status: Idee` archivierbar, sonst
 *          `not-resolvable`), aber mit dem FESTEN `resolved_note:
 *          'superseded-by-specify'` (`SUPERSEDED_BY_SPECIFY_NOTE`) statt
 *          optionaler Nutzer-Eingabe. Atomar (tmp+rename); übrige Felder
 *          byte-genau erhalten; Round-Trip über `BoardAggregator.parseYaml`.
 *
 * Covers (board-feature-archive, S-236 — In-place-Feature-Archiv):
 *   AC1 — `archiveDoneFeatures()` bestimmt die archivierbaren Features exakt nach
 *          V1: ≥1 Story UND alle Stories `Done` UND nicht bereits `archived`.
 *          Features mit ≥1 nicht-Done-Story, Features ohne Stories und verwaiste
 *          Stories (`_orphaned`) werden NICHT archiviert.
 *   AC2 — Setzt `archived: true` (unquoted YAML-Boolean) + `archived_at`
 *          (+ aktualisiertes `updated_at`) in Feature-YAML UND jeder zugehörigen
 *          Story-YAML; Story-`status` bleibt `Done`; übrige Zeilen byte-genau
 *          erhalten; atomar (tmp+rename, keine .tmp-Reste); `board/board.yaml`
 *          unverändert; wiederholter Aufruf idempotent (kein zweites
 *          `archived_at`, Zähler 0/0 im Re-Run); Round-Trip über
 *          `BoardAggregator.parseYaml` (archived === Boolean true).
 *   AC8 — Security/Robustheit: einziger Schreibpfad `BoardWriter`; Pfad-/Slug-
 *          Sicherheit (Traversal `..` → invalid-slug, unbekanntes Projekt →
 *          project-not-found, Symlink-Flucht der Verzeichnis-Schranke);
 *          ungültiger Zeitstempel → invalid-value; best-effort bei einem nicht
 *          patchbaren Feature (duplicate-key) → übrige dennoch archiviert, kein
 *          Crash.
 *
 * Covers (board-feature-archive, S-244 — AC9: Verworfen terminal wie Done):
 *   AC9 — `archiveDoneFeatures()`-Kriterium erweitert (V7): jede Story
 *          `Done` ODER `Verworfen` (terminal) gilt wie zuvor nur `Done`. Ein
 *          Feature mit NUR Verworfen-Stories ODER Done+Verworfen ist
 *          archivierbar; ein Feature mit ≥1 nicht-terminaler Story (z.B.
 *          To Do+Verworfen) bleibt es NICHT. Story-`status` bleibt nach
 *          Archivierung unverändert (`Verworfen` bleibt `Verworfen`);
 *          Idempotenz gilt unverändert (Regressionstest gegen erneutes
 *          Archivieren eines Done+Verworfen-Features).
 *
 * Covers (board-storys-archivieren, S-293 — Story-Ebenen-Archiv, Backend):
 *   AC1 — `archiveDoneStories()` bestimmt die archivierbaren Storys exakt nach
 *          V1: `status` ∈ {Done, Verworfen} UND nicht bereits `archived`;
 *          nicht-terminale und bereits archivierte Storys werden NICHT
 *          angefasst — unabhängig vom Zustand ihres Eltern-Features.
 *   AC2 — Setzt `archived: true` + `archived_at` (+ aktualisiertes `updated_at`)
 *          NUR in der Story-YAML; Story-`status` bleibt unverändert; übrige
 *          Zeilen byte-genau erhalten; atomar (tmp+rename, 0600, keine
 *          .tmp-Reste); Feature-YAMLs UND `board/board.yaml` UNVERÄNDERT;
 *          wiederholter Aufruf idempotent (kein zweites `archived_at`);
 *          Round-Trip über `BoardAggregator.parseYaml`.
 *   AC9 — Security/Robustheit: einziger Schreibpfad `BoardWriter`; Pfad-/Slug-
 *          Sicherheit (Traversal `..` → invalid-slug, unbekanntes Projekt →
 *          project-not-found); ungültiger Zeitstempel → invalid-value; best-
 *          effort bei einer nicht patchbaren Story (duplicate-key) → übrige
 *          dennoch archiviert, kein Crash.
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
  IDEA_TITLE_MAX_LENGTH,
  IDEA_BODY_MAX_LENGTH,
  validateResolveInput,
  RESOLVED_NOTE_MAX_LENGTH,
  RESOLVE_STORY_IDS_MAX_COUNT,
  SUPERSEDED_BY_SPECIFY_NOTE,
  sanitizeAreaId,
} from '../src/BoardWriter.js';
import { parseYaml } from '../src/BoardAggregator.js';

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

  it('ALLOWED_FIELDS enthält exakt status, blocked_reason, updated_at, resolved_at, resolved_story_ids, resolved_note, archived, archived_at (ideen-inbox AC6/AC8, S-200; board-feature-archive AC2, S-236)', () => {
    expect(ALLOWED_FIELDS).toEqual([
      'status',
      'blocked_reason',
      'updated_at',
      'resolved_at',
      'resolved_story_ids',
      'resolved_note',
      'archived',
      'archived_at',
      'area',
    ]);
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

// ── BoardWriter.createIdea (real fs, tmp-Verzeichnis) — ideen-inbox AC3/AC8 ──

describe('ideen-inbox AC3/AC8 — BoardWriter.createIdea (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let storiesDir;
  let boardYamlPath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-idea-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      boardYamlPath,
      'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 1\nnext_story_id: 42\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  it('happy path (nur Titel): legt S-42.yaml mit status Idee an, zählt next_story_id hoch, KEIN spec/implements', async () => {
    const writer = makeWriter();
    const { storyId, filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Eine schnelle Idee',
      now: '2026-07-01T10:00:00.000Z',
    });

    expect(storyId).toBe('S-42');
    expect(filePath.endsWith(join('myproject', 'board', 'stories', 'S-42.yaml'))).toBe(true);

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('id: S-42');
    expect(raw).toContain('status: Idee');
    expect(raw).toContain("title: 'Eine schnelle Idee'");
    expect(raw).toContain("created_at: '2026-07-01T10:00:00.000Z'");
    expect(raw).toContain("updated_at: '2026-07-01T10:00:00.000Z'");
    expect(raw).not.toMatch(/^spec:/m);
    expect(raw).not.toMatch(/^implements:/m);
    expect(raw).not.toMatch(/^notes:/m); // kein Body → kein notes-Key

    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 43');
    expect(boardRaw).toContain('schema_version: 1'); // übrige Felder erhalten
    expect(boardRaw).toContain('project_slug: myproject');
  });

  it('mit Body: schreibt notes als mehrzeiligen Literal-Block-Skalar', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee mit Stichworten',
      body: 'Erste Zeile\nZweite Zeile\n\nAbsatz nach Leerzeile',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('notes: |\n  Erste Zeile\n  Zweite Zeile\n\n  Absatz nach Leerzeile');
  });

  it('whitespace-only Body wird wie "kein Body" behandelt (kein notes-Key)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee ohne echten Body',
      body: '   \n  \n',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toMatch(/^notes:/m);
  });

  it('escaped eingebettete Single-Quotes im Titel (YAML-Standard-Escaping)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: "Owner's Idee — kann's losgehen",
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain("title: 'Owner''s Idee — kann''s losgehen'");
  });

  it('zwei aufeinanderfolgende Anlagen erhalten fortlaufende, unterschiedliche IDs', async () => {
    const writer = makeWriter();
    const first = await writer.createIdea({ projectSlug: 'myproject', title: 'Erste Idee' });
    const second = await writer.createIdea({ projectSlug: 'myproject', title: 'Zweite Idee' });

    expect(first.storyId).toBe('S-42');
    expect(second.storyId).toBe('S-43');

    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 44');
  });

  it('parallele Anlagen (Promise.all) erhalten JEDE eine eindeutige ID — kein Race auf next_story_id', async () => {
    const writer = makeWriter();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writer.createIdea({ projectSlug: 'myproject', title: `Idee ${i}` })),
    );

    const ids = results.map((r) => r.storyId);
    expect(new Set(ids).size).toBe(8); // alle eindeutig
    expect(ids.sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `S-${42 + i}`).sort(),
    );

    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 50');

    // Jede Datei existiert genau einmal, keine .tmp-Reste
    const entries = await readdir(storiesDir);
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect(entries.sort()).toEqual(ids.map((id) => `${id}.yaml`).sort());
  });

  it('atomar: keine .tmp-Datei bleibt in stories/ oder board/ zurück nach erfolgreichem Schreiben', async () => {
    const writer = makeWriter();
    await writer.createIdea({ projectSlug: 'myproject', title: 'Idee' });

    const storyEntries = await readdir(storiesDir);
    expect(storyEntries.filter((n) => n.includes('.tmp.'))).toEqual([]);

    const boardEntries = await readdir(boardDir);
    expect(boardEntries.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('restriktive Permissions: neue Story-Datei hat Mode 0600', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({ projectSlug: 'myproject', title: 'Idee' });
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('leerer/whitespace-only Titel → invalid-title, kein Schreiben, next_story_id unverändert', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: '   ' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-title' });

    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 42'); // unverändert
    const storyEntries = await readdir(storiesDir);
    expect(storyEntries).toEqual([]);
  });

  it('Titel über Längenlimit → invalid-title', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: 'x'.repeat(IDEA_TITLE_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({ errorClass: 'invalid-title' });
  });

  it('Titel mit eingebettetem Zeilenumbruch → invalid-title', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: 'Zeile1\nZeile2' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-title' });
  });

  it('Body über Längenlimit → invalid-body', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({
        projectSlug: 'myproject',
        title: 'Idee',
        body: 'x'.repeat(IDEA_BODY_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid-body' });
  });

  it('Body mit eingebettetem Steuerzeichen (nicht \\n) → invalid-body', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: 'Idee', body: 'Zeile1\x00Zeile2' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-body' });
  });

  it('unbekanntes projectSlug → project-not-found, kein Crash', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'does-not-exist', title: 'Idee' }),
    ).rejects.toMatchObject({ errorClass: 'project-not-found' });
  });

  it('Pfad-Traversal im projectSlug ("..") → invalid-slug, keine Auflösung außerhalb BOARD_ROOTS', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: '../../etc', title: 'Idee' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-slug' });
  });

  it('Symlink-Flucht: projectSlug zeigt via Symlink aus BOARD_ROOTS heraus → project-not-found', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'boardwriter-idea-outside-'));
    try {
      const outsideStories = join(outsideDir, 'board', 'stories');
      await mkdir(outsideStories, { recursive: true });
      await writeFile(
        join(outsideDir, 'board', 'board.yaml'),
        'schema_version: 1\nproject_slug: outside\nnext_feature_id: 1\nnext_story_id: 1\n',
        'utf8',
      );

      const linkPath = join(boardRootsDir, 'evil-link');
      await symlink(outsideDir, linkPath, 'dir');

      const writer = makeWriter();
      await expect(
        writer.createIdea({ projectSlug: 'evil-link', title: 'Idee' }),
      ).rejects.toMatchObject({ errorClass: 'project-not-found' });

      const outsideEntries = await readdir(outsideStories);
      expect(outsideEntries).toEqual([]); // nichts wurde außerhalb der Schranke geschrieben
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('fehlendes/ungültiges next_story_id in board.yaml → invalid-board-yaml, kein Schreiben', async () => {
    await writeFile(boardYamlPath, 'schema_version: 1\nproject_slug: myproject\n', 'utf8');
    const writer = makeWriter();
    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: 'Idee' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-board-yaml' });

    const storyEntries = await readdir(storiesDir);
    expect(storyEntries).toEqual([]);
  });

  it('Kollisions-Guard (S-199 Iteration 2 — Retry statt stillem Überschreiben): eine vorab von "fremder Hand" ' +
    'angelegte S-42.yaml (z.B. das parallele board-CLI) führt NICHT zu einem Fehler und überschreibt sie NICHT ' +
    '— stattdessen wird next_story_id neu gelesen und mit S-43 erneut versucht', async () => {
    await writeFile(join(storiesDir, 'S-42.yaml'), 'id: S-42\nstatus: To Do\ntitle: Fremde Story\n', 'utf8');
    const writer = makeWriter();

    const { storyId, filePath } = await writer.createIdea({ projectSlug: 'myproject', title: 'Meine Idee' });

    expect(storyId).toBe('S-43'); // S-42 war belegt — nächste freie ID
    expect(filePath.endsWith('S-43.yaml')).toBe(true);

    // Die fremde S-42.yaml wurde NICHT angerührt/überschrieben.
    const foreignRaw = await readFile(join(storiesDir, 'S-42.yaml'), 'utf8');
    expect(foreignRaw).toBe('id: S-42\nstatus: To Do\ntitle: Fremde Story\n');

    // Die eigene Idee wurde tatsächlich geschrieben, nicht verloren.
    const ownRaw = await readFile(filePath, 'utf8');
    expect(ownRaw).toContain("title: 'Meine Idee'");

    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 44'); // zweimal hochgezählt (42 verbraucht per Kollision, 43 erfolgreich)
  });

  it('Kollisions-Guard: bricht nach MAX_ID_ALLOCATION_RETRIES Versuchen mit id-allocation-exhausted ab, ' +
    'statt endlos zu retryen, wenn JEDE ID kollidiert', async () => {
    // Simuliert eine pathologische Dauer-Kollision: jeder exklusive Create schlägt fehl.
    const writer = new BoardWriter({
      boardRootsEnv: boardRootsDir,
      fsDeps: {
        link: async () => {
          const err = new Error('EEXIST: file already exists');
          err.code = 'EEXIST';
          throw err;
        },
      },
    });

    await expect(
      writer.createIdea({ projectSlug: 'myproject', title: 'Idee' }),
    ).rejects.toMatchObject({ errorClass: 'id-allocation-exhausted' });

    // Kein .tmp-Rest im Stories-Verzeichnis (Cleanup nach jedem gescheiterten Versuch).
    const entries = await readdir(storiesDir);
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('Cross-Prozess-Race (S-199 Iteration 2): ZWEI unabhängige BoardWriter-Instanzen (simuliert zwei ' +
    'Prozesse — z.B. dev-gui-Server + externes board-CLI) lesen denselben next_story_id-Wert NAHEZU ' +
    'gleichzeitig — keine der beiden Ideen geht verloren, keine doppelt vergebene ID, keine still ' +
    'überschriebene Story-Datei', async () => {
    // Künstliche Verzögerung NUR beim Lesen von board.yaml erzwingt echtes
    // Interleaving zwischen den zwei unabhängigen Instanzen (jede mit eigenem
    // In-Process-Mutex — der Mutex schützt hier NICHTS, weil es zwei separate
    // BoardWriter-Objekte sind, genau wie Server-Prozess + CLI-Prozess).
    function delayedReadFsDeps() {
      return {
        readFile: async (p, enc) => {
          const raw = await readFile(p, enc);
          if (p === boardYamlPath) {
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          return raw;
        },
      };
    }

    const writerA = new BoardWriter({ boardRootsEnv: boardRootsDir, fsDeps: delayedReadFsDeps() });
    const writerB = new BoardWriter({ boardRootsEnv: boardRootsDir, fsDeps: delayedReadFsDeps() });

    const [resultA, resultB] = await Promise.all([
      writerA.createIdea({ projectSlug: 'myproject', title: 'Idee von Prozess A' }),
      writerB.createIdea({ projectSlug: 'myproject', title: 'Idee von Prozess B' }),
    ]);

    // Keine doppelt vergebene ID.
    expect(resultA.storyId).not.toBe(resultB.storyId);
    expect(resultA.filePath).not.toBe(resultB.filePath);

    // BEIDE Ideen sind tatsächlich vorhanden — keine wurde still überschrieben.
    const rawA = await readFile(resultA.filePath, 'utf8');
    const rawB = await readFile(resultB.filePath, 'utf8');
    expect(rawA).toContain("title: 'Idee von Prozess A'");
    expect(rawB).toContain("title: 'Idee von Prozess B'");

    const entries = await readdir(storiesDir);
    expect(entries.sort()).toEqual([resultA.filePath, resultB.filePath].map((fp) => fp.split('/').pop()).sort());
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('default now: setzt created_at/updated_at auf einen plausiblen ISO-Zeitstempel wenn now nicht übergeben wird', async () => {
    const writer = makeWriter();
    const before = Date.now();
    const { filePath } = await writer.createIdea({ projectSlug: 'myproject', title: 'Idee' });
    const after = Date.now();

    const raw = await readFile(filePath, 'utf8');
    const m = raw.match(/^created_at: '([^']+)'$/m);
    expect(m).not.toBeNull();
    const ts = Date.parse(m[1]);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  it('Apostroph-Round-Trip (S-199 Iteration 2): Titel mit eingebettetem Apostroph wird beim Lesen über ' +
    'BoardAggregator.parseYaml korrekt zurück-unescaped (nicht als doppelter Apostroph)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: "Nutzer's Idee",
      now: '2026-07-01T10:00:00.000Z',
    });
    const raw = await readFile(filePath, 'utf8');
    // Geschrieben mit korrektem YAML-Standard-Escaping (verdoppelt).
    expect(raw).toContain("title: 'Nutzer''s Idee'");
    // Aber über den TATSÄCHLICHEN Read-Parser zurückgelesen: unescaped.
    const parsed = parseYaml(raw);
    expect(parsed.title).toBe("Nutzer's Idee");
  });

  // ── story-idee-bereich-zuordnung AC4: Bereichs-Zuordnung im Create-Pfad ──

  it('AC4 (story-idee-bereich-zuordnung): mit area → neue Story-YAML enthält area: <id> (unquoted)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee im Backend-Bereich',
      area: 'backend',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('area: backend');
    // Bereich muss sich VOR created_at befinden (nach notes falls vorhanden).
    expect(raw.indexOf('area: backend')).toBeLessThan(raw.indexOf('created_at'));
  });

  it('AC4 (story-idee-bereich-zuordnung): ohne area → neue Story-YAML hat KEIN area-Feld (Alt-Verhalten)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee ohne Bereich',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('area:');
  });

  it('AC4 (story-idee-bereich-zuordnung): mit area=null → wie ohne area (kein area-Feld)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee mit explizit null area',
      area: null,
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('area:');
  });

  it('AC4 (story-idee-bereich-zuordnung): mit area und notes → area nach notes, vor created_at', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee mit Bereich und Body',
      body: 'Erste Zeile\nZweite Zeile',
      area: 'frontend-team',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('notes: |');
    expect(raw).toContain('area: frontend-team');
    expect(raw).toContain('created_at:');

    // Reihenfolge: notes → area → created_at
    expect(raw.indexOf('notes: |')).toBeLessThan(raw.indexOf('area: frontend-team'));
    expect(raw.indexOf('area: frontend-team')).toBeLessThan(raw.indexOf('created_at'));
  });

  it('AC4 (story-idee-bereich-zuordnung): ungültiges area-Format → invalid-area, kein Schreiben', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({
        projectSlug: 'myproject',
        title: 'Idee mit ungültigem Bereich',
        area: 'backend/frontend',  // Slash nicht erlaubt
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid-area' });

    const entries = await readdir(storiesDir);
    expect(entries).toEqual([]);
    const boardRaw = await readFile(boardYamlPath, 'utf8');
    expect(boardRaw).toContain('next_story_id: 42'); // unverändert
  });

  it('AC4 (story-idee-bereich-zuordnung): area mit Steuerzeichen → invalid-area', async () => {
    const writer = makeWriter();
    await expect(
      writer.createIdea({
        projectSlug: 'myproject',
        title: 'Idee',
        area: 'backend\nfrontend',  // Zeilenumbruch
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid-area' });
  });

  it('AC4 (story-idee-bereich-zuordnung): area wird über parseYaml korrekt gelesen (Round-Trip)', async () => {
    const writer = makeWriter();
    const { filePath } = await writer.createIdea({
      projectSlug: 'myproject',
      title: 'Idee mit Bereich',
      area: 'security-team',
      now: '2026-07-01T10:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed.area).toBe('security-team');
  });
});

// ── validateResolveInput (pure, no IO) — ideen-inbox AC6/AC8, S-200 ───────────

describe('ideen-inbox AC6/AC8 — validateResolveInput (pure)', () => {
  it('leerer Aufruf (kein Payload): resolvedStoryIds=[] , resolvedNote=null', () => {
    expect(validateResolveInput()).toEqual({ resolvedStoryIds: [], resolvedNote: null });
    expect(validateResolveInput({})).toEqual({ resolvedStoryIds: [], resolvedNote: null });
  });

  it('gültige resolved_story_ids + resolved_note werden getrimmt durchgereicht', () => {
    const result = validateResolveInput({
      resolvedStoryIds: [' S-201 ', 'S-202'],
      resolvedNote: '  siehe docs/specs/foo.md  ',
    });
    expect(result.resolvedStoryIds).toEqual(['S-201', 'S-202']);
    expect(result.resolvedNote).toBe('siehe docs/specs/foo.md');
  });

  it('resolvedStoryIds kein Array → invalid-story-ids', () => {
    expect(() => validateResolveInput({ resolvedStoryIds: 'S-201' })).toThrow(BoardWriterError);
    try {
      validateResolveInput({ resolvedStoryIds: 'S-201' });
    } catch (err) {
      expect(err.errorClass).toBe('invalid-story-ids');
    }
  });

  it('ungültiges Story-ID-Format in resolvedStoryIds → invalid-story-ids', () => {
    try {
      validateResolveInput({ resolvedStoryIds: ['S-201', 'not a valid id!'] });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-story-ids');
    }
  });

  it('resolvedStoryIds über Längenlimit (RESOLVE_STORY_IDS_MAX_COUNT) → invalid-story-ids', () => {
    const tooMany = Array.from({ length: RESOLVE_STORY_IDS_MAX_COUNT + 1 }, (_, i) => `S-${i}`);
    try {
      validateResolveInput({ resolvedStoryIds: tooMany });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('invalid-story-ids');
    }
  });

  it('resolvedNote mit Steuerzeichen → invalid-note', () => {
    try {
      validateResolveInput({ resolvedNote: 'Zeile1\nZeile2' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-note');
    }
  });

  it('resolvedNote über Längenlimit (RESOLVED_NOTE_MAX_LENGTH) → invalid-note', () => {
    try {
      validateResolveInput({ resolvedNote: 'x'.repeat(RESOLVED_NOTE_MAX_LENGTH + 1) });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('invalid-note');
    }
  });

  it('whitespace-only resolvedNote wird zu null normalisiert (wie "kein Note")', () => {
    const result = validateResolveInput({ resolvedNote: '   ' });
    expect(result.resolvedNote).toBeNull();
  });
});

// ── BoardWriter.resolveIdea (real fs) — ideen-inbox AC6/AC8, S-200 ────────────

describe('ideen-inbox AC6/AC8 — BoardWriter.resolveIdea (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let storiesDir;
  let boardYamlPath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-resolve-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      boardYamlPath,
      'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 1\nnext_story_id: 42\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  /** Legt eine minimale Idee-Story-Datei an (Format wie createIdea() sie schreibt). */
  async function writeIdeaFixture(id = 'S-42') {
    const filePath = join(storiesDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        'status: Idee',
        "title: 'Eine Idee'",
        "created_at: '2026-07-01T10:00:00.000Z'",
        "updated_at: '2026-07-01T10:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  it('happy path (mit resolved_story_ids + resolved_note): setzt status Done, hängt resolved_at/resolved_story_ids/resolved_note an', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();

    const result = await writer.resolveIdea({
      projectSlug: 'myproject',
      storyId: 'S-42',
      resolvedStoryIds: ['S-201', 'S-202'],
      resolvedNote: 'docs/specs/foo.md',
      now: '2026-07-01T12:00:00.000Z',
    });

    expect(result.filePath.endsWith(join('myproject', 'board', 'stories', 'S-42.yaml'))).toBe(true);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('status: Done');
    expect(raw).toContain("updated_at: '2026-07-01T12:00:00.000Z'");
    expect(raw).toContain("resolved_at: '2026-07-01T12:00:00.000Z'");
    expect(raw).toContain('resolved_story_ids: [S-201, S-202]');
    expect(raw).toContain("resolved_note: 'docs/specs/foo.md'");
    // Unverändertes Feld bleibt byte-genau erhalten
    expect(raw).toContain("title: 'Eine Idee'");
    expect(raw).toContain("created_at: '2026-07-01T10:00:00.000Z'");
  });

  it('ohne resolved_story_ids/resolved_note: setzt nur status/updated_at/resolved_at, KEINE leeren Felder', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();

    const { filePath } = await writer.resolveIdea({
      projectSlug: 'myproject',
      storyId: 'S-42',
      now: '2026-07-01T12:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('status: Done');
    expect(raw).toContain("resolved_at: '2026-07-01T12:00:00.000Z'");
    expect(raw).not.toMatch(/^resolved_story_ids:/m);
    expect(raw).not.toMatch(/^resolved_note:/m);
  });

  it('bereits Done/aufgelöst → not-resolvable (kein zweites Done, idempotenz-tolerant)', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();

    await writer.resolveIdea({ projectSlug: 'myproject', storyId: 'S-42', now: '2026-07-01T12:00:00.000Z' });

    try {
      await writer.resolveIdea({ projectSlug: 'myproject', storyId: 'S-42', now: '2026-07-01T13:00:00.000Z' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('not-resolvable');
    }

    // Datei unverändert seit dem ERSTEN (erfolgreichen) Resolve — kein zweiter Write.
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain("resolved_at: '2026-07-01T12:00:00.000Z'");
  });

  it('Story mit status ≠ Idee (z.B. To Do) → not-resolvable, Datei unverändert', async () => {
    const filePath = join(storiesDir, 'S-50.yaml');
    await writeFile(filePath, 'id: S-50\nstatus: To Do\ntitle: \'Normale Story\'\n', 'utf8');
    const writer = makeWriter();

    try {
      await writer.resolveIdea({ projectSlug: 'myproject', storyId: 'S-50' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('not-resolvable');
    }

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toBe('id: S-50\nstatus: To Do\ntitle: \'Normale Story\'\n');
  });

  it('unbekannte Story-ID → story-not-found', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    try {
      await writer.resolveIdea({ projectSlug: 'myproject', storyId: 'S-999' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('story-not-found');
    }
  });

  it('unbekanntes Projekt → project-not-found', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    try {
      await writer.resolveIdea({ projectSlug: 'does-not-exist', storyId: 'S-42' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('project-not-found');
    }
  });

  it('atomar: keine .tmp-Datei bleibt nach erfolgreichem Resolve zurück', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    await writer.resolveIdea({ projectSlug: 'myproject', storyId: 'S-42' });

    const entries = await readdir(storiesDir);
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect(entries).toEqual(['S-42.yaml']);
  });

  it('Round-Trip über BoardAggregator.parseYaml: resolved_story_ids/resolved_note korrekt lesbar', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();
    await writer.resolveIdea({
      projectSlug: 'myproject',
      storyId: 'S-42',
      resolvedStoryIds: ['S-201'],
      resolvedNote: 'docs/specs/foo.md',
      now: '2026-07-01T12:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed.status).toBe('Done');
    expect(parsed.resolved_story_ids).toEqual(['S-201']);
    expect(parsed.resolved_note).toBe('docs/specs/foo.md');
    expect(parsed.resolved_at).toBe('2026-07-01T12:00:00.000Z');
  });
});

// ── BoardWriter.archiveSupersededIdea (real fs) — idea-specify-chat AC9, S-216 ──

describe('idea-specify-chat AC9 — BoardWriter.archiveSupersededIdea (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let storiesDir;
  let boardYamlPath;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-archive-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      boardYamlPath,
      'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 1\nnext_story_id: 901\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  /** Legt eine minimale Idee-Story-Datei an (Format wie createIdea() sie schreibt). */
  async function writeIdeaFixture(id = 'S-900') {
    const filePath = join(storiesDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        'status: Idee',
        "title: 'Dark mode'",
        "created_at: '2026-07-01T10:00:00.000Z'",
        "updated_at: '2026-07-01T10:00:00.000Z'",
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  it('happy path: setzt status Done + resolved_at + FESTEN resolved_note (superseded-by-specify)', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();

    const result = await writer.archiveSupersededIdea({
      projectSlug: 'myproject',
      storyId: 'S-900',
      now: '2026-07-01T12:00:00.000Z',
    });

    expect(result.filePath.endsWith(join('myproject', 'board', 'stories', 'S-900.yaml'))).toBe(true);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('status: Done');
    expect(raw).toContain("updated_at: '2026-07-01T12:00:00.000Z'");
    expect(raw).toContain("resolved_at: '2026-07-01T12:00:00.000Z'");
    expect(raw).toContain(`resolved_note: '${SUPERSEDED_BY_SPECIFY_NOTE}'`);
    expect(SUPERSEDED_BY_SPECIFY_NOTE).toBe('superseded-by-specify');
    // Unverändertes Feld bleibt byte-genau erhalten
    expect(raw).toContain("title: 'Dark mode'");
    expect(raw).toContain("created_at: '2026-07-01T10:00:00.000Z'");
  });

  it('bereits Done/übernommen (Agent hat die Idee selbst aufgelöst) → not-resolvable, kein zweiter Write', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();

    await writer.archiveSupersededIdea({ projectSlug: 'myproject', storyId: 'S-900', now: '2026-07-01T12:00:00.000Z' });

    try {
      await writer.archiveSupersededIdea({ projectSlug: 'myproject', storyId: 'S-900', now: '2026-07-01T13:00:00.000Z' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('not-resolvable');
    }

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain("resolved_at: '2026-07-01T12:00:00.000Z'");
  });

  it('Story mit status ≠ Idee (Agent hat die Platzhalter-Idee bereits als eigene Story übernommen) → not-resolvable, Datei unverändert', async () => {
    const filePath = join(storiesDir, 'S-901.yaml');
    await writeFile(filePath, 'id: S-901\nstatus: To Do\ntitle: \'Uebernommene Story\'\n', 'utf8');
    const writer = makeWriter();

    try {
      await writer.archiveSupersededIdea({ projectSlug: 'myproject', storyId: 'S-901' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('not-resolvable');
    }

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toBe('id: S-901\nstatus: To Do\ntitle: \'Uebernommene Story\'\n');
  });

  it('unbekannte Story-ID → story-not-found', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    try {
      await writer.archiveSupersededIdea({ projectSlug: 'myproject', storyId: 'S-999' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('story-not-found');
    }
  });

  it('unbekanntes Projekt → project-not-found', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    try {
      await writer.archiveSupersededIdea({ projectSlug: 'does-not-exist', storyId: 'S-900' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('project-not-found');
    }
  });

  it('atomar: keine .tmp-Datei bleibt nach erfolgreicher Archivierung zurück', async () => {
    await writeIdeaFixture();
    const writer = makeWriter();
    await writer.archiveSupersededIdea({ projectSlug: 'myproject', storyId: 'S-900' });

    const entries = await readdir(storiesDir);
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect(entries).toEqual(['S-900.yaml']);
  });

  it('Round-Trip über BoardAggregator.parseYaml: status/resolved_note/resolved_at korrekt lesbar', async () => {
    const filePath = await writeIdeaFixture();
    const writer = makeWriter();
    await writer.archiveSupersededIdea({
      projectSlug: 'myproject',
      storyId: 'S-900',
      now: '2026-07-01T12:00:00.000Z',
    });

    const raw = await readFile(filePath, 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed.status).toBe('Done');
    expect(parsed.resolved_note).toBe(SUPERSEDED_BY_SPECIFY_NOTE);
    expect(parsed.resolved_at).toBe('2026-07-01T12:00:00.000Z');
  });
});

// ── board-feature-archive AC1/AC2/AC8 — archiveDoneFeatures (real fs) ──────────

describe('board-feature-archive AC1/AC2/AC8 — BoardWriter.archiveDoneFeatures (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let featuresDir;
  let storiesDir;
  let boardYamlPath;

  const BOARD_YAML =
    'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 9\nnext_story_id: 99\n';

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-featarchive-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(boardYamlPath, BOARD_YAML, 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  /**
   * Legt ein Feature-YAML an. Extra-Zeilen (z.B. ein bereits vorhandenes
   * `archived: true` oder ein Duplicate-Key) werden als roher Zeilen-Array
   * `extraLines` durchgereicht.
   */
  async function writeFeature(id, { status = 'Done', extraLines = [] } = {}) {
    const filePath = join(featuresDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        `title: 'Feature ${id}'`,
        `status: ${status}`,
        'priority: P1',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  async function writeStory(id, { parent, status = 'Done', extraLines = [] } = {}) {
    const filePath = join(storiesDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        ...(parent != null ? [`parent: ${parent}`] : []),
        `title: 'Story ${id}'`,
        `status: ${status}`,
        'priority: P2',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  const NOW = '2026-07-01T12:00:00.000Z';

  // ── AC1 — Archivierbarkeits-Kriterium ──────────────────────────────────────

  it('AC1: Feature mit ≥1 Story, alle Done, nicht archiviert → wird archiviert', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1' });
    await writeStory('S-2', { parent: 'F-1' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(1);
    expect(res.archivedStoryCount).toBe(2);
    expect(res.archivedFeatureIds).toEqual(['F-1']);
  });

  it('AC1: Feature mit ≥1 nicht-Done-Story → NICHT archiviert', async () => {
    const fPath = await writeFeature('F-1');
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    const s2 = await writeStory('S-2', { parent: 'F-1', status: 'In Progress' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(res.archivedStoryCount).toBe(0);
    // Keine Datei angefasst.
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
    expect(await readFile(s1, 'utf8')).not.toContain('archived:');
    expect(await readFile(s2, 'utf8')).not.toContain('archived:');
  });

  it('AC1: Feature OHNE Stories → NICHT archiviert', async () => {
    const fPath = await writeFeature('F-1');

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
  });

  it('AC1: verwaiste Story (parent zeigt auf nicht existierendes Feature) → NICHT archiviert', async () => {
    const s1 = await writeStory('S-1', { parent: 'F-999', status: 'Done' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(res.archivedStoryCount).toBe(0);
    expect(await readFile(s1, 'utf8')).not.toContain('archived:');
  });

  it('AC1: bereits archiviertes Feature → übersprungen (0/0)', async () => {
    await writeFeature('F-1', { extraLines: ['archived: true', `archived_at: '${NOW}'`] });
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(res.archivedStoryCount).toBe(0);
    expect(res.archivedFeatureIds).toEqual([]);
  });

  it('AC1: mehrere Features gleichzeitig — nur die vollständig erledigten werden gezählt', async () => {
    await writeFeature('F-1'); // alle Done
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    await writeFeature('F-2'); // eine offene Story
    await writeStory('S-2', { parent: 'F-2', status: 'Done' });
    await writeStory('S-3', { parent: 'F-2', status: 'To Do' });
    await writeFeature('F-3'); // alle Done
    await writeStory('S-4', { parent: 'F-3', status: 'Done' });
    await writeStory('S-5', { parent: 'F-3', status: 'Done' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(2);
    expect(res.archivedStoryCount).toBe(3);
    expect(res.archivedFeatureIds.sort()).toEqual(['F-1', 'F-3']);
  });

  // ── AC2 — Schreibpfad (in-place, atomar, byte-genau, idempotent) ───────────

  it('AC2: setzt archived:true + archived_at + updated_at in Feature UND Stories, status bleibt Done, übrige Zeilen byte-genau', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    const fRaw = await readFile(fPath, 'utf8');
    expect(fRaw).toContain('archived: true');
    expect(fRaw).toContain(`archived_at: '${NOW}'`);
    expect(fRaw).toContain(`updated_at: '${NOW}'`);
    // Unveränderte Felder byte-genau.
    expect(fRaw).toContain('id: F-1');
    expect(fRaw).toContain("title: 'Feature F-1'");
    expect(fRaw).toContain("created_at: '2026-06-01T00:00:00Z'");

    const sRaw = await readFile(sPath, 'utf8');
    expect(sRaw).toContain('archived: true');
    expect(sRaw).toContain(`archived_at: '${NOW}'`);
    expect(sRaw).toContain(`updated_at: '${NOW}'`);
    // Story-status bleibt UNVERÄNDERT Done.
    expect(sRaw).toContain('status: Done');
    expect(sRaw).toContain('id: S-1');
    expect(sRaw).toContain("parent: F-1");
    expect(sRaw).toContain("title: 'Story S-1'");
  });

  it('AC2: board/board.yaml wird NICHT verändert', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(await readFile(boardYamlPath, 'utf8')).toBe(BOARD_YAML);
  });

  it('AC2: atomar — keine .tmp-Reste in features/ oder stories/', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect((await readdir(featuresDir)).filter((n) => n.includes('.tmp.'))).toEqual([]);
    expect((await readdir(storiesDir)).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('AC2: geschriebene Dateien haben Mode 0600', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect((await stat(fPath)).mode & 0o777).toBe(0o600);
    expect((await stat(sPath)).mode & 0o777).toBe(0o600);
  });

  it('AC2: idempotent — zweiter Aufruf archiviert nichts (0/0), kein zweites archived_at', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    const writer = makeWriter();

    await writer.archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });
    const fAfterFirst = await readFile(fPath, 'utf8');
    const sAfterFirst = await readFile(sPath, 'utf8');

    const res2 = await writer.archiveDoneFeatures({
      projectSlug: 'myproject',
      now: '2026-07-02T00:00:00.000Z',
    });

    expect(res2.archivedFeatureCount).toBe(0);
    expect(res2.archivedStoryCount).toBe(0);
    // Dateien unverändert — kein zweites archived_at, alter Zeitstempel bleibt.
    expect(await readFile(fPath, 'utf8')).toBe(fAfterFirst);
    expect(await readFile(sPath, 'utf8')).toBe(sAfterFirst);
  });

  it('AC2: einzelne bereits archivierte Story wird übersprungen (kein zweites archived_at), Feature dennoch archiviert', async () => {
    await writeFeature('F-1');
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    const s2 = await writeStory('S-2', {
      parent: 'F-1',
      status: 'Done',
      extraLines: ['archived: true', "archived_at: '2026-06-15T00:00:00Z'"],
    });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(1);
    // Nur S-1 frisch archiviert — S-2 war bereits archiviert.
    expect(res.archivedStoryCount).toBe(1);
    expect(await readFile(s1, 'utf8')).toContain(`archived_at: '${NOW}'`);
    // S-2 behält seinen ursprünglichen archived_at (kein zweites).
    const s2Raw = await readFile(s2, 'utf8');
    expect(s2Raw).toContain("archived_at: '2026-06-15T00:00:00Z'");
    expect(s2Raw).not.toContain(NOW);
  });

  it('AC2: Round-Trip über BoardAggregator.parseYaml — archived ist Boolean true, status Done', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    const f = parseYaml(await readFile(fPath, 'utf8'));
    expect(f.archived).toBe(true);
    expect(f.archived_at).toBe(NOW);
    const s = parseYaml(await readFile(sPath, 'utf8'));
    expect(s.archived).toBe(true);
    expect(s.status).toBe('Done');
    expect(s.archived_at).toBe(NOW);
  });

  // ── AC8 — Security / Robustheit ────────────────────────────────────────────

  it('AC8: Pfad-Traversal im projectSlug ("..") → invalid-slug', async () => {
    try {
      await makeWriter().archiveDoneFeatures({ projectSlug: '../evil', now: NOW });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-slug');
    }
  });

  it('AC8: unbekanntes Projekt → project-not-found', async () => {
    try {
      await makeWriter().archiveDoneFeatures({ projectSlug: 'does-not-exist', now: NOW });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('project-not-found');
    }
  });

  it('AC8: ungültiger Zeitstempel → invalid-value (kein Schreiben)', async () => {
    const fPath = await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    try {
      await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: 'nicht-iso' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('invalid-value');
    }
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
  });

  it('AC8: best-effort — ein nicht patchbares Feature (duplicate archived-Key) wird übersprungen, übrige dennoch archiviert, kein Crash', async () => {
    // F-1: valide, wird archiviert.
    const f1 = await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    // F-2: enthält den Ziel-Schlüssel `archived` doppelt (aber nicht 'true') →
    // patchTopLevelFields wirft `duplicate-key` → Feature übersprungen.
    const f2 = await writeFeature('F-2', { extraLines: ['archived: false', 'archived: false'] });
    await writeStory('S-2', { parent: 'F-2', status: 'Done' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    // F-1 wurde archiviert, F-2 nicht.
    expect(res.archivedFeatureIds).toContain('F-1');
    expect(res.archivedFeatureIds).not.toContain('F-2');
    expect(await readFile(f1, 'utf8')).toContain('archived: true');
    // F-2 bleibt un-markiert (kein `archived: true`).
    expect(await readFile(f2, 'utf8')).not.toContain('archived: true');
  });

  it('AC8: fehlendes features/-Verzeichnis → kein Crash, 0/0', async () => {
    await rm(featuresDir, { recursive: true, force: true });
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(res.archivedStoryCount).toBe(0);
  });
});

// ── board-feature-archive AC9 (S-244) — Verworfen terminal wie Done ────────────

describe('board-feature-archive AC9 — BoardWriter.archiveDoneFeatures behandelt Verworfen wie Done als terminal (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let featuresDir;
  let storiesDir;

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-featarchive-ac9-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(
      join(boardDir, 'board.yaml'),
      'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 9\nnext_story_id: 99\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  async function writeFeature(id, { status = 'Done', extraLines = [] } = {}) {
    const filePath = join(featuresDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        `title: 'Feature ${id}'`,
        `status: ${status}`,
        'priority: P1',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  async function writeStory(id, { parent, status = 'Done', extraLines = [] } = {}) {
    const filePath = join(storiesDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        ...(parent != null ? [`parent: ${parent}`] : []),
        `title: 'Story ${id}'`,
        `status: ${status}`,
        'priority: P2',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  const NOW = '2026-07-01T12:00:00.000Z';

  it('Feature mit NUR Verworfen-Stories (kein Done) ist archivierbar (alle terminal)', async () => {
    await writeFeature('F-1', { status: 'Verworfen' });
    await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });
    await writeStory('S-2', { parent: 'F-1', status: 'Verworfen' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(1);
    expect(res.archivedStoryCount).toBe(2);
    expect(res.archivedFeatureIds).toEqual(['F-1']);
  });

  it('Feature mit Done + Verworfen (beide terminal) ist archivierbar', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    await writeStory('S-2', { parent: 'F-1', status: 'Verworfen' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(1);
    expect(res.archivedStoryCount).toBe(2);
  });

  it('Feature mit To Do + Verworfen (nicht alle terminal) ist NICHT archivierbar', async () => {
    const fPath = await writeFeature('F-1', { status: 'To Do' });
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });
    const s2 = await writeStory('S-2', { parent: 'F-1', status: 'To Do' });

    const res = await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedFeatureCount).toBe(0);
    expect(res.archivedStoryCount).toBe(0);
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
    expect(await readFile(s1, 'utf8')).not.toContain('archived:');
    expect(await readFile(s2, 'utf8')).not.toContain('archived:');
  });

  it('Story-status bleibt nach Archivierung unverändert: Verworfen bleibt Verworfen', async () => {
    await writeFeature('F-1', { status: 'Verworfen' });
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });

    await makeWriter().archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });

    const sRaw = await readFile(sPath, 'utf8');
    expect(sRaw).toContain('status: Verworfen');
    expect(sRaw).toContain('archived: true');
    expect(sRaw).toContain(`archived_at: '${NOW}'`);
  });

  it('Idempotenz-Regress: zweiter Aufruf auf ein Done+Verworfen-Feature archiviert nichts erneut (0/0)', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });
    const writer = makeWriter();

    await writer.archiveDoneFeatures({ projectSlug: 'myproject', now: NOW });
    const fAfterFirst = await readFile(fPath, 'utf8');
    const sAfterFirst = await readFile(sPath, 'utf8');

    const res2 = await writer.archiveDoneFeatures({
      projectSlug: 'myproject',
      now: '2026-07-02T00:00:00.000Z',
    });

    expect(res2.archivedFeatureCount).toBe(0);
    expect(res2.archivedStoryCount).toBe(0);
    expect(await readFile(fPath, 'utf8')).toBe(fAfterFirst);
    expect(await readFile(sPath, 'utf8')).toBe(sAfterFirst);
  });
});

// ── board-storys-archivieren AC1/AC2/AC9 (S-293) — BoardWriter.archiveDoneStories ──

describe('board-storys-archivieren AC1/AC2/AC9 — BoardWriter.archiveDoneStories (real fs)', () => {
  let boardRootsDir;
  let projectDir;
  let boardDir;
  let featuresDir;
  let storiesDir;
  let boardYamlPath;

  const BOARD_YAML =
    'schema_version: 1\nproject_slug: myproject\nnext_feature_id: 9\nnext_story_id: 99\n';

  beforeEach(async () => {
    boardRootsDir = await mkdtemp(join(tmpdir(), 'boardwriter-storyarchive-test-'));
    projectDir = join(boardRootsDir, 'myproject');
    boardDir = join(projectDir, 'board');
    featuresDir = join(boardDir, 'features');
    storiesDir = join(boardDir, 'stories');
    boardYamlPath = join(boardDir, 'board.yaml');
    await mkdir(featuresDir, { recursive: true });
    await mkdir(storiesDir, { recursive: true });
    await writeFile(boardYamlPath, BOARD_YAML, 'utf8');
  });

  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  function makeWriter() {
    return new BoardWriter({ boardRootsEnv: boardRootsDir });
  }

  async function writeFeature(id, { status = 'To Do', extraLines = [] } = {}) {
    const filePath = join(featuresDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        `title: 'Feature ${id}'`,
        `status: ${status}`,
        'priority: P1',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  async function writeStory(id, { parent, status = 'Done', extraLines = [] } = {}) {
    const filePath = join(storiesDir, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        `id: ${id}`,
        ...(parent != null ? [`parent: ${parent}`] : []),
        `title: 'Story ${id}'`,
        `status: ${status}`,
        'priority: P2',
        "created_at: '2026-06-01T00:00:00Z'",
        "updated_at: '2026-06-01T00:00:00Z'",
        ...extraLines,
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  const NOW = '2026-07-01T12:00:00.000Z';

  // ── AC1 — Archivierbarkeits-Kriterium ──────────────────────────────────────

  it('AC1: Done-Story, nicht archiviert → wird archiviert', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(1);
    expect(res.archivedStoryIds).toEqual(['S-1']);
  });

  it('AC1: Verworfen-Story, nicht archiviert → wird archiviert (terminal wie Done)', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(1);
    expect(res.archivedStoryIds).toEqual(['S-1']);
  });

  it('AC1: nicht-terminale Storys (To Do/In Progress/Blocked/In Review/Idee) werden NICHT angefasst', async () => {
    await writeFeature('F-1');
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'To Do' });
    const s2 = await writeStory('S-2', { parent: 'F-1', status: 'In Progress' });
    const s3 = await writeStory('S-3', { parent: 'F-1', status: 'Blocked' });
    const s4 = await writeStory('S-4', { parent: 'F-1', status: 'In Review' });
    const s5 = await writeStory('S-5', { parent: 'F-1', status: 'Idee' });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(0);
    expect(res.archivedStoryIds).toEqual([]);
    for (const p of [s1, s2, s3, s4, s5]) {
      expect(await readFile(p, 'utf8')).not.toContain('archived:');
    }
  });

  it('AC1: bereits archivierte Story → übersprungen (nicht erneut gezählt)', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', {
      parent: 'F-1',
      status: 'Done',
      extraLines: ['archived: true', "archived_at: '2026-06-15T00:00:00Z'"],
    });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(0);
    expect(res.archivedStoryIds).toEqual([]);
  });

  it('AC1: nur die terminalen Storys eines Features (gemischt Done + To Do) werden archiviert — die Kachel bleibt unangetastet', async () => {
    const fPath = await writeFeature('F-1');
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    const s2 = await writeStory('S-2', { parent: 'F-1', status: 'To Do' });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(1);
    expect(res.archivedStoryIds).toEqual(['S-1']);
    expect(await readFile(s1, 'utf8')).toContain('archived: true');
    expect(await readFile(s2, 'utf8')).not.toContain('archived:');
    // Feature-Kachel selbst niemals angefasst.
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
  });

  it('AC1: mehrere Storys über mehrere Features hinweg — nur terminale werden gezählt', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    await writeStory('S-2', { parent: 'F-1', status: 'To Do' });
    await writeFeature('F-2');
    await writeStory('S-3', { parent: 'F-2', status: 'Verworfen' });
    await writeStory('S-4', { parent: 'F-2', status: 'Done' });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(3);
    expect(res.archivedStoryIds.sort()).toEqual(['S-1', 'S-3', 'S-4']);
  });

  // ── AC2 — Schreibpfad (in-place, atomar, byte-genau, idempotent) ───────────

  it('AC2: setzt archived:true + archived_at + updated_at NUR in der Story-YAML, status bleibt unverändert, übrige Zeilen byte-genau', async () => {
    const fPath = await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    const sRaw = await readFile(sPath, 'utf8');
    expect(sRaw).toContain('archived: true');
    expect(sRaw).toContain(`archived_at: '${NOW}'`);
    expect(sRaw).toContain(`updated_at: '${NOW}'`);
    expect(sRaw).toContain('status: Done'); // Story-status bleibt UNVERÄNDERT.
    expect(sRaw).toContain('id: S-1');
    expect(sRaw).toContain('parent: F-1');
    expect(sRaw).toContain("title: 'Story S-1'");
    expect(sRaw).toContain("created_at: '2026-06-01T00:00:00Z'");

    // Feature-YAML UNVERÄNDERT (kein archived-Feld, keine Bereichs-Kachel-Archivierung).
    expect(await readFile(fPath, 'utf8')).not.toContain('archived:');
  });

  it('AC2: board/board.yaml wird NICHT verändert', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(await readFile(boardYamlPath, 'utf8')).toBe(BOARD_YAML);
  });

  it('AC2: atomar — keine .tmp-Reste in stories/', async () => {
    await writeFeature('F-1');
    await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect((await readdir(storiesDir)).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('AC2: geschriebene Story-Datei hat Mode 0600', async () => {
    await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect((await stat(sPath)).mode & 0o777).toBe(0o600);
  });

  it('AC2: idempotent — zweiter Aufruf archiviert nichts erneut (0), kein zweites archived_at', async () => {
    await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    const writer = makeWriter();

    await writer.archiveDoneStories({ projectSlug: 'myproject', now: NOW });
    const sAfterFirst = await readFile(sPath, 'utf8');

    const res2 = await writer.archiveDoneStories({
      projectSlug: 'myproject',
      now: '2026-07-02T00:00:00.000Z',
    });

    expect(res2.archivedStoryCount).toBe(0);
    expect(await readFile(sPath, 'utf8')).toBe(sAfterFirst);
  });

  it('AC2: Round-Trip über BoardAggregator.parseYaml — archived ist Boolean true, status unverändert', async () => {
    await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Verworfen' });

    await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    const s = parseYaml(await readFile(sPath, 'utf8'));
    expect(s.archived).toBe(true);
    expect(s.status).toBe('Verworfen');
    expect(s.archived_at).toBe(NOW);
  });

  // ── AC9 — Security / Robustheit ────────────────────────────────────────────

  it('AC9: Pfad-Traversal im projectSlug ("..") → invalid-slug', async () => {
    try {
      await makeWriter().archiveDoneStories({ projectSlug: '../evil', now: NOW });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-slug');
    }
  });

  it('AC9: unbekanntes Projekt → project-not-found', async () => {
    try {
      await makeWriter().archiveDoneStories({ projectSlug: 'does-not-exist', now: NOW });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('project-not-found');
    }
  });

  it('AC9: ungültiger Zeitstempel → invalid-value (kein Schreiben)', async () => {
    await writeFeature('F-1');
    const sPath = await writeStory('S-1', { parent: 'F-1', status: 'Done' });

    try {
      await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: 'nicht-iso' });
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err.errorClass).toBe('invalid-value');
    }
    expect(await readFile(sPath, 'utf8')).not.toContain('archived:');
  });

  it('AC9: best-effort — eine nicht patchbare Story (duplicate archived-Key) wird übersprungen, übrige dennoch archiviert, kein Crash', async () => {
    await writeFeature('F-1');
    const s1 = await writeStory('S-1', { parent: 'F-1', status: 'Done' });
    // S-2: enthält den Ziel-Schlüssel `archived` doppelt (aber nicht 'true') →
    // patchTopLevelFields wirft `duplicate-key` → Story übersprungen.
    const s2 = await writeStory('S-2', {
      parent: 'F-1',
      status: 'Done',
      extraLines: ['archived: false', 'archived: false'],
    });

    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryIds).toContain('S-1');
    expect(res.archivedStoryIds).not.toContain('S-2');
    expect(await readFile(s1, 'utf8')).toContain('archived: true');
    expect(await readFile(s2, 'utf8')).not.toContain('archived: true');
  });

  it('AC9: leeres stories/-Verzeichnis (keine Storys) → kein Crash, 0', async () => {
    // stories/ existiert (Pflicht für _resolveProjectPath), enthält aber keine Story-YAMLs.
    const res = await makeWriter().archiveDoneStories({ projectSlug: 'myproject', now: NOW });

    expect(res.archivedStoryCount).toBe(0);
    expect(res.archivedStoryIds).toEqual([]);
  });
});

// ── sanitizeAreaId (story-idee-bereich-zuordnung AC6) ────────────────────────

describe('AC6 — sanitizeAreaId', () => {
  it('akzeptiert und gibt zurück gültige area-ids (alphanumeric + dash/underscore)', () => {
    expect(sanitizeAreaId('backend')).toBe('backend');
    expect(sanitizeAreaId('frontend-team')).toBe('frontend-team');
    expect(sanitizeAreaId('auth_service')).toBe('auth_service');
    expect(sanitizeAreaId('  spaced  ')).toBe('spaced');
  });

  it('gibt null für null/leere String zurück', () => {
    expect(sanitizeAreaId(null)).toBe(null);
    expect(sanitizeAreaId('')).toBe(null);
    expect(sanitizeAreaId('  ')).toBe(null);
  });

  it('lehnt nicht-String ab (invalid-area)', () => {
    try {
      sanitizeAreaId(123);
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-area');
    }
  });

  it('lehnt Steuerzeichen ab (invalid-area)', () => {
    try {
      sanitizeAreaId('backend\nfrontend');
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-area');
    }
  });

  it('lehnt ungültiges Format ab (invalid-area)', () => {
    try {
      sanitizeAreaId('backend/frontend');
      throw new Error('sollte werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(BoardWriterError);
      expect(err.errorClass).toBe('invalid-area');
    }
  });
});

