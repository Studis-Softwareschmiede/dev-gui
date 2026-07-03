/**
 * CockpitObsidianSyncNavigate.test.jsx — Regressionstest für obsidian-sync-
 * trigger AC6 (S-252, Iteration 2 + Iteration 3): reale App-Integrationsprobe,
 * dass „202" tatsächlich in den „Arbeiten"-Reiter wechselt, OHNE den Projekt-
 * Kontext zu verlieren, UND die Terminal-Fläche live sichtbar macht.
 *
 * Hintergrund Iteration 1/2 (live nachgewiesener Bug #1): Ein naiver
 * `onNavigate('factory')`-Aufruf (App-Level `useHashRouter.navigate`) hätte
 * den Hash von `#/factory/<repo>` auf das bare `#/factory` zurückgesetzt
 * (`viewToHash('factory')` kennt kein Repo-Segment) — `factoryRepo` würde
 * `null`, der Nutzer würde auf die Repo-Übersicht geworfen statt den Lauf
 * live im Terminal zu sehen. Ein reiner `jest.fn()`-Spy-Test (siehe
 * SpecViewObsidianSyncTrigger.test.jsx AC6) deckt das NICHT auf — er prüft
 * nur, DASS ein Callback aufgerufen wird, nicht WELCHE reale Wirkung er im
 * gemounteten Cockpit hat.
 *
 * Hintergrund Iteration 3 (live nachgewiesener Bug #2): Der Tab-Wechsel allein
 * (Iteration 2) reicht NICHT — `FactoryWorkspace` zeigt die Terminal-Fläche
 * nur, wenn die Checkbox „Terminal einblenden" aktiv ist (Default AUS,
 * [[fabrik-arbeiten-layout]] AC2). Ein Terminal-Mock, der `null` rendert
 * (wie in Iteration 2), kann diese fehlende Sichtbarkeit NICHT aufdecken —
 * `null` sieht im DOM identisch aus, ob die Checkbox an oder aus ist. Der
 * Mock rendert daher jetzt ein sichtbares Platzhalter-Element, damit der Test
 * tatsächlich beweist, dass die Terminal-Fläche im DOM erscheint (nicht nur
 * das Tabpanel).
 *
 * Dieser Test rendert die ECHTE `CockpitView` (inkl. der ECHTEN, ungemockten
 * `SpecView`/`ObsidianSyncTrigger`) und prüft die tatsächliche DOM-Wirkung:
 * nach 202 verschwindet der Spezifikation-Reiter-Inhalt, der „Arbeiten"-
 * Reiter (`role="tabpanel"`, Name „Arbeiten") wird sichtbar, UND die
 * Terminal-Fläche (Checkbox automatisch aktiviert) erscheint — im selben
 * Cockpit-Mount, ohne Hash-/Projekt-Kontext-Verlust (`navigateFactory` wird
 * dabei NICHT aufgerufen). Die Checkbox bleibt danach normal abwählbar
 * (kein Lock).
 *
 * Dashboard/TriggerPanel/BoardView sind gemockt (WS/DOM-Komplexität
 * vermeiden, wie im übrigen Cockpit-Test-Bestand) — SpecView bleibt bewusst
 * UNGEMOCKT, das ist genau die zu prüfende Naht.
 *
 * Covers (obsidian-sync-trigger): AC6 (reale Router-/Tab-/Terminal-Sichtbar-
 *   keits-Wirkung inkl. „kein dauerhaftes Auto-Einschalten bei späteren,
 *   unabhängigen Tab-Wechseln", ergänzt den Spy-Test in
 *   SpecViewObsidianSyncTrigger.test.jsx).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components (Dashboard/TriggerPanel/BoardView) ───────────────
// SpecView bleibt bewusst UNGEMOCKT — das ist die zu prüfende Naht (AC6).
// Terminal rendert (anders als in Iteration 2) einen sichtbaren Platzhalter
// statt null, damit „Terminal-Fläche live sichtbar" tatsächlich beweisbar ist.

jest.unstable_mockModule('../Terminal.jsx', async () => {
  const R = (await import('react')).default;
  return {
    Terminal: ({ wsUrl }) =>
      R.createElement('div', { 'data-testid': 'terminal-mock', 'data-ws-url': wsUrl ?? '' }, 'Terminal (Mock)'),
  };
});
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({ TriggerPanel: () => null }));
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: () => R.createElement('main', { 'aria-label': 'Studis-Kanban-Board' }, 'Board Mock'),
  };
});

const { render }       = await import('@testing-library/react');
const React             = (await import('react')).default;
const { CockpitView }   = await import('../CockpitView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  window.location.hash = '';
});

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
];
const FAKE_FOLDERS = [
  { name: 'Mein-Projekt', path: 'Projekte/Mein-Projekt' },
];

/**
 * Combined fetch mock covering both FactoryWorkspace's (Arbeiten-Reiter,
 * /api/session busy-guard) and SpecView/ObsidianSyncTrigger's (docs list,
 * obsidian-vault-path, obsidian-vault/projects, /api/command) needs.
 */
