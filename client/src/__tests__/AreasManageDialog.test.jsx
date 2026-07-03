/**
 * AreasManageDialog.test.jsx — Tests für den „Bereiche verwalten"-Dialog
 * (docs/specs/bereichs-modell.md, S-290).
 *
 * Covers (bereichs-modell):
 *   AC8  — Liste sortiert nach `order` (Server-Reihenfolge übernommen);
 *          Anlegen (`POST .../areas`), Umbenennen (Inline-Edit → `PATCH
 *          .../areas/:id`), Umsortieren (Hoch/Runter → `POST
 *          .../areas/reorder` mit adjazentem ID-Swap); nach JEDER
 *          erfolgreichen Mutation wird die Liste per erneutem `GET .../areas`
 *          neu geladen.
 *   AC9  — Lösch-Button je Zeile deaktiviert (mit sprechendem `aria-label` +
 *          `title`), solange `storyCount > 0`; sonst öffnet ein Klick eine
 *          inline Bestätigung; `area-not-empty` (409)/sonstiger 409/5xx
 *          erscheint nicht-blockierend (`role="alert"`) inline, Dialog/Liste
 *          bleiben erhalten.
 *   AC10 — `role="dialog"`/`aria-modal`/`aria-labelledby`; Fokus beim Öffnen
 *          auf das erste Bedienelement; echte Fokusfalle (Tab/Shift+Tab
 *          zyklisch über Buttons UND Inputs); `Esc` schließt + Fokus-
 *          Rückgabe an `triggerRef`; ausschließlich echte `<button>`-
 *          Elemente mit sprechenden `aria-label`n; Lade-/Fehlerzustände
 *          sind `role="status"`/`role="alert"` zugeordnet; Zuordnungs-
 *          Zustand ("leer"/"N Story/Storys") als Text, nicht nur Farbe.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { AreasManageDialog } = await import('../AreasManageDialog.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const AREAS_GET_RE = /\/api\/board\/projects\/([^/]+)\/areas$/;
const AREA_ITEM_RE = /\/api\/board\/projects\/([^/]+)\/areas\/([^/]+)$/;
const REORDER_RE = /\/api\/board\/projects\/([^/]+)\/areas\/reorder$/;

const AREA_BOARD = { id: 'board', name: 'Board', order: 0, description: null, storyCount: 0 };
const AREA_VPS = { id: 'vps', name: 'VPS', order: 1, description: null, storyCount: 3 };
const AREA_EMPTY = { id: 'obsidian', name: 'Obsidian', order: 2, description: null, storyCount: 0 };

/**
 * Stateful fetch mock for the areas endpoints.
 * `areasSequence` liefert die aufeinanderfolgenden GET .../areas-Antworten
 * (letzter Eintrag wird geklammert, analog ObsidianIngestOverlay.test.jsx).
 */
function makeFetch({
  areasSequence = [[AREA_BOARD, AREA_VPS, AREA_EMPTY]],
  postStatus = 201,
  postBody = { id: 'neu' },
  patchStatus = 200,
  patchBody = { id: 'vps' },
  reorderStatus = 200,
  reorderBody = { areas: [] },
  deleteStatus = 200,
  deleteBody = { deleted: 'obsidian' },
} = {}) {
  let getIdx = 0;
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    let parsedBody;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsedBody = opts.body; }
    fetchFn.calls = fetchFn.calls || [];
    fetchFn.calls.push({ url, method, body: parsedBody });

    if (REORDER_RE.test(url) && method === 'POST') {
      return { status: reorderStatus, json: async () => reorderBody };
    }
    if (AREA_ITEM_RE.test(url) && method === 'PATCH') {
      return { status: patchStatus, json: async () => patchBody };
    }
    if (AREA_ITEM_RE.test(url) && method === 'DELETE') {
      return { status: deleteStatus, json: async () => deleteBody };
    }
    if (AREAS_GET_RE.test(url) && method === 'POST') {
      return { status: postStatus, json: async () => postBody };
    }
    if (AREAS_GET_RE.test(url) && method === 'GET') {
      const areas = areasSequence[Math.min(getIdx, areasSequence.length - 1)];
      getIdx += 1;
      return { status: 200, json: async () => ({ areas }) };
    }
    return { status: 404, json: async () => ({ error: 'not found' }) };
  });
  fetchFn.calls = [];
  return fetchFn;
}

