/**
 * AppShell.test.jsx — Unit tests for AppShell, EntryPanel and hash routing.
 *
 * Covers (app-shell-navigation):
 *   - AC1: Entry panel renders exactly six tiles (GitHub, VPS, Cloudflare, Fabrik, Team,
 *          Deployments); each tile activatable via click and keyboard (Enter, Space).
 *          NavBar present on panel (settings-shell: gear always visible).
 *   - AC2: Activating "Fabrik (dev-gui)" tile renders the factory view.
 *   - AC3: Activating GitHub/VPS/Cloudflare tiles renders placeholder views
 *          (no backend calls).
 *   - AC4: NavBar present on every non-panel view; Home link navigates back to panel.
 *   - AC5: Deep-link via hash (#/factory, #/github, …) opens correct view.
 *          Root (#/ or empty hash) shows entry panel.
 *   - AC6 (a): Unknown route falls back to entry panel (no dead screen).
 *   - AC6 (b): Browser Back/Forward navigates between panel and views via hashchange.
 *   - parseHash / viewToHash unit tests.
 *
 * Covers (settings-shell):
 *   - AC1: Gear/settings button visible on entry panel and all views; activatable
 *          via Maus and keyboard.
 *   - AC2: Activating gear opens Settings view (hash #/settings, title "Einstellungen").
 *   - AC3: Deep-link #/settings opens Settings view; unknown route → panel fallback.
 *   - AC4: Settings view shows exactly four sections (GitHub, Cloudflare, Hetzner/VPS, SSH-Keys).
 *   - AC5: Entry panel has six tiles (after dashboard-deployment-tile), Settings is not a tile.
 *   - AC6: From Settings view navigation back to panel and gear remains visible.
 *
 * Covers (dashboard-deployment-tile):
 *   - AC1: Deployments tile present in entry panel; activatable via click and keyboard.
 *   - AC2: No separate Deployments extra-nav text-link in panel; exactly one Deployments element.
 *   - AC3: Activating Deployments tile navigates to #/deployments (DeploymentsView).
 *   - AC4: Panel shows exactly six tiles in order: GitHub, VPS, Cloudflare, Fabrik, Team,
 *          Deployments.
 *   - AC5: Deployments tile uses same button[data-view] markup as other tiles.
 *   - AC6: NavBar includes Deployments link; deep-link #/deployments works.
 *
 * Covers (team-view-frontend):
 *   - AC1: Team tile present in entry panel; activatable via mouse and keyboard.
 *   - AC2: Route #/team opens TeamView; AppShell renders TeamView via viewRegistry.
 *
 * Covers (parallel-agent-workflow — view-registry):
 *   - AC7: AppShell ohne pro-View switch-Kette/import; datengetrieben via VIEW_REGISTRY.
 *   - AC8: implizit — neue View nur via viewRegistry.js-Eintrag, kein AppShell-Edit.
 *   - AC9: alle Routen via Registry (github/vps/cloudflare/deployments/settings; retro + retro-trend in RetroView.test.jsx/RetroTrendView.test.jsx abgedeckt).
 *   - AC10: 6 Kacheln Reihenfolge github→vps→cloudflare→factory→team→deployments; Settings/Retro/Retro-Trend keine Kacheln.
 *   - AC11: FactoryView (RepoOverview) nur bei #/factory gemountet; Unmount bei Navigation weg.
 *          (projekt-cockpit-navigation AC1: #/factory zeigt jetzt Repo-Übersicht statt Terminal.)
 *   - AC12: A11y-neutral (aria-current/Fokus/Touch≥44px); keine neuen Secrets/Endpunkte.
 *
 * Covers (projekt-cockpit-navigation — AppShell-Ebene):
 *   - AC1: #/factory zeigt Repo-Übersicht (statt Terminal); vollständige Tests in ProjektCockpit.test.jsx.
 *   - AC2: #/factory/<repo> Deep-Link und Rückweg; vollständige Tests in ProjektCockpit.test.jsx.
 *   - AC3: Cockpit mit Reitern; vollständige Tests in ProjektCockpit.test.jsx.
 *
 * Terminal, TriggerPanel and Dashboard are mocked to avoid WS/DOM complexity.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components (Terminal needs WS + xterm; Dashboard/TriggerPanel need fetch)
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: () => null,
}));
jest.unstable_mockModule('../Dashboard.jsx', () => ({
  Dashboard: () => null,
}));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({
  TriggerPanel: () => null,
}));
// TeamView mocked to avoid /api/team fetch in AppShell tests (TeamView tests are separate)
jest.unstable_mockModule('../TeamView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    TeamView: () => R.createElement('main', { 'aria-label': 'Team-Ansicht' }, 'Team (Mock)'),
  };
});

// Dynamic imports AFTER mock declarations (ESM VM-modules requirement)
const { render }              = await import('@testing-library/react');
const React                   = (await import('react')).default;
const { AppShell }            = await import('../AppShell.jsx');
const { parseHash, viewToHash, VIEWS } = await import('../useHashRouter.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

let _origFetch;

/** Reset hash to root before each test; mock fetch to avoid act() warnings from SettingsView. */
beforeEach(() => {
  window.location.hash = '';
  // SettingsView now calls fetch on mount. Mock it globally so act() warnings are suppressed.
  _origFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
});

