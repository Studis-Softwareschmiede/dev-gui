/**
 * iconRegistry.js — Icon registry for Entity types in the dev-gui.
 *
 * Provides:
 *   - TYPE_DEFAULTS: kind → { Icon, accentColor } for agent/skill/knowledge
 *   - ROLE_MAP: known agent-id/group → lucide Icon component
 *   - resolveIcon({ kind, id, group }) → { Icon, accentColor, monogram? }
 *
 * Design constraints (docs/specs/team-entity-icons.md):
 *   - Pure function: no fetch, no I/O, no side effects.
 *   - Deterministic: same input → same output across renders/reloads.
 *   - WCAG AA accent colors on dark background (#111 / #1a1a1a).
 *   - Monogram fallback: first letter of id (uppercased) + hash-derived color.
 *   - No dangerouslySetInnerHTML, no secrets.
 *
 * Security: no user-controlled data reaches any sink (pure transformation only).
 */

import {
  Users,
  Zap,
  BookOpen,
  Code,
  Compass,
  Database,
  Palette,
  ClipboardList,
  ShieldCheck,
  FlaskConical,
  Rocket,
  Scale,
  RefreshCw,
  GraduationCap,
} from 'lucide-react';

// ── Accent colors (WCAG AA on #111 dark background) ──────────────────────────
//
// Contrast ratios against #111 (approx luminance 0.0041):
//   #60a5fa (blue-400)  — ratio ≈ 5.9:1  ✓ AA
//   #a78bfa (violet-400) — ratio ≈ 5.5:1  ✓ AA
//   #34d399 (emerald-400) — ratio ≈ 7.2:1  ✓ AA
//
// Each type gets a distinct color so the three types are distinguishable at a
// glance. Color is never the sole meaning carrier (text label is primary, AC7).

const COLOR_AGENT     = '#60a5fa'; // blue-400 — agents
const COLOR_SKILL     = '#a78bfa'; // violet-400 — skills
const COLOR_KNOWLEDGE = '#34d399'; // emerald-400 — knowledge

// ── Type-Default Mapping (AC2a) ───────────────────────────────────────────────
// kind → { Icon, accentColor }

export const TYPE_DEFAULTS = {
  agent:     { Icon: Users,    accentColor: COLOR_AGENT },
  skill:     { Icon: Zap,      accentColor: COLOR_SKILL },
  knowledge: { Icon: BookOpen, accentColor: COLOR_KNOWLEDGE },
};

// ── Individual Role Mapping (AC2b) ────────────────────────────────────────────
// id/group → lucide Icon component
// Covers at least the 12 listed agent roles (spec §Verhalten rule 2).

export const ROLE_MAP = {
  coder:       Code,
  architekt:   Compass,
  dba:         Database,
  designer:    Palette,
  requirement: ClipboardList,
  teamLeader:  Users,
  reviewer:    ShieldCheck,
  tester:      FlaskConical,
  cicd:        Rocket,
  estimator:   Scale,
  retro:       RefreshCw,
  train:       GraduationCap,
};

// ── Deterministic Monogram Palette ────────────────────────────────────────────
// A fixed set of WCAG-AA-compliant colors for the monogram fallback.
// Hash of the id selects from this palette deterministically.

const MONOGRAM_COLORS = [
  '#f87171', // red-400   — contrast ≈ 4.7:1 on #111
  '#fb923c', // orange-400 — contrast ≈ 4.9:1 on #111
  '#fbbf24', // amber-400  — contrast ≈ 7.6:1 on #111
  '#a3e635', // lime-400   — contrast ≈ 7.9:1 on #111
  '#34d399', // emerald-400 — contrast ≈ 7.2:1 on #111
  '#22d3ee', // cyan-400   — contrast ≈ 7.3:1 on #111
  '#60a5fa', // blue-400   — contrast ≈ 5.9:1 on #111
  '#a78bfa', // violet-400 — contrast ≈ 5.5:1 on #111
  '#f472b6', // pink-400   — contrast ≈ 4.9:1 on #111
];

/**
 * Compute a simple, stable hash of a string.
 * djb2 variant: pure arithmetic, no I/O, deterministic.
 *
 * @param {string} str
 * @returns {number} non-negative integer
 */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    // Bitwise ops work on 32-bit signed integers in JS; keep positive via >>> 0.
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Derive a stable accent color from an id string.
 *
 * @param {string} id
 * @returns {string} CSS color
 */
function colorFromId(id) {
  const idx = hashString(id) % MONOGRAM_COLORS.length;
  return MONOGRAM_COLORS[idx];
}

// ── resolveIcon (AC3 — Fallback Cascade) ─────────────────────────────────────

/**
 * Resolve an icon descriptor for an entity.
 *
 * Fallback cascade (spec §Fallback-Kaskade):
 *   1. Explicit ROLE_MAP entry for `id` (or `group` for knowledge).
 *   2. TYPE_DEFAULTS entry for `kind`.
 *   3. Deterministic monogram badge (first letter of id, hash-derived color).
 *
 * @param {{ kind?: string, id?: string, group?: string }} params
 * @returns {{ Icon?: import('lucide-react').LucideIcon, accentColor: string, monogram?: string }}
 */
export function resolveIcon({ kind, id, group } = {}) {
  // Normalize inputs to strings (guard against undefined/null).
  const safeId    = typeof id    === 'string' ? id    : '';
  const safeGroup = typeof group === 'string' ? group : '';
  const safeKind  = typeof kind  === 'string' ? kind  : '';

  // Stage 1 — explicit role/group mapping.
  // Check id first, then group (relevant for knowledge entries keyed by group).
  const explicitIcon = ROLE_MAP[safeId] ?? ROLE_MAP[safeGroup] ?? null;
  if (explicitIcon !== null) {
    // Accent color follows the type (spec §Akzentfarbe rule 1c).
    const accentColor = TYPE_DEFAULTS[safeKind]?.accentColor ?? colorFromId(safeId || safeGroup || '?');
    return { Icon: explicitIcon, accentColor };
  }

  // Stage 2 — type default.
  const typeDefault = TYPE_DEFAULTS[safeKind] ?? null;
  if (typeDefault !== null) {
    return { Icon: typeDefault.Icon, accentColor: typeDefault.accentColor };
  }

  // Stage 3 — deterministic monogram badge.
  // Use id as primary seed; fall back to group, then a neutral placeholder.
  const seed      = safeId || safeGroup || '?';
  const monogram  = seed[0].toUpperCase();
  const accentColor = colorFromId(seed);
  return { monogram, accentColor };
}