async function renderDialog({ fetchFn, onClose, triggerRef, projectSlug = 'my-project' } = {}) {
  const fn = fetchFn ?? makeFetch();
  const close = onClose ?? jest.fn();
  const trigger = triggerRef ?? { current: { focus: jest.fn() } };
  const utils = render(
    React.createElement(AreasManageDialog, {
      projectSlug,
      fetchFn: fn,
      onClose: close,
      triggerRef: trigger,
    }),
  );
  await waitFor(() => {
    expect(utils.container.querySelector('[data-testid="areas-manage-dialog"]')).toBeTruthy();
  });
  return { ...utils, fetchFn: fn, onClose: close, triggerRef: trigger };
}

// ── AC8: Liste, Anlegen, Umbenennen, Umsortieren ─────────────────────────────

describe('bereichs-modell AC8 — Bereichsliste + Mutationen', () => {
  it('lädt die Bereichsliste per GET und zeigt sie in Server-Reihenfolge', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      const rows = utils.container.querySelectorAll('[data-testid="areas-manage-row"]');
      expect(rows).toHaveLength(3);
    });
    const rows = utils.container.querySelectorAll('[data-testid="areas-manage-row"]');
    expect(rows[0].getAttribute('data-area-id')).toBe('board');
    expect(rows[1].getAttribute('data-area-id')).toBe('vps');
    expect(rows[2].getAttribute('data-area-id')).toBe('obsidian');
    expect(utils.fetchFn.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('leere Liste zeigt einen Hinweistext statt eines Crashs', async () => {
    const fetchFn = makeFetch({ areasSequence: [[]] });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelector('[data-testid="areas-manage-empty"]')).toBeTruthy();
    });
  });

  it('Anlegen: POST mit getrimmtem Namen, danach Reload (zweiter GET)', async () => {
    const fetchFn = makeFetch({
      areasSequence: [
        [AREA_BOARD, AREA_VPS, AREA_EMPTY],
        [AREA_BOARD, AREA_VPS, AREA_EMPTY, { id: 'neu', name: 'Neu', order: 3, storyCount: 0 }],
      ],
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });

    const input = utils.container.querySelector('[data-testid="areas-manage-new-name-input"]');
    fireEvent.change(input, { target: { value: '  Neu  ' } });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-add-btn"]'));
    });

    await waitFor(() => {
      const postCalls = fetchFn.calls.filter((c) => c.method === 'POST' && AREAS_GET_RE.test(c.url));
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].body).toEqual({ name: 'Neu' });
    });

    // Reload nach Erfolg (AC8) — zweiter GET, neue Zeile erscheint
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(4);
    });
    const getCalls = fetchFn.calls.filter((c) => c.method === 'GET');
    expect(getCalls).toHaveLength(2);
    // Eingabefeld ist nach Erfolg zurückgesetzt
    expect(input.value).toBe('');
  });

  it('Anlegen: „Hinzufügen" ist deaktiviert, solange der Name (getrimmt) leer ist', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    const addBtn = utils.container.querySelector('[data-testid="areas-manage-add-btn"]');
    expect(addBtn.disabled).toBe(true);

    const input = utils.container.querySelector('[data-testid="areas-manage-new-name-input"]');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(addBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'X' } });
    expect(addBtn.disabled).toBe(false);
  });

  it('Anlegen: 400-Fehler (Duplikat) erscheint nicht-blockierend, Liste bleibt', async () => {
    const fetchFn = makeFetch({ postStatus: 400, postBody: { field: 'name', message: 'Bereich existiert bereits.' } });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    const input = utils.container.querySelector('[data-testid="areas-manage-new-name-input"]');
    fireEvent.change(input, { target: { value: 'Board' } });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-add-btn"]'));
    });
    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="areas-manage-add-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toMatch(/existiert bereits/);
    });
    // Liste bleibt unverändert sichtbar (kein Crash, kein Reload)
    expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
  });

  it('Umbenennen: Inline-Edit → PATCH mit getrimmtem Namen, danach Reload', async () => {
    const fetchFn = makeFetch({
      areasSequence: [
        [AREA_BOARD, AREA_VPS, AREA_EMPTY],
        [{ ...AREA_BOARD, name: 'Board Neu' }, AREA_VPS, AREA_EMPTY],
      ],
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });

    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-rename-btn-board"]'));
    });
    const editInput = utils.container.querySelector('[data-testid="areas-manage-edit-input-board"]');
    expect(editInput).toBeTruthy();
    expect(editInput.value).toBe('Board');
    fireEvent.change(editInput, { target: { value: '  Board Neu  ' } });

    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-save-btn-board"]'));
    });

    await waitFor(() => {
      const patchCalls = fetchFn.calls.filter((c) => c.method === 'PATCH');
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0].url).toMatch(/\/areas\/board$/);
      expect(patchCalls[0].body).toEqual({ name: 'Board Neu' });
    });

    await waitFor(() => {
      expect(utils.container.querySelector('[data-testid="areas-manage-name-board"]').textContent).toBe('Board Neu');
    });
    const getCalls = fetchFn.calls.filter((c) => c.method === 'GET');
    expect(getCalls).toHaveLength(2);
  });

  it('Umbenennen: „Abbrechen" verwirft die Eingabe ohne PATCH', async () => {
    const fetchFn = makeFetch();
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-rename-btn-board"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-cancel-edit-btn-board"]'));
    });
    expect(utils.container.querySelector('[data-testid="areas-manage-edit-input-board"]')).toBeFalsy();
    expect(fetchFn.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('Umsortieren: „nach unten" bei der ersten Zeile sendet adjazenten ID-Swap, danach Reload', async () => {
    const fetchFn = makeFetch({
      areasSequence: [
        [AREA_BOARD, AREA_VPS, AREA_EMPTY],
        [AREA_VPS, AREA_BOARD, AREA_EMPTY],
      ],
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });

    // Erste Zeile: „nach oben" ist deaktiviert (AC10 — Zustand ist sinnvoll begrenzt)
    expect(utils.container.querySelector('[data-testid="areas-manage-up-btn-board"]').disabled).toBe(true);
    // letzte Zeile: „nach unten" ist deaktiviert
    expect(utils.container.querySelector('[data-testid="areas-manage-down-btn-obsidian"]').disabled).toBe(true);

    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-down-btn-board"]'));
    });

    await waitFor(() => {
      const reorderCalls = fetchFn.calls.filter((c) => REORDER_RE.test(c.url) && c.method === 'POST');
      expect(reorderCalls).toHaveLength(1);
      expect(reorderCalls[0].body).toEqual({ orderedIds: ['vps', 'board', 'obsidian'] });
    });

    await waitFor(() => {
      const rows = utils.container.querySelectorAll('[data-testid="areas-manage-row"]');
      expect(rows[0].getAttribute('data-area-id')).toBe('vps');
      expect(rows[1].getAttribute('data-area-id')).toBe('board');
    });
  });

  it('Umsortieren: 409 (Lock) erscheint nicht-blockierend, Liste bleibt unverändert', async () => {
    const fetchFn = makeFetch({ reorderStatus: 409, reorderBody: { error: 'Projekt wird gerade bearbeitet.' } });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-down-btn-board"]'));
    });
    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="areas-manage-reorder-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
    });
    // unverändert (kein Reload, keine neue Reihenfolge)
    const rows = utils.container.querySelectorAll('[data-testid="areas-manage-row"]');
    expect(rows[0].getAttribute('data-area-id')).toBe('board');
  });
});