afterEach(() => {
  window.location.hash = '';
  globalThis.fetch = _origFetch;
});

// ── parseHash unit tests ──────────────────────────────────────────────────────

describe('parseHash', () => {
  it('returns "panel" for empty string', () => {
    expect(parseHash('')).toBe('panel');
  });

  it('returns "panel" for "#"', () => {
    expect(parseHash('#')).toBe('panel');
  });

  it('returns "panel" for "#/"', () => {
    expect(parseHash('#/')).toBe('panel');
  });

  it('returns "factory" for "#/factory"', () => {
    expect(parseHash('#/factory')).toBe('factory');
  });

  it('returns "github" for "#/github"', () => {
    expect(parseHash('#/github')).toBe('github');
  });

  it('returns "vps" for "#/vps"', () => {
    expect(parseHash('#/vps')).toBe('vps');
  });

  it('returns "cloudflare" for "#/cloudflare"', () => {
    expect(parseHash('#/cloudflare')).toBe('cloudflare');
  });

  it('returns "panel" for unknown route "#/unknown"', () => {
    expect(parseHash('#/unknown')).toBe('panel');
  });

  it('is case-insensitive', () => {
    expect(parseHash('#/FACTORY')).toBe('factory');
    expect(parseHash('#/GitHub')).toBe('github');
  });

  it('returns "settings" for "#/settings"', () => {
    expect(parseHash('#/settings')).toBe('settings');
  });
});

describe('viewToHash', () => {
  it('maps "panel" to "#/"', () => {
    expect(viewToHash('panel')).toBe('#/');
  });

  it('maps "factory" to "#/factory"', () => {
    expect(viewToHash('factory')).toBe('#/factory');
  });

  for (const view of VIEWS.filter((v) => v !== 'panel')) {
    it(`maps "${view}" to "#/${view}"`, () => {
      expect(viewToHash(view)).toBe(`#/${view}`);
    });
  }
});

// ── AC1 — Entry panel with exactly six tiles (incl. Deployments) ─────────────

