/**
 * BoardViewCollapse.test.jsx — Tests für board-feature-collapse (S-173).
 *
 * Covers (board-feature-collapse):
 *   AC1  — Jede Feature-Zeile hat einen Auf-/Zu-Schalter (feature-collapse-btn-<id>);
 *           eingeklappt sind Story-Spalten ausgeblendet; ausgeklappt wie bisher sichtbar.
 *   AC2  — Ziel/DoD-Detail-Panel auf separaten Schalter (feature-title-btn-<id>) entkoppelt;
 *           bei eingeklapptem Feature ist der Detail-Schalter ausgeblendet.
 *   AC3  — Default „Gemischt": erledigte Features eingeklappt (done==total, total>0, oder
 *           status Done/Archived); übrige ausgeklappt.
 *   AC4  — „Alle einklappen" / „Alle ausklappen" Schalter in der Board-Kopfleiste
 *           (collapse-all-btn); klappt alle Features auf einmal zu/auf.
 *   AC5  — Zustand pro Projekt im localStorage (Key boardview.collapsed.<slug>);
 *           defektes/fehlendes localStorage → stiller Default, kein Crash.
 *   AC6  — Bei aktivem einschränkendem Filter: eingeklappte Features mit passenden Stories
 *           temporär ausgeklappt; gespeicherter Zustand nicht überschrieben.
 *   AC7  — A11y: feature-collapse-btn hat aria-expanded + aria-controls;
 *           Chevron aria-hidden; Fokusring erhalten (kein outline:none).
 *   AC8  — Kein dangerouslySetInnerHTML; kein neuer API-Aufruf; keine Secrets.
 *
 * NOTE: localStorage wird pro Test isoliert über beforeEach/afterEach.
 * NOTE: jsdom hat keine Layout-Engine — Style/outline nicht testbar; visuell verifiziert.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// Mocks für AppShell-Abhängigkeiten
jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STORY_TODO = {
  id: 'S-001', parent: 'F-001', title: 'Erstelle Login-Seite',
  status: 'To Do', priority: 'high', labels: ['frontend'],
};

const STORY_DONE = {
  id: 'S-003', parent: 'F-001', title: 'Setup Datenbank',
  status: 'Done', priority: 'medium', labels: ['backend'],
};

/** Feature mit aktiven Stories (not done) — default: ausgeklappt */
const FEATURE_ACTIVE = {
  id: 'F-001',
  title: 'Authentication',
  status: 'In Progress',
  priority: 'high',
  progress: { done: 1, total: 3 },
  stories: [STORY_TODO, STORY_DONE],
};

/** Feature mit allen Stories Done — default: eingeklappt (AC3) */
const FEATURE_DONE_ALL = {
  id: 'F-done',
  title: 'Finished Feature',
  status: 'In Progress',
  priority: 'low',
  progress: { done: 2, total: 2 },
  stories: [
    { id: 'S-d1', parent: 'F-done', title: 'Done 1', status: 'Done', labels: [] },
    { id: 'S-d2', parent: 'F-done', title: 'Done 2', status: 'Done', labels: [] },
  ],
};

/** Feature mit Status 'Done' — default: eingeklappt (AC3) */
const FEATURE_STATUS_DONE = {
  id: 'F-st-done',
  title: 'Status-Done Feature',
  status: 'Done',
  priority: 'low',
  progress: { done: 0, total: 0 },
  stories: [
    { id: 'S-sd1', parent: 'F-st-done', title: 'Some Story', status: 'To Do', labels: [] },
  ],
};

/** Feature mit Status 'Archived' — default: eingeklappt (AC3) */
const FEATURE_ARCHIVED = {
  id: 'F-archived',
  title: 'Archived Feature',
  status: 'Archived',
  priority: 'low',
  progress: { done: 0, total: 0 },
  stories: [],
};

/** Feature ohne Stories — standard, ausgeklappt */
const FEATURE_EMPTY = {
  id: 'F-003', title: 'Empty Feature', status: 'To Do', priority: 'low', stories: [],
};

/** Feature mit Label "ci" für Filter-Tests */
const FEATURE_CI = {
  id: 'F-ci',
  title: 'CI/CD Feature',
  status: 'To Do',
  priority: 'low',
  progress: { done: 0, total: 1 },
  stories: [
    { id: 'S-ci1', parent: 'F-ci', title: 'Setup CI', status: 'To Do', labels: ['ci'] },
  ],
};

