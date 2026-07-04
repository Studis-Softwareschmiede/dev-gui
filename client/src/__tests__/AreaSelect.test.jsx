/**
 * AreaSelect.test.jsx — story-idee-bereich-zuordnung AC1/AC2/AC3/AC6 (S-291).
 *
 * Covers:
 *   AC1 — Dropdown listet Bereiche aus GET …/areas (Label name, Wert id) + „Neuer Bereich…".
 *   AC2 — Vorbelegung: defaultAreaId wenn vorhanden, sonst erster Bereich; leere Liste
 *         erzwingt Inline-Neuanlage (Eingabefeld direkt sichtbar, onChange(null)).
 *   AC3 — „Neuer Bereich…" legt über POST …/areas an (201 → Reload + Auswahl); 409-Fehler
 *         erscheint inline (role=alert) ohne Dialog-Verlust.
 *   AC6 — beschriftetes select (label/htmlFor), sprechende aria-label.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { AreaSelect } = await import('../AreaSelect.jsx');

const AREAS = [
  { id: 'board', name: 'Board', order: 1 },
  { id: 'vps', name: 'VPS', order: 2 },
];

function makeFetch({ areas = AREAS, createStatus = 201, createBody = { id: 'neu' } } = {}) {
  const state = { areas: [...areas] };
  const fn = jest.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      if (createStatus === 201) state.areas.push({ id: createBody.id, name: 'Neu', order: 99 });
      return { ok: createStatus === 201, status: createStatus, json: async () => (createStatus === 201 ? createBody : { error: 'Bereichsname ist bereits vergeben' }) };
    }
    return { ok: true, status: 200, json: async () => ({ areas: state.areas }) };
  });
  return fn;
}

describe('AreaSelect (S-291)', () => {
  it('AC1/AC2/AC6 — listet Bereiche, belegt ersten vor, label/aria vorhanden', async () => {
    const onChange = jest.fn();
    const fetchFn = makeFetch();
    const { container } = render(React.createElement(AreaSelect, {
      projectSlug: 'dev-gui', value: null, onChange, fetchFn, idPrefix: 't1',
    }));
    await waitFor(() => { expect(container.querySelector('#t1-select')).toBeTruthy(); });
    expect(onChange).toHaveBeenCalledWith('board'); // erster nach order
    const opts = [...container.querySelectorAll('option')].map((o) => o.value);
    expect(opts).toContain('board');
    expect(opts).toContain('vps');
    expect(opts).toContain('__neuer_bereich__');
    expect(container.querySelector('label[for="t1-select"]')).toBeTruthy();
    expect(container.querySelector('#t1-select').getAttribute('aria-label')).toMatch(/Bereich/);
  });

  it('AC2 — defaultAreaId gewinnt; leere Liste erzwingt Neuanlage', async () => {
    const onChange = jest.fn();
    const { unmount } = render(React.createElement(AreaSelect, {
      projectSlug: 'dev-gui', value: null, onChange, fetchFn: makeFetch(), defaultAreaId: 'vps', idPrefix: 't2',
    }));
    await waitFor(() => { expect(onChange).toHaveBeenCalledWith('vps'); });
    unmount();
    const onChange2 = jest.fn();
    const { container: c2 } = render(React.createElement(AreaSelect, {
      projectSlug: 'dev-gui', value: null, onChange: onChange2, fetchFn: makeFetch({ areas: [] }), idPrefix: 't3',
    }));
    await waitFor(() => { expect(c2.querySelector('#t3-new-name')).toBeTruthy(); });
    expect(onChange2).toHaveBeenCalledWith(null);
    expect(c2.querySelector('#t3-select')).toBeNull();
  });

  it('AC3 — Neuanlage 201 wählt neuen Bereich; 409 zeigt role=alert inline', async () => {
    const onChange = jest.fn();
    const fetchFn = makeFetch();
    const { container, getByText } = render(React.createElement(AreaSelect, {
      projectSlug: 'dev-gui', value: 'board', onChange, fetchFn, idPrefix: 't4',
    }));
    await waitFor(() => { expect(container.querySelector('#t4-select')).toBeTruthy(); });
    fireEvent.change(container.querySelector('#t4-select'), { target: { value: '__neuer_bereich__' } });
    fireEvent.change(container.querySelector('#t4-new-name'), { target: { value: 'Neu' } });
    fireEvent.click(getByText('Anlegen'));
    await waitFor(() => { expect(onChange).toHaveBeenCalledWith('neu'); });

    const onChange2 = jest.fn();
    const f2 = makeFetch({ createStatus: 409 });
    const { container: c2, getByText: g2 } = render(React.createElement(AreaSelect, {
      projectSlug: 'dev-gui', value: 'board', onChange: onChange2, fetchFn: f2, idPrefix: 't5',
    }));
    await waitFor(() => { expect(c2.querySelector('#t5-select')).toBeTruthy(); });
    fireEvent.change(c2.querySelector('#t5-select'), { target: { value: '__neuer_bereich__' } });
    fireEvent.change(c2.querySelector('#t5-new-name'), { target: { value: 'Board' } });
    fireEvent.click(g2('Anlegen'));
    await waitFor(() => {
      const alert = c2.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(/vergeben/);
    });
    expect(c2.querySelector('#t5-new-name')).toBeTruthy(); // Dialog nicht verloren
  });
});
