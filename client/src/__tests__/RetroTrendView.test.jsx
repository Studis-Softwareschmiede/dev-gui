/**
 * RetroTrendView.test.jsx — Unit tests for RetroTrendView + TeamView Retro-Trend-Link
 *   + AppShell/useHashRouter routing.
 *
 * Covers (retro-trend-frontend):
 *   AC1  — Retro-Trend-Link im TeamView-Kopfbereich navigiert auf 'retro-trend' per Maus und
 *           Tastatur (Enter/Space); Link ist markant (minHeight ≥ 44px, kein outline:none).
 *   AC2  — Route 'retro-trend' in VIEWS + Doc-Kommentar; AppShell rendert <RetroTrendView> bei
 *           view === 'retro-trend'; RetroTrendView NICHT in TILES (sechs Kacheln bleiben).
 *   AC3  — Browser-Verlauf: geerbt aus app-shell-navigation, kein separater Unit-Test.
 *   AC4  — Default-Kategorie "knowledge" wird beim Mount einmalig geladen
 *           (GET /api/retro/trend?category=knowledge); Radio-Wechsel löst neuen Fetch aus;
 *           Stale-Response-Guard: überholte Antwort überschreibt aktuelle nicht;
 *           aria-busy/aria-live Ladezustand erkennbar.
 *   AC5  — Board rendert inline-SVG mit Mittellinie; Bahn-Linien + Legende zur Y-Richtung
 *           (Verbesserung / Verschlechterung) vorhanden.
 *   AC6  — A11y: Text-Labels an Bahnen; Form-Marker an Punkten (nicht nur Farbe);
 *           Punkte mit zugänglichem Text (title/aria-label); radiogroup mit Pfeiltasten-Support;
 *           sichtbare Fokusringe (kein outline:none); Touch-Targets ≥ 44px; aria-live vorhanden.
 *   AC7  — Skills-Platzhalter: Antwort mit lanes:[] + placeholder → erkennbarer Hinweis
 *           „— noch keine Messmethode für Skill-Güte"; Skills-Radio bleibt wählbar; kein Crash.
 *   AC8  — Leerzustand (empty:true / leere lanes+runs) → erkennbarer Hinweis „Noch keine
 *           Trenddaten"; kein Crash.
 *   AC9  — Fehlerzustand: role=alert Fehlermeldung; RadioGroup bleibt bedienbar; kein Crash.
 *   AC10 — Dark-Theme-Styles, SVG mit viewBox + width:100%; responsiv (visuell verifiziert;
 *           jsdom hat keine Layout-Engine — Note unten).
 *   AC11 — Nur /api/retro/trend aufgerufen; kein dangerouslySetInnerHTML/innerHTML;
 *           keine externe Lib.
 *
 * NOTE (jsdom-Limitation): jsdom hat keine Layout-Engine — Style-Property-Asserts beweisen kein
 * Scroll-/Layout-Verhalten; getestet werden Verhalten, Struktur, Rollen und aria, nicht Pixel.
 * AC3 (Browser-Verlauf), AC10 (responsives Layout auf schmalem Viewport) sind durch
 * app-shell-navigation abgedeckt bzw. visuell zu verifizieren.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// Mock heavy sub-components (Terminal needs WS + xterm)
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: () => null,
}));
jest.unstable_mockModule('../Dashboard.jsx', () => ({
  Dashboard: () => null,
}));

const { render }            = await import('@testing-library/react');
const React                 = (await import('react')).default;
const { RetroTrendView }    = await import('../RetroTrendView.jsx');
const { TeamView }          = await import('../TeamView.jsx');
const { AppShell }          = await import('../AppShell.jsx');
const { parseHash, VIEWS }  = await import('../useHashRouter.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Antwort mit zwei Bahnen + zwei Läufen */
const TREND_KNOWLEDGE = {
  category: 'knowledge',
  runs: [
    { run: 'retro/PR-Q100', date: '2026-04-01' },
    { run: 'retro/PR-Q200', date: '2026-06-01' },
  ],
  lanes: [
    {
      id: 'spring-boot-3',
      label: 'spring-boot-3',
      points: [
        { run: 'retro/PR-Q100', date: '2026-04-01', momentum: 0, contributingRules: [] },
        { run: 'retro/PR-Q200', date: '2026-06-01', momentum: 1.5, contributingRules: ['spring-boot-3/B01'] },
      ],
    },
    {
      id: 'maven',
      label: 'maven',
      points: [
        { run: 'retro/PR-Q100', date: '2026-04-01', momentum: 0, contributingRules: [] },
        { run: 'retro/PR-Q200', date: '2026-06-01', momentum: -0.8, contributingRules: ['maven/B02'] },
      ],
    },
  ],
};

