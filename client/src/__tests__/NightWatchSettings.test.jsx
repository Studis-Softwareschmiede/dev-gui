/**
 * NightWatchSettings.test.jsx — Unit-Tests für den Nachtwächter-Settings-Abschnitt.
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC17 — Rendert alle Felder (enabled, window.start/end/timezone, intervalMinutes,
 *          maxParallel, staleInProgressHours, escalationAttempts, projects) aus
 *          GET /api/settings/ticker; PUT /api/settings/ticker wird mit den geänderten
 *          Werten aufgerufen (Speichern-Button); 400-Antwort ({field,message}) wird
 *          feldzugeordnet angezeigt (role=alert); Ladefehler zeigt role=alert statt
 *          Absturz; "Auswahl"-Modus rendert Checkboxen aus GET /api/workspace/repos
 *          (best-effort — Fehler dort blockiert das Speichern im "all"-Modus nicht).
 *
 * Covers (retro-auto-trigger):
 *   AC3 —  Schalter „Danach automatisch Retro durchführen" liest GET /api/settings/retro-auto
 *          (Initialzustand), schreibt bei Änderung sofort PUT /api/settings/retro-auto
 *          (unabhängig vom Ticker-Speichern-Knopf); Status textlich (An/Aus); Fehler beim
 *          Schreiben rollt den Schalter zurück + role=alert; der Ticker-`enabled`-Schalter
 *          bleibt unverändert. Cooldown-Bypass-Hilfetext ist im Quelltext dokumentiert
 *          (aria-describedby) — visuell/Text-Assert unten.
 *
 * Covers (night-budget-guard, S-272):
 *   AC2 —  Felder „Nacht-Budget (Tokens)" (`nightBudgetTokens`) und „Budget-Schwelle (%)"
 *          (`budgetThresholdPercent`) rendern die aus GET /api/settings/ticker geladenen
 *          Werte (inkl. Default 0/85); Speichern-Klick sendet beide Felder im PUT-Body;
 *          Client-Vorabprüfung (negativ / außerhalb 1–100 / nicht-ganzzahlig) verhindert
 *          den PUT und zeigt eine feldzugeordnete Fehleranzeige (role=alert,
 *          aria-describedby/aria-invalid, Muster wie window.start/end); eine 400-Antwort
 *          vom Backend ({field:'nightBudgetTokens'|'budgetThresholdPercent', message})
 *          wird über dasselbe feldzugeordnete Fehler-Muster anzeigt.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { NightWatchSettings } = await import('../NightWatchSettings.jsx');

const DEFAULT_SETTINGS = {
  enabled: false,
  window: { start: '23:00', end: '07:00', timezone: 'Europe/Zurich' },
  intervalMinutes: 15,
  maxParallel: 3,
  staleInProgressHours: 4,
  escalationAttempts: 3,
  projects: 'all',
  nightBudgetTokens: 0,
  budgetThresholdPercent: 85,
};

/**
 * URL-routender Fetch-Mock.
 *
 * @param {{ getResponse?, putResponse?, workspaceRepos?, getFails?: boolean }} opts
 */
function makeFetch({
  getResponse = DEFAULT_SETTINGS,
  putResponse = null, // null = Erfolg (Echo der PUT-Body gemergt mit Defaults); 'invalid-window-start' = 400
  workspaceRepos = { repos: [{ name: 'dev-gui' }, { name: 'agent-flow' }] },
  getFails = false,
  retroAuto = { enabled: false }, // Initialzustand des Auto-Retro-Schalters (retro-auto-trigger AC3)
  retroAutoPutFails = false, // simuliert Persistenz-Fehler beim PUT /api/settings/retro-auto
} = {}) {
  return jest.fn(async (url, opts) => {
    const method = opts?.method ?? 'GET';

    if (url === '/api/settings/ticker' && method === 'GET') {
      if (getFails) return { ok: false, status: 500, json: async () => ({ error: 'Fehler' }) };
      return { ok: true, status: 200, json: async () => getResponse };
    }

    if (url === '/api/settings/ticker' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (putResponse === 'invalid-window-start') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ field: 'window.start', message: 'window.start muss im 24h-Format "HH:MM" sein.' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ...DEFAULT_SETTINGS, ...body }) };
    }

    if (url === '/api/settings/retro-auto' && method === 'GET') {
      return { ok: true, status: 200, json: async () => retroAuto };
    }

    if (url === '/api/settings/retro-auto' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (retroAutoPutFails) {
        return { ok: false, status: 500, json: async () => ({ error: 'kaputt' }) };
      }
      return { ok: true, status: 200, json: async () => ({ enabled: body.enabled }) };
    }

    if (url === '/api/workspace/repos' && method === 'GET') {
      return { ok: true, status: 200, json: async () => workspaceRepos };
    }

    return { ok: false, status: 404, json: async () => ({ error: 'unbekannt' }) };
  });
}

