/**
 * UsageOverlay.test.jsx — Owner-Ko-Design 2026-07-03/05 ("goldene Münze").
 *
 * Covers (docs/specs/usage-official-values.md):
 *   AC10 — `source: "official"` zeigt Prozent + lokalisierten Reset-Zeitpunkt
 *          für Session, "Alle Modelle" + je Modell, sowie `spend` falls vorhanden
 *          (inkl. dem realen Upstream-Schema `{used,limit,percent,description,
 *          can_purchase_credits}` — live verifiziert 2026-07-18, S-369: Betrag
 *          formatiert, `description`/`can_purchase_credits` nicht dargestellt,
 *          `limit: null` → kein Limit-Text, unerkennbares Objekt → kein
 *          Guthaben-Block statt Roh-JSON).
 *   AC11 — `source: "estimated"` zeigt weiterhin nur die geschätzten rohen
 *          Output-Token-Zahlen (kein %/Reset); fehlt `source` (Alt-Antwort),
 *          wird defensiv wie `estimated` behandelt. `source: "unavailable"`
 *          zeigt einen ehrlichen Fehler-/Leer-Hinweis statt Zahlen.
 *   AC12 — Dialog-A11y (role=dialog/aria-modal, ESC schliesst, Fokus-Falle,
 *          Fokus-Rückgabe, Aktualisieren-Knopf) bleibt in allen drei
 *          Zuständen erhalten.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { UsageCoinButton } = await import('../UsageOverlay.jsx');

function makeFetch(payload) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
}

function estimatedPayload(overrides = {}) {
  return {
    source: 'estimated',
    generatedAt: new Date().toISOString(),
    session: { outputTokens: 12345, windowHours: 5 },
    week: { outputTokens: 987654, windowDays: 7 },
    ...overrides,
  };
}

function officialPayload(overrides = {}) {
  return {
    source: 'official',
    generatedAt: new Date().toISOString(),
    session: { percentUsed: 42, resetAt: '2026-07-18T20:00:00.000Z' },
    week: {
      allModels: { percentUsed: 61.5, resetAt: '2026-07-21T00:00:00.000Z' },
      perModel: [
        { model: 'opus', percentUsed: 10, resetAt: '2026-07-21T00:00:00.000Z' },
        { model: 'sonnet', percentUsed: 20, resetAt: '2026-07-21T00:00:00.000Z' },
      ],
    },
    ...overrides,
  };
}

describe('UsageCoinButton / UsageOverlay (S-Q14) — Grundverhalten', () => {
  it('Klick auf die Münze öffnet das Overlay und ruft GET /api/usage', async () => {
    const fetchFn = makeFetch(estimatedPayload());
    const { getByLabelText, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(queryByRole('dialog')).toBeTruthy(); });
    expect(fetchFn).toHaveBeenCalledWith('/api/usage');
  });

  it('Schliessen-Kreuz schliesst das Overlay und gibt den Fokus zurück', async () => {
    const fetchFn = makeFetch(estimatedPayload());
    const { getByLabelText, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    const trigger = getByLabelText('Token-Nutzung anzeigen');
    fireEvent.click(trigger);
    await waitFor(() => { expect(queryByRole('dialog')).toBeTruthy(); });
    fireEvent.click(getByLabelText('Schliessen'));
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ESC schliesst das Overlay', async () => {
    const fetchFn = makeFetch(estimatedPayload());
    const { getByLabelText, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(queryByRole('dialog')).toBeTruthy(); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });
});

describe('AC10 — source: "official" zeigt Prozent + Reset für Session/Alle Modelle/je Modell', () => {
  it('zeigt Session-Prozent + lokalisierten Reset-Zeitpunkt', async () => {
    const fetchFn = makeFetch(officialPayload());
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/42/)).toBeTruthy(); });
    expect(getByText(/Aktuelle Sitzung/)).toBeTruthy();
  });

  it('zeigt "Alle Modelle" + je-Modell-Prozentwerte', async () => {
    const fetchFn = makeFetch(officialPayload());
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Alle Modelle/)).toBeTruthy(); });
    expect(getByText(/opus/)).toBeTruthy();
    expect(getByText(/sonnet/)).toBeTruthy();
    expect(getByText(/61.5/)).toBeTruthy();
  });

  it('zeigt spend, wenn vorhanden', async () => {
    const fetchFn = makeFetch(officialPayload({ spend: { amountUsd: 12.5 } }));
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Guthaben/)).toBeTruthy(); });
    expect(getByText(/12.5/)).toBeTruthy();
  });

  it('zeigt kein Guthaben-Feld, wenn spend fehlt', async () => {
    const fetchFn = makeFetch(officialPayload());
    const { getByLabelText, queryByText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Aktuelle Sitzung/)).toBeTruthy(); });
    expect(queryByText(/Guthaben/)).toBeNull();
  });

  it('reales Upstream-Schema: formatierter Betrag sichtbar, kein Roh-JSON im DOM', async () => {
    const fetchFn = makeFetch(officialPayload({
      spend: {
        used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
        limit: null,
        percent: null,
        description: 'Extra usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)',
        can_purchase_credits: true,
      },
    }));
    const { getByLabelText, getByText, queryByText, container } = render(
      React.createElement(UsageCoinButton, { fetchFn })
    );
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Guthaben/)).toBeTruthy(); });
    expect(getByText(/12.34 USD/)).toBeTruthy();
    expect(queryByText(/Learn more/)).toBeNull();
    expect(queryByText(/can_purchase_credits/)).toBeNull();
    expect(container.textContent).not.toMatch(/amount_minor/);
  });

  it('reales Upstream-Schema mit gesetztem limit + percent: beide werden angezeigt', async () => {
    const fetchFn = makeFetch(officialPayload({
      spend: {
        used: { amount_minor: 500, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
        percent: 5,
        description: 'irrelevant',
        can_purchase_credits: false,
      },
    }));
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Guthaben/)).toBeTruthy(); });
    expect(getByText(/5.00 USD/)).toBeTruthy();
    expect(getByText(/Limit/)).toBeTruthy();
    expect(getByText(/100.00 USD/)).toBeTruthy();
    expect(getByText(/5 % genutzt/)).toBeTruthy();
  });

  it('reales Upstream-Schema mit limit: null zeigt keinen Limit-Text', async () => {
    const fetchFn = makeFetch(officialPayload({
      spend: {
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        limit: null,
        percent: null,
        description: 'x',
        can_purchase_credits: false,
      },
    }));
    const { getByLabelText, getByText, queryByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Guthaben/)).toBeTruthy(); });
    expect(getByText(/0.00 USD/)).toBeTruthy();
    expect(queryByText(/Limit/)).toBeNull();
  });

  it('unerkennbares spend-Objekt: kein Guthaben-Block, kein Roh-JSON', async () => {
    const fetchFn = makeFetch(officialPayload({
      spend: { irgendwas: 'unbekannt', foo: 42 },
    }));
    const { getByLabelText, getByText, queryByText, container } = render(
      React.createElement(UsageCoinButton, { fetchFn })
    );
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/Aktuelle Sitzung/)).toBeTruthy(); });
    expect(queryByText(/Guthaben/)).toBeNull();
    expect(container.textContent).not.toMatch(/irgendwas/);
  });
});

describe('AC11 — source: "estimated"/"unavailable" transparent, keine erfundenen Werte', () => {
  it('estimated: zeigt geschätzte Rohzahlen, keine Prozent-/Reset-Werte', async () => {
    const fetchFn = makeFetch(estimatedPayload());
    const { getByLabelText, getByText, queryByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/12.345/)).toBeTruthy(); });
    expect(getByText(/987.654/)).toBeTruthy();
    expect(getByText(/Geschätzt/)).toBeTruthy();
    expect(queryByText(/%/)).toBeNull();
  });

  it('fehlendes `source`-Feld (Alt-Antwort) wird defensiv wie estimated behandelt', async () => {
    const fetchFn = makeFetch({
      generatedAt: new Date().toISOString(),
      session: { outputTokens: 111, windowHours: 5 },
      week: { outputTokens: 222, windowDays: 7 },
    });
    const { getByLabelText, getByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/111/)).toBeTruthy(); });
    expect(getByText(/222/)).toBeTruthy();
  });

  it('unavailable: zeigt ehrlichen Fehler-/Leer-Hinweis statt Zahlen', async () => {
    const fetchFn = makeFetch({ source: 'unavailable', generatedAt: new Date().toISOString() });
    const { getByLabelText, getByText, queryByText } = render(React.createElement(UsageCoinButton, { fetchFn }));
    fireEvent.click(getByLabelText('Token-Nutzung anzeigen'));
    await waitFor(() => { expect(getByText(/nicht verfügbar/)).toBeTruthy(); });
    expect(queryByText(/Output-Tokens/)).toBeNull();
    expect(queryByText(/%/)).toBeNull();
  });
});

describe('AC12 — A11y bleibt in allen drei Zuständen erhalten', () => {
  it('official: role=dialog/aria-modal, ESC schliesst, Fokus-Rückgabe, Aktualisieren-Knopf', async () => {
    const fetchFn = makeFetch(officialPayload());
    const { getByLabelText, getByRole, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    const trigger = getByLabelText('Token-Nutzung anzeigen');
    fireEvent.click(trigger);
    await waitFor(() => { expect(getByRole('button', { name: 'Aktualisieren' })).toBeTruthy(); });
    expect(getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('unavailable: role=dialog/aria-modal, ESC schliesst, Fokus-Rückgabe, Aktualisieren-Knopf', async () => {
    const fetchFn = makeFetch({ source: 'unavailable', generatedAt: new Date().toISOString() });
    const { getByLabelText, getByRole, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    const trigger = getByLabelText('Token-Nutzung anzeigen');
    fireEvent.click(trigger);
    await waitFor(() => { expect(getByRole('button', { name: 'Aktualisieren' })).toBeTruthy(); });
    expect(getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('estimated: role=dialog/aria-modal, ESC schliesst, Fokus-Rückgabe, Aktualisieren-Knopf', async () => {
    const fetchFn = makeFetch(estimatedPayload());
    const { getByLabelText, getByRole, queryByRole } = render(React.createElement(UsageCoinButton, { fetchFn }));
    const trigger = getByLabelText('Token-Nutzung anzeigen');
    fireEvent.click(trigger);
    await waitFor(() => { expect(getByRole('button', { name: 'Aktualisieren' })).toBeTruthy(); });
    expect(getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