function makeFetchFn({ commandStatus = 202 } = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
    }
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/settings/obsidian-vault-path') {
      return { ok: true, status: 200, json: async () => ({ vaultPath: '/vault', configured: true }) };
    }
    if (url === '/api/settings/obsidian-vault/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: FAKE_FOLDERS }) };
    }
    if (url === '/api/command' && opts?.method === 'POST') {
      return { ok: commandStatus === 202, status: commandStatus, json: async () => ({ commandId: 'cmd-1', status: 'running' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('CockpitView — obsidian-sync-trigger AC6: reale Tab-/Projekt-Kontext-Wirkung nach 202', () => {
  it('202 wechselt in den „Arbeiten"-Reiter, OHNE navigateFactory (kein Hash-/Projekt-Kontext-Verlust)', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 202 });
    globalThis.fetch = fetchFn;
    const navigateFactorySpy = jest.fn();
    const onNavigateSpy = jest.fn();

    const { getByRole, getByTestId, queryByTestId } = render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: navigateFactorySpy,
        onNavigate: onNavigateSpy,
      }),
    );

    // Zum Spezifikation-Reiter wechseln (die echte SpecView/ObsidianSyncTrigger mounten).
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /spezifikation/i }));
    });
    expect(getByRole('tabpanel', { name: /spezifikation/i })).toBeTruthy();

    // Button aktivierbar abwarten (Vault konfiguriert, Session frei).
    await waitFor(() => {
      expect(getByTestId('obsidian-sync-btn').disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(getByTestId('obsidian-sync-btn'));
    });
    await waitFor(() => {
      expect(getByTestId('obsidian-sync-folder-select')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(getByTestId('obsidian-sync-folder-select'), {
        target: { value: FAKE_FOLDERS[0].path },
      });
    });
    await act(async () => {
      fireEvent.click(getByTestId('obsidian-sync-confirm-yes'));
    });

    // Realer DOM-Effekt: „Arbeiten"-Tabpanel erscheint, Spezifikation-Inhalt verschwindet.
    await waitFor(() => {
      expect(getByRole('tabpanel', { name: /arbeiten/i })).toBeTruthy();
    });
    expect(queryByTestId('obsidian-sync-box')).toBeNull();
    expect(queryByTestId('obsidian-sync-confirm-dialog')).toBeNull();

    // Iteration 3: die Terminal-Fläche muss TATSÄCHLICH im DOM erscheinen —
    // nicht nur das Tabpanel. Die Checkbox „Terminal einblenden" ist dafür
    // automatisch aktiv (autoShowTerminalToken), OBWOHL ihr Default AUS ist
    // (fabrik-arbeiten-layout AC2).
    const terminalCheckbox = getByTestId('show-terminal-checkbox');
    expect(terminalCheckbox.checked).toBe(true);
    expect(getByTestId('terminal-mock')).toBeTruthy();
    expect(getByRole('main', { name: /^terminal$/i })).toBeTruthy();

    // Der Projekt-Kontext bleibt erhalten — KEIN Hash-/Übersichts-Wechsel:
    // navigateFactory(null) (Rückweg zur Repo-Übersicht) wurde NICHT aufgerufen.
    expect(navigateFactorySpy).not.toHaveBeenCalled();
    // Das generische App-Level onNavigate wird von ObsidianSyncTrigger nicht
    // mehr genutzt (Präzisierung Iteration 2 — s. SpecView.jsx-Doku).
    expect(onNavigateSpy).not.toHaveBeenCalled();

    // Kein Lock: die Checkbox bleibt normal bedienbar — manuelles Abwählen
    // versteckt die Terminal-Fläche wieder (kein erzwungenes Anzeigen).
    await act(async () => {
      fireEvent.click(terminalCheckbox);
    });
    expect(terminalCheckbox.checked).toBe(false);
    expect(queryByTestId('terminal-mock')).toBeNull();
  });

  it('ein SPÄTERER, unabhängiger Tab-Wechsel (weg von/zurück zu „Arbeiten") schaltet die Checkbox NICHT erneut automatisch ein', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 202 });
    globalThis.fetch = fetchFn;

    const { getByRole, getByTestId, queryByTestId } = render(
      React.createElement(CockpitView, {
        activeRepo: 'my-project',
        navigateFactory: jest.fn(),
        onNavigate: jest.fn(),
      }),
    );

    // Kompletter Sync-Trigger-Durchlauf (wie oben) bis zum automatischen
    // Tab-Wechsel mit aktivierter Terminal-Fläche.
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /spezifikation/i }));
    });
    await waitFor(() => {
      expect(getByTestId('obsidian-sync-btn').disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(getByTestId('obsidian-sync-btn'));
    });
    await waitFor(() => {
      expect(getByTestId('obsidian-sync-folder-select')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(getByTestId('obsidian-sync-folder-select'), {
        target: { value: FAKE_FOLDERS[0].path },
      });
    });
    await act(async () => {
      fireEvent.click(getByTestId('obsidian-sync-confirm-yes'));
    });
    await waitFor(() => {
      expect(getByTestId('show-terminal-checkbox').checked).toBe(true);
    });

    // Nutzer blendet die Terminal-Fläche manuell wieder aus.
    await act(async () => {
      fireEvent.click(getByTestId('show-terminal-checkbox'));
    });
    expect(queryByTestId('terminal-mock')).toBeNull();

    // Weg zu einem anderen Reiter und zurück zu „Arbeiten" — OHNE den
    // Sync-Trigger erneut auszulösen (autoShowTerminalToken wurde von
    // CockpitView nach dem ersten Mount bereits auf 0 zurückgesetzt).
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /studis-kanban-board/i }));
    });
    await act(async () => {
      fireEvent.click(getByRole('tab', { name: /^arbeiten$/i }));
    });

    // Checkbox startet wieder mit dem gewöhnlichen Default AUS (fabrik-
    // arbeiten-layout AC2) — kein dauerhaftes automatisches Wieder-Einschalten.
    expect(getByTestId('show-terminal-checkbox').checked).toBe(false);
    expect(queryByTestId('terminal-mock')).toBeNull();
  });
});