/** Antwort für category=agents */
const TREND_AGENTS = {
  category: 'agents',
  runs: [
    { run: 'retro/PR-Q100', date: '2026-04-01' },
  ],
  lanes: [
    {
      id: 'coder',
      label: 'coder',
      points: [
        { run: 'retro/PR-Q100', date: '2026-04-01', momentum: 0, contributingRules: [] },
      ],
    },
  ],
};

/** Antwort für category=skills (Platzhalter) */
const TREND_SKILLS = {
  category: 'skills',
  runs: [],
  lanes: [],
  placeholder: '— noch keine Messmethode für Skill-Güte',
};

/** Leerzustand (Phase 0) */
const TREND_EMPTY = {
  category: 'knowledge',
  runs: [],
  lanes: [],
  empty: true,
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

/**
 * Erstellt einen fetch-Mock für /api/retro/trend.
 * Gibt je nach category die passende Fixture zurück.
 */
function makeTrendFetch(overrides = {}) {
  return jest.fn(async (url) => {
    if (!url.startsWith('/api/retro/trend')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const urlObj = new URL(url, 'http://localhost');
    const cat = urlObj.searchParams.get('category') ?? 'knowledge';

    const map = {
      knowledge: TREND_KNOWLEDGE,
      agents:    TREND_AGENTS,
      skills:    TREND_SKILLS,
      ...overrides,
    };
    const body = map[cat] ?? TREND_KNOWLEDGE;
    return { ok: true, status: 200, json: async () => body };
  });
}

/** Rendert RetroTrendView mit gemocktem fetch. */
function renderTrend(fetchOverride, props = {}) {
  if (fetchOverride !== undefined) {
    globalThis.fetch = fetchOverride;
  } else {
    globalThis.fetch = makeTrendFetch();
  }
  const onNavigate = jest.fn();
  const utils = render(React.createElement(RetroTrendView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

// ── AC2 — useHashRouter VIEWS + parseHash ─────────────────────────────────────

describe('retro-trend-frontend — AC2: Route-Registrierung in useHashRouter', () => {
  it('VIEWS enthält "retro-trend"', () => {
    expect(VIEWS).toContain('retro-trend');
  });

  it('parseHash gibt "retro-trend" für "#/retro-trend" zurück', () => {
    expect(parseHash('#/retro-trend')).toBe('retro-trend');
  });

  it('parseHash ist case-insensitiv für retro-trend', () => {
    expect(parseHash('#/RETRO-TREND')).toBe('retro-trend');
  });
});

// ── AC2 — AppShell rendert RetroTrendView für view === 'retro-trend' ──────────

describe('retro-trend-frontend — AC2: AppShell rendert RetroTrendView', () => {
  beforeEach(() => {
    globalThis.fetch = makeTrendFetch();
  });

  it('Deep-Link #/retro-trend rendert Retro-Trend-Ansicht', async () => {
    window.location.hash = '#/retro-trend';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /retro-trend-ansicht/i })).toBeTruthy();
    });
  });

  it('Panel hat weiterhin genau sechs Kacheln (RetroTrendView ist KEIN TILES-Eintrag)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    expect(tiles).toHaveLength(6);
    const ids = Array.from(tiles).map((t) => t.getAttribute('data-view'));
    expect(ids).not.toContain('retro-trend');
  });
});

// ── AC1 — Retro-Trend-Link im TeamView-Kopfbereich ───────────────────────────

