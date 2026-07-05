/**
 * UsageOverlay.test.jsx — Owner-Ko-Design 2026-07-03/05 ("goldene Münze").
 *
 * Covers: Münz-Button öffnet Overlay (GET /api/usage), zeigt Session-/Wochen-
 * Werte, Schliessen-Kreuz + ESC schliessen (Fokus-Rückgabe).
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { UsageCoinButton } = await import('../UsageOverlay.jsx');

function makeFetch() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      estimated: true,
      generatedAt: new Date().toISOString(),
      session: { outputTokens: 12345, windowHours: 5 },
      week: { outputTokens: 987654, windowDays: 7 },
    }),
  }));
}

describe('UsageCoinButton / UsageOverlay (S-Q14)', () => {
  it('Klick auf die Münze öffnet das Overlay mit Session-/Wochen-Werten', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/12.345/)).toBeTruthy(); });
    expect(getByText(/987.654/)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledWith('/api/usage');
  });

  it('Schliessen-Kreuz schliesst das Overlay und gibt den Fokus zurück', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    const trigger = getByLabelText('Token-Nutzung anzeigen');
    fireEvent.click(trigger);
    await waitFor(() => { expect(queryByRole('dialog')).toBeTruthy(); });
    fireEvent.click(getByLabelText('Schliessen'));
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ESC schliesst das Overlay', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(queryByRole('dialog')).toBeTruthy(); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });
});
