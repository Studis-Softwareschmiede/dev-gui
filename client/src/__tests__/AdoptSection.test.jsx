/**
 * AdoptSection.test.jsx — Komponenten-Test für den "Adopt"-Weg
 * (neues-projekt-auswahl-dialog, S-301).
 *
 * Covers (neues-projekt-auswahl-dialog): AC4, AC5, AC6, AC7, AC8
 *   AC4 — URL-Eingabefeld mit Validierung: gültige GitHub-Repo-URLs (mit/ohne
 *         www./.git/abschließendem Slash, http/https) werden akzeptiert; ungültige
 *         Eingaben (kein GitHub-Host, fehlendes owner/repo, Leerstring, SSH-Form,
 *         überzählige Pfadsegmente) → Validierungsmeldung, "Weiter" disabled.
 *   AC5 — Nach "Weiter" zeigt eine Bestätigungs-Zusammenfassung <owner>/<repo> +
 *         "wird geforkt: ja/nein" (case-insensitiver Org-Vergleich); kein Auto-Start.
 *   AC6 — "Übernehmen" POSTet GENAU EINMAL { command: '/agent-flow:adopt <owner/repo>' }
 *         an POST /api/command.
 *   AC7 — Busy (GET /api/session state:"busy") → "Übernehmen" disabled + Lock-Hinweis;
 *         Kill-Knopf aktiv während des Laufs (POST /api/command/cancel); 202 → inline
 *         Lauf-Status; 409 → "Ein Job läuft bereits"; 400/500/Netzwerkfehler →
 *         Fehleranzeige mit Reset, kein Crash; Doppelklick → kein zweiter POST.
 *   AC8 — Nutzt ausschließlich POST /api/command, POST /api/command/cancel,
 *         GET /api/session, GET /api/github/repos (Eigene-Org-Ableitung); kein
 *         Backend-Test hier (reiner Frontend-Change).
 *
 * Covers (per-app-gpg-passphrase-provisioning, F-073/S-343): AC12, AC14
 *   AC12 — "Adopt anlegen" (headless, PRIMÄR) POSTet GENAU EINMAL
 *          { ownerRepo: '<owner>/<repo>' } an POST /api/adopt/start (NICHT
 *          /api/command); 202 → Hintergrund-Hinweis; 403/409/400/500/Netzwerk-
 *          fehler → sichtbare Fehlermeldung, kein Crash.
 *   AC14 — der bestehende PTY-Fallback-Button ("Übernehmen", identischer
 *          Endpunkt POST /api/command, identisches Guard-/Kill-Verhalten)
 *          bleibt unverändert erreichbar — s. bestehende AC6/AC7-Tests oben.
 *
 * NFR A11y:
 *   - Buttons/Feld: Touch-Target ≥ 44 px (minHeight), disabled-Attribut + Text-Label.
 *   - Validierungs-/Status-/Fehlermeldungen: role=alert bzw. role=status, aria-live.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { AdoptSection, parseGithubRepoUrl } = await import('../AdoptSection.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWN_ORG_REPOS = {
  repos: [
    { name: 'dev-gui', fullName: 'Studis-Softwareschmiede/dev-gui', visibility: 'private', openIssues: 0, lastCi: 'passing', htmlUrl: 'https://github.com/Studis-Softwareschmiede/dev-gui' },
  ],
};

const SESSION_READY = { state: 'ready' };
const SESSION_BUSY = { state: 'busy' };

const ADOPT_ACCEPTED = { commandId: 'cmd-1', status: 'accepted' };

// ── Helper: routed fetchFn ───────────────────────────────────────────────────

/**
 * Erstellt einen fetchFn, der alle von AdoptSection benötigten Endpunkte bedient.
 *
 * @param {{
 *   repos?: { status: number, data: object } | 'reject',
 *   session?: object,
 *   command?: { status: number, data: object } | 'reject' | 'pending',
 *   cancel?: { status: number } | 'reject',
 * }} opts
 * @returns {{ fetchFn: jest.Mock, calls: Array<{url:string, method:string, body:*}> }}
 */
