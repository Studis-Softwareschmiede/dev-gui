/**
 * RedTeamScanPanel.test.jsx — Tests für das Live-Fortschritts-/Ergebnis-Panel des
 * Pro-Container Red-Team-Scans (docs/specs/red-team-scan-per-container.md AC11/AC12/AC13).
 *
 * @jest-environment jsdom
 *
 * Covers (red-team-scan-per-container):
 *   AC11 — POSTet `.../scan` beim Mount, pollt danach `GET .../scan/:jobId` bis zu einem
 *          Terminalzustand; zeigt einen (defensiven) Phasen-Stepper NUR während `running`
 *          (Review-Fix Iteration 2: NICHT während `starting`, sonst würde Direkt+Cloudflare
 *          fälschlich als "in Arbeit" erscheinen, bevor der Job überhaupt gestartet ist).
 *   AC12 — bei `done` MIT echten `ampel`-Daten vom Endpunkt: Ampel-Textbadge + Befund-
 *          Kurzliste (inkl. "N weitere"-Kürzung) + Link zum vollen Bericht (`reportRef`),
 *          oder ein klarer "kein Bericht"-Hinweis ohne `reportRef`; "Keine Befunde erkannt"
 *          bei leerer Findings-Liste. Bei `done` OHNE `ampel`-Daten (Findings-Extraktion ist
 *          eine offene Folge-Naht, s. `vpsContainerScanRouter.js`) zeigt das Panel eine
 *          ehrliche neutrale Meldung statt einer irreführenden grünen "keine Befunde"-
 *          Aussage (Review-Fund Iteration 2, Critical) — der Bericht-Link bleibt in BEIDEN
 *          Fällen verfügbar.
 *   AC13 — `failed`/`auth-expired`/Start-Fehler (Netzwerk, non-202, 409, 422)/Nicht-200-
 *          Poll-Antwort zeigen einen `role="alert"`-Text — nie ein hängender Spinner;
 *          `onEnded` wird in JEDEM Terminalzustand genau einmal aufgerufen; `onClose`
 *          reagiert in JEDEM Zustand sofort (Esc, Backdrop, Schließen-Button) — auch
 *          während der Lauf noch aktiv ist.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { RedTeamScanPanel } = await import('../RedTeamScanPanel.jsx');

const PROPS = {
  provider: 'hetzner',
  serverId: 'srv1',
  containerId: 'c1',
  containerLabel: 'app.example.com',
};

function makeFetchFn({
  startStatus = 202,
  startBody = { jobId: 'job-1' },
  pollResponses = [{ status: 200, body: { status: 'running', phase: 'direkt' } }],
} = {}) {
  let pollIdx = 0;
  const calls = [];
  const fn = jest.fn(async (url, opts) => {
    calls.push({ url, opts });
    if (opts?.method === 'POST') {
      return { ok: startStatus === 202, status: startStatus, json: async () => startBody };
    }
    // GET status poll — advance through pollResponses, sticking on the last entry.
    const next = pollResponses[Math.min(pollIdx, pollResponses.length - 1)];
    pollIdx += 1;
    if (next.throw) throw new Error('network');
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  });
  fn.calls = calls;
  return fn;
}

function renderPanel(fetchFn, extra = {}) {
  const onClose = jest.fn();
  const onEnded = jest.fn();
  const utils = render(
    React.createElement(RedTeamScanPanel, {
      ...PROPS,
      onClose,
      onEnded,
      fetchFn,
      pollMs: 10,
      ...extra,
    }),
  );
  return { ...utils, onClose, onEnded };
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── AC11 — Start + Poll ─────────────────────────────────────────────────────────

describe('RedTeamScanPanel — AC11: Start + Live-Poll', () => {
  it('postet .../scan beim Mount und zeigt "läuft" während status:running', async () => {
    const fetchFn = makeFetchFn();
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-running')).toBeDefined();
    });

    const postCalls = fetchFn.calls.filter((c) => c.opts?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].url).toBe('/api/vps/machines/hetzner/srv1/containers/c1/scan');
  });

  it('pollt GET .../scan/:jobId nach dem Start', async () => {
    const fetchFn = makeFetchFn();
    renderPanel(fetchFn);

    await waitFor(() => {
      const pollCalls = fetchFn.calls.filter((c) => !c.opts?.method);
      expect(pollCalls.length).toBeGreaterThan(0);
      expect(pollCalls[0].url).toBe('/api/vps/machines/hetzner/srv1/containers/c1/scan/job-1');
    });
  });

  it('während "starting" wird KEIN Stepper gezeigt (Review-Fix Iteration 2 — kein Vortäuschen laufender Schritte vor Job-Start)', async () => {
    let resolvePost;
    const postPromise = new Promise((resolve) => { resolvePost = resolve; });
    const fetchFn = jest.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        await postPromise;
        return { ok: true, status: 202, json: async () => ({ jobId: 'job-1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'running', phase: 'direkt' }) };
    });
    const { getByTestId, queryByRole, getByRole } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-running').textContent).toMatch(/wird gestartet/);
    });
    expect(queryByRole('list', { name: /Scan-Fortschritt/i })).toBeNull();

    await act(async () => { resolvePost(); });

    await waitFor(() => {
      expect(getByTestId('redteam-scan-running').textContent).toMatch(/läuft/);
    });
    expect(getByRole('list', { name: /Scan-Fortschritt/i })).toBeDefined();
  });
});

// ── AC12 — Ergebnis-Anzeige ──────────────────────────────────────────────────────

describe('RedTeamScanPanel — AC12: Ergebnis-Anzeige', () => {
  it('zeigt Ampel + Befund-Kurzliste + Bericht-Link bei done', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [
        {
          status: 200,
          body: {
            status: 'done',
            phase: 'fertig',
            ampel: 'rot',
            findings: [{ id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'XSS gefunden' }],
            reportRef: 'https://github.com/org/repo/pull/7',
          },
        },
      ],
    });
    const { getByTestId, onEnded } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-result')).toBeDefined();
    });

    expect(getByTestId('redteam-scan-ampel').textContent).toMatch(/Rot/);
    expect(getByTestId('redteam-scan-findings').textContent).toMatch(/XSS gefunden/);
    const link = getByTestId('redteam-scan-report-link');
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/7');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('zeigt "Keine Befunde erkannt" bei leerer Findings-Liste', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'done', phase: 'fertig', ampel: 'gruen', findings: [] } }],
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-no-findings')).toBeDefined();
    });
  });

  it('zeigt einen "kein Bericht"-Hinweis ohne reportRef', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'done', phase: 'fertig', ampel: 'gruen', findings: [] } }],
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-no-report')).toBeDefined();
    });
  });

  it('kürzt mehr als 5 Befunde auf eine "N weitere"-Zeile', async () => {
    const manyFindings = Array.from({ length: 7 }, (_, i) => ({
      id: `f${i}`,
      severity: 'low',
      kind: 'info',
      testort: 'direkt',
      titel: `Befund ${i}`,
    }));
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'done', phase: 'fertig', ampel: 'gelb', findings: manyFindings } }],
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-findings').textContent).toMatch(/2 weitere/);
    });
  });

  it('done OHNE ampel-Daten: NIEMALS eine grüne "keine Befunde"-Aussage (Review-Fund Iteration 2, Critical)', async () => {
    // Der Backend-Endpunkt liefert bei done OHNE Store-Treffer NUR status/phase/reportRef —
    // kein ampel/findings (offene Findings-Extraktions-Naht, s. vpsContainerScanRouter.js).
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'done', phase: 'fertig', reportRef: 'https://github.com/org/repo/pull/9' } }],
    });
    const { getByTestId, queryByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-no-ampel-data')).toBeDefined();
    });
    // Kein Ampel-Badge, kein "Keine Befunde erkannt" — beides würde "geprüft, sauber" vortäuschen.
    expect(queryByTestId('redteam-scan-ampel')).toBeNull();
    expect(queryByTestId('redteam-scan-no-findings')).toBeNull();
    // Der Bericht-Link bleibt trotzdem verfügbar.
    expect(getByTestId('redteam-scan-report-link').getAttribute('href')).toBe('https://github.com/org/repo/pull/9');
  });

  it('done OHNE ampel-Daten UND OHNE reportRef: neutrale Meldung + "kein Bericht"-Hinweis (kein leerer Endzustand)', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'done', phase: 'fertig' } }],
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-no-ampel-data')).toBeDefined();
    });
    expect(getByTestId('redteam-scan-no-report')).toBeDefined();
  });
});

// ── AC13 — Fehler/Abbruch klar, nie still ────────────────────────────────────────

describe('RedTeamScanPanel — AC13: Fehler/Abbruch', () => {
  it('status:failed → role=alert-Meldung, onEnded aufgerufen', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'failed', phase: 'fertig', error: 'Red-Team-Lauf fehlgeschlagen' } }],
    });
    const { getByTestId, onEnded } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-error')).toBeDefined();
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('status:auth-expired → klare Anmeldungs-Meldung', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'auth-expired', phase: 'fertig' } }],
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-error').textContent).toMatch(/Anmeldung abgelaufen/i);
    });
  });

  it('POST 409 (scan-in-progress) → sofortiger Start-Fehler, kein Poll', async () => {
    const fetchFn = makeFetchFn({ startStatus: 409, startBody: { errorClass: 'scan-in-progress' } });
    const { getByTestId, onEnded } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-error').textContent).toMatch(/läuft bereits/i);
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
    const pollCalls = fetchFn.calls.filter((c) => !c.opts?.method);
    expect(pollCalls).toHaveLength(0);
  });

  it('POST 422 (not-scannable) → klare Meldung', async () => {
    const fetchFn = makeFetchFn({ startStatus: 422, startBody: { errorClass: 'not-scannable' } });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-error').textContent).toMatch(/nicht scanbar/i);
    });
  });

  it('Netzwerkfehler beim Start → klare Meldung, kein Crash', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('network down'); });
    const { getByTestId, onEnded } = renderPanel(fetchFn);

    await waitFor(() => {
      expect(getByTestId('redteam-scan-error').textContent).toMatch(/Netzwerkfehler/i);
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('Nicht-200-Poll-Antwort wird NICHT als "noch running" behandelt (lessons 2026-07-01)', async () => {
    // 5 aufeinanderfolgende 404-Antworten (SCAN_MAX_CONSECUTIVE_FAILURES) → Timeout-Fehler.
    const fetchFn = makeFetchFn({
      pollResponses: Array.from({ length: 6 }, () => ({ status: 404, body: {} })),
    });
    const { getByTestId } = renderPanel(fetchFn);

    await waitFor(
      () => {
        expect(getByTestId('redteam-scan-error').textContent).toMatch(/Zeitüberschreitung/i);
      },
      { timeout: 3000 },
    );
  });

  it('Esc schließt sofort — auch während der Lauf noch aktiv ist', async () => {
    const fetchFn = makeFetchFn();
    const { getByTestId, onClose } = renderPanel(fetchFn);

    await waitFor(() => expect(getByTestId('redteam-scan-running')).toBeDefined());

    await act(async () => {
      fireEvent.keyDown(getByTestId('redteam-scan-panel'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Schließen-Button reagiert sofort im Fehlerzustand', async () => {
    const fetchFn = makeFetchFn({
      pollResponses: [{ status: 200, body: { status: 'failed', phase: 'fertig' } }],
    });
    const { getByTestId, onClose } = renderPanel(fetchFn);

    await waitFor(() => expect(getByTestId('redteam-scan-error')).toBeDefined());

    await act(async () => {
      fireEvent.click(getByTestId('redteam-scan-close-btn'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
