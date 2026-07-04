/**
 * SpecViewAreaFilter.test.jsx — spec-bereichs-filter AC1–AC4 (S-295).
 *
 * Covers:
 *   AC2 — Bereichs-Filter erscheint (Mehrfachauswahl aus GET …/areas, plus „ohne Bereich");
 *         Abwahl eines Bereichs blendet dessen Specs aus; „ohne Bereich" filtert area-lose Specs.
 *   AC3 — Degradation: ohne Bereiche (leere/fehlgeschlagene areas-Antwort) erscheint KEIN
 *         Bereichs-Filter, die Spec-Liste bleibt voll funktionsfähig.
 *   AC4 — A11y: echte Checkboxen mit sprechendem aria-label.
 * (AC1 — DocsReader-Durchreichung — ist in test/DocsReader.test.js abgedeckt.)
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { SpecView } = await import('../SpecView.jsx');

const DOCS = [
  { path: 'docs/specs/alpha.md', title: 'Alpha', type: 'spec', status: 'active', area: 'board', id: 'alpha', version: 1 },
  { path: 'docs/specs/beta.md',  title: 'Beta',  type: 'spec', status: 'active', area: 'vps',   id: 'beta',  version: 1 },
  { path: 'docs/specs/gamma.md', title: 'Gamma', type: 'spec', status: 'active', area: null,    id: 'gamma', version: 1 },
];
const AREAS = [
  { id: 'board', name: 'Board', order: 1 },
  { id: 'vps', name: 'VPS', order: 2 },
];

function makeFetch({ areas = AREAS, areasFail = false } = {}) {
  return jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/areas')) {
      if (areasFail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ areas }) };
    }
    if (u.includes('/docs/') || u.endsWith('/docs')) {
      return { ok: true, status: 200, json: async () => ({ docs: DOCS }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('spec-bereichs-filter AC2–AC4 (S-295)', () => {
  it('AC2/AC4 — Bereichs-Filter erscheint mit Bereichen + „ohne Bereich" als Checkboxen', async () => {
    const fetchFn = makeFetch();
    global.fetch = fetchFn;
    const { container } = render(React.createElement(SpecView, { projectSlug: 'dev-gui', fetchFn }));
    await waitFor(() => {
      expect(container.querySelector('#spec-filter-area-board')).toBeTruthy();
    });
    expect(container.querySelector('#spec-filter-area-vps')).toBeTruthy();
    expect(container.querySelector('#spec-filter-area-__ohne_bereich__')).toBeTruthy();
    const cb = container.querySelector('#spec-filter-area-board');
    expect(cb.getAttribute('type')).toBe('checkbox');
    expect(cb.getAttribute('aria-label')).toMatch(/Bereich Board/);
  });

  it('AC2 — Abwahl eines Bereichs blendet dessen Specs aus; area-lose hängen an „ohne Bereich"', async () => {
    const fetchFn = makeFetch();
    global.fetch = fetchFn;
    const { container, queryByText, getByText } = render(React.createElement(SpecView, { projectSlug: 'dev-gui', fetchFn }));
    await waitFor(() => { expect(container.querySelector('#spec-filter-area-board')).toBeTruthy(); });
    await waitFor(() => { expect(queryByText('Alpha')).toBeTruthy(); });
    // board abwählen -> Alpha weg, Beta+Gamma bleiben
    fireEvent.click(container.querySelector('#spec-filter-area-board'));
    await waitFor(() => { expect(queryByText('Alpha')).toBeNull(); });
    expect(queryByText('Beta')).toBeTruthy();
    expect(queryByText('Gamma')).toBeTruthy();
    // „ohne Bereich" abwählen -> Gamma weg
    fireEvent.click(container.querySelector('#spec-filter-area-__ohne_bereich__'));
    await waitFor(() => { expect(queryByText('Gamma')).toBeNull(); });
    expect(getByText('Beta')).toBeTruthy();
  });

  it('AC3 — ohne Bereiche: kein Bereichs-Filter, Liste voll funktionsfähig', async () => {
    const fetchFn = makeFetch({ areasFail: true });
    global.fetch = fetchFn;
    const { container, queryByText } = render(React.createElement(SpecView, { projectSlug: 'dev-gui', fetchFn }));
    await waitFor(() => { expect(queryByText('Alpha')).toBeTruthy(); });
    expect(container.querySelector('#spec-filter-area-board')).toBeNull();
    expect(queryByText('Beta')).toBeTruthy();
    expect(queryByText('Gamma')).toBeTruthy();
  });
});
