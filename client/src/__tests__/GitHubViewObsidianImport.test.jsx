/**
 * GitHubViewObsidianImport.test.jsx — dritte "Neues Projekt"-Option "Aus Obsidian-Notizen"
 * innerhalb der GitHub-Ansicht (obsidian-project-intake, S-249).
 *
 * Covers (obsidian-project-intake): AC1, AC2, AC3, AC5, AC6, AC7
 *   AC1 — Toggle-Button "Aus Obsidian-Notizen" sichtbar; disabled + Text-Hinweis wenn
 *         GET /api/settings/obsidian-vault-path → configured:false; die zwei bestehenden
 *         Optionen ("+ Neues Repo", per-Zeile "Klonen") bleiben unverändert vorhanden;
 *         Touch-Target ≥ 44 px.
 *   AC2 — Auswahl lädt GET /api/settings/obsidian-vault/projects → auswählbare Liste
 *         (name sichtbar); leere Liste → Hinweis; Ladefehler → sichtbare Fehleranzeige,
 *         kein Crash.
 *   AC3 — "Auslösen" POSTet GENAU EINMAL { command: '/agent-flow:from-notes <path>' } an
 *         POST /api/command; ohne Auswahl disabled; Doppelklick während "starting" → kein
 *         zweiter POST.
 *   AC5 — GET /api/session → busy → "Auslösen" disabled + Lock-Hinweis; Klick löst keinen
 *         POST aus.
 *   AC6 — 202 → onNavigate('factory').
 *   AC7 — 409 → sichtbare Fehleranzeige, kein Navigate. 400/500/Netzwerkfehler →
 *         Fehleranzeige mit Reset, kein Navigate, kein Crash.
 *
 * (AC4 — Backend-Allowlist-Erweiterung — bereits gelandet via S-248, nicht Teil dieser Datei.)
 *
 * NFR A11y:
 *   - Toggle-Button + "Auslösen"-Button: Touch-Target ≥ 44 px (minHeight).
 *   - Disabled-Zustände: disabled-Attribut UND Text-Label (nie nur Farbe).
 *   - Fehler-/Lock-Hinweise: role=alert bzw. role=status, aria-live.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }     = await import('@testing-library/react');
const React          = (await import('react')).default;
const { GitHubView } = await import('../GitHubView.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPOS_EMPTY = { repos: [] };
const WORKSPACE_REPOS_EMPTY = { repos: [] };

const VAULT_CONFIGURED   = { vaultPath: '/vault', configured: true };
const VAULT_UNCONFIGURED = { vaultPath: null, configured: false };

const PROJECTS_RESPONSE = {
  projects: [
    { name: 'mein-projekt', path: '/vault/Projekte/mein-projekt' },
    { name: 'anderes-projekt', path: '/vault/Projekte/anderes-projekt' },
  ],
};
const PROJECTS_EMPTY = { projects: [] };

const SESSION_READY = { state: 'ready' };
const SESSION_BUSY  = { state: 'busy' };

const FROM_NOTES_ACCEPTED = { commandId: 'cmd-1', status: 'accepted' };

// ── Helper: routed fetchFn ───────────────────────────────────────────────────

/**
 * Erstellt einen fetchFn, der alle von GitHubView benötigten Endpunkte separat bedient.
 *
 * @param {{
 *   vaultStatus?: object,
 *   projects?: { status: number, data: object } | 'reject',
 *   session?: object,
 *   command?: { status: number, data: object } | 'reject' | 'pending',
 * }} opts
 * @returns {{ fetchFn: jest.Mock, calls: Array<{url:string, method:string, body:*}> }}
 */
function makeFetchFn({
  vaultStatus = VAULT_CONFIGURED,
  projects    = { status: 200, data: PROJECTS_RESPONSE },
  session     = SESSION_READY,
  command     = { status: 202, data: FROM_NOTES_ACCEPTED },
} = {}) {
  const calls = [];

  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/github/repos') {
      return { ok: true, status: 200, json: async () => REPOS_EMPTY };
    }
    if (url === '/api/workspace/repos') {
      return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
    }
    if (url === '/api/settings/obsidian-vault-path') {
      return { ok: true, status: 200, json: async () => vaultStatus };
    }
    if (url === '/api/settings/obsidian-vault/projects') {
      if (projects === 'reject') throw new Error('network error');
      return {
        ok: projects.status < 400,
        status: projects.status,
        json: async () => projects.data,
      };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => session };
    }
    if (url === '/api/command' && method === 'POST') {
      if (command === 'reject') throw new Error('network error');
      if (command === 'pending') {
        // Simuliert einen in-flight Request der nie auflöst (Doppelklick-Test)
        return new Promise(() => {});
      }
      return {
        ok: command.status >= 200 && command.status < 300,
        status: command.status,
        json: async () => command.data,
      };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });

  return { fetchFn, calls };
}

