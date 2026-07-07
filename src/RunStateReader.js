/**
 * RunStateReader.js — read-only Leseschicht für `board/runs/F-###/state.yaml`
 * (run-state-live-view AC1, AC2, AC3)
 *
 * Liest je Projekt-Repo den ephemeren Run-State, den ein Feature-Drain
 * (`board-feature-drain.sh F-###`, agent-flow `feature-batch-orchestration` v2)
 * unter `board/runs/F-###/state.yaml` schreibt. Diese Leseschicht definiert das
 * Schema NICHT neu — es ist bindend in der agent-flow-Spec `feature-batch-
 * orchestration` v2 (siehe docs/specs/run-state-live-view.md, Abschnitt
 * "Vertrags-Herkunft"). Hier wird nur toleranz-behaftet gelesen/gemappt.
 *
 * Vertrag (AC2):
 *   Je state.yaml werden folgende Felder übernommen (fehlende Einzelfelder → null,
 *   unbekannte Zusatzfelder werden ignoriert — vorwärtskompatibel):
 *     - feature      (aus dem Ordnernamen F-### abgeleitet, nicht aus der Datei)
 *     - phase        ("dossier"|"story"|"merge"|"rollout"|<beliebiger String>|null)
 *     - currentStory (state.yaml-Feld "current_story" bzw. "currentStory")
 *     - done / total (state.yaml-Feld "done"/"total", ggf. unter "progress: {done,total}")
 *     - round        (state.yaml-Feld "round")
 *     - startedAt    (state.yaml-Feld "started_at" bzw. "startedAt")
 *     - lastError    (state.yaml-Feld "last_error" bzw. "lastError")
 *     - isLastRun    (true, wenn NUR ein kompaktes Last-Run-Protokoll vorliegt —
 *                     agent-flow markiert dies über ein state.yaml-Feld
 *                     "last_run"/"is_last_run": true; Default false)
 *
 * Fehlertoleranz (AC3):
 *   - `board/runs/` fehlt ganz → leere Liste, kein Fehler (Normalzustand ohne
 *     laufenden Feature-Drain).
 *   - Ein einzelnes defektes/halb-geschriebenes state.yaml (Parse-Fehler, ENOENT
 *     durch Race mit dem schreibenden Feature-Drain) macht NUR diesen einen
 *     Feature-Lauf unsichtbar (übersprungen, best-effort geloggt, secret-frei) —
 *     der restliche Run-State-Index bleibt intakt (kein Crash).
 *
 * Security:
 *   - Rein lesend — KEIN Schreibpfad nach board/runs/.
 *   - Ordnernamen werden gegen ein striktes F-###-Muster geprüft, bevor sie als
 *     Pfadsegment verwendet werden (kein beliebiger Nutzer-Input, aber defensiv).
 *   - Keine absoluten Host-Pfade/Secrets im zurückgegebenen Objekt.
 *
 * @module RunStateReader
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYaml } from './BoardAggregator.js';

/** Strenges Muster für Feature-Ordnernamen unter board/runs/. */
const FEATURE_DIR_RE = /^F-\d+$/;

/**
 * Normalisiert ein rohes, geparstes state.yaml-Objekt in das AC2-Vertragsformat.
 * Toleriert sowohl snake_case (agent-flow-typisch) als auch camelCase-Varianten
 * und eine verschachtelte `progress: { done, total }`-Struktur. Fehlende Felder
 * werden zu `null` (nie `undefined`), unbekannte Zusatzfelder werden ignoriert.
 *
 * @param {string} feature  Feature-ID, aus dem Ordnernamen abgeleitet (nicht aus der Datei).
 * @param {Record<string, unknown>} raw  Bereits geparstes state.yaml-Objekt.
 * @returns {{
 *   feature: string,
 *   phase: string|null,
 *   currentStory: string|null,
 *   done: number|null,
 *   total: number|null,
 *   round: number|null,
 *   startedAt: string|null,
 *   lastError: string|null,
 *   isLastRun: boolean,
 * }}
 */
export function normalizeRunState(feature, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const phase = r.phase != null ? String(r.phase) : null;

  const currentStory =
    r.current_story != null ? String(r.current_story)
    : r.currentStory != null ? String(r.currentStory)
    : null;

  // done/total: entweder Top-Level oder unter progress: { done, total }
  const progress = r.progress && typeof r.progress === 'object' ? r.progress : null;
  const doneRaw = r.done ?? progress?.done;
  const totalRaw = r.total ?? progress?.total;
  const done = typeof doneRaw === 'number' && Number.isFinite(doneRaw) ? doneRaw : null;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : null;

  const roundRaw = r.round;
  const round = typeof roundRaw === 'number' && Number.isFinite(roundRaw) ? roundRaw : null;

  const startedAt =
    r.started_at != null ? String(r.started_at)
    : r.startedAt != null ? String(r.startedAt)
    : null;

  const lastError =
    r.last_error != null ? String(r.last_error)
    : r.lastError != null ? String(r.lastError)
    : null;

  const isLastRun = r.last_run === true || r.is_last_run === true || r.isLastRun === true;

  return { feature, phase, currentStory, done, total, round, startedAt, lastError, isLastRun };
}

/**
 * Liest alle `board/runs/F-###/state.yaml`-Dateien eines Projekt-Repos read-only.
 *
 * Never throws (AC3 — Fehlertoleranz): fehlt `board/runs/` ganz, oder ist es kein
 * Verzeichnis, wird eine leere Liste zurückgegeben.
 *
 * @param {string} repoPath  Absoluter Pfad zum Projekt-Repo (Root, NICHT board/).
 * @param {{ readdir: Function, readFile: Function }} [fsDeps]  Injectable für Tests.
 * @returns {Promise<Array<ReturnType<typeof normalizeRunState>>>}
 */
export async function readRunStates(repoPath, fsDeps = { readdir, readFile }) {
  const runsDir = join(repoPath, 'board', 'runs');

  let entries;
  try {
    entries = await fsDeps.readdir(runsDir, { withFileTypes: true });
  } catch {
    // board/runs/ fehlt/nicht lesbar → leerer Normalzustand, kein Fehler (AC1/AC3).
    return [];
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.isDirectory()) continue;
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue; // defensiv, analog BoardAggregator-Scan
    if (!FEATURE_DIR_RE.test(entry.name)) continue; // nur F-###-Ordner

    const statePath = join(runsDir, entry.name, 'state.yaml');
    try {
      const raw = await fsDeps.readFile(statePath, 'utf8');
      const parsed = parseYaml(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('state.yaml parsed to non-object');
      }
      runs.push(normalizeRunState(entry.name, parsed));
    } catch (err) {
      // AC3: EIN defektes/halb-geschriebenes state.yaml macht nur diesen Lauf
      // unsichtbar — best-effort geloggt, secret-frei, kein Crash.
      console.warn(
        `[RunStateReader] state.yaml für ${entry.name} übersprungen (${statePath}): ${err.message}`
      );
    }
  }

  return runs;
}
