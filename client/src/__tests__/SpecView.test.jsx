/**
 * SpecView.test.jsx — Tests für SpecView (client/src/SpecView.jsx).
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC4 — Reiter „Spezifikation" im geöffneten Projekt:
 *          Navigation (Schicht-Gruppen) links, gerendertes Markdown rechts,
 *          Ladezustand (aria-busy); Gruppen Konzept/Architektur/Spec/README.
 *   AC5 — initialPath-Prop öffnet direkt eine Datei (Story → Spec-Link-Klick in BoardView).
 *          Getest via CockpitView-Integration: Board-Reiter bettet BoardView mit onOpenSpec ein;
 *          Klick auf Spec-Link setzt pendingSpecPath + wechselt zu Spezifikation-Reiter.
 *          (BoardView-Klickverhalten getestet in BoardView.test.jsx; hier: SpecView-Direktöffnung.)
 *   AC6 — Filter nach Doku-Typ (Mehrfachauswahl) + Spec-Status (Mehrfachauswahl);
 *          Deaktivieren eines Typs blendet entsprechende Einträge aus.
 *
 * NOTE: jsdom hat keine Layout-Engine — Style-Asserts sind nicht Teil dieses Tests.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, waitFor, fireEvent } from '@testing-library/react';

// ── fetchMock Setup ───────────────────────────────────────────────────────────

let fetchMock;
beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  delete globalThis.fetch;
});

// ── React-Import (nach Mock-Setup) ────────────────────────────────────────────

let React, createRoot, SpecView;

beforeEach(async () => {
  const reactMod = await import('react');
  React = reactMod.default ?? reactMod;
  const reactDom = await import('react-dom/client');
  createRoot = reactDom.createRoot;
  const specMod = await import('../SpecView.jsx');
  SpecView = specMod.SpecView;
});

// ── Render-Hilfsfunktion ──────────────────────────────────────────────────────

function renderSpec(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(SpecView, props));
  });
  return {
    container,
    unmount: () => act(() => root.unmount()),
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

// ── Fixture-Daten ─────────────────────────────────────────────────────────────

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
  { path: 'docs/concept.md', title: 'concept', type: 'konzept', status: null, id: null, version: null },
  { path: 'docs/architecture.md', title: 'architecture', type: 'architektur', status: null, id: null, version: null },
  { path: 'docs/specs/foo.md', title: 'Foo Spec', type: 'spec', status: 'active', id: 'foo', version: 1 },
  { path: 'docs/specs/bar.md', title: 'Bar Spec', type: 'spec', status: 'draft', id: 'bar', version: 1 },
];

function mockDocsOk() {
  fetchMock.mockImplementation((url) => {
    if (url.includes('/docs') && !url.includes('/raw')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ docs: FAKE_DOCS }),
      });
    }
    if (url.includes('/raw')) {
      return Promise.resolve({
        ok: true,
        text: async () => '# Markdown Inhalt',
      });
    }
    return Promise.reject(new Error('Unexpected fetch: ' + url));
  });
}

// ── AC4: Grundlegende Anzeige ─────────────────────────────────────────────────

describe('SpecView — AC4: Reiter Spezifikation', () => {
  it('rendert Navigations-Bereich und Inhalt-Bereich', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('nav[aria-label="Dokument-Navigation"]')).not.toBeNull();
    });

    cleanup();
  });

  it('zeigt Ladezustand (aria-busy) wenn Dokument geladen wird', async () => {
    let resolveContent;
    fetchMock.mockImplementation((url) => {
      if (url.includes('/raw')) {
        return new Promise((res) => {
          resolveContent = () => res({ ok: true, text: async () => '# Inhalt' });
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ docs: FAKE_DOCS }),
      });
    });

    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    // Warte bis Docs geladen sind
    await waitFor(() => {
      const btn = container.querySelector('button[title="README.md"]');
      expect(btn).not.toBeNull();
    });

    // Klick auf README → Ladevorgang startet
    act(() => {
      container.querySelector('button[title="README.md"]').click();
    });

    // Content-Bereich sollte aria-busy="true" tragen
    await waitFor(() => {
      const contentDiv = container.querySelector('[aria-live="polite"]');
      expect(contentDiv?.getAttribute('aria-busy')).toBe('true');
    });

    // Auflösen
    act(() => resolveContent && resolveContent());
    cleanup();
  });

  it('zeigt Navigations-Gruppen nach Schicht (Konzept/Architektur/Spec/README)', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      const nav = container.querySelector('nav[aria-label="Dokument-Navigation"]');
      expect(nav?.textContent).toMatch(/README/);
      expect(nav?.textContent).toMatch(/Konzept/);
      expect(nav?.textContent).toMatch(/Architektur/);
      expect(nav?.textContent).toMatch(/Spec/);
    });

    cleanup();
  });

  it('rendert Markdown-Inhalt über markdownLite nach Datei-Auswahl', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('button[title="README.md"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector('button[title="README.md"]').click();
    });

    await waitFor(() => {
      // markdownLite rendert # Markdown Inhalt als <h1>
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toBe('Markdown Inhalt');
    });

    cleanup();
  });

  it('zeigt Hinweis wenn kein Dokument ausgewählt', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.textContent).toMatch(/Dokument aus der Navigation auswählen/);
    });

    cleanup();
  });

  it('Nav-Buttons haben minHeight ≥ 44 (Touch-Target)', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      const btn = container.querySelector('button[title="README.md"]');
      expect(btn).not.toBeNull();
    });

    const btns = container.querySelectorAll('nav button');
    for (const btn of btns) {
      // jsdom hat kein Layout, aber style.minHeight ist gesetzt
      expect(btn.style.minHeight).toBe('44px');
    }

    cleanup();
  });
});

// ── AC5: initialPath öffnet Datei direkt ─────────────────────────────────────

describe('SpecView — AC5: initialPath öffnet Datei direkt', () => {
  it('lädt Inhalt der initialPath-Datei direkt beim Mount', async () => {
    const rawCalls = [];
    fetchMock.mockImplementation((url) => {
      if (url.includes('/raw')) {
        rawCalls.push(url);
        return Promise.resolve({ ok: true, text: async () => '# Spec Inhalt' });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ docs: FAKE_DOCS }),
      });
    });

    const { container, cleanup } = renderSpec({
      projectSlug: 'myproject',
      initialPath: 'docs/specs/foo.md',
    });

    await waitFor(() => {
      expect(rawCalls.some((u) => u.includes('docs%2Fspecs%2Ffoo.md'))).toBe(true);
    });

    await waitFor(() => {
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toBe('Spec Inhalt');
    });

    cleanup();
  });

  it('aria-current="page" ist auf dem aktiven Nav-Button gesetzt', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('button[title="README.md"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector('button[title="README.md"]').click();
    });

    await waitFor(() => {
      const btn = container.querySelector('button[title="README.md"]');
      expect(btn?.getAttribute('aria-current')).toBe('page');
    });

    cleanup();
  });
});

// ── AC6: Filter nach Typ + Spec-Status ───────────────────────────────────────

describe('SpecView — AC6: Filter', () => {
  it('blendet README-Einträge aus wenn README-Typ-Filter deaktiviert', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('button[title="README.md"]')).not.toBeNull();
    });

    // Deaktiviere readme-Filter
    const readmeCheckbox = container.querySelector('#spec-filter-type-readme');
    expect(readmeCheckbox).not.toBeNull();
    act(() => {
      fireEvent.click(readmeCheckbox);
    });

    await waitFor(() => {
      expect(container.querySelector('button[title="README.md"]')).toBeNull();
    });

    cleanup();
  });

  it('blendet Specs mit "draft"-Status aus wenn draft-Status-Filter deaktiviert', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      // Beide Specs sichtbar
      expect(container.querySelector('button[title="docs/specs/bar.md"]')).not.toBeNull();
    });

    // Deaktiviere draft-Status
    const draftCheckbox = container.querySelector('#spec-filter-status-draft');
    expect(draftCheckbox).not.toBeNull();
    act(() => {
      fireEvent.click(draftCheckbox);
    });

    await waitFor(() => {
      // bar.md (draft) soll verschwinden
      expect(container.querySelector('button[title="docs/specs/bar.md"]')).toBeNull();
      // foo.md (active) soll noch da sein
      expect(container.querySelector('button[title="docs/specs/foo.md"]')).not.toBeNull();
    });

    cleanup();
  });

  it('zeigt Mehrfachauswahl: beide Typ-Filter aktiv → beide Typen sichtbar', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('button[title="README.md"]')).not.toBeNull();
      expect(container.querySelector('button[title="docs/specs/foo.md"]')).not.toBeNull();
    });

    cleanup();
  });

  it('zeigt "Keine Dokumente gefunden" wenn alle Typen deaktiviert', async () => {
    mockDocsOk();
    const { container, cleanup } = renderSpec({ projectSlug: 'myproject' });

    await waitFor(() => {
      expect(container.querySelector('#spec-filter-type-readme')).not.toBeNull();
    });

    // Alle Typ-Checkboxen deaktivieren
    for (const type of ['readme', 'konzept', 'architektur', 'spec']) {
      const cb = container.querySelector(`#spec-filter-type-${type}`);
      if (cb?.checked) {
        act(() => { fireEvent.click(cb); });
      }
    }

    await waitFor(() => {
      expect(container.textContent).toMatch(/Keine Dokumente gefunden/);
    });

    cleanup();
  });
});