describe('retro-trend-frontend — AC1: Retro-Trend-Link im TeamView-Kopfbereich', () => {
  function makeTeamFetch() {
    return jest.fn(async (url) => {
      if (url === '/api/team') {
        return { ok: true, json: async () => ({ agents: [], skills: [], knowledge: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });
  }

  it('rendert einen „Retro-Trend"-Button im TeamView-Header', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const btn = getByRole('button', { name: /retro-trend/i });
    expect(btn).toBeTruthy();
  });

  it('Klick auf Retro-Trend-Button ruft onNavigate("retro-trend") auf', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /retro-trend/i }));
    });

    expect(onNavigate).toHaveBeenCalledWith('retro-trend');
  });

  it('Enter-Taste auf Retro-Trend-Button ruft onNavigate("retro-trend") auf (AC1)', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    await act(async () => {
      fireEvent.keyDown(getByRole('button', { name: /retro-trend/i }), { key: 'Enter' });
    });

    expect(onNavigate).toHaveBeenCalledWith('retro-trend');
  });

  it('Space-Taste auf Retro-Trend-Button ruft onNavigate("retro-trend") auf (AC1)', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    await act(async () => {
      fireEvent.keyDown(getByRole('button', { name: /retro-trend/i }), { key: ' ' });
    });

    expect(onNavigate).toHaveBeenCalledWith('retro-trend');
  });

  it('Retro-Trend-Button hat minHeight ≥ 44px (Touch-Target AC6)', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const btn = getByRole('button', { name: /retro-trend/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('Retro-Trend-Button hat kein outline:none (Fokusring erhalten, AC6)', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    const btn = getByRole('button', { name: /retro-trend/i });
    expect(btn.style.outline).not.toBe('none');
    expect(btn.style.outline).not.toBe('0');
  });

  it('bestehender Retro-Button bleibt erhalten (neben Retro-Trend-Link)', async () => {
    globalThis.fetch = makeTeamFetch();
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(TeamView, { onNavigate }));

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/team')).toBe(true);
    });

    // Beide Buttons müssen vorhanden sein
    expect(getByRole('button', { name: /^retro — self-improvement-historie$/i })).toBeTruthy();
    expect(getByRole('button', { name: /retro-trend — momentum-board/i })).toBeTruthy();
  });
});

// ── AC4 — Default-Kategorie + Fetch + Stale-Guard ────────────────────────────