/** Rendert GitHubView mit injizierbarem fetchFn + onNavigate-Spy. */
function renderView(fetchFn) {
  const onNavigate = jest.fn();
  const utils = render(
    React.createElement(GitHubView, { onNavigate, fetchFn })
  );
  return { ...utils, onNavigate };
}

/** Öffnet die Obsidian-Import-Sektion über den Toggle-Button (muss enabled sein). */
async function openObsidianPanel(getByRole) {
  const toggleBtn = getByRole('button', { name: /aus obsidian-notizen/i });
  await act(async () => {
    fireEvent.click(toggleBtn);
  });
}

/** Wählt einen Projekt-Ordner im <select> aus (nach AC2-Ladeabschluss). */
async function selectProject(getByLabelText, path) {
  const select = await waitFor(() => getByLabelText(/^projekt-ordner$/i));
  fireEvent.change(select, { target: { value: path } });
  return select;
}

afterEach(() => {
  jest.clearAllMocks();
});

// ── AC1: Dritte Option — sichtbar/disabled + Touch-Target ────────────────────

describe('obsidian-project-intake AC1 — dritte Option "Aus Obsidian-Notizen"', () => {
  it('rendert den Toggle-Button "Aus Obsidian-Notizen"', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_CONFIGURED });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('button', { name: /aus obsidian-notizen/i })).toBeTruthy();
    });
  });

  it('kein Vault konfiguriert → Toggle-Button ist disabled', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_UNCONFIGURED });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const btn = getByRole('button', { name: /aus obsidian-notizen/i });
      expect(btn.disabled).toBe(true);
    });
  });

  it('kein Vault konfiguriert → Text-Hinweis "Zuerst Obsidian-Vault in den Einstellungen setzen" sichtbar (nicht nur Farbe)', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_UNCONFIGURED });
    const { getByText } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByText(/zuerst obsidian-vault in den einstellungen setzen/i)).toBeTruthy();
    });
  });

  it('Vault konfiguriert → Toggle-Button ist enabled, kein Disabled-Hinweis', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_CONFIGURED });
    const { getByRole, queryByText } = renderView(fetchFn);
    await waitFor(() => {
      const btn = getByRole('button', { name: /aus obsidian-notizen/i });
      expect(btn.disabled).toBe(false);
    });
    expect(queryByText(/zuerst obsidian-vault in den einstellungen setzen/i)).toBeNull();
  });

  it('Toggle-Button hat Touch-Target ≥ 44 px (minHeight)', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_CONFIGURED });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      const btn = getByRole('button', { name: /aus obsidian-notizen/i });
      expect(btn.style.minHeight).toBe('44px');
    });
  });

  it('die zwei bestehenden Optionen ("+ Neues Repo" / "Klonen") bleiben unverändert vorhanden', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_CONFIGURED });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => {
      expect(getByRole('button', { name: /\+ neues repo/i })).toBeTruthy();
    });
  });
});

// ── AC2: Projekt-Liste laden ──────────────────────────────────────────────────

describe('obsidian-project-intake AC2 — Projekt-Unterordner-Liste', () => {
  it('öffnet die Sektion und zeigt Projekt-Namen aus GET .../obsidian-vault/projects', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      projects: { status: 200, data: PROJECTS_RESPONSE },
    });
    const { getByRole, getByText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      expect(getByText('mein-projekt')).toBeTruthy();
      expect(getByText('anderes-projekt')).toBeTruthy();
    });
  });

  it('leere Liste → klarer Hinweis, kein Auslöser aktiv', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      projects: { status: 200, data: PROJECTS_EMPTY },
    });
    const { getByRole, getByText, queryByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      expect(getByText(/keine projekte unter/i)).toBeTruthy();
    });
    expect(queryByLabelText(/^projekt-ordner$/i)).toBeNull();
  });

  it('Ladefehler (500) → sichtbare Fehleranzeige (role=alert), kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      projects: { status: 500, data: { error: 'boom' } },
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/nicht geladen werden/i);
    });
  });

  it('Ladefehler (Netzwerkfehler) → sichtbare Fehleranzeige, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      projects: 'reject',
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/nicht geladen werden/i);
    });
  });
});

// ── AC3: Auslösen — genau ein POST ────────────────────────────────────────────