describe('AppShell — AC1: Entry panel tiles', () => {
  it('shows the entry panel on the root route (NavBar present for gear)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    // NavBar is now always present (gear visible from entry panel — settings-shell AC1)
    expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
  });

  it('renders exactly six tile buttons (gear is a separate nav button, not a tile)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    // Tile buttons are inside the entry panel main landmark
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    expect(tiles).toHaveLength(6);
  });

  it('renders tile labelled "GitHub"', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /^github/i })).toBeTruthy();
  });

  it('renders tile labelled "VPS"', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /^vps/i })).toBeTruthy();
  });

  it('renders tile labelled "Cloudflare"', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /^cloudflare/i })).toBeTruthy();
  });

  it('renders tile labelled "Fabrik (dev-gui)"', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /fabrik.*dev-gui/i })).toBeTruthy();
  });

  it('renders tile labelled "Team"', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /^team/i })).toBeTruthy();
  });

  it('renders tile labelled "Deployments" (AC1)', () => {
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /^deployments/i })).toBeTruthy();
  });

  it('Deployments tile is the last (sixth) tile in order (AC4)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = Array.from(panel.querySelectorAll('button[data-view]'));
    expect(tiles).toHaveLength(6);
    const ids = tiles.map((t) => t.getAttribute('data-view'));
    expect(ids).toEqual(['github', 'vps', 'cloudflare', 'factory', 'team', 'deployments']);
  });

  it('Deployments IS a tile (button[data-view="deployments"]) in the panel (AC1/AC2)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    // Deployments MUST appear as a tile button
    const deploymentsTile = panel.querySelector('button[data-view="deployments"]');
    expect(deploymentsTile).toBeTruthy();
    // Deployments must NOT appear as a text-link in the panel (AC2)
    const deploymentLinks = panel.querySelectorAll('a[href="#/deployments"]');
    expect(deploymentLinks.length).toBe(0);
  });

  it('Deployments tile in the panel navigates to #/deployments on click (AC3)', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const deploymentsTile = panel.querySelector('button[data-view="deployments"]');
    expect(deploymentsTile).toBeTruthy();

    await act(async () => {
      fireEvent.click(deploymentsTile);
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/deployments');
    });
  });

  it('Deployments tile navigates to #/deployments on Enter key (AC1)', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const deploymentsTile = getByRole('button', { name: /^deployments/i });

    await act(async () => {
      fireEvent.keyDown(deploymentsTile, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/deployments');
    });
  });

  it('Deployments tile navigates to #/deployments on Space key (AC1)', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const deploymentsTile = getByRole('button', { name: /^deployments/i });

    await act(async () => {
      fireEvent.keyDown(deploymentsTile, { key: ' ' });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/deployments');
    });
  });

  it('each tile is focusable (not disabled)', () => {
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    for (const tile of tiles) {
      expect(tile.disabled).toBe(false);
    }
  });

  it('activates tile on Enter key', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const githubTile = getByRole('button', { name: /^github/i });

    await act(async () => {
      fireEvent.keyDown(githubTile, { key: 'Enter' });
    });

    // Should navigate to github view — NavBar visible
    await waitFor(() => {
      expect(window.location.hash).toBe('#/github');
    });
  });

  it('activates tile on Space key', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const vpsTile = getByRole('button', { name: /^vps/i });

    await act(async () => {
      fireEvent.keyDown(vpsTile, { key: ' ' });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/vps');
    });
  });
});

// ── AC2 — Fabrik tile opens FactoryView ───────────────────────────────────────

describe('AppShell — AC2: Factory view', () => {
  it('clicking Fabrik tile shows the factory view (NavBar + factory content)', async () => {
    window.location.hash = '';
    const { getByRole, queryByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /fabrik.*dev-gui/i }));
    });

    await waitFor(() => {
      // NavBar is now visible
      expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
      // Entry panel is gone
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeNull();
    });
  });

  it('Fabrik view sets hash to #/factory', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /fabrik.*dev-gui/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/factory');
    });
  });
});

// ── AC3 — Placeholder views (no backend calls) ───────────────────────────────