function renderComp(fetchFn) {
  return render(React.createElement(NightWatchSettings, { fetchFn: fetchFn ?? makeFetch() }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NightWatchSettings — AC17: Felder aus GET /api/settings/ticker', () => {
  it('rendert enabled-Select mit geladenem Wert (Deaktiviert)', async () => {
    const { getByLabelText } = renderComp();
    await waitFor(() => {
      expect(getByLabelText(/nachtwächter:/i).value).toBe('false');
    });
  });

  it('rendert window.start/end/timezone mit geladenen Werten', async () => {
    const fetchFn = makeFetch({
      getResponse: { ...DEFAULT_SETTINGS, window: { start: '22:00', end: '06:30', timezone: 'Europe/Berlin' } },
    });
    const { getByLabelText } = renderComp(fetchFn);
    await waitFor(() => {
      expect(getByLabelText(/fenster-start/i).value).toBe('22:00');
      expect(getByLabelText(/fenster-ende/i).value).toBe('06:30');
      expect(getByLabelText(/zeitzone/i).value).toBe('Europe/Berlin');
    });
  });

  it('rendert intervalMinutes/maxParallel/staleInProgressHours/escalationAttempts', async () => {
    const fetchFn = makeFetch({
      getResponse: {
        ...DEFAULT_SETTINGS,
        intervalMinutes: 30,
        maxParallel: 2,
        staleInProgressHours: 6,
        escalationAttempts: 5,
      },
    });
    const { getByLabelText } = renderComp(fetchFn);
    await waitFor(() => {
      expect(String(getByLabelText(/polling-intervall/i).value)).toBe('30');
      expect(getByLabelText(/max\. parallele projekte/i).value).toBe('2');
      expect(String(getByLabelText(/verwaist ab/i).value)).toBe('6');
      expect(String(getByLabelText(/eskalation nach/i).value)).toBe('5');
    });
  });

  it('night-budget-guard AC2: rendert nightBudgetTokens/budgetThresholdPercent (Default 0/85)', async () => {
    const { getByLabelText } = renderComp();
    await waitFor(() => {
      expect(String(getByLabelText(/nacht-budget \(tokens\)/i).value)).toBe('0');
      expect(String(getByLabelText(/budget-schwelle/i).value)).toBe('85');
    });
  });

  it('night-budget-guard AC2: rendert geladene nightBudgetTokens/budgetThresholdPercent-Werte', async () => {
    const fetchFn = makeFetch({
      getResponse: { ...DEFAULT_SETTINGS, nightBudgetTokens: 500000, budgetThresholdPercent: 70 },
    });
    const { getByLabelText } = renderComp(fetchFn);
    await waitFor(() => {
      expect(String(getByLabelText(/nacht-budget \(tokens\)/i).value)).toBe('500000');
      expect(String(getByLabelText(/budget-schwelle/i).value)).toBe('70');
    });
  });

  it('projects="all" (Default) → Projekte-Select zeigt "Alle Projekte", keine Checkboxen', async () => {
    const { getByLabelText, queryByText } = renderComp();
    await waitFor(() => {
      expect(getByLabelText(/^projekte:/i).value).toBe('all');
    });
    expect(queryByText('dev-gui')).toBeNull();
  });

  it('projects=[array] → Auswahl-Modus mit vorbelegten Checkboxen', async () => {
    const fetchFn = makeFetch({ getResponse: { ...DEFAULT_SETTINGS, projects: ['dev-gui'] } });
    const { getByLabelText } = renderComp(fetchFn);
    await waitFor(() => {
      expect(getByLabelText(/^projekte:/i).value).toBe('selection');
    });
    await waitFor(() => {
      expect(getByLabelText('dev-gui').checked).toBe(true);
      expect(getByLabelText('agent-flow').checked).toBe(false);
    });
  });

  it('Ladefehler → role=alert statt Absturz', async () => {
    const fetchFn = makeFetch({ getFails: true });
    const { getByRole } = renderComp(fetchFn);
    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/nicht geladen werden/i);
    });
  });
});