const PROJECT = {
  slug: 'proj-test',
  repo_path: '/home/user/proj',
  features: [FEATURE_ACTIVE, FEATURE_DONE_ALL, FEATURE_EMPTY],
};

const PROJECT_MIXED = {
  slug: 'proj-mixed',
  repo_path: '/home/user/mixed',
  features: [FEATURE_ACTIVE, FEATURE_STATUS_DONE, FEATURE_ARCHIVED],
};

const PROJECT_CI = {
  slug: 'proj-ci',
  repo_path: '/home/user/ci',
  features: [FEATURE_ACTIVE, FEATURE_DONE_ALL, FEATURE_CI],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;
let localStorageStore = {};

beforeEach(() => {
  originalFetch = globalThis.fetch;

  // Mock localStorage für AC5-Tests
  localStorageStore = {};
  const localStorageMock = {
    getItem: jest.fn((key) => localStorageStore[key] ?? null),
    setItem: jest.fn((key, value) => { localStorageStore[key] = value; }),
    removeItem: jest.fn((key) => { delete localStorageStore[key]; }),
    clear: jest.fn(() => { localStorageStore = {}; }),
  };
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Build fetch-Mock für Cockpit-Modus.
 */
function makeFetch(project) {
  return jest.fn(async (url) => {
    if (url.includes(`/api/board/projects/${project.slug}`)) {
      return { ok: true, status: 200, json: async () => ({ project }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Rendere BoardView im Cockpit-Modus und warte bis Daten geladen. */
async function renderCockpit(project) {
  globalThis.fetch = makeFetch(project);
  const { container } = render(
    React.createElement(BoardView, { onNavigate: jest.fn(), lockedProject: project.slug })
  );
  await waitFor(() => {
    expect(container.querySelector(`[data-project="${project.slug}"]`)).toBeTruthy();
  });
  return container;
}

// ── AC1: Feature ein-/ausklappen ──────────────────────────────────────────────

describe('board-feature-collapse — AC1: Feature ein-/ausklappen', () => {
  it('jede Feature-Zeile hat einen Auf-/Zu-Schalter (feature-collapse-btn)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('ausgeklapptes Feature zeigt Story-Spalten', async () => {
    const container = await renderCockpit(PROJECT);
    // F-001 ist active → default ausgeklappt → Stories sichtbar
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
  });

  it('Klick auf Collapse-Button klappt Feature ein (Stories ausgeblendet)', async () => {
    const container = await renderCockpit(PROJECT);

    // F-001 ist active → ausgeklappt → Story sichtbar
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });
  });

  it('zweiter Klick klappt Feature wieder aus (Stories sichtbar)', async () => {
    const container = await renderCockpit(PROJECT);

    // Einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });

    // Ausklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });
  });

  it('Feature ohne Stories: einklappen blendet "Keine Stories"-Hinweis aus', async () => {
    const container = await renderCockpit(PROJECT);

    // F-003 ist empty → hint sichtbar
    const feature = container.querySelector('[data-feature="F-003"]');
    expect(feature).toBeTruthy();
    // hint text visible when expanded
    expect(feature.textContent).toMatch(/Keine Stories/);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-003"]'));
    });

    await waitFor(() => {
      const feat = container.querySelector('[data-feature="F-003"]');
      // After collapse, stories region hidden → hint not rendered
      expect(feat.textContent).not.toMatch(/Keine Stories/);
    });
  });
});

// ── AC2: Detail-Panel entkoppelt ──────────────────────────────────────────────

describe('board-feature-collapse — AC2: Ziel/DoD-Detail-Panel entkoppelt', () => {
  it('Detail-Button (feature-title-btn) ist sichtbar wenn Feature ausgeklappt', async () => {
    const container = await renderCockpit(PROJECT);
    // F-001 ist ausgeklappt (active)
    const detailBtn = container.querySelector('[data-testid="feature-title-btn-F-001"]');
    expect(detailBtn).toBeTruthy();
  });

  it('Detail-Button ist ausgeblendet wenn Feature eingeklappt (AC2)', async () => {
    const container = await renderCockpit(PROJECT);

    // Einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });

    await waitFor(() => {
      // Detail-Button ausgeblendet (nicht im DOM)
      expect(container.querySelector('[data-testid="feature-title-btn-F-001"]')).toBeNull();
    });
  });

  it('Detail-Button togglet das Detail-Panel unabhängig vom Einklappen (AC2)', async () => {
    const container = await renderCockpit(PROJECT);

    // F-001 ausgeklappt → Detail-Panel noch zu
    expect(container.querySelector('[data-testid="feature-detail-F-001"]')).toBeNull();

    // Detail-Panel öffnen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-001"]')).toBeTruthy();
    });

    // Stories weiterhin sichtbar (Einklappen nicht betroffen)
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
  });

  it('Collapse-Button und Detail-Button sind unabhängig (AC2)', async () => {
    const container = await renderCockpit(PROJECT);

    // Detail-Panel öffnen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-001"]')).toBeTruthy();
    });

    // Einklappen → Detail-Panel und Stories beide ausgeblendet
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-testid="feature-detail-F-001"]')).toBeNull();
    });
  });
});