describe('AppShell — AC3: Placeholder views', () => {
  // GitHub-Ansicht ist kein Platzhalter mehr — es enthält ein Anlege-Formular (github-repo-create).
  // Cloudflare-Ansicht ist kein Platzhalter mehr — view-cloudflare #108 implementiert.
  // VPS-Ansicht ist kein Platzhalter mehr — sie enthält Machine-Listing + Create-Formular (#99).
  const placeholders = [
  ];

  for (const { tile, view, label } of placeholders) {
    it(`clicking ${view} tile renders placeholder view`, async () => {
      window.location.hash = '';
      const { getByRole } = render(React.createElement(AppShell));

      await act(async () => {
        fireEvent.click(getByRole('button', { name: tile }));
      });

      await waitFor(() => {
        expect(window.location.hash).toBe(view);
        expect(getByRole('main', { name: label })).toBeTruthy();
      });
    });

    it(`${view} placeholder contains "folgt" hint`, async () => {
      window.location.hash = view;
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      const { getByRole } = render(React.createElement(AppShell));

      await waitFor(() => {
        const main = getByRole('main', { name: label });
        expect(main.textContent).toMatch(/folgt/i);
      });
    });
  }

  // Cloudflare: kein Platzhalter mehr — zeigt Inventar-UI (view-cloudflare #108, AC5–AC9)
  it('clicking #/cloudflare tile renders Cloudflare inventory view', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /^cloudflare/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/cloudflare');
      expect(getByRole('main', { name: /cloudflare-ansicht/i })).toBeTruthy();
    });
  });

  // VPS-Ansicht (#99): kein Platzhalter mehr — zeigt Machine-Listing + Create-Button
  it('clicking #/vps tile renders VPS view with h1 heading "VPS"', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /^vps/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/vps');
      expect(getByRole('main', { name: /vps-ansicht/i })).toBeTruthy();
      // h1-Heading "VPS" vorhanden
      expect(getByRole('heading', { name: /^vps$/i })).toBeTruthy();
    });
  });

  // GitHub: kein Platzhalter — zeigt Repo-Liste + Andockpunkt „Neues Repo" (github-repos-overview AC4)
  it('clicking #/github tile renders GitHub view with repo list and new-repo anchor', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /^github/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/github');
      expect(getByRole('main', { name: /github-ansicht/i })).toBeTruthy();
      // AC4: „+ Neues Repo"-Button über der Liste ist sichtbar
      expect(getByRole('button', { name: /\+ neues repo/i })).toBeTruthy();
    });
  });
});

// ── AC4 — NavBar on all views; Home returns to panel ─────────────────────────

describe('AppShell — AC4: Navigation', () => {
  const views = ['factory', 'github', 'vps', 'cloudflare'];

  for (const v of views) {
    it(`NavBar is visible on ${v} view`, async () => {
      window.location.hash = `#/${v}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      const { getByRole } = render(React.createElement(AppShell));
      await waitFor(() => {
        expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
      });
    });

    it(`NavBar on ${v} contains all tile + extra-nav links`, async () => {
      window.location.hash = `#/${v}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      const { getByRole } = render(React.createElement(AppShell));
      await waitFor(() => {
        const nav = getByRole('navigation', { name: /haupt-navigation/i });
        expect(nav.textContent).toMatch(/github/i);
        expect(nav.textContent).toMatch(/vps/i);
        expect(nav.textContent).toMatch(/cloudflare/i);
        expect(nav.textContent).toMatch(/fabrik/i);
        expect(nav.textContent).toMatch(/deployments/i);
        expect(nav.textContent).toMatch(/team/i);
      });
    });
  }

  it('Home link in NavBar navigates back to panel', async () => {
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole, queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
    });

    const homeLink = getByRole('link', { name: /zurück zum einstiegs-panel/i });
    await act(async () => {
      fireEvent.click(homeLink);
    });

    await waitFor(() => {
      // Panel is shown; NavBar still present (gear always visible — settings-shell AC1)
      expect(queryByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('NavBar marks active view with aria-current="page"', async () => {
    window.location.hash = '#/github';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const nav = getByRole('navigation', { name: /haupt-navigation/i });
      const githubLink = nav.querySelector('[aria-current="page"]');
      expect(githubLink).toBeTruthy();
      expect(githubLink.textContent).toMatch(/github/i);
    });
  });

  it('placeholder views have Home button leading back to panel', async () => {
    window.location.hash = '#/vps';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole, queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /vps-ansicht/i })).toBeTruthy();
    });

    const homeBtn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    await act(async () => {
      fireEvent.click(homeBtn);
    });

    await waitFor(() => {
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });
  });
});