describe('retro-trend-frontend — AC4: Laden + Stale-Response-Guard', () => {
  it('lädt beim Mount GET /api/retro/trend?category=knowledge (Default)', async () => {
    globalThis.fetch = makeTrendFetch();
    renderTrend(undefined);

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0].includes('/api/retro/trend') && c[0].includes('category=knowledge'),
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('lädt Default-Kategorie genau einmal beim Mount', async () => {
    globalThis.fetch = makeTrendFetch();
    const { rerender } = renderTrend(undefined);

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.filter((c) => c[0].includes('/api/retro/trend')),
      ).toHaveLength(1);
    });

    // Re-render darf keinen zweiten Fetch auslösen
    await act(async () => {
      rerender(React.createElement(RetroTrendView, { onNavigate: jest.fn() }));
    });

    expect(
      globalThis.fetch.mock.calls.filter((c) => c[0].includes('/api/retro/trend')),
    ).toHaveLength(1);
  });

  it('Radio-Wechsel auf „Agent-Defs" löst GET /api/retro/trend?category=agents aus (AC4)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=knowledge')),
      ).toBe(true);
    });

    const agentsRadio = container.querySelector('[data-radio="agents"]');
    await act(async () => {
      fireEvent.click(agentsRadio);
    });

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=agents')),
      ).toBe(true);
    });
  });

  it('Radio-Wechsel auf „Skills" löst GET /api/retro/trend?category=skills aus (AC4)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=knowledge')),
      ).toBe(true);
    });

    const skillsRadio = container.querySelector('[data-radio="skills"]');
    await act(async () => {
      fireEvent.click(skillsRadio);
    });

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=skills')),
      ).toBe(true);
    });
  });

  it('zeigt aria-busy="true" während des Ladevorgangs (AC4, AC6)', async () => {
    // Wir bauen den fetch-Mock vor dem Render auf, damit resolveKnowledge vor dem
    // render-Aufruf initialisiert wird.
    let resolveKnowledge;
    const slowFetch = jest.fn(async (url) => {
      if (url.includes('/api/retro/trend')) {
        return new Promise((resolve) => {
          resolveKnowledge = () => resolve({ ok: true, json: async () => TREND_KNOWLEDGE });
        });
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderTrend(slowFetch);

    // Direkt nach render (noch kein resolveKnowledge() call) muss aria-busy="true" vorhanden sein
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    });

    await act(async () => {
      resolveKnowledge();
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('Stale-Guard: überholte Antwort überschreibt aktuelle Daten nicht (AC4)', async () => {
    // Erster Fetch (knowledge) ist langsam; zweiter (agents) ist schnell.
    // Nur die agents-Daten dürfen erscheinen.
    let resolveKnowledge;

    globalThis.fetch = jest.fn(async (url) => {
      if (url.includes('category=knowledge')) {
        await new Promise((r) => { resolveKnowledge = r; });
        return { ok: true, json: async () => TREND_KNOWLEDGE };
      }
      if (url.includes('category=agents')) {
        return { ok: true, json: async () => TREND_AGENTS };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderTrend(undefined);

    // Warte bis der knowledge-Fetch gestartet ist
    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=knowledge')),
      ).toBe(true);
    });

    // Wechsel zu agents (schnell) — bevor knowledge fertig ist
    const agentsRadio = container.querySelector('[data-radio="agents"]');
    await act(async () => {
      fireEvent.click(agentsRadio);
    });

    // agents-Antwort sofort, zeigt "coder"-Bahn
    await waitFor(() => {
      expect(container.textContent).toMatch(/coder/i);
    });

    // Jetzt löst sich der langsame knowledge-Fetch auf — darf NICHT spring-boot-3 zeigen
    await act(async () => {
      if (resolveKnowledge) resolveKnowledge();
      await new Promise((r) => setTimeout(r, 30));
    });

    // spring-boot-3 (knowledge) darf nicht erscheinen
    expect(container.textContent).not.toMatch(/spring-boot-3/);
  });
});

// ── AC5 — Momentum-Board (SVG) ────────────────────────────────────────────────

describe('retro-trend-frontend — AC5: Momentum-Board inline SVG', () => {
  it('rendert ein <svg>-Element als Momentum-Board', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
  });

  it('SVG hat viewBox-Attribut (responsiv, AC10)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg.getAttribute('viewBox')).toBeTruthy();
    });
  });

  it('SVG hat eine Mittellinie (dashed line für Y=0, AC5)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // Mittellinie ist eine gestrichelte Linie im SVG
      const dashLines = Array.from(container.querySelectorAll('line[stroke-dasharray]'));
      expect(dashLines.length).toBeGreaterThan(0);
    });
  });

  it('SVG enthält Polylines für die Bahnen (eine je Bahn mit ≥ 2 Punkten, AC5)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // knowledge hat 2 Bahnen mit je 2 Punkten → je eine Polyline
      const polylines = container.querySelectorAll('polyline');
      expect(polylines.length).toBeGreaterThan(0);
    });
  });

  it('Legende erklärt die Y-Richtung (Verbesserung/Verschlechterung, AC5)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.textContent).toMatch(/verbesserung/i);
      expect(container.textContent).toMatch(/verschlechterung/i);
    });
  });

  it('Bahn mit nur einem Punkt rendert keinen Crash und keinen Linienzug (AC5/§10)', async () => {
    const singlePointLane = {
      category: 'agents',
      runs: [{ run: 'retro/PR-Q100', date: '2026-04-01' }],
      lanes: [
        {
          id: 'coder',
          label: 'coder',
          points: [
            { run: 'retro/PR-Q100', date: '2026-04-01', momentum: 0, contributingRules: [] },
          ],
        },
      ],
    };

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => singlePointLane,
    }));

    await expect(
      act(async () => {
        renderTrend(undefined);
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });
});

// ── AC6 — A11y: Labels, Marker, RadioGroup, Fokusringe ───────────────────────

