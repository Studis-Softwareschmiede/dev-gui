/**
 * parseEntityLabel.js — Derive an entity reference from GitHub Issue labels.
 *
 * Label convention (AC12, docs/specs/team-entity-icons.md):
 *   "agent:<id>"     → { kind: 'agent',     id: '<id>' }
 *   "skill:<id>"     → { kind: 'skill',     id: '<id>' }
 *   "knowledge:<id>" → { kind: 'knowledge', id: '<id>' }
 *
 * Precedence rule (documented, deterministic):
 *   Take the FIRST label in the array that matches one of the three kinds
 *   in their natural order within the labels array.  There is no kind-level
 *   priority ordering imposed — the first matching label wins regardless of
 *   kind.  This keeps the rule simple, transparent, and predictable.
 *
 * Split rule:
 *   Split only at the FIRST colon so that ids containing colons (e.g.
 *   "knowledge:frameworks:spring") are preserved intact as the id part.
 *
 * Security:
 *   Pure data transformation — no fetch, no DOM, no secrets, no side effects.
 *
 * @module parseEntityLabel
 */

/** Accepted entity kinds (order is irrelevant — first label match wins). */
const ENTITY_KINDS = new Set(['agent', 'skill', 'knowledge']);

/**
 * Parse entity kind + id from an array of GitHub Issue label strings.
 *
 * Returns the first label that matches the `<kind>:<id>` convention where
 * `kind` is one of `agent`, `skill`, or `knowledge`.  Returns `null` when
 * no matching label is found.
 *
 * @param {string[]} labels  Array of label strings (may be empty or null).
 * @returns {{ kind: string, id: string } | null}
 */
export function parseEntityLabel(labels) {
  if (!Array.isArray(labels)) return null;

  for (const label of labels) {
    // Guard: only process non-empty strings.
    if (typeof label !== 'string' || label.length === 0) continue;

    // Split at the FIRST colon only (preserves colons within the id).
    const colonIdx = label.indexOf(':');
    if (colonIdx <= 0) continue; // no colon, or colon is the first character

    const kind = label.slice(0, colonIdx);
    const id   = label.slice(colonIdx + 1);

    if (!ENTITY_KINDS.has(kind)) continue;
    if (id.length === 0) continue; // skip "agent:" with empty id

    return { kind, id };
  }

  return null;
}