// ── AC9: Lösch-Guard + Bestätigung + Fehleranzeige ───────────────────────────

describe('bereichs-modell AC9 — Lösch-Guard + Bestätigung', () => {
  it('Lösch-Button ist deaktiviert (mit Hinweis), solange storyCount > 0', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    const vpsDeleteBtn = utils.container.querySelector('[data-testid="areas-manage-delete-btn-vps"]');
    expect(vpsDeleteBtn.disabled).toBe(true);
    expect(vpsDeleteBtn.getAttribute('aria-label')).toMatch(/nicht möglich/i);

    const emptyDeleteBtn = utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]');
    expect(emptyDeleteBtn.disabled).toBe(false);
  });

  it('Klick auf einen aktiven Lösch-Button öffnet eine inline Bestätigung (kein sofortiger DELETE)', async () => {
    const fetchFn = makeFetch();
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]'));
    });
    expect(utils.container.querySelector('[data-testid="areas-manage-delete-confirm-obsidian"]')).toBeTruthy();
    expect(fetchFn.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('Bestätigen sendet DELETE und lädt danach neu (Zeile verschwindet)', async () => {
    const fetchFn = makeFetch({
      areasSequence: [
        [AREA_BOARD, AREA_VPS, AREA_EMPTY],
        [AREA_BOARD, AREA_VPS],
      ],
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-confirm-btn-obsidian"]'));
    });

    await waitFor(() => {
      const deleteCalls = fetchFn.calls.filter((c) => c.method === 'DELETE');
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].url).toMatch(/\/areas\/obsidian$/);
    });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(2);
    });
  });

  it('Abbrechen der Bestätigung sendet keinen DELETE', async () => {
    const fetchFn = makeFetch();
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-cancel-btn-obsidian"]'));
    });
    expect(utils.container.querySelector('[data-testid="areas-manage-delete-confirm-obsidian"]')).toBeFalsy();
    expect(fetchFn.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('area-not-empty (409) erscheint nicht-blockierend mit Story-/Spec-Zählern, Dialog/Liste bleiben', async () => {
    const fetchFn = makeFetch({
      deleteStatus: 409,
      deleteBody: { error: 'area-not-empty', storyCount: 0, specCount: 2 },
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-confirm-btn-obsidian"]'));
    });

    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="areas-manage-delete-error-obsidian"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toMatch(/2 Spec/);
    });
    // Dialog + Zeile bleiben erhalten (kein Crash, kein Verwerfen der Liste)
    expect(utils.container.querySelector('[data-testid="areas-manage-dialog"]')).toBeTruthy();
    expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
  });

  it('5xx beim Löschen erscheint nicht-blockierend, Ansicht bleibt', async () => {
    const fetchFn = makeFetch({ deleteStatus: 500, deleteBody: { error: 'Bereich konnte nicht gelöscht werden.' } });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-btn-obsidian"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-delete-confirm-btn-obsidian"]'));
    });
    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="areas-manage-delete-error-obsidian"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
    });
    expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
  });
});