// ── AC5 — Deep-link ───────────────────────────────────────────────────────────

describe('AppShell — AC5: Deep-link', () => {
  it('direct load with #/factory opens factory view', () => {
    window.location.hash = '#/factory';
    const { getByRole, queryByRole } = render(React.createElement(AppShell));
    expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
    expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeNull();
  });

  it('direct load with #/github opens GitHub placeholder', () => {
    window.location.hash = '#/github';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /github-ansicht/i })).toBeTruthy();
  });

  it('direct load with #/vps opens VPS placeholder', () => {
    window.location.hash = '#/vps';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /vps-ansicht/i })).toBeTruthy();
  });

  it('direct load with #/cloudflare opens Cloudflare placeholder', () => {
    window.location.hash = '#/cloudflare';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /cloudflare-ansicht/i })).toBeTruthy();
  });

  it('root route (#/) shows entry panel', () => {
    window.location.hash = '#/';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
  });

  it('empty hash shows entry panel', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
  });
});

// ── AC6 (a) — Unknown route falls back to panel ──────────────────────────────

describe('AppShell — AC6 (a): Unknown route fallback', () => {
  it('unknown route #/unknown shows entry panel (no blank screen)', () => {
    window.location.hash = '#/unknown';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
  });

  it('unknown route #/anything shows entry panel', () => {
    window.location.hash = '#/anything-totally-made-up';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
  });

  it('navigating back to panel after unknown route shows entry panel', async () => {
    window.location.hash = '#/unknown';
    const { getByRole } = render(React.createElement(AppShell));
    // Already on panel (fallback) — six tiles visible
    const tiles = getByRole('main', { name: /einstiegs-panel/i });
    expect(tiles).toBeTruthy();
  });
});

// ── AC6 (b) — Browser Back/Forward via hashchange ────────────────────────────

describe('AppShell — AC6 (b): Browser Back/Forward', () => {
  it('simulated browser Back to #/ shows entry panel', async () => {
    // Start at factory view
    window.location.hash = '#/factory';
    const { getByRole, queryByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
    });

    // Simulate browser Back: hash changes to root (as if the user pressed Back)
    await act(async () => {
      window.location.hash = '#/';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      // NavBar remains (gear always visible — settings-shell AC1); entry panel shown
      expect(queryByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
      expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('simulated browser Forward to #/factory shows factory view', async () => {
    // Start at root (panel)
    window.location.hash = '#/';
    const { getByRole, queryByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });

    // Simulate browser Forward: hash changes to #/factory
    await act(async () => {
      window.location.hash = '#/factory';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeNull();
      expect(getByRole('navigation', { name: /haupt-navigation/i })).toBeTruthy();
    });
  });
});

// ── settings-shell AC1 — Gear visible on entry panel ─────────────────────────

describe('settings-shell — AC1: Gear button visible on entry panel', () => {
  it('gear/settings button is present on the entry panel', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /einstellungen/i })).toBeTruthy();
  });

  it('gear button is a <button> (Tab-focusable, keyboard-activatable)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const gear = getByRole('button', { name: /einstellungen/i });
    expect(gear.tagName).toBe('BUTTON');
    expect(gear.disabled).toBe(false);
  });

  it('gear button has touch-target minHeight >= 44px', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const gear = getByRole('button', { name: /einstellungen/i });
    const minH = parseInt(gear.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('gear button is present on a non-panel view (factory)', async () => {
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('button', { name: /einstellungen/i })).toBeTruthy();
    });
  });
});

// ── settings-shell AC2 — Gear opens Settings view ────────────────────────────

describe('settings-shell — AC2: Gear opens Settings view', () => {
  it('clicking gear from entry panel navigates to #/settings', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /einstellungen/i }));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/settings');
    });
  });

  it('Settings view shows title "Einstellungen"', async () => {
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      const heading = getByRole('heading', { name: /^einstellungen$/i });
      expect(heading).toBeTruthy();
    });
  });

  it('gear button has aria-current="page" on settings view', async () => {
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      const gear = getByRole('button', { name: /einstellungen/i });
      expect(gear.getAttribute('aria-current')).toBe('page');
    });
  });
});