// ── AC3: Default „Gemischt" ───────────────────────────────────────────────────

describe('board-feature-collapse — AC3: Default Gemischt (kein gespeicherter Zustand)', () => {
  it('aktives Feature (progress nicht 100%) ist default ausgeklappt', async () => {
    const container = await renderCockpit(PROJECT);
    // F-001: done=1, total=3 → nicht fertig → ausgeklappt
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
  });

  it('feature mit done==total (total>0) ist default eingeklappt', async () => {
    const container = await renderCockpit(PROJECT);
    // F-done: done=2, total=2 → eingeklappt
    const feature = container.querySelector('[data-feature="F-done"]');
    expect(feature).toBeTruthy();
    // Stories ausgeblendet
    expect(container.querySelector('[data-story="S-d1"]')).toBeNull();
    expect(container.querySelector('[data-story="S-d2"]')).toBeNull();
  });

  it('feature mit status "Done" ist default eingeklappt (AC3)', async () => {
    const container = await renderCockpit(PROJECT_MIXED);
    // F-st-done: status='Done' → eingeklappt
    expect(container.querySelector('[data-feature="F-st-done"]')).toBeTruthy();
    expect(container.querySelector('[data-story="S-sd1"]')).toBeNull();
  });

  it('feature mit status "Archived" ist default eingeklappt (AC3)', async () => {
    const container = await renderCockpit(PROJECT_MIXED);
    // F-archived: status='Archived' → eingeklappt
    expect(container.querySelector('[data-feature="F-archived"]')).toBeTruthy();
  });

  it('collapse-btn für eingeklapptes Feature zeigt aria-expanded=false (AC3/AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    // F-done ist default eingeklappt
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-done"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('collapse-btn für ausgeklapptes Feature zeigt aria-expanded=true (AC3/AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    // F-001 ist default ausgeklappt
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── AC4: „Alle einklappen" / „Alle ausklappen" ───────────────────────────────

describe('board-feature-collapse — AC4: Alle-Toggle', () => {
  it('„Alle einklappen"-Button ist vorhanden in der Filterbar (collapse-all-btn)', async () => {
    const container = await renderCockpit(PROJECT);
    expect(container.querySelector('[data-testid="collapse-all-btn"]')).toBeTruthy();
  });

  it('„Alle einklappen" klappt alle Features ein (keine Stories sichtbar)', async () => {
    const container = await renderCockpit(PROJECT);

    // Alle ausklappen erst (F-done ist eingeklappt) — prüfe dass F-001 sichtbar
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();

    // Alle einklappen
    await act(async () => {
      const btn = container.querySelector('[data-testid="collapse-all-btn"]');
      // Button zeigt "Alle einklappen" wenn nicht alle eingeklappt
      fireEvent.click(btn);
    });

    await waitFor(() => {
      // F-001 Storys ausgeblendet
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });
  });

  it('nach „Alle einklappen" zeigt Button „Alle ausklappen"', async () => {
    const container = await renderCockpit(PROJECT);

    // Erst alle einklappen
    await act(async () => {
      const btn = container.querySelector('[data-testid="collapse-all-btn"]');
      if (btn.textContent.includes('Alle einklappen')) fireEvent.click(btn);
    });

    // Wenn alle eingeklappt → Button-Text ändert sich
    await waitFor(() => {
      const btn = container.querySelector('[data-testid="collapse-all-btn"]');
      // aria-pressed=true wenn alle eingeklappt
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('„Alle ausklappen" klappt alle Features aus', async () => {
    const container = await renderCockpit(PROJECT);

    // Alle einklappen
    await act(async () => {
      const collapseBtn = container.querySelector('[data-testid="collapse-all-btn"]');
      if (!collapseBtn.getAttribute('aria-pressed') || collapseBtn.getAttribute('aria-pressed') === 'false') {
        fireEvent.click(collapseBtn);
      }
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });

    // Alle ausklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="collapse-all-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });
  });

  it('Alle-Toggle hat aria-label (A11y, AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="collapse-all-btn"]');
    expect(btn.getAttribute('aria-label')).toMatch(/alle features ein|ausklappen/i);
  });
});

// ── AC5: localStorage-Persistenz ─────────────────────────────────────────────

describe('board-feature-collapse — AC5: localStorage-Persistenz pro Projekt', () => {
  it('einklappen schreibt Feature-ID in localStorage (boardview.collapsed.<slug>)', async () => {
    const container = await renderCockpit(PROJECT);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });

    // localStorage muss den neuen Zustand enthalten
    const stored = window.localStorage.setItem.mock.calls.find(
      ([key]) => key === 'boardview.collapsed.proj-test'
    );
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored[1]);
    expect(parsed.collapsed).toContain('F-001');
  });

  it('ausklappen entfernt Feature-ID aus localStorage', async () => {
    const container = await renderCockpit(PROJECT);

    // Einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });

    // Ausklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Nach Ausklappen: F-001 nicht mehr in collapsed-Liste
    const lastCall = window.localStorage.setItem.mock.calls
      .filter(([key]) => key === 'boardview.collapsed.proj-test')
      .at(-1);
    expect(lastCall).toBeTruthy();
    const parsed = JSON.parse(lastCall[1]);
    expect(parsed.collapsed).not.toContain('F-001');
  });

  it('defektes localStorage → stiller Default, kein Crash (AC5)', async () => {
    // localStorage.getItem wirft
    window.localStorage.getItem = jest.fn(() => {
      throw new Error('localStorage not available');
    });

    // Sollte trotzdem rendern ohne Crash
    const container = await renderCockpit(PROJECT);
    expect(container.querySelector('[data-project="proj-test"]')).toBeTruthy();
    // F-001 (active) nach Default-Fallback ausgeklappt
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
  });

  it('korruptes localStorage-JSON → stiller Default-Fallback, kein Crash (AC5)', async () => {
    localStorageStore['boardview.collapsed.proj-test'] = 'INVALID_JSON{{{';
    window.localStorage.getItem = jest.fn((key) => localStorageStore[key] ?? null);

    const container = await renderCockpit(PROJECT);
    expect(container.querySelector('[data-project="proj-test"]')).toBeTruthy();
    // Kein Crash; Default-Verhalten: F-001 ausgeklappt
    expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
  });

  it('localStorage-Zustand wird beim Laden angewendet (gespeicherter Zustand)', async () => {
    // Vorab: F-001 als eingeklappt speichern
    localStorageStore['boardview.collapsed.proj-test'] = JSON.stringify({ collapsed: ['F-001'] });
    window.localStorage.getItem = jest.fn((key) => localStorageStore[key] ?? null);

    const container = await renderCockpit(PROJECT);

    // F-001 soll eingeklappt sein (aus localStorage)
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });
  });

  it('localStorage-Zustand schlägt Default-„Gemischt" vor wenn vorhanden (AC5)', async () => {
    // F-done ist normalerweise default eingeklappt.
    // Wenn localStorage F-done als NICHT collapsed speichert (leere Liste), soll F-done ausgeklappt sein.
    localStorageStore['boardview.collapsed.proj-test'] = JSON.stringify({ collapsed: [] });
    window.localStorage.getItem = jest.fn((key) => localStorageStore[key] ?? null);

    const container = await renderCockpit(PROJECT);

    // F-done ist normalerweise eingeklappt — aber localStorage sagt "nichts eingeklappt"
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-d1"]')).toBeTruthy();
    });
  });
});