describe('NightWatchSettings — AC17: PUT mit geänderten Werten', () => {
  it('Speichern-Button ruft PUT mit geänderten Werten auf', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/nachtwächter:/i).value).toBe('false'));

    fireEvent.change(getByLabelText(/nachtwächter:/i), { target: { value: 'true' } });
    fireEvent.change(getByLabelText(/fenster-start/i), { target: { value: '22:30' } });
    fireEvent.change(getByLabelText(/max\. parallele projekte/i), { target: { value: '2' } });

    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.enabled).toBe(true);
      expect(body.window.start).toBe('22:30');
      expect(body.maxParallel).toBe(2);
    });

    await waitFor(() => {
      expect(getByRole('status').textContent).toMatch(/gespeichert/i);
    });
  });

  it('night-budget-guard AC2: Speichern-Button sendet geänderte nightBudgetTokens/budgetThresholdPercent im PUT-Body', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(String(getByLabelText(/nacht-budget \(tokens\)/i).value)).toBe('0'));

    fireEvent.change(getByLabelText(/nacht-budget \(tokens\)/i), { target: { value: '250000' } });
    fireEvent.change(getByLabelText(/budget-schwelle/i), { target: { value: '90' } });

    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.nightBudgetTokens).toBe(250000);
      expect(body.budgetThresholdPercent).toBe(90);
    });
  });

  it('night-budget-guard AC2: Client-Vorabprüfung — negatives nightBudgetTokens verhindert PUT + zeigt feldzugeordneten Fehler', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(String(getByLabelText(/nacht-budget \(tokens\)/i).value)).toBe('0'));
    fireEvent.change(getByLabelText(/nacht-budget \(tokens\)/i), { target: { value: '-1' } });
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/nightBudgetTokens/);
    });
    expect(getByLabelText(/nacht-budget \(tokens\)/i).getAttribute('aria-invalid')).toBe('true');
    const putCalls = fetchFn.mock.calls.filter(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('night-budget-guard AC2: Client-Vorabprüfung — budgetThresholdPercent außerhalb 1–100 verhindert PUT + zeigt feldzugeordneten Fehler', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(String(getByLabelText(/budget-schwelle/i).value)).toBe('85'));
    fireEvent.change(getByLabelText(/budget-schwelle/i), { target: { value: '101' } });
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/budgetThresholdPercent/);
    });
    const putCalls = fetchFn.mock.calls.filter(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('night-budget-guard AC2: 400-Antwort ({field:"budgetThresholdPercent"}) → feldzugeordnete Fehleranzeige (role=alert)', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/ticker' && method === 'GET') {
        return { ok: true, status: 200, json: async () => DEFAULT_SETTINGS };
      }
      if (url === '/api/settings/ticker' && method === 'PUT') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ field: 'budgetThresholdPercent', message: 'budgetThresholdPercent muss eine ganze Zahl zwischen 1 und 100 sein.' }),
        };
      }
      if (url === '/api/settings/retro-auto' && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ enabled: false }) };
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => ({ repos: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(String(getByLabelText(/budget-schwelle/i).value)).toBe('85'));
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/budgetThresholdPercent/);
    });
  });

  it('projectsMode="selection" + Checkbox-Auswahl → PUT sendet projects als Array', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/^projekte:/i).value).toBe('all'));
    fireEvent.change(getByLabelText(/^projekte:/i), { target: { value: 'selection' } });

    await waitFor(() => expect(getByLabelText('dev-gui')).toBeTruthy());
    fireEvent.click(getByLabelText('dev-gui'));

    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.projects).toEqual(['dev-gui']);
    });
  });

  it('400-Antwort ({field,message}) → feldzugeordnete Fehleranzeige (role=alert)', async () => {
    const fetchFn = makeFetch({ putResponse: 'invalid-window-start' });
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/fenster-start/i).value).toBe('23:00'));
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/window\.start/);
      expect(alert.textContent).toMatch(/24h-Format/);
    });
  });

  it('Client-Vorabprüfung: ungültiges window.start (kein PUT-Request) → feldzugeordnete Fehleranzeige', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/fenster-start/i).value).toBe('23:00'));
    fireEvent.change(getByLabelText(/fenster-start/i), { target: { value: 'not-a-time' } });
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/window\.start/);
    });
    const putCalls = fetchFn.mock.calls.filter(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('GET /api/workspace/repos schlägt fehl → Auswahl-Modus bleibt nutzbar (graceful degradation), Speichern im all-Modus unbeeinträchtigt', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/ticker' && method === 'GET') {
        return { ok: true, status: 200, json: async () => DEFAULT_SETTINGS };
      }
      if (url === '/api/settings/ticker' && method === 'PUT') {
        const body = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ...DEFAULT_SETTINGS, ...body }) };
      }
      if (url === '/api/workspace/repos') {
        return { ok: false, status: 500, json: async () => ({ error: 'kaputt' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/nachtwächter:/i).value).toBe('false'));
    fireEvent.click(getByRole('button', { name: /einstellungen speichern/i }));

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
    });
  });

  it('GET /api/workspace/repos wirft (Netzwerkfehler, kein !res.ok) → kein Crash, kein ungefangener Rejection (Regression)', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/ticker' && method === 'GET') {
        return { ok: true, status: 200, json: async () => DEFAULT_SETTINGS };
      }
      if (url === '/api/workspace/repos') {
        throw new Error('Netzwerkfehler');
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByLabelText } = renderComp(fetchFn);
    // Rendert weiterhin normal (kein Absturz durch die ungefangene Rejection).
    await waitFor(() => expect(getByLabelText(/nachtwächter:/i).value).toBe('false'));
  });
});