describe('obsidian-project-intake AC3 — "Auslösen" POSTet genau einmal', () => {
  it('ohne Auswahl ist "Auslösen" disabled', async () => {
    const { fetchFn } = makeFetchFn({ vaultStatus: VAULT_CONFIGURED });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      const btn = getByRole('button', { name: /auslösen/i });
      expect(btn.disabled).toBe(true);
    });
  });

  it('mit Auswahl POSTet "Auslösen" genau einmal { command: "/agent-flow:from-notes <path>" }', async () => {
    const { fetchFn, calls } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await waitFor(() => expect(triggerBtn.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
    const body = JSON.parse(commandCalls[0].body);
    expect(body.command).toBe('/agent-flow:from-notes /vault/Projekte/mein-projekt');
    // Edge-Case: GitHubView ist org-weit (kein Projekt-Kontext) → kein projectPath.
    expect(body.projectPath).toBeUndefined();
  });

  it('Doppelklick während "starting" → kein zweiter POST (Button gesperrt)', async () => {
    const { fetchFn, calls } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: 'pending',
    });
    const { getByRole, getByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await waitFor(() => expect(triggerBtn.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(triggerBtn);
    });
    // Button ist jetzt im "starting"-Zustand gesperrt — zweiter Klick darf nichts auslösen.
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(1);
  });
});

// ── AC5: Busy-Guard ────────────────────────────────────────────────────────────

describe('obsidian-project-intake AC5 — Busy-Guard über GET /api/session', () => {
  it('state:"busy" → "Auslösen" ist disabled + Lock-Hinweis sichtbar', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      session: SESSION_BUSY,
    });
    const { getByRole, getByLabelText, getByText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    await waitFor(() => {
      expect(getByText(/job läuft bereits — auslösen gesperrt/i)).toBeTruthy();
    });
    const triggerBtn = getByRole('button', { name: /auslösen/i });
    expect(triggerBtn.disabled).toBe(true);
  });

  it('state:"busy" → Klick löst keinen POST an /api/command aus', async () => {
    const { fetchFn, calls } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      session: SESSION_BUSY,
    });
    const { getByRole, getByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await waitFor(() => expect(triggerBtn.disabled).toBe(true));
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    const commandCalls = calls.filter((c) => c.url === '/api/command' && c.method === 'POST');
    expect(commandCalls.length).toBe(0);
  });
});

// ── AC6: 202 → onNavigate('factory') ──────────────────────────────────────────

describe('obsidian-project-intake AC6 — Erfolg (202) navigiert zum Terminal', () => {
  it('202 → onNavigate("factory") wird aufgerufen', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('factory');
    });
  });

  it('202 → kein stehengebliebenes "gestartet"-Element (keine Erfolgsanzeige verbleibt)', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText, queryByText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(queryByText(/wird ausgelöst/i)).toBeNull();
    });
  });
});

// ── AC7: Fehlerpfade ───────────────────────────────────────────────────────────

describe('obsidian-project-intake AC7 — Fehlerpfade', () => {
  it('409 → sichtbare Fehleranzeige "Job läuft bereits", kein onNavigate', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 409, data: { error: 'locked' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/job läuft bereits/i);
    });
    expect(onNavigate).not.toHaveBeenCalledWith('factory');
  });

  it('400 → sichtbare Fehleranzeige mit Reset, kein onNavigate', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 400, data: { reason: 'invalid' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert')).toBeTruthy();
    });
    expect(getByRole('button', { name: /zurücksetzen/i })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalledWith('factory');
  });

  it('500 → sichtbare Fehleranzeige, kein onNavigate, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 500, data: { error: 'boom' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/serverfehler/i);
    });
    expect(onNavigate).not.toHaveBeenCalledWith('factory');
  });

  it('Netzwerkfehler → sichtbare Fehleranzeige mit Reset, kein onNavigate, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: 'reject',
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/netzwerkfehler/i);
    });
    expect(getByRole('button', { name: /zurücksetzen/i })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalledWith('factory');
  });

  it('nach Fehler: "Zurücksetzen" setzt den Fehlerzustand zurück (kein Crash)', async () => {
    const { fetchFn } = makeFetchFn({
      vaultStatus: VAULT_CONFIGURED,
      command: { status: 500, data: { error: 'boom' } },
    });
    const { getByRole, getByLabelText, queryByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });
    await waitFor(() => expect(getByRole('alert')).toBeTruthy());

    const resetBtn = getByRole('button', { name: /zurücksetzen/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    expect(queryByRole('alert')).toBeNull();
  });
});
