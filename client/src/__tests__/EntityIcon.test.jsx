/**
 * EntityIcon.test.jsx — Unit tests for EntityIcon + iconRegistry.
 *
 * Covers (team-entity-icons, Etappe 1):
 *   - AC2: TYPE_DEFAULTS and ROLE_MAP contents (Mapping)
 *   - AC3: Fallback cascade — explicit → type-default → monogram
 *   - AC4: Monogram badge stability — same id ⇒ same letter + color
 *   - AC5: EntityIcon renders lucide-SVG or monogram; aria-hidden="true"
 *   - AC6: No crash for missing/empty id, kind, group
 *   - AC7: A11y/Floor — aria-hidden, no-script-injection, Determinismus; WCAG-Farbkontrast in iconRegistry.js dokumentiert, jsdom-untestbar
 *
 * @jest-environment jsdom
 */

import { describe, it, expect } from '@jest/globals';
import { act } from '@testing-library/react';

const { render }         = await import('@testing-library/react');
const React              = (await import('react')).default;
const { EntityIcon }     = await import('../icons/EntityIcon.jsx');
const registry           = await import('../icons/iconRegistry.js');

const { resolveIcon, TYPE_DEFAULTS, ROLE_MAP } = registry;

// ── AC2 — Mapping ─────────────────────────────────────────────────────────────

describe('iconRegistry — AC2a: TYPE_DEFAULTS', () => {
  it('has entries for agent, skill, and knowledge', () => {
    expect(TYPE_DEFAULTS).toHaveProperty('agent');
    expect(TYPE_DEFAULTS).toHaveProperty('skill');
    expect(TYPE_DEFAULTS).toHaveProperty('knowledge');
  });

  it('each type default has an Icon and an accentColor', () => {
    for (const [, def] of Object.entries(TYPE_DEFAULTS)) {
      expect(def.Icon).toBeTruthy();
      expect(typeof def.accentColor).toBe('string');
      expect(def.accentColor.startsWith('#')).toBe(true);
    }
  });

  it('the three accent colors are all distinct', () => {
    const colors = Object.values(TYPE_DEFAULTS).map((d) => d.accentColor);
    const unique  = new Set(colors);
    expect(unique.size).toBe(3);
  });
});

describe('iconRegistry — AC2b: ROLE_MAP', () => {
  const requiredRoles = [
    'coder', 'architekt', 'dba', 'designer', 'requirement',
    'teamLeader', 'reviewer', 'tester', 'cicd', 'estimator',
    'retro', 'train',
  ];

  for (const role of requiredRoles) {
    it(`ROLE_MAP has an Icon for "${role}"`, () => {
      expect(ROLE_MAP[role]).toBeTruthy();
    });
  }

  it('all ROLE_MAP values are renderable React components (function or forwardRef object)', () => {
    for (const [, Icon] of Object.entries(ROLE_MAP)) {
      // lucide-react ships forwardRef components (typeof === 'object') in CJS builds
      // and plain functions in ESM builds. Both are valid React component shapes.
      const isRenderable = typeof Icon === 'function' || (typeof Icon === 'object' && Icon !== null);
      expect(isRenderable).toBe(true);
    }
  });
});

// ── AC3 — Fallback Cascade ────────────────────────────────────────────────────

