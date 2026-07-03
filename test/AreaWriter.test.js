/**
 * AreaWriter.test.js — Unit-/Integrationstests für AreaWriter (bereichs-modell
 * AC3-AC7, S-289).
 *
 * Covers (bereichs-modell.md):
 *   AC3 — `createArea()`: neuer Bereich mit stabiler kebab-case-`id`
 *          (kollisionsfrei aus `name`, inkl. Umlaut-Transliteration),
 *          getrimmtem/validiertem `name`, `order` ans Ende; atomar
 *          (tmp+rename, 0600); leerer/zu langer Name → `invalid-name`;
 *          case-insensitiver Duplikat-Name → `duplicate-name`, kein Anlegen.
 *   AC4 — `renameArea()`: ändert NUR `name` (id/order/description stabil),
 *          gleiche Validierung wie AC3 (Duplikat-Check schließt sich selbst
 *          aus); unbekannte id → `area-not-found`. `reorderAreas()`: setzt
 *          `order` gemäß `orderedIds`; `orderedIds` MUSS exakt die
 *          vorhandene ID-Menge sein (fehlend/fremd/doppelt) → `invalid-order-ids`,
 *          kein Teil-Schreiben.
 *   AC5 — `deleteArea()`: löscht NUR wenn kein Feature/keine Story (aktiv
 *          ODER archiviert — Scan deckt beide automatisch ab) mit eigenem
 *          `area === id` UND keine Spec mit `area: <id>`-Frontmatter
 *          existiert; sonst `area-not-empty` mit `err.details =
 *          { storyCount, specCount }`, keine Teil-Löschung. Bei Erfolg
 *          bleiben verbleibende `order`-Werte lückentolerant gültig.
 *   AC7 — Security/Robustheit: Pfad-Traversal im projectSlug ("..") →
 *          `invalid-slug`; Symlink-Flucht aus BOARD_ROOTS → `project-not-found`;
 *          atomare Einzeldatei-Writes (kein .tmp-Rest); ungültige Eingaben
 *          sauber abgewiesen (kein Crash).
 *
 * Strategy: echtes tmp-Verzeichnis (kein Mock) — die Pfad-Sicherheits-Logik
 * (realpath-Containment, Symlink-Flucht) ist nur gegen ein echtes Filesystem
 * aussagekräftig prüfbar (analog BoardWriter.test.js).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile, readdir, stat, writeFile, symlink } from 'node:fs/promises';
import {
  AreaWriter,
  AreaWriterError,
  AREA_NAME_MAX_LENGTH,
  AREA_DESCRIPTION_MAX_LENGTH,
  AREA_ID_RE,
  validateAreaName,
  validateAreaDescription,
  validateOrderedIds,
} from '../src/AreaWriter.js';
import { parseAreasYamlList } from '../src/BoardAggregator.js';

let boardRootsDir;
let projectDir;
let areasPath;

async function setupProject() {
  boardRootsDir = await mkdtemp(join(tmpdir(), 'areawriter-test-'));
  projectDir = join(boardRootsDir, 'myproject');
  await mkdir(join(projectDir, 'board', 'stories'), { recursive: true });
  await mkdir(join(projectDir, 'board', 'features'), { recursive: true });
  areasPath = join(projectDir, 'board', 'areas.yaml');
}

function makeWriter() {
  return new AreaWriter({ boardRootsEnv: boardRootsDir });
}

async function readAreasRaw() {
  const raw = await readFile(areasPath, 'utf8');
  return parseAreasYamlList(raw);
}

const SEEDED_AREAS = [
  '- id: board',
  "  name: 'Board'",
  '  order: 1',
  '- id: fabrik-arbeiten',
  "  name: 'Fabrik-Arbeiten'",
  '  order: 2',
  '',
].join('\n');

describe('AreaWriter — pure validation helpers', () => {
  it('validateAreaName: trimmt und akzeptiert einen normalen Namen', () => {
    expect(validateAreaName('  Neuer Bereich  ')).toBe('Neuer Bereich');
  });

  it('validateAreaName: leerer Name → invalid-name', () => {
    expect(() => validateAreaName('   ')).toThrow(AreaWriterError);
    try {
      validateAreaName('');
    } catch (err) {
      expect(err.errorClass).toBe('invalid-name');
    }
  });

  it('validateAreaName: zu langer Name → invalid-name', () => {
    const tooLong = 'a'.repeat(AREA_NAME_MAX_LENGTH + 1);
    expect(() => validateAreaName(tooLong)).toThrow(
      expect.objectContaining({ errorClass: 'invalid-name' }),
    );
  });

  it('validateAreaName: Steuerzeichen/Zeilenumbruch → invalid-name', () => {
    expect(() => validateAreaName('Zeile1\nZeile2')).toThrow(
      expect.objectContaining({ errorClass: 'invalid-name' }),
    );
  });

  it('validateAreaDescription: null/undefined → null', () => {
    expect(validateAreaDescription(null)).toBeNull();
    expect(validateAreaDescription(undefined)).toBeNull();
  });

  it('validateAreaDescription: zu lang → invalid-description', () => {
    const tooLong = 'a'.repeat(AREA_DESCRIPTION_MAX_LENGTH + 1);
    expect(() => validateAreaDescription(tooLong)).toThrow(
      expect.objectContaining({ errorClass: 'invalid-description' }),
    );
  });

  it('validateOrderedIds: leeres/nicht-Array → invalid-order-ids', () => {
    expect(() => validateOrderedIds([])).toThrow(
      expect.objectContaining({ errorClass: 'invalid-order-ids' }),
    );
    expect(() => validateOrderedIds('not-an-array')).toThrow(
      expect.objectContaining({ errorClass: 'invalid-order-ids' }),
    );
  });

  it('AREA_ID_RE: akzeptiert kebab-case, lehnt Großbuchstaben/Leerzeichen/Traversal ab', () => {
    expect(AREA_ID_RE.test('board')).toBe(true);
    expect(AREA_ID_RE.test('fabrik-arbeiten')).toBe(true);
    expect(AREA_ID_RE.test('Board')).toBe(false);
    expect(AREA_ID_RE.test('board arbeiten')).toBe(false);
    expect(AREA_ID_RE.test('../etc')).toBe(false);
  });
});

describe('AreaWriter#createArea (AC3)', () => {
  beforeEach(setupProject);
  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('legt einen neuen Bereich mit kebab-case-id + order ans Ende an (leere areas.yaml)', async () => {
    const writer = makeWriter();
    const result = await writer.createArea({ projectSlug: 'myproject', name: 'Nachtwächter' });

    expect(result.id).toBe('nachtwaechter');

    const areas = await readAreasRaw();
    expect(areas).toEqual([{ id: 'nachtwaechter', name: 'Nachtwächter', order: 1 }]);
  });

  it('order ans Ende: bei bestehenden Einträgen wird order = max(order) + 1', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    const writer = makeWriter();
    const result = await writer.createArea({ projectSlug: 'myproject', name: 'Einstellungen' });

    const areas = await readAreasRaw();
    const created = areas.find((a) => a.id === result.id);
    expect(created.order).toBe(3);
  });

  it('description wird gespeichert und rundet über parseAreasYamlList korrekt (inkl. Apostroph-Escaping)', async () => {
    const writer = makeWriter();
    await writer.createArea({
      projectSlug: 'myproject',
      name: 'VPS',
      description: "Owner's VPS-Verwaltung",
    });

    const areas = await readAreasRaw();
    expect(areas[0].description).toBe("Owner's VPS-Verwaltung");
  });

  it('kollisionsfreie ID: zweiter Bereich mit gleicher Slug-Basis bekommt Suffix -2', async () => {
    const writer = makeWriter();
    const first = await writer.createArea({ projectSlug: 'myproject', name: 'Board' });
    const second = await writer.createArea({ projectSlug: 'myproject', name: 'BOARD!!!' });

    expect(first.id).toBe('board');
    expect(second.id).toBe('board-2');
  });

  it('leerer Name → invalid-name, keine Datei angelegt', async () => {
    const writer = makeWriter();
    await expect(
      writer.createArea({ projectSlug: 'myproject', name: '   ' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-name' });

    await expect(readFile(areasPath, 'utf8')).rejects.toThrow();
  });

  it('case-insensitiver Duplikat-Name → duplicate-name, kein zweiter Eintrag', async () => {
    const writer = makeWriter();
    await writer.createArea({ projectSlug: 'myproject', name: 'Board' });

    await expect(
      writer.createArea({ projectSlug: 'myproject', name: 'board' }),
    ).rejects.toMatchObject({ errorClass: 'duplicate-name' });

    const areas = await readAreasRaw();
    expect(areas).toHaveLength(1);
  });

  it('atomar: kein .tmp-Rest, finale Datei mit Mode 0600', async () => {
    const writer = makeWriter();
    await writer.createArea({ projectSlug: 'myproject', name: 'Board' });

    const entries = await readdir(join(projectDir, 'board'));
    expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);

    const st = await stat(areasPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('unbekanntes projectSlug → project-not-found', async () => {
    const writer = makeWriter();
    await expect(
      writer.createArea({ projectSlug: 'does-not-exist', name: 'Board' }),
    ).rejects.toMatchObject({ errorClass: 'project-not-found' });
  });

  it('Pfad-Traversal im projectSlug ("..") → invalid-slug', async () => {
    const writer = makeWriter();
    await expect(
      writer.createArea({ projectSlug: '../etc', name: 'Board' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-slug' });
  });

  it('Symlink-Flucht: projectSlug zeigt via Symlink aus BOARD_ROOTS heraus → project-not-found', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'areawriter-outside-'));
    await mkdir(join(outsideDir, 'board', 'stories'), { recursive: true });
    const linkPath = join(boardRootsDir, 'escape-link');
    await symlink(outsideDir, linkPath, 'dir');

    const writer = makeWriter();
    await expect(
      writer.createArea({ projectSlug: 'escape-link', name: 'Board' }),
    ).rejects.toMatchObject({ errorClass: 'project-not-found' });

    await rm(outsideDir, { recursive: true, force: true });
  });
});

describe('AreaWriter#renameArea (AC4)', () => {
  beforeEach(async () => {
    await setupProject();
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
  });
  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('ändert nur name — id/order bleiben stabil', async () => {
    const writer = makeWriter();
    const result = await writer.renameArea({ projectSlug: 'myproject', id: 'board', name: 'Board (neu)' });

    expect(result.id).toBe('board');
    const areas = await readAreasRaw();
    const renamed = areas.find((a) => a.id === 'board');
    expect(renamed.name).toBe('Board (neu)');
    expect(renamed.order).toBe(1);
    // anderer Eintrag unverändert
    const other = areas.find((a) => a.id === 'fabrik-arbeiten');
    expect(other.name).toBe('Fabrik-Arbeiten');
  });

  it('Umbenennen auf denselben (nur Groß-/Kleinschreibung geänderten) Namen ist erlaubt (Selbstausschluss im Duplikat-Check)', async () => {
    const writer = makeWriter();
    await expect(
      writer.renameArea({ projectSlug: 'myproject', id: 'board', name: 'BOARD' }),
    ).resolves.toMatchObject({ id: 'board' });
  });

  it('Duplikat-Name (case-insensitive, gegen ANDEREN Eintrag) → duplicate-name, keine Änderung', async () => {
    const writer = makeWriter();
    const before = await readAreasRaw();

    await expect(
      writer.renameArea({ projectSlug: 'myproject', id: 'board', name: 'fabrik-arbeiten' }),
    ).rejects.toMatchObject({ errorClass: 'duplicate-name' });

    const after = await readAreasRaw();
    expect(after).toEqual(before);
  });

  it('unbekannte id → area-not-found', async () => {
    const writer = makeWriter();
    await expect(
      writer.renameArea({ projectSlug: 'myproject', id: 'does-not-exist', name: 'X' }),
    ).rejects.toMatchObject({ errorClass: 'area-not-found' });
  });

  it('leerer name → invalid-name, keine Änderung', async () => {
    const writer = makeWriter();
    const before = await readAreasRaw();
    await expect(
      writer.renameArea({ projectSlug: 'myproject', id: 'board', name: '' }),
    ).rejects.toMatchObject({ errorClass: 'invalid-name' });
    const after = await readAreasRaw();
    expect(after).toEqual(before);
  });
});

describe('AreaWriter#reorderAreas (AC4)', () => {
  beforeEach(async () => {
    await setupProject();
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
  });
  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('setzt order gemäß der übergebenen Reihenfolge (1-basiert)', async () => {
    const writer = makeWriter();
    const result = await writer.reorderAreas({
      projectSlug: 'myproject',
      orderedIds: ['fabrik-arbeiten', 'board'],
    });

    expect(result.areas.find((a) => a.id === 'fabrik-arbeiten').order).toBe(1);
    expect(result.areas.find((a) => a.id === 'board').order).toBe(2);

    const areas = await readAreasRaw();
    expect(areas.find((a) => a.id === 'fabrik-arbeiten').order).toBe(1);
    expect(areas.find((a) => a.id === 'board').order).toBe(2);
  });

  it('fehlende ID in orderedIds → invalid-order-ids, kein Teil-Schreiben', async () => {
    const writer = makeWriter();
    const before = await readAreasRaw();

    await expect(
      writer.reorderAreas({ projectSlug: 'myproject', orderedIds: ['board'] }),
    ).rejects.toMatchObject({ errorClass: 'invalid-order-ids' });

    const after = await readAreasRaw();
    expect(after).toEqual(before);
  });

  it('fremde ID in orderedIds → invalid-order-ids, kein Teil-Schreiben', async () => {
    const writer = makeWriter();
    const before = await readAreasRaw();

    await expect(
      writer.reorderAreas({ projectSlug: 'myproject', orderedIds: ['board', 'fabrik-arbeiten', 'unbekannt'] }),
    ).rejects.toMatchObject({ errorClass: 'invalid-order-ids' });

    const after = await readAreasRaw();
    expect(after).toEqual(before);
  });

  it('doppelte ID in orderedIds → invalid-order-ids, kein Teil-Schreiben', async () => {
    const writer = makeWriter();
    const before = await readAreasRaw();

    await expect(
      writer.reorderAreas({ projectSlug: 'myproject', orderedIds: ['board', 'board'] }),
    ).rejects.toMatchObject({ errorClass: 'invalid-order-ids' });

    const after = await readAreasRaw();
    expect(after).toEqual(before);
  });
});

describe('AreaWriter#deleteArea (AC5 — Leer-Guard)', () => {
  beforeEach(setupProject);
  afterEach(async () => {
    await rm(boardRootsDir, { recursive: true, force: true });
  });

  it('happy path: löscht einen leeren Bereich, verbleibende order-Werte bleiben lückentolerant gültig', async () => {
    await writeFile(
      areasPath,
      ['- id: board', "  name: 'Board'", '  order: 1', '- id: vps', "  name: 'VPS'", '  order: 5', ''].join(
        '\n',
      ),
      'utf8',
    );
    const writer = makeWriter();
    const result = await writer.deleteArea({ projectSlug: 'myproject', id: 'vps' });

    expect(result.id).toBe('vps');
    const areas = await readAreasRaw();
    expect(areas).toEqual([{ id: 'board', name: 'Board', order: 1 }]);
  });

  it('unbekannte id → area-not-found', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    const writer = makeWriter();
    await expect(
      writer.deleteArea({ projectSlug: 'myproject', id: 'does-not-exist' }),
    ).rejects.toMatchObject({ errorClass: 'area-not-found' });
  });

  it('Feature mit eigenem area === id → area-not-empty (storyCount>=1), keine Löschung', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    await writeFile(
      join(projectDir, 'board', 'features', 'F-1.yaml'),
      ['id: F-1', "title: 'Beispiel-Feature'", 'status: To Do', 'area: board', ''].join('\n'),
      'utf8',
    );

    const writer = makeWriter();
    let caught;
    try {
      await writer.deleteArea({ projectSlug: 'myproject', id: 'board' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AreaWriterError);
    expect(caught.errorClass).toBe('area-not-empty');
    expect(caught.details).toEqual({ storyCount: 1, specCount: 0 });

    const areas = await readAreasRaw();
    expect(areas.some((a) => a.id === 'board')).toBe(true); // unverändert, nicht gelöscht
  });

  it('Story mit eigenem area === id (auch wenn archived: true) → area-not-empty', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    await writeFile(
      join(projectDir, 'board', 'stories', 'S-1.yaml'),
      ['id: S-1', "title: 'Beispiel-Story'", 'status: Done', 'area: board', 'archived: true', ''].join('\n'),
      'utf8',
    );

    const writer = makeWriter();
    let caught;
    try {
      await writer.deleteArea({ projectSlug: 'myproject', id: 'board' });
    } catch (err) {
      caught = err;
    }
    expect(caught.errorClass).toBe('area-not-empty');
    expect(caught.details).toEqual({ storyCount: 1, specCount: 0 });
  });

  it('Spec mit area-Frontmatter === id → area-not-empty (specCount>=1)', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    await mkdir(join(projectDir, 'docs', 'specs'), { recursive: true });
    await writeFile(
      join(projectDir, 'docs', 'specs', 'beispiel.md'),
      ['---', 'id: beispiel', 'title: Beispiel', 'status: active', 'area: board', 'version: 1', '---', '', '# Beispiel', ''].join(
        '\n',
      ),
      'utf8',
    );

    const writer = makeWriter();
    let caught;
    try {
      await writer.deleteArea({ projectSlug: 'myproject', id: 'board' });
    } catch (err) {
      caught = err;
    }
    expect(caught.errorClass).toBe('area-not-empty');
    expect(caught.details).toEqual({ storyCount: 0, specCount: 1 });
  });

  it('Story mit anderem area-Wert bindet den zu löschenden Bereich NICHT', async () => {
    await writeFile(areasPath, SEEDED_AREAS, 'utf8');
    await writeFile(
      join(projectDir, 'board', 'stories', 'S-1.yaml'),
      ['id: S-1', "title: 'Beispiel-Story'", 'status: Done', 'area: fabrik-arbeiten', ''].join('\n'),
      'utf8',
    );

    const writer = makeWriter();
    await expect(
      writer.deleteArea({ projectSlug: 'myproject', id: 'board' }),
    ).resolves.toMatchObject({ id: 'board' });
  });
});