function makeFetchFn({
  repos = { status: 200, data: OWN_ORG_REPOS },
  session = SESSION_READY,
  command = { status: 202, data: ADOPT_ACCEPTED },
  cancel = { status: 200 },
} = {}) {
  const calls = [];

  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/github/repos') {
      if (repos === 'reject') throw new Error('network error');
      return {
        ok: repos.status < 400,
        status: repos.status,
        json: async () => repos.data,
      };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => session };
    }
    if (url === '/api/command' && method === 'POST') {
      if (command === 'reject') throw new Error('network error');
      if (command === 'pending') {
        return new Promise(() => {});
      }
      return {
        ok: command.status >= 200 && command.status < 300,
        status: command.status,
        json: async () => command.data,
      };
    }
    if (url === '/api/command/cancel' && method === 'POST') {
      if (cancel === 'reject') throw new Error('network error');
      return { ok: cancel.status >= 200 && cancel.status < 300, status: cancel.status };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });

  return { fetchFn, calls };
}

/** Rendert AdoptSection mit injizierbarem fetchFn. */
function renderSection(fetchFn) {
  return render(React.createElement(AdoptSection, { fetchFn }));
}

/** Trägt eine URL ein und klickt "Weiter" (AC4 → AC5 Übergang). */
async function enterUrlAndProceed(container, url) {
  const input = container.getByLabelText(/github-repo-url/i);
  fireEvent.change(input, { target: { value: url } });
  const proceedBtn = await waitFor(() => container.getByRole('button', { name: /^weiter/i }));
  await waitFor(() => expect(proceedBtn.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(proceedBtn);
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

// ── parseGithubRepoUrl (AC4 — reine Parsing-Logik) ───────────────────────────

describe('neues-projekt-auswahl-dialog AC4 — parseGithubRepoUrl', () => {
  it('akzeptiert https://github.com/<owner>/<repo>', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('akzeptiert http (ohne s)', () => {
    expect(parseGithubRepoUrl('http://github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('akzeptiert www.-Präfix', () => {
    expect(parseGithubRepoUrl('https://www.github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('akzeptiert .git-Suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat/Hello-World.git')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('akzeptiert abschließenden Slash', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat/Hello-World/')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('lehnt Leerstring ab', () => {
    expect(parseGithubRepoUrl('')).toBeNull();
    expect(parseGithubRepoUrl('   ')).toBeNull();
  });

  it('lehnt Nicht-GitHub-Host ab', () => {
    expect(parseGithubRepoUrl('https://gitlab.com/octocat/Hello-World')).toBeNull();
  });

  it('lehnt fehlendes repo-Segment ab', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat')).toBeNull();
  });

  it('lehnt SSH-Form ab (git@github.com:owner/repo.git)', () => {
    expect(parseGithubRepoUrl('git@github.com:octocat/Hello-World.git')).toBeNull();
  });

  it('lehnt überzählige Pfadsegmente ab (/tree/main)', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat/Hello-World/tree/main')).toBeNull();
  });

  it('lehnt überzählige Pfadsegmente ab (/pull/1)', () => {
    expect(parseGithubRepoUrl('https://github.com/octocat/Hello-World/pull/1')).toBeNull();
  });
});

// ── AC4: URL-Feld im Rendering ────────────────────────────────────────────────

describe('neues-projekt-auswahl-dialog AC4 — URL-Eingabefeld + Validierung', () => {
  it('leeres Feld → "Weiter" disabled, keine Validierungsmeldung', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, queryByRole } = renderSection(fetchFn);
    await waitFor(() => {
      const btn = getByRole('button', { name: /^weiter/i });
      expect(btn.disabled).toBe(true);
    });
    expect(queryByRole('alert')).toBeNull();
  });

  it('ungültige URL → sichtbare Validierungsmeldung (role=alert), "Weiter" disabled', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByLabelText, getByRole } = renderSection(fetchFn);
    const input = getByLabelText(/github-repo-url/i);
    fireEvent.change(input, { target: { value: 'not-a-url' } });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/ungültige github-repo-url/i);
    });
    expect(getByRole('button', { name: /^weiter/i }).disabled).toBe(true);
  });

  it('gültige URL → "Weiter" wird aktiviert, keine Validierungsmeldung', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByLabelText, getByRole, queryByRole } = renderSection(fetchFn);
    const input = getByLabelText(/github-repo-url/i);
    fireEvent.change(input, { target: { value: 'https://github.com/octocat/Hello-World' } });

    await waitFor(() => {
      expect(getByRole('button', { name: /^weiter/i }).disabled).toBe(false);
    });
    expect(queryByRole('alert')).toBeNull();
  });
});