describe('resolveIcon — AC3: Fallback cascade', () => {
  it('stage 1: returns explicit ROLE_MAP icon for known id', () => {
    const result = resolveIcon({ kind: 'agent', id: 'coder' });
    expect(result.Icon).toBeTruthy();
    expect(result.Icon).toBe(ROLE_MAP.coder);
    expect(result.monogram).toBeUndefined();
  });

  it('stage 1: uses type accent color when explicit icon matches', () => {
    const result = resolveIcon({ kind: 'agent', id: 'coder' });
    expect(result.accentColor).toBe(TYPE_DEFAULTS.agent.accentColor);
  });

  it('stage 2: returns type-default icon for unknown agent id', () => {
    const result = resolveIcon({ kind: 'agent', id: 'unknown-agent-xyz' });
    expect(result.Icon).toBeTruthy();
    expect(result.Icon).toBe(TYPE_DEFAULTS.agent.Icon);
    expect(result.monogram).toBeUndefined();
  });

  it('stage 2: returns type-default icon for unknown skill id', () => {
    const result = resolveIcon({ kind: 'skill', id: 'some-unknown-skill' });
    expect(result.Icon).toBeTruthy();
    expect(result.Icon).toBe(TYPE_DEFAULTS.skill.Icon);
    expect(result.monogram).toBeUndefined();
  });

  it('stage 2: returns type-default icon for unknown knowledge id', () => {
    const result = resolveIcon({ kind: 'knowledge', id: 'mystery-doc', group: 'misc' });
    expect(result.Icon).toBeTruthy();
    expect(result.Icon).toBe(TYPE_DEFAULTS.knowledge.Icon);
    expect(result.monogram).toBeUndefined();
  });

  it('stage 3: returns monogram badge for unknown kind', () => {
    const result = resolveIcon({ kind: 'unknown-type', id: 'foobar' });
    expect(result.Icon).toBeUndefined();
    expect(result.monogram).toBe('F');
    expect(typeof result.accentColor).toBe('string');
  });

  it('stage 3: returns monogram badge when kind is missing', () => {
    const result = resolveIcon({ id: 'zulu' });
    expect(result.Icon).toBeUndefined();
    expect(result.monogram).toBe('Z');
  });

  it('stage 1 takes precedence over stage 2 for known id', () => {
    const explicitResult = resolveIcon({ kind: 'agent', id: 'reviewer' });
    const defaultResult  = resolveIcon({ kind: 'agent', id: 'unknown-xyz' });
    // reviewer should map to ShieldCheck, not the Users default
    expect(explicitResult.Icon).not.toBe(defaultResult.Icon);
    expect(explicitResult.Icon).toBe(ROLE_MAP.reviewer);
  });
});

// ── AC4 — Monogram Stability ──────────────────────────────────────────────────

describe('resolveIcon — AC4: Monogram badge is stable per id', () => {
  it('same id always produces the same monogram letter', () => {
    const id = 'unknown-entity-42';
    const results = Array.from({ length: 5 }, () => resolveIcon({ id }));
    const letters = results.map((r) => r.monogram);
    expect(new Set(letters).size).toBe(1);
    expect(letters[0]).toBe(id[0].toUpperCase());
  });

  it('same id always produces the same accent color', () => {
    const id = 'persistent-node';
    const results = Array.from({ length: 5 }, () => resolveIcon({ id }));
    const colors = results.map((r) => r.accentColor);
    expect(new Set(colors).size).toBe(1);
  });

  it('different ids generally produce different colors', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const colors = ids.map((id) => resolveIcon({ id }).accentColor);
    // With 9 palette slots and 5 different ids, expecting at least some variation
    // (not all the same). This is a sanity check; hash collisions are allowed.
    const unique = new Set(colors);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('monogram letter is uppercased first character of id', () => {
    // coder-x has no explicit ROLE_MAP entry as 'coder-x'; with no kind it falls
    // through to stage-3 monogram.
    const r1 = resolveIcon({ id: 'coder-x' });
    expect(r1.monogram).toBe('C');
    // Confirm with another unknown id + empty kind.
    const r = resolveIcon({ kind: '', id: 'mango' });
    expect(r.monogram).toBe('M');
  });
});

// ── AC5 — EntityIcon renders correctly ───────────────────────────────────────

describe('EntityIcon — AC5: Renders icon or monogram with aria-hidden', () => {
  it('renders without crashing for a known agent', async () => {
    await act(async () => {
      render(React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 16 }));
    });
  });

  it('rendered output has aria-hidden="true" for a known icon', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 16 }),
    );
    // lucide renders an <svg> element; EntityIcon passes aria-hidden to it.
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('rendered output has aria-hidden="true" for the type-default icon', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'skill', id: 'some-unknown-skill', size: 20 }),
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('default size (16px) applies when size prop is omitted', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'agent', id: 'coder' }),
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // lucide sets width/height attributes on the SVG
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
  });

  it('custom size is applied to the SVG', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 32 }),
    );
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
  });

  it('renders a monogram badge (span) for unknown kind', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'unknown-kind', id: 'foobar', size: 24 }),
    );
    // No svg for monogram; a span with the letter
    const svg   = container.querySelector('svg');
    const badge = container.querySelector('span[aria-hidden="true"]');
    expect(svg).toBeNull();
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('F');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
  });

  it('monogram badge renders with the correct letter', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: '', id: 'zeppelin', size: 16 }),
    );
    const badge = container.querySelector('span[aria-hidden="true"]');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('Z');
  });
});