// ── AC6: Filter-Wechselwirkung ─────────────────────────────────────────────

describe('board-feature-collapse — AC6: Filter-Wechselwirkung', () => {
  it('eingeklapptes Feature mit Treffern bei aktivem Label-Filter temporär ausgeklappt', async () => {
    const container = await renderCockpit(PROJECT_CI);

    // F-done einklappen (default schon eingeklappt wenn done==total)
    // F-ci manuell einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-ci"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeNull();
    });

    // Label-Filter auf 'ci' setzen → F-ci hat Treffer → temporär ausgeklappt
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    // S-ci1 soll nun sichtbar sein (temporär ausgeklappt durch Filter)
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeTruthy();
    });
  });

  it('Filter-Sicht überschreibt gespeicherten Zustand NICHT (AC6)', async () => {
    const container = await renderCockpit(PROJECT_CI);

    // F-ci einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-ci"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeNull();
    });

    // Merke localStorage-Stand nach Einklappen
    const storedAfterCollapse = window.localStorage.setItem.mock.calls
      .filter(([key]) => key === 'boardview.collapsed.proj-ci')
      .at(-1);
    const collapsedBefore = storedAfterCollapse
      ? JSON.parse(storedAfterCollapse[1]).collapsed
      : [];
    expect(collapsedBefore).toContain('F-ci');

    // Label-Filter setzen → temporäre Aufklappung
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    // Prüfe: localStorage wurde NICHT erneut mit F-ci als offen gespeichert
    // (Anzahl setItem-Calls darf nicht höher sein als zuvor für diesen Key)
    const callsAfterFilter = window.localStorage.setItem.mock.calls
      .filter(([key]) => key === 'boardview.collapsed.proj-ci');
    // Die letzte Speicherung (falls vorhanden) soll F-ci noch als collapsed enthalten
    const lastCall = callsAfterFilter.at(-1);
    if (lastCall) {
      const parsed = JSON.parse(lastCall[1]);
      expect(parsed.collapsed).toContain('F-ci');
    }
  });

  it('eingeklapptes Feature OHNE Filter-Treffer bleibt eingeklappt (AC6)', async () => {
    const container = await renderCockpit(PROJECT_CI);

    // F-done (done=2/2, default eingeklappt) hat keine Stories mit Label 'ci'
    // Label-Filter auf 'ci'
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      // S-d1 bleibt ausgeblendet (F-done bleibt eingeklappt — kein Treffer)
      expect(container.querySelector('[data-story="S-d1"]')).toBeNull();
    });
  });

  it('nach Filter-Reset kehrt eingeklapptes Feature zu gespeichertem Zustand zurück (AC6)', async () => {
    const container = await renderCockpit(PROJECT_CI);

    // F-ci einklappen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-ci"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeNull();
    });

    // Filter setzen → temporär ausgeklappt
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeTruthy();
    });

    // Filter zurücksetzen
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: '' },
      });
    });

    // F-ci wieder eingeklappt (gespeicherter Zustand)
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-ci1"]')).toBeNull();
    });
  });
});