// ── AC5: Bestätigungs-Zusammenfassung + Fork-Einschätzung ────────────────────

describe('neues-projekt-auswahl-dialog AC5 — Bestätigungs-Zusammenfassung', () => {
  it('fremdes Repo (owner ≠ eigene Org) → "wird geforkt: ja"', async () => {
    const { fetchFn } = makeFetchFn({ repos: { status: 200, data: OWN_ORG_REPOS } });
    const container = renderSection(fetchFn);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/github/repos'));

    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const summary = container.getByTestId('adopt-confirm-summary');
    expect(summary.textContent).toMatch(/octocat\/Hello-World/);
    expect(summary.textContent).toMatch(/wird geforkt:\s*ja/i);
  });

  it('eigenes Repo (owner === eigene Org, case-insensitiv) → "wird geforkt: nein"', async () => {
    const { fetchFn } = makeFetchFn({ repos: { status: 200, data: OWN_ORG_REPOS } });
    const container = renderSection(fetchFn);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/github/repos'));

    await enterUrlAndProceed(container, 'https://github.com/studis-softwareschmiede/dev-gui');

    const summary = container.getByTestId('adopt-confirm-summary');
    expect(summary.textContent).toMatch(/wird geforkt:\s*nein/i);
  });

  it('Org-Ableitung nicht erreichbar (Netzwerkfehler) → konservativer Fallback, kein Blockieren', async () => {
    const { fetchFn } = makeFetchFn({ repos: 'reject' });
    const container = renderSection(fetchFn);

    await enterUrlAndProceed(container, 'https://github.com/anyorg/anyrepo');

    // Auslösung bleibt möglich (nicht blockiert) — Zusammenfassung wird trotzdem gezeigt.
    const summary = container.getByTestId('adopt-confirm-summary');
    expect(summary.textContent).toMatch(/anyorg\/anyrepo/);
  });

  it('kein Auto-Start: "Weiter" allein triggert KEINEN POST /api/command', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const commandCalls = calls.filter((c) => c.url === '/api/command');
    expect(commandCalls.length).toBe(0);
  });
});

// ── AC6: Auslösung — genau ein POST ──────────────────────────────────────────

describe('neues-projekt-auswahl-dialog AC6 — "Übernehmen" POSTet genau einmal', () => {
  it('POSTet { command: "/agent-flow:adopt <owner>/<repo>" } an POST /api/command', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await waitFor(() => expect(confirmBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:adopt octocat/Hello-World');
  });

  it('kollabiert das Argument zu einer Zeile ohne Steuerzeichen (defense in depth)', async () => {
    // URL selbst ist bereits validiert/eng gefasst (Regex), aber der Test
    // dokumentiert, dass owner/repo niemals roh mit Whitespace gesendet wird.
    const { fetchFn, calls } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World.git');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:adopt octocat/Hello-World');
    expect(body.command).not.toMatch(/[\r\n\t]/);
  });

  it('Doppelklick auf "Übernehmen" während "starting" → kein zweiter POST', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: 'pending' });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    // Button muss nach dem ersten Klick disabled sein (Race-Schutz).
    await waitFor(() => expect(confirmBtn.disabled).toBe(true));
    fireEvent.click(confirmBtn);

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
  });
});

// ── AC7: Busy-Sperre + Kill + Rückmeldung ─────────────────────────────────────