describe('NightWatchSettings — retro-auto-trigger AC3: Auto-Retro-Schalter', () => {
  it('liest GET /api/settings/retro-auto und zeigt den Initialzustand (An) im Schalter', async () => {
    const fetchFn = makeFetch({ retroAuto: { enabled: true } });
    const { getByLabelText } = renderComp(fetchFn);
    await waitFor(() => {
      expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('true');
    });
    const getCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/retro-auto' && (opts?.method ?? 'GET') === 'GET');
    expect(getCall).toBeDefined();
  });

  it('Default (enabled:false) → Schalter steht auf "Aus", Status-Text zeigt "Aus"', async () => {
    const { getByLabelText, getByText } = renderComp();
    await waitFor(() => {
      expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('false');
    });
    expect(getByText('Aus', { selector: 'span' })).toBeTruthy();
  });

  it('Umschalten auf "An" schreibt sofort PUT /api/settings/retro-auto {enabled:true}', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText, getByText } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('false'));
    fireEvent.change(getByLabelText(/automatisch retro durchführen/i), { target: { value: 'true' } });

    await waitFor(() => {
      const putCall = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/retro-auto' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall[1].body)).toEqual({ enabled: true });
    });
    // Schalter bleibt auf dem persistierten Wert (An) + Erfolgs-Status erscheint.
    await waitFor(() => {
      expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('true');
      expect(getByText(/auto-retro-einstellung gespeichert/i)).toBeTruthy();
    });
  });

  it('PUT ohne Ticker-Speichern-Knopf: Schalter-Änderung löst KEINEN PUT /api/settings/ticker aus', async () => {
    const fetchFn = makeFetch();
    const { getByLabelText } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('false'));
    fireEvent.change(getByLabelText(/automatisch retro durchführen/i), { target: { value: 'true' } });

    await waitFor(() => {
      const retroPut = fetchFn.mock.calls.find(([url, opts]) => url === '/api/settings/retro-auto' && opts?.method === 'PUT');
      expect(retroPut).toBeDefined();
    });
    const tickerPut = fetchFn.mock.calls.filter(([url, opts]) => url === '/api/settings/ticker' && opts?.method === 'PUT');
    expect(tickerPut.length).toBe(0);
  });

  it('PUT-Fehler → Schalter rollt auf vorherigen Wert zurück + role=alert', async () => {
    const fetchFn = makeFetch({ retroAuto: { enabled: false }, retroAutoPutFails: true });
    const { getByLabelText, getByRole } = renderComp(fetchFn);

    await waitFor(() => expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('false'));
    fireEvent.change(getByLabelText(/automatisch retro durchführen/i), { target: { value: 'true' } });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/auto-retro/i);
    });
    // Revert: Schalter steht wieder auf dem persistierten Vorwert.
    expect(getByLabelText(/automatisch retro durchführen/i).value).toBe('false');
  });

  it('Hilfetext erklärt den Cooldown-Bypass (aria-describedby verknüpft)', async () => {
    const { getByLabelText, getByText } = renderComp();
    await waitFor(() => expect(getByLabelText(/automatisch retro durchführen/i)).toBeTruthy());
    const help = getByText(/wochen-cooldown wird dabei umgangen/i);
    expect(help).toBeTruthy();
    expect(getByLabelText(/automatisch retro durchführen/i).getAttribute('aria-describedby')).toBe(help.id);
  });

  it('GET /api/settings/retro-auto schlägt fehl → Nachtwächter-Sektion bleibt nutzbar (graceful), role=alert für Auto-Retro', async () => {
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/ticker' && method === 'GET') {
        return { ok: true, status: 200, json: async () => DEFAULT_SETTINGS };
      }
      if (url === '/api/settings/retro-auto') {
        return { ok: false, status: 500, json: async () => ({ error: 'kaputt' }) };
      }
      if (url === '/api/workspace/repos') {
        return { ok: true, status: 200, json: async () => ({ repos: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { getByLabelText, getByRole } = renderComp(fetchFn);
    // Nachtwächter-Felder rendern trotz Auto-Retro-Ladefehler.
    await waitFor(() => expect(getByLabelText(/nachtwächter:/i).value).toBe('false'));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/auto-retro/i));
  });

  it('bestehender Nachtwächter-enabled-Schalter bleibt unverändert (Regression)', async () => {
    const { getByLabelText } = renderComp();
    await waitFor(() => expect(getByLabelText(/nachtwächter:/i).value).toBe('false'));
    // Der Auto-Retro-Schalter ist ein SEPARATES Control (eigenes Label).
    expect(getByLabelText(/automatisch retro durchführen/i)).not.toBe(getByLabelText(/nachtwächter:/i));
  });
});
