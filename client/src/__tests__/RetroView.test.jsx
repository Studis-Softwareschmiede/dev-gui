/**
 * RetroView.test.jsx — Unit tests for RetroView + TeamView Retro-Link + AppShell/useHashRouter.
 *
 * Covers (retro-view-frontend):
 *   AC1  — Retro-Link im TeamView-Kopfbereich navigiert auf 'retro' per Maus und Tastatur.
 *   AC2  — Route 'retro' in VIEWS + Doc-Kommentar; AppShell rendert <RetroView> bei view==='retro';
 *          RetroView NICHT in TILES.
 *   AC4  — Einmaliger GET /api/retro/runs beim Mount; absteigende Reihenfolge nach Datum;
 *          Datum, Slug, Quelle-Badge, Zähler je Eintrag; aria-busy/aria-live Ladezustand.
 *   AC5  — Auswahl (Maus + Tastatur) lädt GET /api/retro/runs/:slug; Report mit 3 Sektionen
 *          Agenten/Skills/Knowledge; je Eintrag Regel, Status-Badge, Provenance;
 *          leere Sektion weggelassen; aria-current auf aktivem Eintrag; statusMix.
 *   AC6  — metric != null → rate_per_100ep, baseline → neu angezeigt;
 *          metric == null → Platzhalter „noch keine Messdaten", kein Crash.
 *   AC7  — Leere runs-Liste → erkennbarer Hinweis; kein Crash.
 *   AC8  — Fetch-Fehler → Fehlermeldung; Shell bleibt bedienbar.
 *   AC9  — aria-current auf aktivem Eintrag; Tastatur Enter/Space; kein outline:none;
 *          Touch-Targets ≥ 44 px; Badges mit Text-Label.
 *   AC3  — geerbt aus app-shell-navigation (Browser-Verlauf + unbekannte Route → Panel),
 *          kein separater Unit-Test.
 *   AC10 — responsiv/Theme, jsdom hat keine Layout-Engine — visuell verifiziert
 *          (Styles konsistent zu TeamView).
 *   AC11 — Kein dangerouslySetInnerHTML/innerHTML; nur /api/retro/* aufgerufen.
 *
 * NOTE (jsdom-Limitation): jsdom hat keine Layout-Engine — Style-Property-Asserts beweisen kein
 * Scroll-/Layout-Verhalten; getestet werden Verhalten, Struktur, Rollen und aria, nicht Pixel.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// Mock TeamView dependency for AppShell routing tests
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: () => null,
}));
jest.unstable_mockModule('../Dashboard.jsx', () => ({
  Dashboard: () => null,
}));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({
  TriggerPanel: () => null,
}));

const { render }           = await import('@testing-library/react');
const React                = (await import('react')).default;
const { RetroView }        = await import('../RetroView.jsx');
const { TeamView }         = await import('../TeamView.jsx');
const { AppShell }         = await import('../AppShell.jsx');
const { parseHash, VIEWS } = await import('../useHashRouter.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RUNS = [
  {
    slug: 'retro/PR-Q1234-coder-R01',
    date: '2026-06-10',
    source: 'retro',
    counts: { agents: 2, skills: 0, knowledge: 1 },
    statusMix: { Applied: 2, Pending: 1 },
  },
  {
    slug: 'train/PR-Q1100-train',
    date: '2026-05-15',
    source: 'train',
    counts: { agents: 0, skills: 1, knowledge: 2 },
    statusMix: { Applied: 3 },
  },
];

// Runs pre-sorted descending by backend (as the API contract guarantees):
const RUNS_PRESORTED = [
  { slug: 'retro/newer', date: '2026-06-01', source: 'retro', counts: {}, statusMix: {} },
  { slug: 'retro/older', date: '2026-04-01', source: 'retro', counts: {}, statusMix: {} },
];

const REPORT_FULL = {
  slug: 'retro/PR-Q1234-coder-R01',
  date: '2026-06-10',
  source: 'retro',
  statusMix: { Applied: 2, Pending: 1 },
  agents: [
    {
      id: 'R01',
      rule: 'Kein Gold-Plating über die Spec hinaus.',
      status: 'Applied',
      provenance: 'coder',
      metric: {
        rate_per_100ep: 4.2,
        baseline: 8.1,
        neu: 4.2,
        status: 'Applied',
      },
    },
  ],
  skills: [
    {
      id: 'S01',
      rule: 'Teste Skalierungsverhalten.',
      status: 'Pending',
      provenance: 'reviewer',
      metric: null,
    },
  ],
  knowledge: [],  // empty → section omitted (AC5)
};

const REPORT_AGENTS_ONLY = {
  slug: 'train/PR-Q1100-train',
  date: '2026-05-15',
  source: 'train',
  statusMix: { Applied: 1 },
  agents: [
    {
      id: 'T01',
      rule: 'Schreibe vollständige Tests.',
      status: 'Applied',
      provenance: 'tester',
      metric: null,
    },
  ],
  skills: [],
  knowledge: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.location.hash = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

function makeRetroFetch({ runsBody, reportBody, runsOk = true, reportOk = true }) {
  return jest.fn(async (url) => {
    if (url === '/api/retro/runs') {
      return {
        ok: runsOk,
        status: runsOk ? 200 : 500,
        json: async () => runsBody,
      };
    }
    if (url.startsWith('/api/retro/runs/')) {
      return {
        ok: reportOk,
        status: reportOk ? 200 : 500,
        json: async () => reportBody,
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderRetro(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(RetroView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

// ── AC2 — useHashRouter VIEWS + parseHash ─────────────────────────────────────

describe('retro-view-frontend — AC2: Route registration in useHashRouter', () => {
  it('VIEWS array includes "retro"', () => {
    expect(VIEWS).toContain('retro');
  });

  it('parseHash returns "retro" for "#/retro"', () => {
    expect(parseHash('#/retro')).toBe('retro');
  });

  it('parseHash is case-insensitive for retro', () => {
    expect(parseHash('#/RETRO')).toBe('retro');
  });
});

// ── AC2 — AppShell renders RetroView for view === 'retro' ─────────────────────

describe('retro-view-frontend — AC2: AppShell renders RetroView', () => {
  beforeEach(() => {
    // Suppress /api/retro/runs fetch warnings from RetroView mount
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/retro/runs') {
        return Promise.resolve({ ok: true, json: async () => ({ runs: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
  });

  it('direct load with #/retro renders Retro-Ansicht', async () => {
    window.location.hash = '#/retro';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /retro-ansicht/i })).toBeTruthy();
    });
  });

  it('panel still has exactly six tiles (RetroView is NOT a TILES entry)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    expect(tiles).toHaveLength(6);
    const ids = Array.from(tiles).map((t) => t.getAttribute('data-view'));
    expect(ids).not.toContain('retro');
  });
});

// ── AC1 — Retro-Link im TeamView-Kopfbereich ──────────────────────────────────

describe('retro-view-frontend — AC1: Retro-Link im TeamView-Kopfbereich', () => {
  beforeEach(() => {
    globalThis.fetch = makeRetroFetch({
      runsBody: { runs: RUNS },
    });
  });

  it('renders a "Retro" button in the TeamView header', async () => {
    // TeamView needs /api/team mock
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    // Wait for load
    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });
    expect(retroBtn).toBeTruthy();
  });

  it('clicking Retro button calls onNavigate("retro")', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });

    await act(async () => {
      fireEvent.click(retroBtn);
    });

    expect(onNavigate).toHaveBeenCalledWith('retro');
  });

  it('Enter key on Retro button calls onNavigate("retro")', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });

    await act(async () => {
      fireEvent.keyDown(retroBtn, { key: 'Enter' });
    });

    expect(onNavigate).toHaveBeenCalledWith('retro');
  });

  it('Space key on Retro button calls onNavigate("retro")', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });

    await act(async () => {
      fireEvent.keyDown(retroBtn, { key: ' ' });
    });

    expect(onNavigate).toHaveBeenCalledWith('retro');
  });

  it('Retro button has minHeight >= 44px (touch-target AC9)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });
    const minH = parseInt(retroBtn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('Retro button does not have outline:none (focus ring preserved AC9)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/team') return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const retroBtn = getByRole('button', { name: /^retro — self-improvement-historie$/i });
    expect(retroBtn.style.outline).not.toBe('none');
    expect(retroBtn.style.outline).not.toBe('0');
  });
});

// ── AC4 — Mount loads runs exactly once; descending date order ────────────────

describe('retro-view-frontend — AC4: Mount loads runs exactly once', () => {
  it('calls GET /api/retro/runs exactly once on mount', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    renderRetro();

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/retro/runs');
      expect(calls).toHaveLength(1);
    });
  });

  it('does NOT call GET /api/retro/runs again on re-render', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { rerender } = renderRetro();

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/retro/runs')).toHaveLength(1);
    });

    await act(async () => {
      rerender(React.createElement(RetroView, { onNavigate: jest.fn() }));
    });

    expect(globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/retro/runs')).toHaveLength(1);
  });

  it('shows aria-busy loading state during fetch', async () => {
    let resolveRuns;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/retro/runs') {
        await new Promise((r) => { resolveRuns = r; });
        return { ok: true, json: async () => ({ runs: RUNS }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderRetro();

    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveRuns(); });

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('renders run slugs in the nav list after load', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      const slugTexts = Array.from(container.querySelectorAll('nav button[data-slug]'))
        .map((b) => b.getAttribute('data-slug'));
      expect(slugTexts).toContain('retro/PR-Q1234-coder-R01');
      expect(slugTexts).toContain('train/PR-Q1100-train');
    });
  });

  it('renders runs in the API-provided order (descending date, AC4)', async () => {
    // The backend returns runs sorted descending by date (AC4 contract).
    // The component renders them in the order received — no client-side re-sort.
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS_PRESORTED } });

    const { container } = renderRetro();

    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll('nav button[data-slug]'));
      expect(buttons).toHaveLength(2);
      // Newer run (2026-06-01) first (API already sorted descending)
      expect(buttons[0].getAttribute('data-slug')).toBe('retro/newer');
      expect(buttons[1].getAttribute('data-slug')).toBe('retro/older');
    });
  });

  it('renders source badge with text label per run item (AC4, AC9)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      // Source badges are spans with aria-label containing "Quelle:"
      const badges = container.querySelectorAll('[aria-label^="Quelle:"]');
      expect(badges.length).toBeGreaterThan(0);
      // Badge text is not empty
      for (const badge of badges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('renders count text per run item (AC4)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      // First run has agents: 2, knowledge: 1 → count text
      const runButtons = container.querySelectorAll('nav button[data-slug]');
      const firstButton = runButtons[0];
      // The first run (retro/PR-Q1234) has agents and knowledge counts
      expect(firstButton.textContent).toMatch(/Agenten|Agent|Knowledge/i);
    });
  });
});

// ── AC5 — Selection loads report + 3 sections + empty section omitted ─────────

describe('retro-view-frontend — AC5: Selection loads report', () => {
  it('clicking a run calls GET /api/retro/runs/:slug', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/retro/runs/retro/PR-Q1234-coder-R01',
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('Enter key on run item loads report (keyboard AC5)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'),
        { key: 'Enter' },
      );
    });

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/retro/runs/retro/PR-Q1234-coder-R01',
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('Space key on run item loads report (keyboard AC5)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(
        container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'),
        { key: ' ' },
      );
    });

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/retro/runs/retro/PR-Q1234-coder-R01',
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('report shows Agenten section with rule text', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container, getByText } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // Agenten section heading
      expect(container.querySelector('[aria-label="Agenten"]')).toBeTruthy();
      // Rule text (no dangerouslySetInnerHTML — AC11)
      expect(getByText('Kein Gold-Plating über die Spec hinaus.')).toBeTruthy();
    });
  });

  it('report shows Skills section', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Skills"]')).toBeTruthy();
    });
  });

  it('Knowledge section is omitted when empty (AC5)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // Knowledge is empty in REPORT_FULL → section must not render
      expect(container.querySelector('[aria-label="Knowledge"]')).toBeNull();
    });
  });

  it('active run item carries aria-current (AC5, AC9)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      const btn = container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]');
      // aria-current='page' is semantically precise for navigation list items (AC9)
      expect(btn.getAttribute('aria-current')).toBe('page');
    });
  });

  it('non-active run item does NOT carry aria-current', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      const otherBtn = container.querySelector('button[data-slug="train/PR-Q1100-train"]');
      expect(otherBtn.getAttribute('aria-current')).toBeNull();
    });
  });

  it('statusMix is shown on run level (AC5)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // statusMix row is labelled (AC5)
      expect(container.querySelector('[aria-label="Status-Mix"]')).toBeTruthy();
    });
  });

  it('provenance is shown per entry (AC5)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container, getByText } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // provenance "coder" is shown in badge
      expect(getByText('coder')).toBeTruthy();
    });
  });

  it('stale-response guard: only the last-selected run report is shown (race condition)', async () => {
    // Simulate: first fetch is slow, second fetch is fast — only the second result must appear.
    let resolveFirst;
    const slowReport = { ...REPORT_AGENTS_ONLY };   // train run — would show "Schreibe vollständige Tests"
    const fastReport = { ...REPORT_FULL };           // retro run — shows "Kein Gold-Plating…"

    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/retro/runs') {
        return { ok: true, json: async () => ({ runs: RUNS }) };
      }
      if (url === '/api/retro/runs/train/PR-Q1100-train') {
        // First selection — slow; will be aborted before it resolves
        await new Promise((r) => { resolveFirst = r; });
        return { ok: true, json: async () => slowReport };
      }
      if (url === '/api/retro/runs/retro/PR-Q1234-coder-R01') {
        // Second selection — fast
        return { ok: true, json: async () => fastReport };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    // Select first run (slow) — then immediately select second run (fast)
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="train/PR-Q1100-train"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    // Let the fast fetch resolve first
    await waitFor(() => {
      expect(container.textContent).toMatch(/Kein Gold-Plating/);
    });

    // Now resolve the slow (stale) first fetch — it must NOT overwrite the current report
    await act(async () => {
      if (resolveFirst) resolveFirst();
      await new Promise((r) => setTimeout(r, 30));
    });

    // The detail pane must still show the second (fast) report, not the stale first
    expect(container.textContent).toMatch(/Kein Gold-Plating/);
    expect(container.textContent).not.toMatch(/Schreibe vollständige Tests/);
  });
});

// ── AC6 — Metric display + Phase-0 placeholder ───────────────────────────────

describe('retro-view-frontend — AC6: Metric display', () => {
  it('shows metric data when metric != null', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // Metric row exists (agents entry has metric)
      const metricRows = container.querySelectorAll('[aria-label="Metrik"]');
      expect(metricRows.length).toBeGreaterThan(0);
      // rate_per_100ep shown
      expect(container.textContent).toMatch(/4\.2\/100ep/);
    });
  });

  it('shows Phase-0 placeholder when metric === null (AC6)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      // Skills entry (S01) has metric: null → placeholder
      const placeholder = container.querySelector('[aria-label="Keine Messdaten"]');
      expect(placeholder).toBeTruthy();
      expect(placeholder.textContent).toMatch(/noch keine Messdaten/i);
    });
  });

  it('does NOT crash with metric === null (AC6)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_AGENTS_ONLY });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await expect(
      act(async () => {
        fireEvent.click(container.querySelector('button[data-slug="train/PR-Q1100-train"]'));
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });
});

// ── AC7 — Empty state ─────────────────────────────────────────────────────────

describe('retro-view-frontend — AC7: Empty state', () => {
  it('shows hint when runs list is empty', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: [] } });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });

    expect(container.querySelector('[role="status"]').textContent).toMatch(
      /keine.*läufe|noch keine/i,
    );
  });

  it('does not crash with empty runs list (AC7)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: [] } });

    await expect(
      act(async () => {
        renderRetro();
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });

  it('does not render nav buttons when runs empty', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: [] } });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    expect(container.querySelectorAll('button[data-slug]')).toHaveLength(0);
  });
});

// ── AC8 — Error state ─────────────────────────────────────────────────────────

describe('retro-view-frontend — AC8: Error state', () => {
  it('shows error alert when overview fetch fails (network error)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/retro/runs') throw new Error('Network error');
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shows error alert when overview fetch returns non-ok status', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: {}, runsOk: false });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('main landmark remains in DOM when fetch fails (shell stays bedienbar)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { getByRole } = renderRetro();

    await waitFor(() => {
      expect(getByRole('main', { name: /retro-ansicht/i })).toBeTruthy();
    });
  });

  it('detail pane shows error and list remains usable after report fetch fails', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/retro/runs') {
        return { ok: true, json: async () => ({ runs: RUNS }) };
      }
      throw new Error('Report error');
    });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });

    // List still usable — other run buttons still present
    expect(container.querySelector('button[data-slug="train/PR-Q1100-train"]')).toBeTruthy();
  });
});

// ── AC9 — A11y ────────────────────────────────────────────────────────────────

describe('retro-view-frontend — AC9: A11y', () => {
  it('main landmark has aria-label "Retro-Ansicht"', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: [] } });

    const { getByRole } = renderRetro();

    expect(getByRole('main', { name: /retro-ansicht/i })).toBeTruthy();
  });

  it('nav landmark is present with aria-label "Retro-Läufe"', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { getByRole } = renderRetro();

    await waitFor(() => {
      expect(getByRole('navigation', { name: /retro-läufe/i })).toBeTruthy();
    });
  });

  it('run buttons have minHeight >= 44px (touch-targets AC9)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('button[data-slug]')).toBeTruthy();
    });

    const runButtons = container.querySelectorAll('button[data-slug]');
    for (const btn of runButtons) {
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    }
  });

  it('run buttons do not have outline:none (focus ring preserved)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('button[data-slug]')).toBeTruthy();
    });

    const btn = container.querySelector('button[data-slug]');
    expect(btn.style.outline).not.toBe('none');
    expect(btn.style.outline).not.toBe('0');
  });

  it('source badges have text content (meaning not solely through colour, AC9)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS } });

    const { container } = renderRetro();

    await waitFor(() => {
      const sourceBadges = container.querySelectorAll('[aria-label^="Quelle:"]');
      expect(sourceBadges.length).toBeGreaterThan(0);
      for (const badge of sourceBadges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('status badges in report have text content (meaning not solely through colour, AC9)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      const statusBadges = container.querySelectorAll('[aria-label^="Status:"]');
      expect(statusBadges.length).toBeGreaterThan(0);
      for (const badge of statusBadges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });
});

// ── AC11 — Security floor: no dangerouslySetInnerHTML ─────────────────────────

describe('retro-view-frontend — AC11: Security floor', () => {
  it('RetroView has no dangerouslySetInnerHTML usage (rule text as text nodes)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Agenten"]')).toBeTruthy();
    });

    // dangerouslySetInnerHTML would set __html; jsdom exposes this as innerHTML with raw HTML.
    // Verify rule text is plain text (not HTML tags injected).
    const ruleElements = Array.from(container.querySelectorAll('p')).filter(
      (p) => p.textContent.includes('Gold-Plating'),
    );
    expect(ruleElements.length).toBeGreaterThan(0);
    // Plain text — no inner tags from rule string
    for (const el of ruleElements) {
      expect(el.children).toHaveLength(0); // no child HTML elements (just text node)
    }
  });

  it('only /api/retro/* URLs are called (no other API endpoints)', async () => {
    globalThis.fetch = makeRetroFetch({ runsBody: { runs: RUNS }, reportBody: REPORT_FULL });

    const { container } = renderRetro();

    await waitFor(() => {
      expect(container.querySelector('nav button[data-slug]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[data-slug="retro/PR-Q1234-coder-R01"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Agenten"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/retro\//);
    }
  });
});
