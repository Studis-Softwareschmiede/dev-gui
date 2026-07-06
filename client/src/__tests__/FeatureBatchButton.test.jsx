/**
 * FeatureBatchButton.test.jsx — Feature-Umsetzen-Button, 3 Zustände
 * (Owner-Auftrag 2026-07-06, design.md „Feature-Umsetzen-Button").
 *
 * Covers: Zustand 1 grün/„Umsetzen"/klickbar, Zustand 2 orange/„In Progress"/
 * gesperrt, Zustand 3 rot/„Done"/gesperrt, Bestätigungsdialog vor Trigger,
 * optimistischer Zustandswechsel nach Bestätigen, POST-Fehler zeigt Meldung
 * + Zustand fällt auf autoritativen Wert zurück, aria-label je Zustand.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { FeatureBatchButton } = await import('../FeatureBatchButton.jsx');

function makeFetch(state, { postOk = true, postError = 'Fehler' } = {}) {
  return jest.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      if (postOk) return { ok: true, status: 202, json: async () => ({ state: 'running' }) };
      return { ok: false, status: 400, json: async () => ({ error: postError }) };
    }
    return { ok: true, status: 200, json: async () => ({ state }) };
  });
}

afterEach(() => { jest.useRealTimers(); });

describe('FeatureBatchButton — 3 Zustände', () => {
  it('Zustand "ready": grün, Text Umsetzen, klickbar', async () => {
    const fetchFn = makeFetch('ready');
    const { getByTestId } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'Mein Feature' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    expect(btn.textContent).toContain('Umsetzen');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toMatch(/umsetzen/);
  });

  it('Zustand "running": orange, Text In Progress, gesperrt', async () => {
    const fetchFn = makeFetch('running');
    const { getByTestId } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    await waitFor(() => expect(btn.textContent).toContain('In Progress'));
    expect(btn.disabled).toBe(true);
  });

  it('Zustand "done": rot, Text Done, gesperrt', async () => {
    const fetchFn = makeFetch('done');
    const { getByTestId } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    await waitFor(() => expect(btn.textContent).toContain('Done'));
    expect(btn.disabled).toBe(true);
  });

  it('Klick auf "Umsetzen" öffnet Bestätigungsdialog, kein sofortiger POST', async () => {
    const fetchFn = makeFetch('ready');
    const { getByTestId, getByText } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    fireEvent.click(btn);
    expect(getByText(/Startet die Batch-Verarbeitung/)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }));
  });

  it('Bestätigen löst POST aus und wechselt optimistisch auf "In Progress"', async () => {
    const fetchFn = makeFetch('ready');
    const { getByTestId, getByText } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    fireEvent.click(btn);
    fireEvent.click(getByText('Ja, starten'));
    await waitFor(() => expect(btn.textContent).toContain('In Progress'));
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/board/projects/demo/features/F-042/batch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POST-Fehler zeigt Meldung und Zustand fällt auf autoritativen Wert zurück', async () => {
    const fetchFn = makeFetch('ready', { postOk: false, postError: 'weniger als 2 Storys' });
    const { getByTestId, getByText } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    fireEvent.click(btn);
    fireEvent.click(getByText('Ja, starten'));
    await waitFor(() => expect(getByText(/weniger als 2 Storys/)).toBeTruthy());
    await waitFor(() => expect(btn.textContent).toContain('Umsetzen')); // zurück auf autoritativ 'ready'
  });

  it('Polling erkennt asynchronen Wartezustand (Exit 3) und zeigt die konkrete Server-Meldung (2026-07-06, dritte Runde)', async () => {
    jest.useFakeTimers();
    let getCount = 0;
    const fetchFn = jest.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ state: 'running' }) };
      }
      getCount += 1;
      // Erster GET (initial mount): ready. Der ERSTE Poll nach dem Start
      // (asynchron beendet, Exit 3) meldet konkret, worauf gewartet wird —
      // vorher wurde diese Information nie gelesen.
      if (getCount === 1) return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      return {
        ok: true, status: 200,
        json: async () => ({ state: 'ready', error: 'WARTET: S-901 wartet auf S-800 (To Do, gehört zu F-002)' }),
      };
    });
    const { getByTestId, getByText } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    const btn = await waitFor(() => getByTestId('feature-batch-btn-F-042'));
    fireEvent.click(btn);
    fireEvent.click(getByText('Ja, starten'));
    await waitFor(() => expect(btn.textContent).toContain('In Progress'));

    await jest.advanceTimersByTimeAsync(4000);

    await waitFor(() => expect(getByText(/S-901 wartet auf S-800/)).toBeTruthy());
    expect(btn.textContent).toContain('Umsetzen');
  });

  it('Live-Region-Wrapper trägt role=status/aria-live=polite (nicht am Button selbst)', async () => {
    const fetchFn = makeFetch('ready');
    const { container } = render(React.createElement(FeatureBatchButton, {
      feature: { id: 'F-042', title: 'X' }, projectSlug: 'demo', fetchFn,
    }));
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeTruthy());
    const wrapper = container.querySelector('[role="status"]');
    expect(wrapper.getAttribute('aria-live')).toBe('polite');
    const btn = container.querySelector('button[data-testid="feature-batch-btn-F-042"]');
    expect(btn.getAttribute('role')).not.toBe('status');
  });
});
