/**
 * IdeaCaptureModal.test.jsx — Tests für AC4 (ideen-inbox): „Idee"-Button + Modal
 * auf der „Arbeiten"-Seite (CockpitView).
 *
 * Covers (ideen-inbox):
 *   AC4 — Sichtbarer „Idee"-Button im Reiter „Arbeiten"; Klick öffnet ein Modal
 *          (role=dialog, aria-modal) mit Einzeiler-Titel (Pflicht) + optionalem
 *          mehrzeiligem Stichwort-Body. Leerer Titel → Speichern deaktiviert.
 *          Speichern → POST /api/board/projects/:slug/ideas { title, body? };
 *          201 → Modal schließt. 400 → Fehlermeldung inline, Modal bleibt offen
 *          (Owner kann korrigieren). Esc schließt das Modal.
 *
 * CockpitView-Integration wird gegen echte Sub-Komponenten der Sidebar getestet
 * (IdeaCaptureModal selbst), Terminal/Dashboard/TriggerPanel/BoardView/SpecView
 * bleiben gemockt (WS/DOM-Komplexität vermeiden, analog CockpitFlowTrigger.test.jsx).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// ── Mock heavy sub-components (analog CockpitFlowTrigger.test.jsx) ───────────

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../TriggerPanel.jsx', () => ({ TriggerPanel: () => null }));
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: () => R.createElement('main', { 'aria-label': 'Studis-Kanban-Board' }, 'Board Mock'),
  };
});
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    SpecView: () => R.createElement('div', { 'data-testid': 'spec-view-stub' }, 'Spec Mock'),
  };
});

const { render }      = await import('@testing-library/react');
const React           = (await import('react')).default;
const { CockpitView } = await import('../CockpitView.jsx');
const { IdeaCaptureModal } = await import('../IdeaCaptureModal.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const IDEAS_URL_RE = /^\/api\/board\/projects\/[^/]+\/ideas$/;

/**
 * Fetch-Mock: /api/session (ready) + POST .../ideas.
 * @param {object} opts
 * @param {number} [opts.ideaStatus=201]
 * @param {object} [opts.ideaBody={storyId:'S-42'}]
 */
function makeFetchFn({ ideaStatus = 201, ideaBody = { storyId: 'S-42' } } = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
    }
    // story-idee-bereich-zuordnung S-291: AreaSelect lädt GET …/areas — Default-Mock
    // liefert eine kleine Bereichsliste (Vorbelegung 'board'), damit die Speichern-
    // Gates (AC5) wie in einem migrierten Projekt reagieren.
    if (/\/areas$/.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ areas: [{ id: 'board', name: 'Board', order: 1 }] }) };
    }
    if (IDEAS_URL_RE.test(url) && opts?.method === 'POST') {
      return { ok: ideaStatus === 201, status: ideaStatus, json: async () => ideaBody };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function renderCockpit(fetchFn) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;
  render(
    React.createElement(CockpitView, {
      activeRepo: 'my-project',
      navigateFactory: jest.fn(),
      onNavigate: jest.fn(),
    }),
  );
  return { fetchFn: fn };
}

// ── AC4: Button vorhanden, öffnet Modal ───────────────────────────────────────

describe('CockpitView — AC4 (ideen-inbox): „Idee"-Button im Reiter Arbeiten', () => {
  it('renders a visible "Idee"-Button in the Arbeiten tab', () => {
    renderCockpit();
    const btn = document.querySelector('[data-testid="idea-capture-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/idee/i);
  });

  it('clicking "Idee" opens the Quick-Capture-Modal (role=dialog, aria-modal)', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    const modal = document.querySelector('[data-testid="idea-capture-modal"]');
    expect(modal).toBeTruthy();
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
  });

  it('title input + optional body textarea are present in the modal', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    expect(document.querySelector('[data-testid="idea-title-input"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="idea-body-input"]')).toBeTruthy();
  });

  it('Escape closes the modal', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    expect(document.querySelector('[data-testid="idea-capture-modal"]')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-testid="idea-capture-modal"]'), { key: 'Escape' });
    });
    expect(document.querySelector('[data-testid="idea-capture-modal"]')).toBeNull();
  });

  it('Abbrechen closes the modal without any POST to .../ideas', async () => {
    const fetchFn = makeFetchFn();
    renderCockpit(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-cancel-btn"]'));
    });
    expect(document.querySelector('[data-testid="idea-capture-modal"]')).toBeNull();
    const ideaCalls = fetchFn.mock.calls.filter((c) => IDEAS_URL_RE.test(c[0]));
    expect(ideaCalls).toHaveLength(0);
  });
});