// ── settings-shell AC3 — Deep-link #/settings ────────────────────────────────

describe('settings-shell — AC3: Deep-link and unknown-route fallback', () => {
  it('direct load with #/settings opens Settings view', () => {
    window.location.hash = '#/settings';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
  });

  it('browser Back from #/settings to #/ shows entry panel', async () => {
    window.location.hash = '#/settings';
    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = '#/';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });
  });
});

// ── settings-shell AC4 — Exactly four sections in Settings view ───────────────

describe('settings-shell — AC4: Settings view sections', () => {
  it('Settings view shows at least four section headings', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    // h2 section headings — settings-credentials adds sections; expect ≥4
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      const h2s = main.querySelectorAll('h2');
      expect(h2s.length).toBeGreaterThanOrEqual(4);
    });
    delete globalThis.fetch;
  });

  it('Settings view shows GitHub section', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/github/i);
    });
    delete globalThis.fetch;
  });

  it('Settings view shows Cloudflare section', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/cloudflare/i);
    });
    delete globalThis.fetch;
  });

  it('Settings view shows Hetzner / VPS section', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/hetzner/i);
    });
    delete globalThis.fetch;
  });

  it('Settings view shows SSH-Keys section', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/ssh-keys/i);
    });
    delete globalThis.fetch;
  });

  it('SSH-Keys section shows real SSH-key management UI (not placeholder)', async () => {
    window.location.hash = '#/settings';
    globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // SSH-Keys section now shows real UI (settings-ssh-keys AC1–AC6 implemented in #46)
      expect(main.textContent).toMatch(/ssh-keys/i);
      // "folgt"-Platzhalter wurde durch echte Implementierung ersetzt
      expect(main.textContent).not.toMatch(/^folgt$/i);
    });
    delete globalThis.fetch;
  });
});

// ── settings-shell AC5 — Entry panel: six tiles, Settings is not a tile ──────

describe('settings-shell — AC5: Entry panel (six tiles, Settings not a tile)', () => {
  it('entry panel shows exactly six tiles (after dashboard-deployment-tile)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tiles = panel.querySelectorAll('button[data-view]');
    expect(tiles).toHaveLength(6);
  });

  it('Settings is NOT a tile in the entry panel', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const tileLabels = Array.from(panel.querySelectorAll('button[data-view]')).map(
      (b) => b.getAttribute('data-view')
    );
    expect(tileLabels).not.toContain('settings');
  });
});

// ── settings-shell AC6 — Navigation back from Settings view ──────────────────

describe('settings-shell — AC6: Navigation from Settings view', () => {
  it('Home button in Settings view returns to entry panel', async () => {
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole, queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });

    const homeBtn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    await act(async () => {
      fireEvent.click(homeBtn);
    });

    await waitFor(() => {
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('gear button remains visible in Settings view', () => {
    window.location.hash = '#/settings';
    const { getByRole } = render(React.createElement(AppShell));
    expect(getByRole('button', { name: /einstellungen/i })).toBeTruthy();
  });
});

// ── build-version — VersionBadge ──────────────────────────────────────────────

describe('build-version — VersionBadge: shows fetched version', () => {
  it('displays "Version: <value>" after fetch resolves with version', async () => {
    window.location.hash = '';
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, json: async () => ({ version: '260609063500 CEST' }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    const { getByText } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByText(/version:\s*260609063500 cest/i)).toBeTruthy();
    });
  });

  it('displays "Version: dev" when fetch fails', async () => {
    window.location.hash = '';
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/version') {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    const { getByText } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByText(/version:\s*dev/i)).toBeTruthy();
    });
  });

  it('displays "Version: dev" when fetch returns non-ok response', async () => {
    window.location.hash = '';
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/version') {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    const { getByText } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByText(/version:\s*dev/i)).toBeTruthy();
    });
  });

  it('version badge is visible on the entry panel (panel view)', async () => {
    window.location.hash = '';
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, json: async () => ({ version: '260609063500 CEST' }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    const { getByRole, getByText } = render(React.createElement(AppShell));

    // Panel is shown
    expect(getByRole('main', { name: /einstiegs-panel/i })).toBeTruthy();

    // Version badge is also rendered
    await waitFor(() => {
      expect(getByText(/version:\s*260609063500 cest/i)).toBeTruthy();
    });
  });

  it('version badge is visible on a non-panel view (factory)', async () => {
    window.location.hash = '#/factory';
    globalThis.fetch = jest.fn((url) => {
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, json: async () => ({ version: '260609063500 CEST' }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    const { getByText } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByText(/version:\s*260609063500 cest/i)).toBeTruthy();
    });
  });
});