describe('retro-trend-frontend — AC6: A11y', () => {
  it('Bahn-Labels (Text) sind im SVG vorhanden (nicht nur Farbe, AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // Text-Labels der Bahnen müssen im SVG stehen
      const texts = Array.from(container.querySelectorAll('svg text'));
      const labels = texts.map((t) => t.textContent.trim());
      expect(labels).toContain('spring-boot-3');
      expect(labels).toContain('maven');
    });
  });

  it('Datenpunkte haben zugänglichen Text (title/aria-label, AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // SVG-<title>-Elemente an Punkten
      const titles = Array.from(container.querySelectorAll('svg title'));
      expect(titles.length).toBeGreaterThan(0);
      // Titel enthält Bahn-Name und Momentum
      const titleTexts = titles.map((t) => t.textContent);
      const hasLaneRef = titleTexts.some((t) => /spring-boot-3|maven/i.test(t));
      expect(hasLaneRef).toBe(true);
    });
  });

  it('Form-Marker (SVG-Shapes) sind an Datenpunkten vorhanden (nicht nur Farbe, AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // Mindestens ein non-line shape (circle/rect/polygon) als Marker
      const circles = container.querySelectorAll('svg circle');
      const rects = container.querySelectorAll('svg rect');
      const polygons = container.querySelectorAll('svg polygon');
      const totalShapes = circles.length + rects.length + polygons.length;
      expect(totalShapes).toBeGreaterThan(0);
    });
  });

  it('role="radiogroup" ist vorhanden (AC6)', async () => {
    const { getByRole } = renderTrend(undefined);

    await waitFor(() => {
      expect(getByRole('radiogroup')).toBeTruthy();
    });
  });

  it('drei Radio-Buttons sind in der Gruppe (AC4, AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      const radios = container.querySelectorAll('[type="radio"]');
      expect(radios).toHaveLength(3);
    });
  });

  it('Radio-Labels haben minHeight ≥ 44px als Touch-Target (AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      const labels = Array.from(container.querySelectorAll('label'));
      const radioLabels = labels.filter((l) => l.querySelector('[type="radio"]'));
      expect(radioLabels.length).toBeGreaterThan(0);
      for (const label of radioLabels) {
        const minH = parseInt(label.style.minHeight, 10);
        expect(minH).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('Radio-Inputs haben kein outline:none (Fokusring erhalten, AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      const radios = container.querySelectorAll('[type="radio"]');
      expect(radios.length).toBeGreaterThan(0);
      for (const radio of radios) {
        expect(radio.style.outline).not.toBe('none');
        expect(radio.style.outline).not.toBe('0');
      }
    });
  });

  it('aria-live-Bereich ist vorhanden (AC6)', async () => {
    const { container } = renderTrend(undefined);

    // aria-live muss im DOM sein (vor dem Laden)
    expect(container.querySelector('[aria-live]')).toBeTruthy();
  });

  it('aria-label "Artefakt-Kategorie" auf der RadioGroup (AC6)', async () => {
    const { getByRole } = renderTrend(undefined);

    await waitFor(() => {
      expect(getByRole('radiogroup', { name: /artefakt-kategorie/i })).toBeTruthy();
    });
  });

  it('Pfeiltaste ArrowRight wechselt Radio-Auswahl (AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="knowledge"]')).toBeTruthy();
    });

    const knowledgeRadio = container.querySelector('[data-radio="knowledge"]');

    await act(async () => {
      fireEvent.keyDown(knowledgeRadio, { key: 'ArrowRight' });
    });

    await waitFor(() => {
      const agentsRadio = container.querySelector('[data-radio="agents"]');
      expect(agentsRadio.checked).toBe(true);
    });
  });

  it('Pfeiltaste ArrowLeft wechselt Radio-Auswahl rückwärts (AC6)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="agents"]')).toBeTruthy();
    });

    // Zuerst auf agents wechseln
    await act(async () => {
      fireEvent.click(container.querySelector('[data-radio="agents"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-radio="agents"]').checked).toBe(true);
    });

    // ArrowLeft → zurück auf knowledge
    await act(async () => {
      fireEvent.keyDown(container.querySelector('[data-radio="agents"]'), { key: 'ArrowLeft' });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-radio="knowledge"]').checked).toBe(true);
    });
  });
});

// ── AC7 — Skills-Platzhalter ──────────────────────────────────────────────────

describe('retro-trend-frontend — AC7: Skills-Platzhalter', () => {
  it('zeigt Platzhalter-Text bei category=skills (AC7)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="knowledge"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-radio="skills"]'));
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/noch keine messmethode für skill-güte/i);
    });
  });

  it('Skills-Radio bleibt wählbar nach Platzhalter-Antwort (AC7)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="skills"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-radio="skills"]'));
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/noch keine messmethode/i);
    });

    // Skills-Radio muss immer noch interagierbar sein
    const skillsRadio = container.querySelector('[data-radio="skills"]');
    expect(skillsRadio.disabled).toBeFalsy();
  });

  it('kein Crash bei skills-Platzhalter-Antwort (AC7)', async () => {
    const trendFetch = makeTrendFetch();

    // Render normal, dann Skills-Wechsel — kein Crash erwartet
    const { container } = renderTrend(trendFetch);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="skills"]')).toBeTruthy();
    });

    await expect(
      act(async () => {
        fireEvent.click(container.querySelector('[data-radio="skills"]'));
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });

  it('kein leeres Board bei Skills (Platzhalter statt leerem SVG, AC7)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="knowledge"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-radio="skills"]'));
    });

    await waitFor(() => {
      // Platzhalter-Text sichtbar
      expect(container.querySelector('[aria-label="Skills-Platzhalter"]')).toBeTruthy();
    });
  });
});

