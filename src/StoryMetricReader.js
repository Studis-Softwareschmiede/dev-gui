/**
 * StoryMetricReader — liest Story-Metrik-Daten aus den agent-flow Metrik-Ledgern.
 *
 * Datenquellen (je Projekt-Root / repo_path):
 *   .claude/metrics/dispatches.jsonl — je Zeile: { ts, agent, seq, iter, gate, secs, tok, item, ... }
 *   .claude/metrics/items.jsonl      — je Zeile: { id, size_est, ep_est, ep_act, tok_total, ... }
 *
 * Liefert pro Story:
 *   started_at   — min(ts) aller Dispatches mit item == storyId (ISO-String, null wenn keine)
 *   ended_at     — max(ts) aller Dispatches mit item == storyId (ISO-String, null wenn keine)
 *   duration     — Differenz in Sekunden (null wenn started_at oder ended_at fehlt)
 *   flow         — Liste { seq, agent, iter, gate, secs, tok } seq-geordnet, fehlende Felder null
 *   ep_est       — aus items.jsonl (null wenn nicht vorhanden)
 *   ep_act       — aus items.jsonl (null wenn nicht vorhanden)
 *   tok_est      — aus items.jsonl (null wenn Feld fehlt; kein Ableiten aus Dispatches)
 *   tok_total    — aus items.jsonl (null wenn nicht vorhanden)
 *   size_est     — aus items.jsonl (null wenn nicht vorhanden)
 *   ep_dev       — Abweichung ep (null wenn ep_est oder ep_act null)
 *   ep_dev_pct   — Abweichung % ep (null wenn ep_est oder ep_act null)
 *   tok_dev      — Abweichung tok (null wenn tok_est oder tok_total null)
 *   tok_dev_pct  — Abweichung % tok (null wenn tok_est oder tok_total null)
 *
 * Design:
 *   - Read-only, lazy (on-demand pro Story).
 *   - Fehlende / kaputte Dateien → Felder null, kein Crash (AC1).
 *   - Injectable fsDeps für Tests (kein echtes Filesystem nötig).
 *
 * story-detail-yaml-fallback:
 *   AC2 — Robustes ID-Matching: item ↔ storyId matcht sowohl bei String- als auch bei
 *          Integer-Ledgerzeilen (z.B. "S-165" == 165 nach Normalisierung).
 *          Matching rein wertbasiert — item/storyId nie als Pfad benutzt.
 *
 * Security:
 *   - Liest NUR .claude/metrics/dispatches.jsonl + items.jsonl.
 *   - Kein User-Input in Pfadkonstruktion; storyId wird NUR zum Vergleich genutzt, nie als Pfad.
 *   - Kein Secret in Output; kein Schreiben.
 *
 * @module StoryMetricReader
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default FS dependencies (real node:fs/promises). */
const defaultFsDeps = { readFile };

/**
 * Robustes ID-Matching zwischen einem Ledger-item-Feld und einer Story-ID (AC2).
 *
 * Matcht wenn:
 *   (a) String-Gleichheit: String(item) === String(storyId), ODER
 *   (b) Numerische Gleichheit: Zahl aus item (Präfix S-/s- + führende Nullen entfernen)
 *       entspricht Zahl aus storyId — damit matchen Integer-Ledgerzeilen (165) gegen "S-165".
 *
 * Reiner Wertvergleich — item/storyId werden NIE als Pfad benutzt (Security unverändert).
 *
 * @param {unknown} item       Ledger-item-Wert (string oder number).
 * @param {string}  storyId    Story-ID (z.B. "S-165").
 * @returns {boolean}
 */
export function matchesStoryId(item, storyId) {
  if (item == null) return false;
  // (a) String-Gleichheit
  if (String(item) === String(storyId)) return true;
  // (b) Numerische Gleichheit nach Normalisierung: S-Präfix + führende Nullen entfernen
  const normalize = (v) => {
    const s = String(v).trim().replace(/^[Ss]-?0*/, '');
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  const n1 = normalize(item);
  const n2 = normalize(storyId);
  return !Number.isNaN(n1) && !Number.isNaN(n2) && n1 === n2;
}

/**
 * Parse a JSONL file: each non-empty line as JSON. Invalid lines silently skipped.
 *
 * @param {string} content  Raw file content.
 * @returns {object[]}
 */
export function parseJsonl(content) {
  if (!content || typeof content !== 'string') return [];
  const result = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') result.push(parsed);
    } catch {
      // skip invalid lines silently
    }
  }
  return result;
}

/**
 * Compute Soll-Ist deviations.
 *
 * @param {number|null} est  Estimated value.
 * @param {number|null} act  Actual value.
 * @returns {{ dev: number|null, dev_pct: number|null }}
 */
function computeDeviation(est, act) {
  if (est == null || act == null) return { dev: null, dev_pct: null };
  const dev = act - est;
  const dev_pct = est !== 0 ? Math.round((dev / est) * 1000) / 10 : null;
  return { dev, dev_pct };
}

/**
 * StoryMetricReader reads .claude/metrics/dispatches.jsonl + items.jsonl for a given repo.
 *
 * @param {object} [options]
 * @param {object} [options.fsDeps]  Injectable: { readFile }. Defaults to real node:fs/promises.
 */
export class StoryMetricReader {
  #fsDeps;

  constructor({ fsDeps } = {}) {
    this.#fsDeps = fsDeps ?? defaultFsDeps;
  }