// ── AC4/AC3: Validierung — leerer Titel deaktiviert Speichern ────────────────

describe('CockpitView — AC4 (ideen-inbox): Leerer Titel deaktiviert Speichern', () => {
  it('Save button is disabled while title is empty', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    const saveBtn = document.querySelector('[data-testid="idea-save-btn"]');
    expect(saveBtn.disabled).toBe(true);
  });

  it('Save button becomes enabled once a non-whitespace title is entered', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    const titleInput = document.querySelector('[data-testid="idea-title-input"]');
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: 'Eine Idee' } });
    });
    expect(document.querySelector('[data-testid="idea-save-btn"]').disabled).toBe(false);
  });

  it('whitespace-only title keeps Save disabled', async () => {
    renderCockpit();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    const titleInput = document.querySelector('[data-testid="idea-title-input"]');
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: '   ' } });
    });
    expect(document.querySelector('[data-testid="idea-save-btn"]').disabled).toBe(true);
  });
});

// ── AC3/AC4: Speichern → POST, 201 schließt, 400 zeigt Fehler ────────────────

describe('CockpitView — AC4 (ideen-inbox): Speichern ruft POST .../ideas', () => {
  it('Speichern POSTs { title } to /api/board/projects/:slug/ideas', async () => {
    const fetchFn = makeFetchFn({ ideaStatus: 201 });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-title-input"]'), {
        target: { value: 'Dark-Mode für die Übersicht' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-save-btn"]'));
    });

    await waitFor(() => {
      const call = fetchFn.mock.calls.find((c) => IDEAS_URL_RE.test(c[0]) && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      expect(call[0]).toBe('/api/board/projects/my-project/ideas');
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ title: 'Dark-Mode für die Übersicht', area: 'board' });
    });
  });

  it('includes body when a non-empty Stichwort-Body is entered', async () => {
    const fetchFn = makeFetchFn({ ideaStatus: 201 });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-title-input"]'), {
        target: { value: 'Idee mit Stichworten' },
      });
      fireEvent.change(document.querySelector('[data-testid="idea-body-input"]'), {
        target: { value: 'Stichwort 1\nStichwort 2' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-save-btn"]'));
    });

    await waitFor(() => {
      const call = fetchFn.mock.calls.find((c) => IDEAS_URL_RE.test(c[0]) && c[1]?.method === 'POST');
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ title: 'Idee mit Stichworten', body: 'Stichwort 1\nStichwort 2', area: 'board' });
    });
  });

  it('201 response closes the modal', async () => {
    const fetchFn = makeFetchFn({ ideaStatus: 201 });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-title-input"]'), {
        target: { value: 'Eine Idee' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-save-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-capture-modal"]')).toBeNull();
    });
  });

  it('400 response shows inline error and keeps the modal open (Owner kann korrigieren)', async () => {
    const fetchFn = makeFetchFn({
      ideaStatus: 400,
      ideaBody: { field: 'title', message: 'title darf nicht leer sein' },
    });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-title-input"]'), {
        target: { value: 'Eine Idee' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-save-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="idea-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/title darf nicht leer sein/i);
    });
    expect(document.querySelector('[data-testid="idea-capture-modal"]')).toBeTruthy();
  });

  it('network error shows a generic error message, no crash', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/session') {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      throw new Error('network down');
    });
    renderCockpit(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-capture-btn"]'));
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="idea-title-input"]'), {
        target: { value: 'Eine Idee' },
      });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-save-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="idea-error"]')).toBeTruthy();
    });
  });
});

// ── IdeaCaptureModal (isoliert, ohne CockpitView) — Rendering-Grundlagen ─────

describe('IdeaCaptureModal (isoliert): Grundstruktur', () => {
  it('renders heading "Idee erfassen"', () => {
    render(
      React.createElement(IdeaCaptureModal, {
        projectSlug: 'my-project',
        onClose: jest.fn(),
        fetchFn: makeFetchFn(),
      }),
    );
    expect(document.body.textContent).toMatch(/idee erfassen/i);
  });

  it('onClose is called when Abbrechen is clicked', async () => {
    const onClose = jest.fn();
    render(
      React.createElement(IdeaCaptureModal, {
        projectSlug: 'my-project',
        onClose,
        fetchFn: makeFetchFn(),
      }),
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="idea-cancel-btn"]'));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