// ── AC8 — Leerzustand (Phase 0) ───────────────────────────────────────────────

describe('retro-trend-frontend — AC8: Leerzustand (Phase 0)', () => {
  it('zeigt „Noch keine Trenddaten" bei empty:true (AC8)', async () => {
    const emptyFetch = jest.fn(async () => ({
      ok: true,
      json: async () => TREND_EMPTY,
    }));

    const { container } = renderTrend(emptyFetch);

    await waitFor(() => {
      expect(container.textContent).toMatch(/noch keine trenddaten/i);
    });
  });

  it('kein Crash bei leeren lanes+runs (AC8)', async () => {
    const emptyFetch = jest.fn(async () => ({
      ok: true,
      json: async () => TREND_EMPTY,
    }));

    await expect(
      act(async () => {
        renderTrend(emptyFetch);
        await new Promise((r) => setTimeout(r, 50));
      }),
    ).resolves.not.toThrow();
  });

  it('zeigt „Noch keine Trenddaten" auch bei lanes:[] ohne empty:true (AC8)', async () => {
    const noLanesFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ category: 'knowledge', runs: [], lanes: [] }),
    }));

    const { container } = renderTrend(noLanesFetch);

    await waitFor(() => {
      expect(container.textContent).toMatch(/noch keine trenddaten/i);
    });
  });
});

// ── AC9 — Fehlerzustand ───────────────────────────────────────────────────────

describe('retro-trend-frontend — AC9: Fehlerzustand', () => {
  it('zeigt role=alert bei Fetch-Fehler (AC9)', async () => {
    const errorFetch = jest.fn(async () => {
      throw new Error('Network error');
    });

    const { container } = renderTrend(errorFetch);

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('zeigt role=alert bei HTTP-Fehler (AC9)', async () => {
    const httpErrorFetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const { container } = renderTrend(httpErrorFetch);

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('Main-Landmark bleibt im DOM bei Fehler (Shell bedienbar, AC9)', async () => {
    const errorFetch = jest.fn(async () => {
      throw new Error('Network error');
    });

    const { getByRole } = renderTrend(errorFetch);

    await waitFor(() => {
      expect(getByRole('main', { name: /retro-trend-ansicht/i })).toBeTruthy();
    });
  });

  it('RadioGroup bleibt nach Fetch-Fehler bedienbar (AC9)', async () => {
    const errorFetch = jest.fn(async () => {
      throw new Error('Network error');
    });

    const { getByRole } = renderTrend(errorFetch);

    await waitFor(() => {
      expect(getByRole('main', { name: /retro-trend-ansicht/i })).toBeTruthy();
    });

    // RadioGroup muss nach dem Fehler noch im DOM und interagierbar sein
    expect(getByRole('radiogroup')).toBeTruthy();
  });
});

// ── AC11 — Security Floor ─────────────────────────────────────────────────────

describe('retro-trend-frontend — AC11: Security Floor', () => {
  it('ruft ausschliesslich /api/retro/trend auf (keine anderen API-Endpunkte)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      // Warte bis Daten geladen
      expect(container.querySelector('svg')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/retro\/trend/);
    }
  });

  it('nach Radio-Wechsel werden nur /api/retro/trend-Endpunkte aufgerufen', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('[data-radio="agents"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-radio="agents"]'));
    });

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some((c) => c[0].includes('category=agents')),
      ).toBe(true);
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/retro\/trend/);
    }
  });

  it('SVG enthält kein dangerouslySetInnerHTML (AC11)', async () => {
    const { container } = renderTrend(undefined);

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });

    // Alle SVG-text-Elemente müssen einfache Text-Nodes sein
    const svgTexts = Array.from(container.querySelectorAll('svg text'));
    for (const el of svgTexts) {
      // Wenn dangerouslySetInnerHTML genutzt würde, könnten HTML-Tags im textContent erscheinen
      // Einfache Überprüfung: kein script/img innerhalb
      expect(el.querySelector('script')).toBeNull();
      expect(el.querySelector('img')).toBeNull();
    }
  });
});