  /**
   * Read and parse a JSONL file from disk. Returns [] on any error.
   *
   * @param {string} filePath  Absolute path.
   * @returns {Promise<object[]>}
   */
  async #readJsonl(filePath) {
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    return parseJsonl(content);
  }

  /**
   * Whether a metrics file exists at all (readable), independent of content.
   * Distinguishes "kein Ledger im Projekt" from "Ledger da, aber leer" (AC3b).
   *
   * @param {string} filePath  Absolute path.
   * @returns {Promise<boolean>}
   */
  async #fileExists(filePath) {
    try {
      await this.#fsDeps.readFile(filePath, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get story detail metrics for a given story ID within a project.
   *
   * Reads dispatches.jsonl (all rows with item == storyId) and items.jsonl (the story row).
   * Fehlende Metrik → Felder null, kein Crash (AC1).
   *
   * @param {string} repoPath   Absolute path to the project repo root.
   * @param {string} storyId    Story ID (e.g. "S-116"). Used ONLY as a value to compare — never as a path.
   * @returns {Promise<StoryDetail>}
   */
  async getDetail(repoPath, storyId) {
    const metricsDir = join(repoPath, '.claude', 'metrics');

    // Read both files in parallel — errors caught per-file
    const [dispatches, items, dispatchesExist, itemsExist] = await Promise.all([
      this.#readJsonl(join(metricsDir, 'dispatches.jsonl')),
      this.#readJsonl(join(metricsDir, 'items.jsonl')),
      this.#fileExists(join(metricsDir, 'dispatches.jsonl')),
      this.#fileExists(join(metricsDir, 'items.jsonl')),
    ]);

    // ledger_present: existiert überhaupt ein Metrik-Ledger im Projekt? (AC3b)
    // false → in diesem Projekt wird nichts erfasst; true, aber keine Story-Zeile
    // → Story lief vor der Erfassung / noch kein Flow-Lauf.
    const ledger_present = dispatchesExist || itemsExist;

    // ── dispatches: filter by item == storyId (AC2 robustes ID-Matching) ──────────
    const storyDispatches = dispatches.filter(
      (d) => d && matchesStoryId(d.item, storyId),
    );

    // ── Zeiten (Start/Ende/Dauer) ───────────────────────────────────────────────
    let started_at = null;
    let ended_at   = null;
    let duration   = null;

    if (storyDispatches.length > 0) {
      // ts values: parse as ISO strings or epoch-ms numbers
      const timestamps = storyDispatches
        .map((d) => d.ts)
        .filter((ts) => ts != null)
        .map((ts) => (typeof ts === 'number' ? ts : Date.parse(String(ts))))
        .filter((n) => !Number.isNaN(n));

      if (timestamps.length > 0) {
        const minTs = Math.min(...timestamps);
        const maxTs = Math.max(...timestamps);
        started_at = new Date(minTs).toISOString();
        ended_at   = new Date(maxTs).toISOString();
        duration   = (maxTs - minTs) / 1000; // seconds
      }
    }

    // ── Agenten-Flow (seq-geordnet) ─────────────────────────────────────────────
    const flow = storyDispatches
      .map((d) => ({
        seq:   d.seq  ?? null,
        agent: d.agent ?? null,
        iter:  d.iter  ?? null,
        gate:  d.gate  ?? null,
        secs:  d.secs  ?? null,
        tok:   d.tok   ?? null,
      }))
      .sort((a, b) => {
        // seq ascending; null seqs go last
        const sa = a.seq ?? Infinity;
        const sb = b.seq ?? Infinity;
        return sa - sb;
      });

    // ── Story-Metrik aus items.jsonl (AC2 robustes ID-Matching) ────────────────
    const storyItem = items.find(
      (i) => i && matchesStoryId(i.id, storyId),
    ) ?? null;

    const ep_est    = storyItem?.ep_est    ?? null;
    const ep_act    = storyItem?.ep_act    ?? null;
    const tok_total = storyItem?.tok_total ?? null;
    const size_est  = storyItem?.size_est  ?? null;

    // tok_est: read from items.jsonl Story-Eintrag if present; otherwise null.
    // The dispatch tok-sum is the measured IST-consumption, NOT a Schätzwert (AC1 Nicht-Ziel).
    // tok_est may be populated externally (e.g. from ep_est/ep_per_token in estimator).
    const tok_est = storyItem?.tok_est ?? null;

    // ── Abweichungen ────────────────────────────────────────────────────────────
    const { dev: ep_dev, dev_pct: ep_dev_pct } = computeDeviation(ep_est, ep_act);
    const { dev: tok_dev, dev_pct: tok_dev_pct } = computeDeviation(tok_est, tok_total);

    return {
      started_at,
      ended_at,
      duration,
      flow,
      ep_est,
      ep_act,
      tok_est,
      tok_total,
      size_est,
      ep_dev,
      ep_dev_pct,
      tok_dev,
      tok_dev_pct,
      ledger_present,
    };
  }
}

/**
 * @typedef {{
 *   started_at:   string|null,
 *   ended_at:     string|null,
 *   duration:     number|null,
 *   flow:         Array<{seq:number|null,agent:string|null,iter:number|null,gate:string|null,secs:number|null,tok:number|null}>,
 *   ep_est:       number|null,
 *   ep_act:       number|null,
 *   tok_est:      number|null,
 *   tok_total:    number|null,
 *   size_est:     *|null,
 *   ep_dev:       number|null,
 *   ep_dev_pct:   number|null,
 *   tok_dev:      number|null,
 *   tok_dev_pct:  number|null,
 * }} StoryDetail
 */