// ── team-view-frontend AC1 — Team tile in entry panel ────────────────────────

describe('team-view-frontend — AC1: Team tile in entry panel', () => {
  it('renders tile labelled "Team" in the entry panel', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');
    expect(teamTile).toBeTruthy();
  });

  it('Team tile is focusable (not disabled)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');
    expect(teamTile.disabled).toBe(false);
  });

  it('Team tile activates on click and navigates to #/team', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');

    await act(async () => {
      fireEvent.click(teamTile);
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/team');
    });
  });

  it('Team tile activates on Enter key', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');

    await act(async () => {
      fireEvent.keyDown(teamTile, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/team');
    });
  });

  it('Team tile activates on Space key', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');

    await act(async () => {
      fireEvent.keyDown(teamTile, { key: ' ' });
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('#/team');
    });
  });
});

// ── dashboard-deployment-tile AC6 — NavBar + deep-link #/deployments ─────────

describe('dashboard-deployment-tile — AC6: NavBar + deep-link', () => {
  it('NavBar contains a Deployments link on a non-panel view', async () => {
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const nav = getByRole('navigation', { name: /haupt-navigation/i });
      expect(nav.textContent).toMatch(/deployments/i);
    });
  });

  it('NavBar contains exactly one Deployments link (no duplicate) (AC6)', async () => {
    window.location.hash = '#/github';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      const nav = getByRole('navigation', { name: /haupt-navigation/i });
      const deploymentLinks = nav.querySelectorAll('a[href="#/deployments"]');
      expect(deploymentLinks).toHaveLength(1);
    });
  });

  it('direct load with #/deployments opens DeploymentsView (deep-link AC6)', async () => {
    window.location.hash = '#/deployments';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      // Entry panel is not shown
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeNull();
    });
    // Hash must remain #/deployments
    expect(window.location.hash).toBe('#/deployments');
  });

  it('parseHash returns "deployments" for "#/deployments"', () => {
    expect(parseHash('#/deployments')).toBe('deployments');
  });

  it('VIEWS array includes "deployments"', () => {
    expect(VIEWS).toContain('deployments');
  });
});

// ── team-view-frontend AC2 — Route #/team opens TeamView ─────────────────────

describe('team-view-frontend — AC2: Route #/team opens TeamView', () => {
  it('direct load with #/team opens Team view', async () => {
    window.location.hash = '#/team';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const { getByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      expect(getByRole('main', { name: /team-ansicht/i })).toBeTruthy();
    });
  });

  it('clicking Team tile renders Team view landmark', async () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const teamTile = panel.querySelector('button[data-view="team"]');

    await act(async () => {
      fireEvent.click(teamTile);
    });

    await waitFor(() => {
      expect(getByRole('main', { name: /team-ansicht/i })).toBeTruthy();
    });
  });

  it('parseHash returns "team" for "#/team"', () => {
    expect(parseHash('#/team')).toBe('team');
  });

  it('VIEWS array includes "team"', () => {
    expect(VIEWS).toContain('team');
  });
});

// ── view-registry (AC7–AC12) — View-Registry / Manifest ──────────────────────