describe('neues-projekt-auswahl-dialog AC7 — Busy-Sperre + Kill + Rückmeldung', () => {
  it('GET /api/session state:"busy" → "Übernehmen" disabled + Text-/Lock-Hinweis', async () => {
    const { fetchFn } = makeFetchFn({ session: SESSION_BUSY });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    await waitFor(() => {
      const btn = container.getByTestId('adopt-confirm-btn');
      expect(btn.disabled).toBe(true);
    });
    expect(container.getByText(/ein job läuft bereits — übernehmen gesperrt/i)).toBeTruthy();
  });

  it('202 → inline Lauf-Status "läuft", Kill-Button wird aktiv', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(container.getByText(/adopt-lauf läuft/i)).toBeTruthy();
    });
    const killBtn = container.getByRole('button', { name: /laufenden adopt-job abbrechen/i });
    expect(killBtn.disabled).toBe(false);
  });

  it('Kill POSTet /api/command/cancel und setzt zurück auf Eingabe', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => expect(container.getByText(/adopt-lauf läuft/i)).toBeTruthy());

    const killBtn = container.getByRole('button', { name: /laufenden adopt-job abbrechen/i });
    await act(async () => {
      fireEvent.click(killBtn);
    });

    const cancelCalls = calls.filter((c) => c.url === '/api/command/cancel' && c.method === 'POST');
    expect(cancelCalls.length).toBe(1);
    await waitFor(() => {
      expect(container.getByLabelText(/github-repo-url/i).value).toBe('');
    });
  });

  it('409 → "Ein Job läuft bereits", kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 409, data: {} } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(container.getByRole('alert').textContent).toMatch(/ein job läuft bereits/i);
    });
  });

  it('400 → sichtbare Fehlermeldung mit Reset, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 400, data: { reason: 'ungültige Allowlist' } } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(container.getByRole('alert').textContent).toMatch(/ungültiger befehl/i);
    });
    const resetBtn = container.getByRole('button', { name: /fehler zurücksetzen/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(container.queryByRole('alert')).toBeNull();
  });

  it('500 → sichtbare Fehlermeldung mit Reset, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: { status: 500, data: {} } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(container.getByRole('alert').textContent).toMatch(/serverfehler/i);
    });
  });

  it('Netzwerkfehler → sichtbare Fehlermeldung mit Reset, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({ command: 'reject' });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(container.getByRole('alert').textContent).toMatch(/netzwerkfehler/i);
    });
  });
});

// ── AC8: nur bestehende Endpunkte, kein Secret ───────────────────────────────

describe('neues-projekt-auswahl-dialog AC8 — reiner Frontend-Change', () => {
  it('nutzt ausschließlich /api/command, /api/command/cancel, /api/session, /api/github/repos', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => expect(container.getByText(/adopt-lauf läuft/i)).toBeTruthy());

    const killBtn = container.getByRole('button', { name: /laufenden adopt-job abbrechen/i });
    await act(async () => {
      fireEvent.click(killBtn);
    });

    const allowedUrls = new Set(['/api/github/repos', '/api/session', '/api/command', '/api/command/cancel']);
    for (const call of calls) {
      expect(allowedUrls.has(call.url)).toBe(true);
    }
  });
});

// ── per-app-gpg-passphrase-provisioning AC12/AC14 (F-073/S-343) ─────────────

/**
 * Fetch-Helfer für den headless "Adopt anlegen"-Pfad — erweitert `makeFetchFn`
 * um `/api/adopt/start` (der PTY-`/api/command`-Pfad bleibt unverändert
 * mitbedient, da beide Buttons gleichzeitig gerendert werden — AC14).
 */
function makeHeadlessFetchFn({
  repos = { status: 200, data: OWN_ORG_REPOS },
  session = SESSION_READY,
  adoptStart = { status: 202, data: { status: 'started', jobId: 'job-1' } },
} = {}) {
  const calls = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/github/repos') {
      return { ok: repos.status < 400, status: repos.status, json: async () => repos.data };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => session };
    }
    if (url === '/api/adopt/start' && method === 'POST') {
      if (adoptStart === 'reject') throw new Error('network error');
      return {
        ok: adoptStart.status >= 200 && adoptStart.status < 300,
        status: adoptStart.status,
        json: async () => adoptStart.data,
      };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });
  return { fetchFn, calls };
}

