/**
 * costMode.js — Shared Cost-Mode constants and helpers (AC9).
 *
 * Extracted so TriggerPanel and IntakeDialog can share cost-mode logic
 * without duplication.
 *
 * Covers: cost mode values, display info, the costFlag() helper.
 */

/**
 * Cost-mode values (AC9) — mirrors agent-flow knowledge/model-tiers.md and the
 * server enum COST_MODES. 'balanced' is the default and is NOT emitted as a flag
 * (the project default profile.cost_mode applies).
 * @type {string[]}
 */
export const COST_MODES = ['low-cost', 'balanced', 'max-quality', 'frontier'];

/**
 * Grobe, GUI-lokale Tier-/Kosten-Charakterisierung je Modus (User-Wunsch: $/MTok).
 * BEWUSST grob: die maßgebliche Rolle×Modus→Modell-Matrix lebt in agent-flow
 * (knowledge/model-tiers.md) — die GUI kennt sie nicht (architecture.md §7) und
 * zeigt hier nur eine Tier-Schwere-Orientierung. Preise aus der Anthropic-Pricing-
 * Quelle (Input/Output je MTok). ADR-001: Abo-Betrieb → KEINE Direktkosten pro
 * Token; die Werte sind nur relative Schwere, kein Dollar-Zielwert.
 * @type {Record<string,{models:string,price:string}>}
 */
export const COST_MODE_INFO = {
  'low-cost':    { models: 'haiku/sonnet', price: '$1–3 / $5–15' },
  'balanced':    { models: 'sonnet/opus',  price: '$3–5 / $15–25' },
  'max-quality': { models: 'opus',         price: '$5 / $25' },
  'frontier':    { models: 'fable (neueste Klasse)', price: '$10 / $50' },
};

/**
 * Commands that dispatch agents and therefore support the cost-mode switch (AC9).
 * @type {string[]}
 */
export const COST_AWARE_COMMANDS = [
  '/agent-flow:flow',
  '/agent-flow:requirement',
  '/agent-flow:train',
];

/**
 * Cost-mode flag fragment for cost-aware commands (AC9).
 * Returns ' --cost <mode>' positioned right after the prefix, or '' when the
 * command is not cost-aware or the mode is 'balanced' (default → no flag).
 *
 * @param {string} cmd       Plugin-namespaced command prefix.
 * @param {string} costMode  One of COST_MODES.
 * @returns {string}
 */
export function costFlag(cmd, costMode) {
  if (!COST_AWARE_COMMANDS.includes(cmd)) return '';
  if (!costMode || costMode === 'balanced') return '';
  return ` --cost ${costMode}`;
}

/**
 * Collapse a multiline text to a single line (AC2b):
 * - Replace all whitespace sequences (including newlines, \r, \t, …) with a
 *   single space.
 * - Trim leading/trailing whitespace.
 * Returns '' when the result is empty.
 *
 * @param {string} text  Raw multiline input from a textarea.
 * @returns {string}     Single-line, trimmed, no control characters.
 */
export function collapseToLine(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}