// ── AC6 — Robustness ─────────────────────────────────────────────────────────

describe('EntityIcon — AC6: No crash for missing/empty props', () => {
  it('renders without crash when no props are passed', async () => {
    await expect(
      act(async () => {
        render(React.createElement(EntityIcon, {}));
      }),
    ).resolves.not.toThrow();
  });

  it('renders a valid element (not empty fragment) when no props are passed', async () => {
    const { container } = render(React.createElement(EntityIcon, {}));
    // Something must be in the DOM (no empty fragment that breaks layout)
    expect(container.firstChild).toBeTruthy();
  });

  it('renders without crash when only kind is passed (no id)', async () => {
    await expect(
      act(async () => {
        render(React.createElement(EntityIcon, { kind: 'agent' }));
      }),
    ).resolves.not.toThrow();
  });

  it('renders type-default icon when kind is known but id is missing', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'knowledge' }),
    );
    const svg = container.querySelector('svg');
    // Should fall back to knowledge default icon
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders without crash when only id is passed (no kind)', async () => {
    await expect(
      act(async () => {
        render(React.createElement(EntityIcon, { id: 'orphan-id' }));
      }),
    ).resolves.not.toThrow();
  });

  it('renders without crash when id is an empty string', async () => {
    await expect(
      act(async () => {
        render(React.createElement(EntityIcon, { id: '', kind: '' }));
      }),
    ).resolves.not.toThrow();
  });

  it('renders a valid element for empty-string id (monogram with placeholder)', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { id: '', kind: '' }),
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('does NOT make any fetch calls during render', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => { fetchCalled = true; return Promise.resolve({}); };

    try {
      await act(async () => {
        render(React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 16 }));
      });
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── AC7 — A11y / Floor ───────────────────────────────────────────────────────

describe('EntityIcon — AC7: A11y and floor', () => {
  it('icon output contains no meaningful text (only aria-hidden content)', async () => {
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 16 }),
    );
    // The SVG has aria-hidden; it should carry no text content that screen
    // readers would announce as meaningful.
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    // No visible text node directly inside the component wrapper
    // (lucide SVGs may have path elements, but no text elements)
    expect(container.querySelectorAll('text')).toHaveLength(0);
  });

  it('resolveIcon is deterministic (same input → same output, repeated calls)', () => {
    const input = { kind: 'skill', id: 'deploy', group: '' };
    const r1 = resolveIcon(input);
    const r2 = resolveIcon(input);
    expect(r1.Icon).toBe(r2.Icon);
    expect(r1.accentColor).toBe(r2.accentColor);
    expect(r1.monogram).toBe(r2.monogram);
  });

  it('no dangerouslySetInnerHTML in EntityIcon output', async () => {
    // Verify at the DOM level: no element has a dangerouslySetInnerHTML-set innerHTML.
    // We inspect the container for any <script> or unexpected raw HTML injection.
    const { container } = render(
      React.createElement(EntityIcon, { kind: 'agent', id: 'coder', size: 16 }),
    );
    expect(container.querySelector('script')).toBeNull();
    // SVG path elements are expected; script elements are not.
    expect(container.innerHTML).not.toContain('<script');
  });
});
