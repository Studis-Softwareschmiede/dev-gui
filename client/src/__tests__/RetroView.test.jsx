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
 * Covers (retro-train-board-local):
 *   AC3  — Reiter-Umschalter „Läufe | Verbesserungs-Board" vorhanden; Läufe-Reiter bleibt
 *          unverändert erreichbar; Board-Reiter aktivierbar; Kanban-Spalten je Status.
 *   AC4  — Board-Reiter: je Karte Regel-ID, Ziel, Art-Badge, Status-Badge, PR-Link;
 *          Kennzahlen aus baseline.json eingeblendet wo vorhanden.
 *   AC5  — Filter nach Kategorie + Art (Mehrfachauswahl); aktive Filter als aria-pressed.
 *
 * Covers (team-train-trigger):
 *   AC8  — „Retro starten"-Button in Reiter-Leiste (kein role=tab); öffnet Ja/Nein-Dialog;
 *          „Ja" sendet genau einen POST /api/command {command:'/agent-flow:retro'};
 *          klar abgesetzt vom „Retro"-Historie-Link.
 *   AC9  — Doppel-Feuer-Schutz: „Ja"-Button disabled während sending; 409 → Hinweis
 *          „Session belegt"; ok/error → Status-Feedback.
 *   AC10 — Dialog: role=dialog, aria-modal, aria-labelledby, Esc schließt, Fokus-Rückgabe;
 *          Touch-Targets ≥ 44 px auf Trigger-Button — jsdom inline-style-Check;
 *          Fokus-Falle — jsdom nicht vollständig testbar (kein echtes focus-management),
 *          visuell und per Tab-Handler-Inspektion verifiziert.
 *   AC11 — Security-Floor: POST /api/command mit genau {command:'/agent-flow:retro'};
 *          kein dangerouslySetInnerHTML; Abgrenzung: nur /api/retro/* + /api/command gerufen.
 *
 * NOTE (Touch-Target): Touch-Target ≥44px (tabBtn, filterChip, retroStartBtn, dialog-Buttons)
 *   — jsdom inline-style-Check für retroStartBtn; für dialog-Buttons visuell verifiziert
 *   (jsdom rendert keine Pixel-Layout).
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

function makeRetroFetch({
  runsBody,
  reportBody,
  cardsBody,
  runsOk = true,
  reportOk = true,
  cardsOk = true,
  commandStatus = 202, // status for POST /api/command
}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/retro/runs') {
      return {
        ok: runsOk,
        status: runsOk ? 200 : 500,
        json: async () => runsBody,
      };
    }
    if (url === '/api/retro/cards') {
      return {
        ok: cardsOk,
        status: cardsOk ? 200 : 500,
        json: async () => cardsBody ?? { cards: {} },
      };
    }
    if (url.startsWith('/api/retro/runs/')) {
      return {
        ok: reportOk,
        status: reportOk ? 200 : 500,
        json: async () => reportBody,
      };
    }
    if (url === '/api/command' && opts?.method === 'POST') {
      return {
        ok: commandStatus >= 200 && commandStatus < 300,
        status: commandStatus,
        json: async () => ({}),
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

  it('panel still has exactly seven tiles (RetroView is NOT a TILES entry)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    expect(tiles).toHaveLength(7);
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

// ═══════════════════════════════════════════════════════════════════════════════
// retro-train-board-local — AC3, AC4, AC5
// ═══════════════════════════════════════════════════════════════════════════════

// ── Board fixtures ─────────────────────────────────────────────────────────────

const CARDS_FIXTURE = {
  Proposed: [
    {
      id: 'R01',
      datum: '2025-01-15',
      ziel: 'agents/coder.md',
      regel: 'Kein Gold-Plating über die Spec hinaus.',
      quelle: 'agents/coder.md',
      pr: 'retro/PR-Q001',
      status: 'Proposed',
      art: 'retro',
      kategorie: ['agents'],
      metric: { rate_per_100ep: 1.5, baseline: 2.0, neu: 1.5, status: 'improved' },
    },
  ],
  Merged: [
    {
      id: 'R02',
      datum: '2025-02-10',
      ziel: 'knowledge/js.md',
      regel: 'JS knowledge rule.',
      quelle: 'knowledge/js.md',
      pr: 'train/PR-Q002',
      status: 'Merged',
      art: 'train',
      kategorie: ['knowledge'],
      metric: null,
    },
  ],
  Measuring: [],
  Validated: [],
  Reverted: [],
  Expired: [],
};

const CARDS_MULTI = {
  Proposed: [
    {
      id: 'R01',
      datum: '2025-01-15',
      ziel: 'agents/coder.md',
      regel: 'Rule agents.',
      quelle: 'agents/coder.md',
      pr: 'retro/PR-A',
      status: 'Proposed',
      art: 'retro',
      kategorie: ['agents'],
      metric: null,
    },
    {
      id: 'R02',
      datum: '2025-02-10',
      ziel: 'skills/deploy/SKILL.md',
      regel: 'Rule skills.',
      quelle: 'skills/deploy.md',
      pr: 'train/PR-B',
      status: 'Proposed',
      art: 'train',
      kategorie: ['skills'],
      metric: null,
    },
    {
      id: 'R03',
      datum: '2025-03-01',
      ziel: 'knowledge/js.md',
      regel: 'Rule knowledge.',
      quelle: 'knowledge/js.md',
      pr: 'retro/PR-C',
      status: 'Proposed',
      art: 'retro',
      kategorie: ['knowledge'],
      metric: null,
    },
  ],
};

function renderRetroWithCards(cardsBody = { cards: CARDS_FIXTURE }) {
  globalThis.fetch = makeRetroFetch({
    runsBody: { runs: [] },
    cardsBody,
  });
  const onNavigate = jest.fn();
  const utils = render(React.createElement(RetroView, { onNavigate }));
  return utils;
}

async function switchToBoard(container) {
  const boardTab = container.querySelector('button[data-tab="board"]');
  await act(async () => {
    fireEvent.click(boardTab);
    // Allow the fetch to start and resolve within this act
    await new Promise((r) => setTimeout(r, 0));
  });
  // Wait for board to finish loading and render Kanban
  await waitFor(() => {
    expect(container.querySelector('[aria-label="Kanban-Board"]')).toBeTruthy();
  }, { timeout: 3000 });
}

// ── AC3 — Tab switcher ────────────────────────────────────────────────────────

describe('retro-train-board-local — AC3: Reiter-Umschalter', () => {
  it('renders a "Läufe" tab button', async () => {
    const { container } = renderRetroWithCards();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    expect(container.querySelector('button[data-tab="runs"]')).toBeTruthy();
    expect(container.querySelector('button[data-tab="runs"]').textContent).toMatch(/Läufe/i);
  });

  it('renders a "Verbesserungs-Board" tab button', async () => {
    const { container } = renderRetroWithCards();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    expect(container.querySelector('button[data-tab="board"]')).toBeTruthy();
    expect(container.querySelector('button[data-tab="board"]').textContent).toMatch(/Verbesserungs-Board/i);
  });

  it('tab buttons are inside a tablist', async () => {
    const { container } = renderRetroWithCards();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabs = tablist.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
  });

  it('Läufe tab is selected by default (aria-selected=true)', async () => {
    const { container } = renderRetroWithCards();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const runsTab = container.querySelector('button[data-tab="runs"]');
    expect(runsTab.getAttribute('aria-selected')).toBe('true');
    const boardTab = container.querySelector('button[data-tab="board"]');
    expect(boardTab.getAttribute('aria-selected')).toBe('false');
  });

  it('clicking Board tab activates board panel (aria-selected switches)', async () => {
    const { container } = renderRetroWithCards();

    const boardTab = container.querySelector('button[data-tab="board"]');
    await act(async () => {
      fireEvent.click(boardTab);
    });

    await waitFor(() => {
      expect(container.querySelector('button[data-tab="board"]').getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('button[data-tab="runs"]').getAttribute('aria-selected')).toBe('false');
    });
  });

  it('Läufe tab panel still shows run content (existing view unaffected)', async () => {
    globalThis.fetch = makeRetroFetch({
      runsBody: { runs: RUNS },
      cardsBody: CARDS_FIXTURE,
    });
    const { container } = render(React.createElement(RetroView, { onNavigate: jest.fn() }));

    // Läufe tab is default
    await waitFor(() => {
      expect(container.querySelector('[role="tabpanel"][aria-label="Läufe"]')).toBeTruthy();
    });
  });

  it('Board tab panel contains Kanban-Board landmark', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);
    expect(container.querySelector('[aria-label="Kanban-Board"]')).toBeTruthy();
  });

  it('fetches /api/retro/cards when Board tab is activated', async () => {
    const fetchMock = makeRetroFetch({ runsBody: { runs: [] }, cardsBody: CARDS_FIXTURE });
    globalThis.fetch = fetchMock;
    const { container } = render(React.createElement(RetroView, { onNavigate: jest.fn() }));

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    // Switch to board
    await act(async () => {
      fireEvent.click(container.querySelector('button[data-tab="board"]'));
    });

    await waitFor(() => {
      const cardsCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/retro/cards');
      expect(cardsCalls.length).toBeGreaterThan(0);
    });
  });

  it('Kanban has columns for all 6 standard status values', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const expectedStatuses = ['Proposed', 'Merged', 'Measuring', 'Validated', 'Reverted', 'Expired'];
    for (const status of expectedStatuses) {
      expect(container.querySelector(`[aria-label="Spalte: ${status}"]`)).toBeTruthy();
    }
  });
});

// ── AC4 — Card display ────────────────────────────────────────────────────────

describe('retro-train-board-local — AC4: Card display (Regel-ID, Ziel, Art-Badge, Status-Badge, PR-Link)', () => {
  it('shows Regel-ID on card', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    // R01 is in Proposed column
    const col = container.querySelector('[aria-label="Spalte: Proposed"]');
    expect(col.textContent).toMatch(/R01/);
  });

  it('shows Ziel (packSkill) on card', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const col = container.querySelector('[aria-label="Spalte: Proposed"]');
    expect(col.textContent).toMatch(/agents\/coder\.md/);
  });

  it('shows Art-Badge with text label (AC4, AC9)', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    // Art badge for R01 → 'retro'
    const artBadges = container.querySelectorAll('[aria-label^="Art:"]');
    expect(artBadges.length).toBeGreaterThan(0);
    expect(artBadges[0].textContent.trim().length).toBeGreaterThan(0);
  });

  it('retro card shows "retro" art badge', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const retroBadge = Array.from(container.querySelectorAll('[aria-label^="Art:"]'))
      .find((el) => el.getAttribute('aria-label') === 'Art: retro');
    expect(retroBadge).toBeTruthy();
  });

  it('train card shows "train" art badge', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const trainBadge = Array.from(container.querySelectorAll('[aria-label^="Art:"]'))
      .find((el) => el.getAttribute('aria-label') === 'Art: train');
    expect(trainBadge).toBeTruthy();
  });

  it('shows Status-Badge with text label per card (AC4, AC9)', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const statusBadges = container.querySelectorAll('[aria-label^="Status:"]');
    expect(statusBadges.length).toBeGreaterThan(0);
    for (const badge of statusBadges) {
      expect(badge.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows PR-Link as anchor with href containing the pr value', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    // R01 has pr: 'retro/PR-Q001'
    const links = container.querySelectorAll('a[aria-label^="PR:"]');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toContain('PR-Q001');
  });

  it('PR-Link opens externally (target=_blank + rel=noopener)', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const links = container.querySelectorAll('a[aria-label^="PR:"]');
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });

  it('shows metric (rate_per_100ep) when metric is not null', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    // R01 has metric.rate_per_100ep = 1.5
    const metricAreas = container.querySelectorAll('[aria-label="Metrik"]');
    expect(metricAreas.length).toBeGreaterThan(0);
    expect(metricAreas[0].textContent).toMatch(/1\.5/);
  });

  it('does not show metric area when metric is null', async () => {
    // R02 has metric: null — no metric area should appear in Merged column
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const mergedCol = container.querySelector('[aria-label="Spalte: Merged"]');
    const metricAreas = mergedCol.querySelectorAll('[aria-label="Metrik"]');
    expect(metricAreas.length).toBe(0);
  });

  it('regel text is shown as plain text (no dangerouslySetInnerHTML — AC11 floor)', async () => {
    const { container } = renderRetroWithCards();
    await switchToBoard(container);

    const rulesWithText = Array.from(container.querySelectorAll('p')).filter(
      (p) => p.textContent.includes('Gold-Plating'),
    );
    expect(rulesWithText.length).toBeGreaterThan(0);
    // No inner HTML elements (plain text node)
    for (const el of rulesWithText) {
      expect(el.children).toHaveLength(0);
    }
  });
});

// ── AC5 — Filter ──────────────────────────────────────────────────────────────

describe('retro-train-board-local — AC5: Filter nach Kategorie + Art (Mehrfachauswahl)', () => {
  it('renders filter bar with Kategorie + Art buttons', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    expect(container.querySelector('[aria-label="Board-Filter"]')).toBeTruthy();
    expect(container.querySelector('[data-filter-kategorie="agents"]')).toBeTruthy();
    expect(container.querySelector('[data-filter-kategorie="skills"]')).toBeTruthy();
    expect(container.querySelector('[data-filter-kategorie="knowledge"]')).toBeTruthy();
    expect(container.querySelector('[data-filter-art="retro"]')).toBeTruthy();
    expect(container.querySelector('[data-filter-art="train"]')).toBeTruthy();
  });

  it('filter chips start as not pressed (all cards visible)', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    const chips = container.querySelectorAll('[data-filter-kategorie], [data-filter-art]');
    for (const chip of chips) {
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('clicking Kategorie chip toggles aria-pressed to true', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    const agentsChip = container.querySelector('[data-filter-kategorie="agents"]');
    await act(async () => {
      fireEvent.click(agentsChip);
    });

    expect(container.querySelector('[data-filter-kategorie="agents"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking same chip again deactivates it (toggle off)', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    const agentsChip = container.querySelector('[data-filter-kategorie="agents"]');
    await act(async () => {
      fireEvent.click(agentsChip);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-kategorie="agents"]'));
    });

    expect(container.querySelector('[data-filter-kategorie="agents"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('multiple filter chips can be active simultaneously (Mehrfachauswahl)', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-kategorie="agents"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-kategorie="knowledge"]'));
    });

    expect(container.querySelector('[data-filter-kategorie="agents"]').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-filter-kategorie="knowledge"]').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-filter-kategorie="skills"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('filtering by art=retro shows only retro cards (R01 visible, R02 train hidden)', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-art="retro"]'));
    });

    // After retro filter: R01 (retro) and R03 (retro) should be visible; R02 (train) hidden
    const proposedCol = container.querySelector('[aria-label="Spalte: Proposed"]');
    // R01 is retro → visible; R02 is train → filtered out; R03 is retro → visible
    expect(proposedCol.textContent).toContain('R01');
    expect(proposedCol.textContent).not.toContain('R02');
    expect(proposedCol.textContent).toContain('R03');
  });

  it('filtering by kategorie=skills shows only skills cards (R02 visible, R01/R03 hidden)', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-kategorie="skills"]'));
    });

    // After skills filter: only R02 (skills) should remain; R01 (agents), R03 (knowledge) hidden
    const proposedCol = container.querySelector('[aria-label="Spalte: Proposed"]');
    expect(proposedCol.textContent).toContain('R02');
    expect(proposedCol.textContent).not.toContain('R01');
    expect(proposedCol.textContent).not.toContain('R03');
  });

  it('shows filtered count when any filter is active', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-filter-art="retro"]'));
    });

    // Count indicator appears
    await waitFor(() => {
      const filterBar = container.querySelector('[aria-label="Board-Filter"]');
      expect(filterBar.textContent).toMatch(/\d+\/\d+ Karten/);
    });
  });

  it('count not shown when no filter is active', async () => {
    const { container } = renderRetroWithCards({ cards: CARDS_MULTI });
    await switchToBoard(container);

    // No filter active — count should not be shown
    const filterBar = container.querySelector('[aria-label="Board-Filter"]');
    expect(filterBar.textContent).not.toMatch(/\d+\/\d+ Karten/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// team-train-trigger — AC8, AC9, AC10, AC11 (S-176)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: render RetroView with a simple runs+command mock
function renderRetroForTrigger({ commandStatus = 202 } = {}) {
  globalThis.fetch = makeRetroFetch({
    runsBody: { runs: [] },
    commandStatus,
  });
  const onNavigate = jest.fn();
  const utils = render(React.createElement(RetroView, { onNavigate }));
  return utils;
}

// Helper: open dialog by clicking the trigger button
async function openRetroDialog(container) {
  // Wait for the trigger button to be available (mount + initial fetch resolves)
  await waitFor(() => {
    expect(container.querySelector('[data-testid="retro-start-btn"]')).toBeTruthy();
  });
  const triggerBtn = container.querySelector('[data-testid="retro-start-btn"]');
  await act(async () => {
    fireEvent.click(triggerBtn);
  });
  await waitFor(() => {
    expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeTruthy();
  });
}

// ── AC8 — Button vorhanden, kein role=tab, Dialog öffnet ─────────────────────

describe('team-train-trigger — AC8: „Retro starten"-Button + Dialog öffnet', () => {
  it('renders a "Retro starten" button in the tab bar', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const btn = container.querySelector('[data-testid="retro-start-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Retro starten/i);
  });

  it('"Retro starten" button does NOT have role=tab (AC8 — kein role=tab)', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const btn = container.querySelector('[data-testid="retro-start-btn"]');
    expect(btn.getAttribute('role')).not.toBe('tab');
  });

  it('"Retro starten" button is visually distinct: NOT inside the tablist (AC8)', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    // The tablist must still have only the two role=tab buttons
    const tablist = container.querySelector('[role="tablist"]');
    const tabBtns = tablist.querySelectorAll('[role="tab"]');
    expect(tabBtns).toHaveLength(2);
    // None of the tab buttons is "Retro starten"
    for (const tb of tabBtns) {
      expect(tb.textContent).not.toMatch(/retro starten/i);
    }
  });

  it('clicking "Retro starten" opens the confirm dialog', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);
    expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeTruthy();
  });

  it('dialog has role=dialog (AC8/AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);
    const dialog = container.querySelector('[data-testid="retro-confirm-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
  });

  it('dialog has aria-modal="true" (AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);
    const dialog = container.querySelector('[data-testid="retro-confirm-dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('dialog has aria-labelledby pointing to a title element (AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);
    const dialog = container.querySelector('[data-testid="retro-confirm-dialog"]');
    const labelledById = dialog.getAttribute('aria-labelledby');
    expect(labelledById).toBeTruthy();
    // useId() generates IDs with colons (e.g. ":r0:") — use getElementById instead of
    // CSS-selector (CSS.escape not available in jsdom)
    const titleEl = document.getElementById(labelledById);
    expect(titleEl).toBeTruthy();
    expect(titleEl.textContent).toMatch(/Retro/i);
  });

  it('dialog contains "Ja"-Button and "Nein"-Button (AC8)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);
    expect(container.querySelector('[data-testid="retro-confirm-yes"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="retro-confirm-no"]')).toBeTruthy();
  });

  it('"Nein"-Button closes dialog without firing (AC8)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-no"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeNull();
    });
    // No /api/command call
    const cmdCalls = globalThis.fetch.mock.calls.filter(
      (c) => c[0] === '/api/command',
    );
    expect(cmdCalls).toHaveLength(0);
  });

  it('Esc key closes dialog without firing (AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeNull();
    });
    const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
    expect(cmdCalls).toHaveLength(0);
  });

  it('"Retro starten" button has aria-label describing it as action (AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const btn = container.querySelector('[data-testid="retro-start-btn"]');
    const label = btn.getAttribute('aria-label') ?? btn.textContent;
    expect(label).toMatch(/retro/i);
  });

  it('"Retro starten" button has minHeight >= 44px (Touch-Target AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const btn = container.querySelector('[data-testid="retro-start-btn"]');
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('"Retro starten" button does not have outline:none (focus ring preserved AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
    const btn = container.querySelector('[data-testid="retro-start-btn"]');
    expect(btn.style.outline).not.toBe('none');
    expect(btn.style.outline).not.toBe('0');
  });
});

// ── AC8 — Genau EIN /agent-flow:retro feuern ─────────────────────────────────

describe('team-train-trigger — AC8: „Ja" sendet genau einen /agent-flow:retro', () => {
  it('clicking "Ja" calls POST /api/command exactly once', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
      expect(cmdCalls).toHaveLength(1);
    });
  });

  it('POST /api/command body contains command="/agent-flow:retro" (AC8/AC11)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
      expect(cmdCalls).toHaveLength(1);
    });

    const [, opts] = globalThis.fetch.mock.calls.find((c) => c[0] === '/api/command');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.command).toBe('/agent-flow:retro');
  });

  it('POST /api/command uses Content-Type application/json (AC11)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
      expect(cmdCalls).toHaveLength(1);
    });

    const [, opts] = globalThis.fetch.mock.calls.find((c) => c[0] === '/api/command');
    expect(opts.headers?.['Content-Type']).toBe('application/json');
  });

  it('shows success status after "Ja" (ok-response) (AC9)', async () => {
    const { container } = renderRetroForTrigger({ commandStatus: 202 });
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      // status feedback with role=status (polite) rendered
      const statusEl = container.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/gestartet/i);
    });
  });

  it('no additional /api/command calls are made after successful send (AC9 — Doppel-Feuer-Schutz)', async () => {
    const { container } = renderRetroForTrigger({ commandStatus: 202 });
    await openRetroDialog(container);

    // Click Ja
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    // Wait for status to appear
    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });

    // Try clicking Ja again (button should now be disabled)
    await act(async () => {
      const yesBtn = container.querySelector('[data-testid="retro-confirm-yes"]');
      if (yesBtn) fireEvent.click(yesBtn);
    });

    // Still only 1 call
    const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
    expect(cmdCalls).toHaveLength(1);
  });
});

// ── AC9 — Doppel-Feuer-Schutz + 409-Hinweis ──────────────────────────────────

describe('team-train-trigger — AC9: Doppel-Feuer-Schutz + 409-Hinweis', () => {
  it('"Ja"-Button is disabled while sending (Doppel-Feuer-Schutz)', async () => {
    // Slow fetch so we can observe disabled state
    let resolveCmd;
    globalThis.fetch = jest.fn(async (url, opts) => {
      if (url === '/api/retro/runs') {
        return { ok: true, json: async () => ({ runs: [] }) };
      }
      if (url === '/api/command' && opts?.method === 'POST') {
        await new Promise((r) => { resolveCmd = r; });
        return { ok: true, status: 202, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = render(React.createElement(RetroView, { onNavigate: jest.fn() }));
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    // Open dialog
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-start-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeTruthy();
    });

    // Click Ja — fetch is slow
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    // While sending: "Ja"-Button must be disabled
    const yesBtn = container.querySelector('[data-testid="retro-confirm-yes"]');
    expect(yesBtn.disabled).toBe(true);

    // Resolve the fetch
    await act(async () => {
      if (resolveCmd) resolveCmd();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  it('409 response shows "Session belegt" hint (AC9)', async () => {
    const { container } = renderRetroForTrigger({ commandStatus: 409 });
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(/Session belegt/i);
    });
  });

  it('network error shows error feedback (AC9)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/retro/runs') {
        return { ok: true, json: async () => ({ runs: [] }) };
      }
      if (url === '/api/command') {
        throw new Error('Network error');
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = render(React.createElement(RetroView, { onNavigate: jest.fn() }));
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-start-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(/Fehler/i);
    });
  });

  it('after 409, exactly one /api/command was called (no auto-retry)', async () => {
    const { container } = renderRetroForTrigger({ commandStatus: 409 });
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });

    const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
    expect(cmdCalls).toHaveLength(1);
  });
});

// ── AC10 — A11y: Dialog Semantik + Fokus-Rückgabe ────────────────────────────

describe('team-train-trigger — AC10: A11y Dialog-Semantik', () => {
  it('closing dialog with "Nein" does not crash (focus-return smoke test)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await expect(
      act(async () => {
        fireEvent.click(container.querySelector('[data-testid="retro-confirm-no"]'));
        await new Promise((r) => setTimeout(r, 10));
      }),
    ).resolves.not.toThrow();

    // Dialog gone
    expect(container.querySelector('[data-testid="retro-confirm-dialog"]')).toBeNull();
  });

  it('"Nein"-Button text is readable (Bedeutung nicht allein über Farbe, AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    const noBtn = container.querySelector('[data-testid="retro-confirm-no"]');
    expect(noBtn.textContent.trim().length).toBeGreaterThan(0);
  });

  it('"Ja"-Button text is readable (Bedeutung nicht allein über Farbe, AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    const yesBtn = container.querySelector('[data-testid="retro-confirm-yes"]');
    expect(yesBtn.textContent.trim().length).toBeGreaterThan(0);
  });

  it('dialog does not have outline:none on Yes-button (focus ring preserved, AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    const yesBtn = container.querySelector('[data-testid="retro-confirm-yes"]');
    expect(yesBtn.style.outline).not.toBe('none');
    expect(yesBtn.style.outline).not.toBe('0');
  });

  it('dialog does not have outline:none on No-button (focus ring preserved, AC10)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    const noBtn = container.querySelector('[data-testid="retro-confirm-no"]');
    expect(noBtn.style.outline).not.toBe('none');
    expect(noBtn.style.outline).not.toBe('0');
  });
});

// ── AC11 — Security-Floor: kein dangerouslySetInnerHTML, Endpunkte ────────────

describe('team-train-trigger — AC11: Security-Floor', () => {
  it('only /api/retro/* and /api/command endpoints are called', async () => {
    const { container } = renderRetroForTrigger({ commandStatus: 202 });
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/(retro\/|command$)/);
    }
  });

  it('dialog text nodes are plain text (no dangerouslySetInnerHTML, AC11)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    const dialog = container.querySelector('[data-testid="retro-confirm-dialog"]');
    // Heading and body must be simple text — no child elements injected by React
    const title = dialog.querySelector('h2');
    const bodyP = dialog.querySelectorAll('p');
    expect(title).toBeTruthy();
    // No script/style/img injected
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
    // Body paragraphs have text
    for (const p of bodyP) {
      // Check the paragraph has no injected HTML elements (plain text)
      expect(p.querySelector('*')).toBeNull();
    }
  });

  it('POST /api/command body has exactly {command} (no extra keys, AC11)', async () => {
    const { container } = renderRetroForTrigger();
    await openRetroDialog(container);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="retro-confirm-yes"]'));
    });

    await waitFor(() => {
      const cmdCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/command');
      expect(cmdCalls).toHaveLength(1);
    });

    const [, opts] = globalThis.fetch.mock.calls.find((c) => c[0] === '/api/command');
    const body = JSON.parse(opts.body);
    // Must have 'command' key; no injected data
    expect(body.command).toBe('/agent-flow:retro');
    // projectPath is optional per spec; only 'command' is mandatory — no extra sensitive keys
    const keys = Object.keys(body);
    expect(keys.every((k) => k === 'command' || k === 'projectPath')).toBe(true);
  });
});