// ── AC10: A11y (fokussiertes Dialog-Muster) ──────────────────────────────────

describe('bereichs-modell AC10 — A11y (Dialog-Muster)', () => {
  it('role=dialog/aria-modal/aria-labelledby gesetzt; Fokus initial im Dialog', async () => {
    const utils = await renderDialog();
    const dialog = utils.container.querySelector('[data-testid="areas-manage-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('areas-manage-dialog-title');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('Esc schließt den Dialog und gibt den Fokus an triggerRef zurück', async () => {
    const triggerRef = { current: { focus: jest.fn() } };
    const onClose = jest.fn();
    const utils = await renderDialog({ onClose, triggerRef });
    const dialog = utils.container.querySelector('[data-testid="areas-manage-dialog"]');

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(triggerRef.current.focus).toHaveBeenCalledTimes(1);
  });

  it('Backdrop-Klick schließt den Dialog', async () => {
    const onClose = jest.fn();
    const utils = await renderDialog({ onClose });
    const backdrop = utils.container.querySelector('div[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    await act(async () => {
      fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Fokusfalle: Tab am letzten Element springt zum ersten, Shift+Tab am ersten zum letzten', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    const dialog = utils.container.querySelector('[data-testid="areas-manage-dialog"]');
    const focusable = dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])');
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('alle Aktionen sind echte <button>-Elemente mit sprechenden aria-label', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    for (const testid of [
      'areas-manage-rename-btn-board',
      'areas-manage-up-btn-board',
      'areas-manage-down-btn-board',
      'areas-manage-delete-btn-obsidian',
      'areas-manage-close-btn',
      'areas-manage-add-btn',
    ]) {
      const el = utils.container.querySelector(`[data-testid="${testid}"]`);
      expect(el).toBeTruthy();
      expect(el.tagName).toBe('BUTTON');
      expect(el.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('Zuordnungs-Zustand erscheint als Text ("leer"/"N Story/Storys"), nicht nur Farbe', async () => {
    const utils = await renderDialog();
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(3);
    });
    expect(utils.container.querySelector('[data-testid="areas-manage-count-board"]').textContent).toBe('leer');
    expect(utils.container.querySelector('[data-testid="areas-manage-count-vps"]').textContent).toBe('3 Story/Storys');
  });

  it('Ladefehler ist role=status/role=alert zugeordnet, „Erneut versuchen" lädt neu', async () => {
    let callCount = 0;
    const fetchFn = jest.fn(async (url) => {
      callCount += 1;
      if (AREAS_GET_RE.test(url) && callCount === 1) {
        return { status: 500, json: async () => ({ error: 'Serverfehler' }) };
      }
      return { status: 200, json: async () => ({ areas: [AREA_BOARD] }) };
    });
    const utils = await renderDialog({ fetchFn });
    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="areas-manage-load-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-load-retry-btn"]'));
    });
    await waitFor(() => {
      expect(utils.container.querySelectorAll('[data-testid="areas-manage-row"]')).toHaveLength(1);
    });
  });
});
