/**
 * EntityIcon.jsx — Presentational icon component for Agent/Skill/Knowledge entities.
 *
 * Renders the resolved lucide-icon (SVG) or a deterministic monogram badge.
 * Purely presentational: no fetch, no network access, no secrets.
 *
 * Props:
 *   kind  {string}  'agent' | 'skill' | 'knowledge' (optional)
 *   id    {string}  Entity id (optional)
 *   group {string}  Knowledge group (optional)
 *   size  {number}  Icon size in pixels (default: 16)
 *
 * A11y: the icon is decorative — it carries aria-hidden="true" and no
 * meaningful text. The surrounding text-label conveys the entity name.
 *
 * Security:
 *   - No dangerouslySetInnerHTML / innerHTML (lucide renders React-SVG).
 *   - No secrets in bundle.
 *   - No network calls.
 *
 * Robustness: unknown/missing props degrade through the cascade in
 * resolveIcon(); the component never crashes or returns an empty fragment.
 *
 * docs/specs/team-entity-icons.md — AC5, AC6, AC7
 */

import { resolveIcon } from './iconRegistry.js';

/** Default icon size (px). */
const DEFAULT_SIZE = 16;

/**
 * EntityIcon — resolves and renders the appropriate icon or monogram badge.
 *
 * @param {{ kind?: string, id?: string, group?: string, size?: number }} props
 * @returns {React.ReactElement}
 */
export function EntityIcon({ kind, id, group, size }) {
  const px = typeof size === 'number' && size > 0 ? size : DEFAULT_SIZE;

  const resolved = resolveIcon({ kind, id, group });

  // Case A — lucide Icon resolved.
  if (resolved.Icon) {
    return (
      <resolved.Icon
        size={px}
        color={resolved.accentColor}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      />
    );
  }

  // Case B — monogram badge (deterministic, never empty).
  return (
    <span
      aria-hidden="true"
      style={{
        display:         'inline-flex',
        alignItems:      'center',
        justifyContent:  'center',
        width:           px,
        height:          px,
        borderRadius:    '50%',
        background:      resolved.accentColor,
        color:           '#111',
        fontSize:        Math.max(8, Math.round(px * 0.55)),
        fontWeight:      700,
        lineHeight:      1,
        flexShrink:      0,
        userSelect:      'none',
      }}
    >
      {resolved.monogram}
    </span>
  );
}
