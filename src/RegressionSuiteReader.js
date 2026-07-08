/**
 * RegressionSuiteReader — liest die verfügbaren Regressionstest-Suiten
 * (Bereich / Verbund / Gesamt) je Projekt-Klon, inklusive des deklarierten
 * `target` (`local | ephemeral-infra | url`) und — bei `ephemeral-infra` —
 * des Kosten-/Ressourcen-Hinweises aus der Begleitbeschreibung
 * (`docs/specs/regression-run.md` AC4, AC6; Begleitbeschreibungs-Frontmatter-
 * Vertrag agent-flow `regression-runner` §Verträge, Layout agent-flow
 * `regression-playwright-conventions` AC2).
 *
 * Begleitbeschreibung (`<suite>.md`, Frontmatter, `---`-begrenzt):
 *   ---
 *   target: local            # local | ephemeral-infra | url
 *   url: <nur bei target=url>
 *   kosten: <nur bei ephemeral-infra: Kosten-/Ressourcen-Deklaration>
 *   ---
 *
 * Layout (agent-flow `regression-playwright-conventions` AC2):
 *   tests/regression/<bereich>/<suite>.md   — je Bereich (Bereichs-`id` aus board/areas.yaml)
 *   tests/regression/verbund/<suite>.md     — bereichsübergreifende + Infra-Verbund-Suiten
 *
 * Diese Story (S-311) liest NUR — kein Schreibpfad, kein Scaffold-Anlegen
 * (regression-scaffolding ist Nicht-Ziel dieser Spec).
 *
 * `bereich`-Einträge werden je Unterverzeichnis von `tests/regression/`
 * (außer `verbund`) gebildet, das mindestens EINE `.md`-Begleitbeschreibung
 * enthält — deklariertes `target` = das erste in dem Verzeichnis gefundene
 * (Bereichs-Suiten teilen sich ein `target`, Annahme: ein Bereich hat
 * i.d.R. exakt EIN dominantes Testobjekt, konservativ das erste gefunden).
 * `verbund` wird analog aus `tests/regression/verbund/` gebildet (kann
 * mehrere `target`-Werte enthalten — je Suite eine eigene Ausprägung, s.
 * `entries`-Feld). Kein `tests/regression`-Verzeichnis / leer → leere Liste
 * (kein Crash, Edge-Case).
 *
 * Security (Floor): rein lesend, keine Secrets in den Begleitbeschreibungen
 * erwartet/verarbeitet; Pfad-Auflösung erfolgt beim Aufrufer (Router,
 * `validateProjectPath`/`resolveProjectSlug`), dieses Modul erhält nur den
 * bereits validierten absoluten Projekt-Pfad.
 *
 * @module RegressionSuiteReader
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Relativer Pfad des Regressions-Testbaums im Projekt-Klon (agent-flow `regression-playwright-conventions` AC2). */
export const REGRESSION_TESTS_ROOT = 'tests/regression';

/** Name des Verbund-Unterverzeichnisses (agent-flow `regression-playwright-conventions` AC2). */
const VERBUND_DIR = 'verbund';

/**
 * Parst den Frontmatter-Kopf einer Begleitbeschreibung (`---`-begrenzt,
 * agent-flow `regression-runner` §Verträge). Liefert ein leeres Objekt bei
 * fehlendem/malformtem Frontmatter (kein Crash — der Aufrufer degradiert auf
 * `target: undefined`).
 *
 * @param {string} content
 * @returns {{ target?: string, url?: string, kosten?: string, title?: string }}
 */
export function parseSuiteFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (value === '') continue;
    result[key] = value;
  }
  return result;
}

/**
 * Liest alle `.md`-Begleitbeschreibungen eines Verzeichnisses (nicht rekursiv
 * — Suiten liegen flach je Bereichs-/Verbund-Ordner, agent-flow
 * `regression-playwright-conventions` AC2). Liefert `[]`, wenn das
 * Verzeichnis fehlt/leer ist (kein Crash).
 *
 * @param {string} dirPath - absoluter Pfad.
 * @param {{ readdir?: Function, readFile?: Function }} [deps]
 * @returns {Promise<Array<{ file: string, frontmatter: object }>>}
 */