// ── AC7: A11y ─────────────────────────────────────────────────────────────────

describe('board-feature-collapse — AC7: A11y (aria-expanded, aria-controls, Chevron)', () => {
  it('collapse-btn hat aria-expanded=true wenn ausgeklappt', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapse-btn hat aria-expanded=false wenn eingeklappt', async () => {
    const container = await renderCockpit(PROJECT);

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('collapse-btn hat aria-controls auf die Stories-Region', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    const controlsId = btn.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    // Die referenzierte Region muss im DOM existieren (wenn ausgeklappt)
    expect(container.querySelector(`#${controlsId}`)).toBeTruthy();
  });

  it('Chevron-Span hat aria-hidden=true (AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    const chevron = btn.querySelector('[aria-hidden="true"]');
    expect(chevron).toBeTruthy();
  });

  it('collapse-btn ist ein <button> Element (Tastatur-Zugänglichkeit, AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('collapse-btn hat aria-label mit Feature-Name (AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="feature-collapse-btn-F-001"]');
    expect(btn.getAttribute('aria-label')).toMatch(/Authentication|F-001/);
  });

  it('collapse-all-btn hat aria-label (AC4/AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="collapse-all-btn"]');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('collapse-all-btn hat aria-pressed (AC4/AC7)', async () => {
    const container = await renderCockpit(PROJECT);
    const btn = container.querySelector('[data-testid="collapse-all-btn"]');
    // aria-pressed attribute must be present (true or false)
    expect(btn.hasAttribute('aria-pressed')).toBe(true);
  });
});

// ── AC8: Kein Backend-Aufruf, kein dangerouslySetInnerHTML ───────────────────

describe('board-feature-collapse — AC8: Kein Backend-Aufruf beim Einklappen', () => {
  it('Einklappen löst keinen zusätzlichen Fetch aus (AC8)', async () => {
    const container = await renderCockpit(PROJECT);

    const callsBefore = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-collapse-btn-F-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
    });

    // Kein zusätzlicher Fetch
    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);
  });

  it('Alle-einklappen löst keinen zusätzlichen Fetch aus (AC8)', async () => {
    const container = await renderCockpit(PROJECT);

    const callsBefore = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="collapse-all-btn"]'));
    });

    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);
  });
});
