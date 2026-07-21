/**
 * RedTeamView.test.jsx — Tests für die Red-Team-Kachel (Spec docs/specs/red-team-tile.md
 * AC7/AC8/AC9).
 *
 * Deckt ab (AC9):
 *   (a) lädt Targets und rendert sie als Auswahl (Dropdown, KEIN Freitext-Input).
 *   (b) leere Allowlist → Hinweis, kein Start-Button (nichts feuerbar, AC8).
 *   (c) Start erst nach Feuer-Freigabe-Bestätigung möglich (AC7).
 *   (d) POST→202 dann Poll→done zeigt Ergebnis + PR-Link; POST-Body-Default modus:'direkt'.
 *   (f) Sicherheits-Text ist ehrlich zum scharfen Betrieb: „nicht-destruktiv" +
 *       „Koordination"/„Cloudflare … nie selbst", NICHT mehr „Trockenlauf" (F-032).
 *
 * Mock-Muster gespiegelt von SpecViewReconcileTrigger.test.jsx (mockbarer fetchFn,
 * kurzes pollInterval statt Fake-Timer).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const RedTeamView = (await import('../RedTeamView.jsx')).default;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fetch mock covering the three Red-Team endpoints.
 *
 * @param {object} opts
 * @param {Array}  [opts.targets]     — body.targets for GET /api/red-team/targets
 * @param {number} [opts.startStatus] — HTTP status for POST /api/red-team
 * @param {object} [opts.startBody]   — body for POST /api/red-team
 * @param {object} [opts.jobBody]     — body for GET /api/red-team/:jobId
 */