async function readSuiteDescriptions(dirPath, { readdir: readdirFn = readdir, readFile: readFileFn = readFile } = {}) {
  let entries;
  try {
    entries = await readdirFn(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const mdFiles = entries.filter((e) => e.isFile?.() && e.name.endsWith('.md'));
  const out = [];
  for (const entry of mdFiles) {
    try {
      const content = await readFileFn(join(dirPath, entry.name), 'utf8');
      out.push({ file: entry.name, frontmatter: parseSuiteFrontmatter(content) });
    } catch {
      // Einzelne kaputte Datei überspringen (kein Crash für die ganze Liste).
    }
  }
  return out;
}

/**
 * Liest die verfügbaren Regressionstest-Suiten für einen Projekt-Klon
 * (AC4/AC6): je Bereich + Verbund + ein synthetischer „Gesamt"-Eintrag.
 *
 * @param {string} projectPath - absoluter, bereits validierter Projekt-Pfad.
 * @param {{ readdir?: Function, readFile?: Function }} [deps] - injectable fs-Deps für Tests.
 * @returns {Promise<{
 *   suites: Array<{
 *     scope: { typ: 'bereich'|'verbund'|'gesamt', id?: string },
 *     label: string,
 *     target?: 'local'|'ephemeral-infra'|'url',
 *     kosten?: string,
 *     entries?: Array<{ file: string, target?: string, kosten?: string }>,
 *   }>
 * }>}
 */
export async function readRegressionSuites(projectPath, deps = {}) {
  const root = join(projectPath, REGRESSION_TESTS_ROOT);
  let rootEntries;
  try {
    rootEntries = await (deps.readdir ?? readdir)(root, { withFileTypes: true });
  } catch {
    return { suites: [] };
  }

  const bereichDirs = rootEntries
    .filter((e) => e.isDirectory?.() && e.name !== VERBUND_DIR)
    .map((e) => e.name);

  const suites = [];
  let anySuiteFound = false;

  for (const bereichId of bereichDirs) {
    const descs = await readSuiteDescriptions(join(root, bereichId), deps);
    if (descs.length === 0) continue;
    anySuiteFound = true;
    const first = descs[0].frontmatter;
    suites.push({
      scope: { typ: 'bereich', id: bereichId },
      label: bereichId,
      target: first.target,
      ...(first.target === 'ephemeral-infra' && first.kosten ? { kosten: first.kosten } : {}),
    });
  }

  const verbundDescs = await readSuiteDescriptions(join(root, VERBUND_DIR), deps);
  if (verbundDescs.length > 0) {
    anySuiteFound = true;
    const first = verbundDescs[0].frontmatter;
    suites.push({
      scope: { typ: 'verbund' },
      label: 'Verbund',
      target: first.target,
      ...(first.target === 'ephemeral-infra' && first.kosten ? { kosten: first.kosten } : {}),
      entries: verbundDescs.map((d) => ({
        file: d.file,
        target: d.frontmatter.target,
        ...(d.frontmatter.target === 'ephemeral-infra' && d.frontmatter.kosten ? { kosten: d.frontmatter.kosten } : {}),
      })),
    });
  }

  // "Gesamt" nur anbieten, wenn mind. eine reale Suite existiert (kein leerer Lauf).
  if (anySuiteFound) {
    // Kosten-/Ressourcen-Hinweis für "Gesamt": aggregiert, falls IRGENDEINE
    // enthaltene Suite ephemeral-infra ist (AC6 gilt sinngemäß auch für den
    // aggregierten Lauf — der Owner soll vor dem Start wissen, dass Infra-
    // Kosten anfallen KÖNNEN, auch wenn nicht jede Suite darin ephemeral ist).
    const infraKosten = suites
      .filter((s) => s.target === 'ephemeral-infra' && s.kosten)
      .map((s) => s.kosten);
    suites.push({
      scope: { typ: 'gesamt' },
      label: 'Gesamt',
      ...(infraKosten.length > 0 ? { kosten: infraKosten.join('; ') } : {}),
    });
  }

  return { suites };
}