describe('per-app-gpg-passphrase-provisioning AC12 — "Adopt anlegen" (headless, primär)', () => {
  it('202 → POSTet GENAU EINMAL { ownerRepo } an POST /api/adopt/start (nicht /api/command)', async () => {
    const { fetchFn, calls } = makeHeadlessFetchFn();
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const headlessBtn = await waitFor(() => container.getByTestId('adopt-confirm-headless-btn'));
    await act(async () => {
      fireEvent.click(headlessBtn);
    });

    await waitFor(() => expect(container.getByTestId('adopt-headless-started')).toBeTruthy());

    const adoptCalls = calls.filter((c) => c.url === '/api/adopt/start');
    expect(adoptCalls).toHaveLength(1);
    expect(JSON.parse(adoptCalls[0].body)).toEqual({ ownerRepo: 'octocat/Hello-World' });

    const commandCalls = calls.filter((c) => c.url === '/api/command');
    expect(commandCalls).toHaveLength(0);
  });

  it('Doppelklick während "starting" → kein zweiter POST', async () => {
    // Der Adopt-start-Aufruf hängt für immer — wir prüfen nur, dass ein zweiter
    // Klick währenddessen keinen zweiten POST auslöst (Race-Guard).
    const calls = [];
    const hangingFetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body });
      if (url === '/api/github/repos') return { ok: true, status: 200, json: async () => OWN_ORG_REPOS };
      if (url === '/api/session') return { ok: true, status: 200, json: async () => SESSION_READY };
      if (url === '/api/adopt/start') return new Promise(() => {});
      throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
    });
    const container = renderSection(hangingFetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const headlessBtn = await waitFor(() => container.getByTestId('adopt-confirm-headless-btn'));
    await act(async () => {
      fireEvent.click(headlessBtn);
    });
    // Button muss nach dem ersten Klick disabled sein (Race-Schutz), BEVOR der
    // zweite Klick erfolgt (Muster: bestehender "Übernehmen"-Doppelklick-Test).
    await waitFor(() => expect(headlessBtn.disabled).toBe(true));
    fireEvent.click(headlessBtn);

    const adoptCalls = calls.filter((c) => c.url === '/api/adopt/start');
    expect(adoptCalls).toHaveLength(1);
  });

  it('409 (Lauf läuft bereits) → sichtbare Fehlermeldung', async () => {
    const { fetchFn } = makeHeadlessFetchFn({ adoptStart: { status: 409, data: { error: 'locked' } } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const headlessBtn = await waitFor(() => container.getByTestId('adopt-confirm-headless-btn'));
    await act(async () => {
      fireEvent.click(headlessBtn);
    });

    await waitFor(() => {
      expect(container.getByTestId('adopt-headless-error').textContent).toMatch(/läuft bereits/i);
    });
  });

  it('403 (keine Berechtigung) → sichtbare Fehlermeldung', async () => {
    const { fetchFn } = makeHeadlessFetchFn({ adoptStart: { status: 403, data: { error: 'nope' } } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const headlessBtn = await waitFor(() => container.getByTestId('adopt-confirm-headless-btn'));
    await act(async () => {
      fireEvent.click(headlessBtn);
    });

    await waitFor(() => {
      expect(container.getByTestId('adopt-headless-error').textContent).toMatch(/keine berechtigung/i);
    });
  });

  it('Netzwerkfehler → sichtbare Fehlermeldung, kein Crash', async () => {
    const { fetchFn } = makeHeadlessFetchFn({ adoptStart: 'reject' });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const headlessBtn = await waitFor(() => container.getByTestId('adopt-confirm-headless-btn'));
    await act(async () => {
      fireEvent.click(headlessBtn);
    });

    await waitFor(() => {
      expect(container.getByTestId('adopt-headless-error').textContent).toMatch(/netzwerkfehler/i);
    });
  });
});

describe('per-app-gpg-passphrase-provisioning AC14 — PTY-Fallback bleibt unverändert erreichbar', () => {
  it('"Übernehmen"-Fallback-Button ist weiterhin vorhanden und POSTet unverändert an /api/command', async () => {
    const { fetchFn, calls } = makeFetchFn({ command: { status: 202, data: ADOPT_ACCEPTED } });
    const container = renderSection(fetchFn);
    await enterUrlAndProceed(container, 'https://github.com/octocat/Hello-World');

    const confirmBtn = await waitFor(() => container.getByTestId('adopt-confirm-btn'));
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command');
    expect(commandCalls).toHaveLength(1);
    expect(JSON.parse(commandCalls[0].body).command).toBe('/agent-flow:adopt octocat/Hello-World');
  });
});