function makeFetchFn({
  targets = [{ slug: 'app-a', image: 'ghcr/app-a', state: 'running', repo: 'org/app-a' }],
  startStatus = 202,
  startBody = { jobId: 'rt-1', status: 'running' },
  jobBody = { status: 'running' },
} = {}) {
  return jest.fn(async (url, opts) => {
    if (url === '/api/red-team/targets') {
      return { ok: true, status: 200, json: async () => ({ targets }) };
    }
    if (url === '/api/red-team' && opts?.method === 'POST') {
      return { ok: startStatus === 202, status: startStatus, json: async () => startBody };
    }
    if (typeof url === 'string' && url.startsWith('/api/red-team/')) {
      return { ok: true, status: 200, json: async () => jobBody };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function renderView(fetchFn, extra = {}) {
  const onNavigate = jest.fn();
  render(
    React.createElement(RedTeamView, {
      onNavigate,
      fetchFn,
      pollInterval: 10,
      ...extra,
    }),
  );
  return { onNavigate };
}

const sel = (id) => document.querySelector(`[data-testid="${id}"]`);

// ── (a) Targets als Auswahl, kein Freitext ──────────────────────────────────────

describe('RedTeamView — AC7: Ziel-Auswahl aus Allowlist (kein Freitext)', () => {
  it('lädt Targets und rendert sie als Dropdown (SELECT), ohne Freitext-Input', async () => {
    const fetchFn = makeFetchFn({
      targets: [
        { slug: 'app-a', image: 'ghcr/app-a', state: 'running' },
        { slug: 'app-b', image: 'ghcr/app-b', state: 'running' },
      ],
    });
    renderView(fetchFn);

    await waitFor(() => {
      expect(sel('red-team-targets-select')).toBeTruthy();
    });

    const select = sel('red-team-targets-select');
    expect(select.tagName).toBe('SELECT');
    expect(select.textContent).toMatch(/app-a/);
    expect(select.textContent).toMatch(/app-b/);

    // Kein Freitext-Eingabefeld (nur Checkbox + Selects erlaubt).
    expect(document.querySelector('input[type="text"]')).toBeNull();
    expect(document.querySelector('input:not([type="checkbox"])')).toBeNull();

    // GET /api/red-team/targets wurde aufgerufen.
    expect(
      fetchFn.mock.calls.some((c) => c[0] === '/api/red-team/targets'),
    ).toBe(true);
  });
});

// ── (f) Sicherheits-Text: scharf, nicht-destruktiv, Koordination (F-032) ────────

describe('RedTeamView — Sicherheits-Text ist ehrlich zum scharfen Betrieb', () => {
  it('nennt „nicht-destruktiv" + Koordination/Cloudflare-nie-selbst und NICHT mehr „Trockenlauf"', async () => {
    const fetchFn = makeFetchFn({ targets: [{ slug: 'app-a', state: 'running' }] });
    renderView(fetchFn);

    await waitFor(() => expect(sel('red-team-safety-note')).toBeTruthy());

    const note = sel('red-team-safety-note');
    expect(note.textContent).toMatch(/nicht-destruktiv/i);
    expect(note.textContent).toMatch(/koordination/i);
    expect(note.textContent).toMatch(/cloudflare nie selbst/i);
    // „Trockenlauf" ist jetzt falsch und muss verschwunden sein.
    expect(document.body.textContent).not.toMatch(/trockenlauf/i);

    // Auch die Feuer-Freigabe-Bestätigung bleibt scharf-ehrlich.
    await waitFor(() => expect(sel('red-team-fire-confirm')).toBeTruthy());
    const confirmRow = sel('red-team-fire-confirm').closest('label');
    expect(confirmRow.textContent).toMatch(/nicht-destruktiv/i);
    expect(confirmRow.textContent).toMatch(/koordination/i);
  });
});

// ── (b) Leere Allowlist (AC8) ───────────────────────────────────────────────────

describe('RedTeamView — AC8: leere Allowlist', () => {
  it('zeigt „kein autorisiertes Ziel" und bietet keinen Start-Button', async () => {
    const fetchFn = makeFetchFn({ targets: [] });
    renderView(fetchFn);

    await waitFor(() => {
      expect(sel('red-team-empty')).toBeTruthy();
    });
    expect(sel('red-team-empty').textContent).toMatch(/kein autorisiertes ziel/i);

    // Nichts feuerbar → gar kein Start-Button (stärker als „deaktiviert").
    expect(sel('red-team-start-btn')).toBeNull();
    expect(sel('red-team-targets-select')).toBeNull();
  });
});

// ── (c) Feuer-Freigabe-Gate (AC7) ───────────────────────────────────────────────

describe('RedTeamView — AC7: Start erst nach Feuer-Freigabe', () => {
  it('Start bleibt deaktiviert bis Ziel gewählt UND Feuer-Freigabe bestätigt', async () => {
    const fetchFn = makeFetchFn({ targets: [{ slug: 'app-a', state: 'running' }] });
    renderView(fetchFn);

    await waitFor(() => expect(sel('red-team-targets-select')).toBeTruthy());

    // Ohne Auswahl + ohne Bestätigung: deaktiviert.
    expect(sel('red-team-start-btn').disabled).toBe(true);

    // Ziel wählen — immer noch deaktiviert (keine Feuer-Freigabe).
    await act(async () => {
      fireEvent.change(sel('red-team-targets-select'), { target: { value: 'app-a' } });
    });
    expect(sel('red-team-start-btn').disabled).toBe(true);

    // Klick auf deaktivierten Start löst keinen POST aus.
    await act(async () => {
      fireEvent.click(sel('red-team-start-btn'));
    });
    expect(
      fetchFn.mock.calls.filter((c) => c[0] === '/api/red-team' && c[1]?.method === 'POST'),
    ).toHaveLength(0);

    // Feuer-Freigabe bestätigen → Start aktiv.
    await act(async () => {
      fireEvent.click(sel('red-team-fire-confirm'));
    });
    await waitFor(() => {
      expect(sel('red-team-start-btn').disabled).toBe(false);
    });
  });
});

// ── (d) Voller Fluss: POST→202→Poll→done ────────────────────────────────────────

describe('RedTeamView — AC7: POST→202, Poll→done zeigt Ergebnis + PR-Link', () => {
  it('startet den Lauf und zeigt nach „done" Ergebnis, Protokoll-Hinweis und PR-Link', async () => {
    const fetchFn = makeFetchFn({
      targets: [{ slug: 'app-a', state: 'running' }],
      startStatus: 202,
      startBody: { jobId: 'rt-1', status: 'running' },
      jobBody: {
        status: 'done',
        result: '2 potenzielle Funde (scharf)',
        prHint: 'https://github.com/org/app-a/pull/42',
      },
    });
    renderView(fetchFn);

    await waitFor(() => expect(sel('red-team-targets-select')).toBeTruthy());

    await act(async () => {
      fireEvent.change(sel('red-team-targets-select'), { target: { value: 'app-a' } });
    });
    await act(async () => {
      fireEvent.click(sel('red-team-fire-confirm'));
    });
    await waitFor(() => expect(sel('red-team-start-btn').disabled).toBe(false));

    await act(async () => {
      fireEvent.click(sel('red-team-start-btn'));
    });

    // Ergebnis erscheint nach Poll→done.
    await waitFor(() => {
      expect(sel('red-team-result')).toBeTruthy();
    });

    const result = sel('red-team-result');
    expect(result.textContent).toMatch(/docs\/red-team-audit\.md/);
    expect(result.textContent).toMatch(/2 potenzielle Funde/);

    // PR-Link vorhanden + korrekt.
    const prLink = sel('red-team-pr-link');
    expect(prLink).toBeTruthy();
    expect(prLink.getAttribute('href')).toBe('https://github.com/org/app-a/pull/42');

    // POST-Vertrag: genau einmal {projectSlug, modus}.
    const postCalls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/red-team' && c[1]?.method === 'POST',
    );
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(postCalls[0][1].body);
    expect(body.projectSlug).toBe('app-a');
    expect(body.modus).toBe('direkt');
  });
});

// ── (e) Regression: 202 ohne verwertbare jobId → Fehler, kein Endlos-Spinner ────
describe('RedTeamView — 202 ohne gültige jobId geht in Fehler statt Dauer-„running"', () => {
  it('zeigt einen Fehler und KEIN Ergebnis, wenn die 202-Antwort keine jobId liefert', async () => {
    const fetchFn = makeFetchFn({
      targets: [{ slug: 'app-a', state: 'running' }],
      startStatus: 202,
      startBody: { status: 'running' }, // keine jobId
    });
    renderView(fetchFn);

    await waitFor(() => expect(sel('red-team-targets-select')).toBeTruthy());
    await act(async () => {
      fireEvent.change(sel('red-team-targets-select'), { target: { value: 'app-a' } });
    });
    await act(async () => {
      fireEvent.click(sel('red-team-fire-confirm'));
    });
    await waitFor(() => expect(sel('red-team-start-btn').disabled).toBe(false));
    await act(async () => {
      fireEvent.click(sel('red-team-start-btn'));
    });

    // Fehlerzustand statt endlosem „running": Fehlerbox erscheint, kein Ergebnis.
    await waitFor(() => expect(sel('red-team-error')).toBeTruthy());
    expect(sel('red-team-error').textContent).toMatch(/Job-ID/i);
    expect(sel('red-team-result')).toBeFalsy();
  });
});
