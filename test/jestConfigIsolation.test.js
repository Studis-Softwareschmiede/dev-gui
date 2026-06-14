/**
 * jestConfigIsolation.test.js — Regressions-Verriegelung der Worktree-Isolation (AC13–AC15)
 *
 * Covers:
 *   AC13 — jest.config.js schließt Worktree-Pfade in BEIDEN Pattern-Listen aus:
 *           testPathIgnorePatterns UND modulePathIgnorePatterns enthalten /.claude/worktrees/
 *   AC14 — Regressions-Verriegelung: Entfernen eines der Patterns würde diesen Test rot machen;
 *           die Garantie ist nicht mehr nur durch Aufmerksamkeit geschützt.
 *   AC15 — eslint.config.js ignoriert .claude/worktrees/ ebenfalls (Konsistenz-Check);
 *           pragmatisch via Datei-Inhalt-Prüfung (robust gegen ESM-Flat-Config-Ladeprobleme).
 *
 * Strategy:
 *   AC13/AC14: jest.config.js wird per dynamischem Import geladen und die Arrays direkt geprüft.
 *              Das ist robust: jest.config.js ist ESM (export default config) und liegt im
 *              Projekt-Root neben package.json ("type":"module").
 *   AC15: eslint.config.js wird als Text gelesen (readFileSync). Grund: ESLint Flat Configs
 *         importieren plugins (@eslint/js, eslint-plugin-react-hooks) die im Test-Lauf ohne
 *         volle ESLint-Initialisierung unbekannte Seiteneffekte auslösen können. Der Dateiinhalt
 *         ist deterministisch und hinreichend für die Konsistenz-Prüfung.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Prüft ob ein Pattern-Array das Worktree-Muster enthält.
 * Normalisiert: sucht nach Strings die '\.claude/worktrees/' (mit oder ohne Regex-Escape) enthalten.
 */
function containsWorktreePattern(patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    if (typeof p !== 'string') return false;
    // Beide Formen akzeptieren: '/\.claude/worktrees/' (Regex-String) oder '/.claude/worktrees/'
    return p.includes('\\.claude/worktrees/') || p.includes('/.claude/worktrees/');
  });
}

// ── AC13 / AC14: jest.config.js Pattern-Prüfung ──────────────────────────────

describe('jest.config.js — Worktree-Isolation (AC13/AC14)', () => {
  let jestConfig;

  // Einmaliges dynamisches Laden der jest.config.js für alle Tests in dieser Suite
  beforeAll(async () => {
    // pathToFileURL + dynamic import: ESM-kompatibel (package.json "type":"module")
    const { pathToFileURL } = await import('node:url');
    const configUrl = pathToFileURL(join(PROJECT_ROOT, 'jest.config.js')).href;
    const mod = await import(configUrl);
    // jest.config.js exportiert: export default config
    jestConfig = mod.default ?? mod;
  });

  it('jest.config.js kann geladen werden und exportiert ein Objekt', () => {
    expect(jestConfig).toBeDefined();
    expect(typeof jestConfig).toBe('object');
    expect(jestConfig).not.toBeNull();
  });

  it('AC13/AC14 — testPathIgnorePatterns enthält das Worktree-Pattern', () => {
    // VERRIEGELUNG: Entfernen von /.claude/worktrees/ aus testPathIgnorePatterns → Test rot
    expect(
      containsWorktreePattern(jestConfig.testPathIgnorePatterns),
    ).toBe(true);
  });

  it('AC13/AC14 — modulePathIgnorePatterns enthält das Worktree-Pattern', () => {
    // VERRIEGELUNG: Entfernen von /.claude/worktrees/ aus modulePathIgnorePatterns → Test rot
    expect(
      containsWorktreePattern(jestConfig.modulePathIgnorePatterns),
    ).toBe(true);
  });

  it('AC14 — beide Pattern-Listen sind Arrays (kein Typ-Bruch durch Config-Edit)', () => {
    expect(Array.isArray(jestConfig.testPathIgnorePatterns)).toBe(true);
    expect(Array.isArray(jestConfig.modulePathIgnorePatterns)).toBe(true);
  });
});

// ── AC15: eslint.config.js Konsistenz-Check ───────────────────────────────────

describe('eslint.config.js — Worktree-Ausschluss-Konsistenz (AC15)', () => {
  let eslintConfigContent;

  beforeAll(() => {
    // Pragmatisch: Dateiinhalt lesen statt Flat-Config dynamisch importieren.
    // Grund: eslint.config.js importiert @eslint/js und eslint-plugin-react-hooks —
    // diese Plugins haben im Jest-Test-Kontext keine ESLint-Runtime-Umgebung und
    // können unerwartete Seiteneffekte auslösen. Dateiinhalt ist deterministisch
    // und hinreichend für diese Konsistenz-Prüfung (kein Interpretationsunterschied möglich).
    eslintConfigContent = readFileSync(join(PROJECT_ROOT, 'eslint.config.js'), 'utf8');
  });

  it('eslint.config.js kann gelesen werden (Datei existiert)', () => {
    expect(typeof eslintConfigContent).toBe('string');
    expect(eslintConfigContent.length).toBeGreaterThan(0);
  });

  it('AC15 — eslint.config.js enthält .claude/worktrees/ in ignores', () => {
    // VERRIEGELUNG: Entfernen von .claude/worktrees/ aus eslint.config.js → Test rot.
    // Prüft den Roh-String: '.claude/worktrees/' muss im Dateiinhalt vorkommen.
    expect(eslintConfigContent).toContain('.claude/worktrees/');
  });

  it('AC15 — der Worktree-Ausschluss liegt in einem ignores-Array (nicht als aktive Regel)', () => {
    // Sicherstellen, dass das Pattern als Ignorier-Pfad deklariert ist,
    // nicht versehentlich in einem files/rules-Block landet.
    //
    // Robuste Strategie: Regex-Scan für den ignores-Array-Literal.
    // Schritt 1: Finde den Start des ignores-Arrays via /ignores\s*:\s*\[/
    // Schritt 2: Extrahiere den Inhalt bis zur schließenden ] (alles zwischen [ und ])
    // Schritt 3: Prüfe dass .claude/worktrees/ darin vorkommt.
    // Das macht die Prüfung immun gegen spätere Kommentare die das Wort 'ignores'
    // enthalten (z.B. "// foo ignores bar") — nur der echte Array-Literal zählt.
    const ignoresArrayMatch = eslintConfigContent.match(/ignores\s*:\s*\[([^\]]*)\]/);
    expect(ignoresArrayMatch).not.toBeNull(); // ignores-Array muss vorhanden sein
    const ignoresArrayContent = ignoresArrayMatch[1];
    expect(ignoresArrayContent).toContain('.claude/worktrees/');
  });
});