describe('view-registry — AC7: AppShell uses manifest (no per-view switch)', () => {
  it('AppShell renders github view from registry on #/github', async () => {
    window.location.hash = '#/github';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /github-ansicht/i })).toBeTruthy();
    });
  });

  it('AppShell renders vps view from registry on #/vps', async () => {
    window.location.hash = '#/vps';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /vps-ansicht/i })).toBeTruthy();
    });
  });

  it('AppShell renders cloudflare view from registry on #/cloudflare', async () => {
    window.location.hash = '#/cloudflare';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /cloudflare-ansicht/i })).toBeTruthy();
    });
  });

  it('AppShell renders deployments view from registry on #/deployments', async () => {
    window.location.hash = '#/deployments';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      // DeploymentsView is rendered (entry panel is gone)
      expect(queryByRole('main', { name: /einstiegs-panel/i })).toBeNull();
    });
    expect(window.location.hash).toBe('#/deployments');
  });

  it('AppShell renders settings view from registry on #/settings', async () => {
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { getByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });
  });
});

// ── view-registry (AC10) — Settings/Retro/Retro-Trend sind keine Kacheln ─────

describe('view-registry — AC10: non-tile views absent from panel', () => {
  it('Settings is NOT a panel tile (data-view)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    expect(panel.querySelector('button[data-view="settings"]')).toBeNull();
  });

  it('Retro is NOT a panel tile (data-view)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    expect(panel.querySelector('button[data-view="retro"]')).toBeNull();
  });

  it('Retro-Trend is NOT a panel tile (data-view)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    expect(panel.querySelector('button[data-view="retro-trend"]')).toBeNull();
  });

  it('tile order is github→vps→cloudflare→factory→team→deployments (AC10)', () => {
    window.location.hash = '';
    const { getByRole } = render(React.createElement(AppShell));
    const panel = getByRole('main', { name: /einstiegs-panel/i });
    const ids = Array.from(panel.querySelectorAll('button[data-view]')).map(
      (b) => b.getAttribute('data-view')
    );
    expect(ids).toEqual(['github', 'vps', 'cloudflare', 'factory', 'team', 'deployments']);
  });
});

// ── view-registry (AC11) — FactoryView conditional mount (Terminal lifecycle) ─

describe('view-registry — AC11: FactoryView only mounted on factory route', () => {
  it('FactoryView (Terminal main) NOT present on panel route', () => {
    window.location.hash = '';
    const { queryByRole } = render(React.createElement(AppShell));
    // FactoryView renders <main aria-label="Terminal">
    expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
  });

  it('FactoryView (Terminal main) NOT present on github route', async () => {
    window.location.hash = '#/github';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(queryByRole('main', { name: /github-ansicht/i })).toBeTruthy();
    });
    expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
  });

  it('FactoryView (Repo-Übersicht) IS present on factory route (AC1: #/factory → Repo-Übersicht)', async () => {
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      // projekt-cockpit-navigation AC1: #/factory (no repo) → RepoOverview, not Terminal
      expect(queryByRole('main', { name: /repo-übersicht/i })).toBeTruthy();
      expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
    });
  });

  it('FactoryView unmounts when navigating away from factory route', async () => {
    window.location.hash = '#/factory';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { queryByRole } = render(React.createElement(AppShell));

    await waitFor(() => {
      // projekt-cockpit-navigation AC1: #/factory → RepoOverview (not Terminal)
      expect(queryByRole('main', { name: /repo-übersicht/i })).toBeTruthy();
    });

    // Navigate away (simulate browser hash change to github)
    await act(async () => {
      window.location.hash = '#/github';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      // FactoryView (and its RepoOverview) must be gone (unmounted)
      expect(queryByRole('main', { name: /repo-übersicht/i })).toBeNull();
      // GitHub view is now shown
      expect(queryByRole('main', { name: /github-ansicht/i })).toBeTruthy();
    });
  });

  it('FactoryView NOT present on settings route (AC11 — non-tile route)', async () => {
    window.location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const { queryByRole } = render(React.createElement(AppShell));
    await waitFor(() => {
      expect(queryByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });
    expect(queryByRole('main', { name: /^terminal$/i })).toBeNull();
  });
});
