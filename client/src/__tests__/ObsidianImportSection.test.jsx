/**
 * ObsidianImportSection.test.jsx — Komponenten-Test für „Aus Obsidian übernehmen"
 * (obsidian-project-intake, S-249 + obsidian-question-catalog, S-251).
 *
 * Covers (obsidian-project-intake): AC2, AC3, AC5, AC6, AC7
 *   AC1 — Toggle-Button-Integration mit GitHubView (bleibt in GitHubViewObsidianImport.test.jsx,
 *         da dieser AC die Parent-Komponenten-Verdrahtung testet, nicht das Verhalten von
 *         `ObsidianImportSection` selbst).
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
 * Covers (obsidian-question-catalog, v3 S-388 — ersetzt v2 AC10/AC11 aus S-384):
 *   AC10 — Ziel-Projekt-Feld = bestehend wählen ODER neu eingeben: das <select> lädt
 *         GET /api/workspace/repos (Namen sichtbar, dieselbe Quelle wie die Fabrik-
 *         Übersicht/Cockpit-Repo-Auswahl) UND trägt zusätzlich den Sentinel-Eintrag
 *         "Neues Projekt erstellen"; bei dessen Auswahl erscheint ein Freitext-Feld,
 *         vorbelegt mit einem aus dem Notiz-Ordner-Basisnamen abgeleiteten Slug-
 *         Vorschlag (editierbar, `_slugifyBase`-Konvention), inline gegen
 *         `^[A-Za-z0-9_-]+$` validiert (Text-Label, nicht nur Farbe). "Strukturiert
 *         starten" bleibt disabled (disabled-Attribut + Text-Label), solange kein
 *         Notiz-Ordner ODER kein gültiges Ziel (bestehend gewählt ODER gültiger neuer
 *         Name) vorliegt. Eine leere Projekt-Liste ist seit v3 KEIN Blocker mehr
 *         (AC11-Konsequenz) — das <select> trägt den Sentinel-Eintrag unabhängig von
 *         der Listengröße; der frühere `new-project`-Blocker-Hinweis entfällt.
 *   AC15 — Beim Start mit einem NEUEN Namen ruft "Strukturiert starten" zuerst
 *         POST .../obsidian-ingest/ensure-target (+ Status-Poll
 *         GET .../ensure-target/:jobId) und zeigt den Anlage-/Existenz-Status
 *         informativ ("wird geprüft…"/"wird angelegt…"/"vorhanden"/Fehlertext,
 *         Text-Label); das Fragenkatalog-Overlay (und damit `POST .../start`) öffnet
 *         erst bei `ready` — ein Anlage-Fehlschlag zeigt den vom Backend gelieferten,
 *         secret-freien Fehlertext und öffnet KEIN Overlay (kein Ingest-Start).
 *         Bestehendes Ziel gewählt → weiterhin direkt zum Overlay (kein
 *         `ensure-target`-Umweg). Der `POST .../start`-Body-Inhalt selbst
 *         (`targetProjectSlug` inkl. Resume-Kopplung) ist in
 *         `GitHubViewObsidianIngestDocking.test.jsx` (Integration) und
 *         `ObsidianIngestOverlay.test.jsx` (Overlay-Vertrag) abgedeckt.
 *         Review-Fix (Iteration 2, Important): Notiz-Ordner- UND Ziel-Auswahl
 *         sind während `checking`/`creating` disabled; ein Auswahlwechsel
 *         (auch per direktem `fireEvent`, Defense in Depth ohne Verlass auf
 *         das disabled-Attribut) bricht die laufende Vorbereitung sofort ab
 *         (Poll gestoppt, Statusanzeige verschwindet, KEIN Auto-Start gegen
 *         die alte oder neue Auswahl). Unmount während des Polls hinterlässt
 *         keinen State-Update-Leck (kein Poll-Call/kein `console.error` nach
 *         Unmount).
 *
 * NFR A11y:
 *   - "Auslösen"-Button: Touch-Target ≥ 44 px (minHeight).
 *   - Disabled-Zustände: disabled-Attribut UND Text-Label (nie nur Farbe).
 *   - Fehler-/Lock-Hinweise: role=alert bzw. role=status, aria-live.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }     = await import('@testing-library/react');
const React          = (await import('react')).default;
const { ObsidianImportSection } = await import('../ObsidianImportSection.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECTS_RESPONSE = {
  projects: [
    { name: 'mein-projekt', path: '/vault/Projekte/mein-projekt' },
    { name: 'anderes-projekt', path: '/vault/Projekte/anderes-projekt' },
  ],
};
const PROJECTS_EMPTY = { projects: [] };

// obsidian-question-catalog v2 AC10/AC11 (S-384): Ziel-Projekt-Auswahlgrundlage
// (dieselbe Quelle wie die Fabrik-Übersicht/Cockpit-Repo-Auswahl).
const WORKSPACE_REPOS_RESPONSE = {
  repos: [
    { name: 'ziel-repo-a', branch: 'main', dirty: false, lastCommit: null, originUrl: null },
    { name: 'ziel-repo-b', branch: 'main', dirty: false, lastCommit: null, originUrl: null },
  ],
};
const WORKSPACE_REPOS_EMPTY = { repos: [] };

const SESSION_READY = { state: 'ready' };
const SESSION_BUSY  = { state: 'busy' };

const FROM_NOTES_ACCEPTED = { commandId: 'cmd-1', status: 'accepted' };

// ── Helper: routed fetchFn ───────────────────────────────────────────────────

/**
 * Erstellt einen fetchFn, der alle von ObsidianImportSection benötigten Endpunkte bedient.
 *
 * @param {{
 *   projects?: { status: number, data: object } | 'reject',
 *   workspaceRepos?: object,
 *   session?: object,
 *   command?: { status: number, data: object } | 'reject' | 'pending',
 *   ensureTargetPost?: { status: number, data: object } | 'reject',
 *   ensureTargetStatusSequence?: Array<{ status: number, data: object }>,
 *   ingestStart?: { status: number, data: object },
 * }} opts
 * @returns {{ fetchFn: jest.Mock, calls: Array<{url:string, method:string, body:*}> }}
 */
function makeFetchFn({
  projects       = { status: 200, data: PROJECTS_RESPONSE },
  workspaceRepos = WORKSPACE_REPOS_RESPONSE,
  session        = SESSION_READY,
  command        = { status: 202, data: FROM_NOTES_ACCEPTED },
  // obsidian-question-catalog v3 AC15 (S-388): Ziel-Repo-Vorbereitung.
  ensureTargetPost           = { status: 200, data: { status: 'ready' } },
  ensureTargetStatusSequence = [{ status: 200, data: { status: 'ready' } }],
  // Vom Overlay selbst ausgelöst, sobald es (nach AC15-Vorbereitung oder
  // direkt bei bestehendem Ziel) öffnet — nur benötigt, damit der Overlay-
  // Mount keinen "unmatched fetch"-Fehler auslöst; der Katalog-Zyklus selbst
  // ist NICHT Gegenstand dieser Testdatei (s. ObsidianIngestOverlay.test.jsx).
  ingestStart    = { status: 202, data: { jobId: 'ingest-job-1', status: 'running' } },
} = {}) {
  const calls = [];
  let ensureStatusIdx = 0;

  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/settings/obsidian-vault/projects') {
      if (projects === 'reject') throw new Error('network error');
      return {
        ok: projects.status < 400,
        status: projects.status,
        json: async () => projects.data,
      };
    }
    if (url === '/api/workspace/repos') {
      return { ok: true, status: 200, json: async () => workspaceRepos };
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
    if (url === '/api/obsidian-ingest/ensure-target' && method === 'POST') {
      if (ensureTargetPost === 'reject') throw new Error('network error');
      return {
        ok: ensureTargetPost.status < 300,
        status: ensureTargetPost.status,
        json: async () => ensureTargetPost.data,
      };
    }
    if (/^\/api\/obsidian-ingest\/ensure-target\/[^/]+$/.test(url) && method === 'GET') {
      const entry = ensureTargetStatusSequence[Math.min(ensureStatusIdx, ensureTargetStatusSequence.length - 1)];
      ensureStatusIdx += 1;
      return { ok: entry.status === 200, status: entry.status, json: async () => entry.data };
    }
    if (url === '/api/obsidian-ingest/start' && method === 'POST') {
      return { ok: ingestStart.status < 300, status: ingestStart.status, json: async () => ingestStart.data };
    }
    if (/^\/api\/obsidian-ingest\/[^/]+$/.test(url) && method === 'GET') {
      // Poll des Overlays nach dem Start — bleibt bewusst 'running' (kein
      // terminaler Zustand, s.o.).
      return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });

  return { fetchFn, calls };
}

/** Rendert ObsidianImportSection mit injizierbarem fetchFn + onNavigate-Spy. */
function renderSection(fetchFn) {
  const onNavigate = jest.fn();
  const utils = render(
    React.createElement(ObsidianImportSection, { onNavigate, fetchFn })
  );
  return { ...utils, onNavigate };
}

/** Wählt einen Projekt-Ordner im <select> aus (nach AC2-Ladeabschluss). */
async function selectProject(getByLabelText, path) {
  const select = await waitFor(() => getByLabelText(/^projekt-ordner$/i));
  fireEvent.change(select, { target: { value: path } });
  return select;
}

/** Wählt ein BESTEHENDES Ziel-Projekt im <select> aus (obsidian-question-catalog AC10). */
async function selectTargetProject(getByLabelText, slug) {
  const select = await waitFor(() => getByLabelText(/^ziel-projekt$/i));
  fireEvent.change(select, { target: { value: slug } });
  return select;
}

/**
 * Wählt "Neues Projekt erstellen" im Ziel-Projekt-<select> aus (obsidian-
 * question-catalog v3 AC10) — öffnet das Freitext-Feld.
 */
async function selectNewTargetOption(getByLabelText) {
  const select = await waitFor(() => getByLabelText(/^ziel-projekt$/i));
  fireEvent.change(select, { target: { value: '__obsidian-new-target__' } });
  return select;
}

/** Tippt einen Neuanlage-Projektnamen ins Freitext-Feld (AC10). */
async function typeNewTargetName(getByLabelText, name) {
  const input = await waitFor(() => getByLabelText(/^neuer projektname$/i));
  fireEvent.change(input, { target: { value: name } });
  return input;
}

afterEach(() => {
  jest.clearAllMocks();
});

// ── AC2: Projekt-Liste laden ──────────────────────────────────────────────────

describe('obsidian-project-intake AC2 — Projekt-Unterordner-Liste', () => {
  it('zeigt Projekt-Namen aus GET .../obsidian-vault/projects', async () => {
    const { fetchFn } = makeFetchFn({
      projects: { status: 200, data: PROJECTS_RESPONSE },
    });
    const { getByText } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByText('mein-projekt')).toBeTruthy();
      expect(getByText('anderes-projekt')).toBeTruthy();
    });
  });

  it('leere Liste → klarer Hinweis, kein Auslöser aktiv', async () => {
    const { fetchFn } = makeFetchFn({
      projects: { status: 200, data: PROJECTS_EMPTY },
    });
    const { getByText, queryByLabelText } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByText(/keine projekte unter/i)).toBeTruthy();
    });
    expect(queryByLabelText(/^projekt-ordner$/i)).toBeNull();
  });

  it('Ladefehler (500) → sichtbare Fehleranzeige (role=alert), kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      projects: { status: 500, data: { error: 'boom' } },
    });
    const { getByRole } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/nicht geladen werden/i);
    });
  });

  it('Ladefehler (Netzwerkfehler) → sichtbare Fehleranzeige, kein Crash', async () => {
    const { fetchFn } = makeFetchFn({
      projects: 'reject',
    });
    const { getByRole } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/nicht geladen werden/i);
    });
  });
});

// ── v3 AC10 (S-388): Ziel-Projekt — bestehend wählen ODER neu eingeben ───────

describe('obsidian-question-catalog v3 AC10 — Ziel-Projekt: bestehend wählen ODER neu eingeben', () => {
  it('zeigt Ziel-Projekt-Namen aus GET /api/workspace/repos', async () => {
    const { fetchFn } = makeFetchFn({ workspaceRepos: WORKSPACE_REPOS_RESPONSE });
    const { getByText } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByText('ziel-repo-a')).toBeTruthy();
      expect(getByText('ziel-repo-b')).toBeTruthy();
    });
  });

  it('"Strukturiert starten" bleibt disabled ohne Ziel-Projekt, auch wenn Notiz-Ordner bereits gewählt ist', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    expect(startBtn.disabled).toBe(true);
    expect(startBtn.getAttribute('aria-label')).toMatch(/ziel-projekt fehlt/i);
  });

  it('"Strukturiert starten" wird aktiv, sobald Notiz-Ordner UND bestehendes Ziel-Projekt gewählt sind', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectTargetProject(getByLabelText, 'ziel-repo-a');

    await waitFor(() => {
      const startBtn = getByRole('button', { name: /strukturiert starten/i });
      expect(startBtn.disabled).toBe(false);
    });
  });

  it('Klick auf "Strukturiert starten" ohne Ziel-Projekt öffnet KEIN Overlay (defense in depth)', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    await act(async () => { fireEvent.click(startBtn); });

    expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
  });

  it('"Neues Projekt erstellen" zeigt ein Freitext-Feld, vorbelegt mit einem Slug-Vorschlag aus dem Notiz-Ordner-Basisnamen', async () => {
    const { fetchFn } = makeFetchFn({
      projects: {
        status: 200,
        data: { projects: [{ name: 'Müller Notizen', path: '/vault/Projekte/mueller-notizen' }] },
      },
    });
    const { getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mueller-notizen');
    await selectNewTargetOption(getByLabelText);

    await waitFor(() => {
      const input = getByLabelText(/^neuer projektname$/i);
      expect(input.value).toBe('mueller-notizen');
    });
  });

  it('Freitext-Neuanlage-Name mit ungültigen Zeichen → Inline-Fehler (Text-Label), "Strukturiert starten" bleibt disabled', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, getByLabelText, getByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'ungültiger name mit leerzeichen');

    await waitFor(() => {
      expect(getByTestId('obsidian-new-target-invalid').textContent).toMatch(/ungültiger projektname/i);
    });
    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    expect(startBtn.disabled).toBe(true);
    expect(startBtn.getAttribute('aria-label')).toMatch(/ungültiger projektname/i);
  });

  it('gültiger Freitext-Neuanlage-Name → "Strukturiert starten" wird aktiv, kein Inline-Fehler', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole, getByLabelText, queryByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'mein-neues-projekt');

    await waitFor(() => {
      const startBtn = getByRole('button', { name: /strukturiert starten/i });
      expect(startBtn.disabled).toBe(false);
    });
    expect(queryByTestId('obsidian-new-target-invalid')).toBeNull();
  });

  it('leere Ziel-Projekt-Liste (AC11) → KEIN Blocker-Hinweis mehr, das <select> trägt weiterhin "Neues Projekt erstellen"', async () => {
    const { fetchFn } = makeFetchFn({ workspaceRepos: WORKSPACE_REPOS_EMPTY });
    const { getByLabelText, queryByTestId } = renderSection(fetchFn);
    await waitFor(() => {
      expect(getByLabelText(/^ziel-projekt$/i)).toBeTruthy();
    });
    expect(queryByTestId('obsidian-target-project-empty-hint')).toBeNull();
  });

  it('leere Ziel-Projekt-Liste + gültiger neuer Name → "Strukturiert starten" wird aktiv (kein Blocker)', async () => {
    const { fetchFn } = makeFetchFn({ workspaceRepos: WORKSPACE_REPOS_EMPTY });
    const { getByRole, getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'frisches-projekt');

    await waitFor(() => {
      const startBtn = getByRole('button', { name: /strukturiert starten/i });
      expect(startBtn.disabled).toBe(false);
    });
  });
});

// ── v3 AC15 (S-388): Ziel-Repo-Vorbereitung (ensure-target) ──────────────────

describe('obsidian-question-catalog v3 AC15 — Anlage-/Existenz-Statusanzeige vor dem Ingest-Start', () => {
  it('bestehendes Ziel gewählt → Klick öffnet das Overlay DIREKT, kein POST an .../ensure-target', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByRole, getByLabelText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectTargetProject(getByLabelText, 'ziel-repo-a');

    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    await waitFor(() => expect(startBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeTruthy();
    });
    expect(calls.some((c) => c.url === '/api/obsidian-ingest/ensure-target')).toBe(false);
  });

  it('neuer Name, ensure-target liefert sofort 200 "ready" → zeigt "vorhanden", öffnet danach das Overlay', async () => {
    const { fetchFn } = makeFetchFn({
      ensureTargetPost: { status: 200, data: { status: 'ready' } },
    });
    const { getByRole, getByLabelText, getByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'frisches-projekt');

    const startBtn = await waitFor(() => {
      const btn = getByRole('button', { name: /strukturiert starten/i });
      expect(btn.disabled).toBe(false);
      return btn;
    });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(getByTestId('obsidian-target-ensure-status').textContent).toMatch(/vorhanden/i);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeTruthy();
    });
  });

  it('neuer Name, ensure-target liefert 202 "creating" → zeigt "wird angelegt…", pollt bis "ready", öffnet dann das Overlay', async () => {
    const { fetchFn } = makeFetchFn({
      ensureTargetPost: { status: 202, data: { jobId: 'ensure-job-1' } },
      ensureTargetStatusSequence: [
        { status: 200, data: { status: 'creating' } },
        { status: 200, data: { status: 'ready' } },
      ],
    });
    const { getByRole, getByLabelText, getByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'frisches-projekt');

    const startBtn = await waitFor(() => {
      const btn = getByRole('button', { name: /strukturiert starten/i });
      expect(btn.disabled).toBe(false);
      return btn;
    });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(getByTestId('obsidian-target-ensure-status').textContent).toMatch(/wird angelegt/i);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('neuer Name, Anlage schlägt fehl ("failed") → definierter Fehlertext, KEIN Overlay, kein Ingest-Start', async () => {
    const { fetchFn, calls } = makeFetchFn({
      ensureTargetPost: { status: 202, data: { jobId: 'ensure-job-2' } },
      ensureTargetStatusSequence: [
        { status: 200, data: { status: 'failed', error: 'Projekt-Anlage fehlgeschlagen' } },
      ],
    });
    const { getByRole, getByLabelText, getByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'frisches-projekt');

    const startBtn = await waitFor(() => {
      const btn = getByRole('button', { name: /strukturiert starten/i });
      expect(btn.disabled).toBe(false);
      return btn;
    });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(getByTestId('obsidian-target-ensure-error').textContent).toMatch(/projekt-anlage fehlgeschlagen/i);
    });
    expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
    expect(calls.some((c) => c.url === '/api/obsidian-ingest/start')).toBe(false);
  });

  it('Netzwerkfehler bei POST .../ensure-target → Fehleranzeige, kein Overlay', async () => {
    const { fetchFn } = makeFetchFn({ ensureTargetPost: 'reject' });
    const { getByRole, getByLabelText, getByTestId } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectNewTargetOption(getByLabelText);
    await typeNewTargetName(getByLabelText, 'frisches-projekt');

    const startBtn = await waitFor(() => {
      const btn = getByRole('button', { name: /strukturiert starten/i });
      expect(btn.disabled).toBe(false);
      return btn;
    });
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(getByTestId('obsidian-target-ensure-error').textContent).toMatch(/netzwerkfehler/i);
    });
    expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
  });

  // ── Review-Fix Iteration 2 (Important) ───────────────────────────────────
  // Während `ensure-target` läuft (checking/creating), blieben Notiz-Ordner-
  // und Ziel-Auswahl bedienbar; wechselte der Nutzer sie, lief der alte Poll
  // weiter und startete nach `ready` AUTOMATISCH gegen das NEUE Ziel — ohne
  // erneuten Klick auf "Strukturiert starten". Fix: Auswahlwechsel bricht
  // die laufende Vorbereitung sofort ab (Poll gestoppt, kein Auto-Start);
  // die Felder sind während `isEnsuring` zusätzlich disabled.

  it('Ziel-Projekt-Auswahlwechsel WÄHREND der Anlage → kein Auto-Start, Poll gestoppt, Statusanzeige verschwindet', async () => {
    jest.useFakeTimers();
    try {
      const { fetchFn, calls } = makeFetchFn({
        ensureTargetPost: { status: 202, data: { jobId: 'ensure-job-abort-1' } },
        // Antwortet dauerhaft 'creating' — würde ohne Abbruch NIE von selbst
        // 'ready' werden; jeder Poll-Aufruf nach dem Abbruch wäre also ein
        // eindeutiges Indiz für "Poll NICHT gestoppt".
        ensureTargetStatusSequence: [{ status: 200, data: { status: 'creating' } }],
      });
      const { getByRole, getByLabelText, getByTestId, queryByTestId } = renderSection(fetchFn);
      await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
      await selectNewTargetOption(getByLabelText);
      await typeNewTargetName(getByLabelText, 'frisches-projekt');

      const startBtn = await waitFor(() => {
        const btn = getByRole('button', { name: /strukturiert starten/i });
        expect(btn.disabled).toBe(false);
        return btn;
      });
      fireEvent.click(startBtn);

      await waitFor(() => {
        expect(getByTestId('obsidian-target-ensure-status').textContent).toMatch(/wird angelegt/i);
      });
      // Während der Anlage sind beide Auswahl-Felder disabled (Kernpunkt 3).
      expect(getByLabelText(/^projekt-ordner$/i).disabled).toBe(true);
      expect(getByLabelText(/^ziel-projekt$/i).disabled).toBe(true);

      const pollCallsBeforeChange = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;
      expect(pollCallsBeforeChange).toBeGreaterThanOrEqual(1);

      // Auswahlwechsel WÄHREND der Anlage — bewusst per fireEvent (nicht
      // userEvent), da der Abbruch-Schutz (Kernpunkt 2) explizit AUCH ohne
      // Verlass auf das disabled-Attribut greifen muss (Defense in Depth).
      fireEvent.change(getByLabelText(/^ziel-projekt$/i), { target: { value: 'ziel-repo-a' } });

      // Statusanzeige verschwindet sofort (ensureState zurück auf 'idle').
      expect(queryByTestId('obsidian-target-ensure-status')).toBeNull();
      expect(queryByTestId('obsidian-target-ensure-error')).toBeNull();

      // Poll gestoppt: über mehrere weitere Intervalle hinweg keine neuen Calls.
      await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
      const pollCallsAfterWait = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;
      expect(pollCallsAfterWait).toBe(pollCallsBeforeChange);

      // Kein Auto-Start gegen das alte ODER das neue Ziel.
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
      expect(calls.some((c) => c.url === '/api/obsidian-ingest/start')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Notiz-Ordner-Auswahlwechsel WÄHREND der Anlage → kein Auto-Start, Poll gestoppt', async () => {
    jest.useFakeTimers();
    try {
      const { fetchFn, calls } = makeFetchFn({
        ensureTargetPost: { status: 202, data: { jobId: 'ensure-job-abort-2' } },
        ensureTargetStatusSequence: [{ status: 200, data: { status: 'creating' } }],
      });
      const { getByRole, getByLabelText, getByTestId, queryByTestId } = renderSection(fetchFn);
      await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
      await selectNewTargetOption(getByLabelText);
      await typeNewTargetName(getByLabelText, 'frisches-projekt');

      const startBtn = await waitFor(() => {
        const btn = getByRole('button', { name: /strukturiert starten/i });
        expect(btn.disabled).toBe(false);
        return btn;
      });
      fireEvent.click(startBtn);

      await waitFor(() => {
        expect(getByTestId('obsidian-target-ensure-status').textContent).toMatch(/wird angelegt/i);
      });

      const pollCallsBeforeChange = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;

      fireEvent.change(getByLabelText(/^projekt-ordner$/i), { target: { value: '/vault/Projekte/anderes-projekt' } });

      expect(queryByTestId('obsidian-target-ensure-status')).toBeNull();

      await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
      const pollCallsAfterWait = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;
      expect(pollCallsAfterWait).toBe(pollCallsBeforeChange);
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Unmount WÄHREND des Anlage-Polls → kein Leck (kein State-Update nach Unmount), Poll gestoppt, kein Overlay', async () => {
    jest.useFakeTimers();
    try {
      const { fetchFn, calls } = makeFetchFn({
        ensureTargetPost: { status: 202, data: { jobId: 'ensure-job-unmount-1' } },
        ensureTargetStatusSequence: [{ status: 200, data: { status: 'creating' } }],
      });
      const onNavigate = jest.fn();
      const { getByRole, getByLabelText, getByTestId, unmount } = render(
        React.createElement(ObsidianImportSection, { onNavigate, fetchFn }),
      );
      await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
      await selectNewTargetOption(getByLabelText);
      await typeNewTargetName(getByLabelText, 'frisches-projekt');

      const startBtn = await waitFor(() => {
        const btn = getByRole('button', { name: /strukturiert starten/i });
        expect(btn.disabled).toBe(false);
        return btn;
      });
      fireEvent.click(startBtn);

      await waitFor(() => {
        expect(getByTestId('obsidian-target-ensure-status').textContent).toMatch(/wird angelegt/i);
      });

      const pollCallsBeforeUnmount = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;

      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      unmount();

      await act(async () => { await jest.advanceTimersByTimeAsync(6000); });

      const pollCallsAfterUnmount = calls.filter((c) => /\/ensure-target\//.test(c.url)).length;
      expect(pollCallsAfterUnmount).toBe(pollCallsBeforeUnmount);
      // Kein "Can't perform a React state update on an unmounted component"-
      // Leck.
      expect(consoleError).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeNull();
      expect(calls.some((c) => c.url === '/api/obsidian-ingest/start')).toBe(false);

      consoleError.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  // Happy-Path unverändert: bereits durch die o.g. Tests ("bestehendes Ziel
  // …", "sofort 200 'ready'…", "202 'creating' … bis 'ready'…") abgedeckt —
  // kein Auswahlwechsel während der Vorbereitung → unverändertes Verhalten.
});

// ── AC3: Auslösen — genau ein POST ────────────────────────────────────────────

describe('obsidian-project-intake AC3 — "Auslösen" POSTet genau einmal', () => {
  it('ohne Auswahl ist "Auslösen" disabled', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole } = renderSection(fetchFn);
    await waitFor(() => {
      const btn = getByRole('button', { name: /auslösen/i });
      expect(btn.disabled).toBe(true);
    });
  });

  it('mit Auswahl POSTet "Auslösen" genau einmal { command: "/agent-flow:from-notes <path>" }', async () => {
    const { fetchFn, calls } = makeFetchFn({
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText } = renderSection(fetchFn);
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
    // ObsidianImportSection ist org-weit (kein Projekt-Kontext) → kein projectPath.
    expect(body.projectPath).toBeUndefined();
  });

  it('Doppelklick während "starting" → kein zweiter POST (Button gesperrt)', async () => {
    const { fetchFn, calls } = makeFetchFn({
      command: 'pending',
    });
    const { getByRole, getByLabelText } = renderSection(fetchFn);
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
      session: SESSION_BUSY,
    });
    const { getByRole, getByLabelText, getByText } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    await waitFor(() => {
      expect(getByText(/job läuft bereits — auslösen gesperrt/i)).toBeTruthy();
    });
    const triggerBtn = getByRole('button', { name: /auslösen/i });
    expect(triggerBtn.disabled).toBe(true);
  });

  it('state:"busy" → Klick löst keinen POST an /api/command aus', async () => {
    const { fetchFn, calls } = makeFetchFn({
      session: SESSION_BUSY,
    });
    const { getByRole, getByLabelText } = renderSection(fetchFn);
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
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText, onNavigate } = renderSection(fetchFn);
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
      command: { status: 202, data: FROM_NOTES_ACCEPTED },
    });
    const { getByRole, getByLabelText, queryByText } = renderSection(fetchFn);
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
      command: { status: 409, data: { error: 'locked' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderSection(fetchFn);
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
      command: { status: 400, data: { reason: 'invalid' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderSection(fetchFn);
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
      command: { status: 500, data: { error: 'boom' } },
    });
    const { getByRole, getByLabelText, onNavigate } = renderSection(fetchFn);
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
      command: 'reject',
    });
    const { getByRole, getByLabelText, onNavigate } = renderSection(fetchFn);
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
      command: { status: 400, data: { reason: 'invalid' } },
    });
    const { getByRole, getByLabelText, queryByRole } = renderSection(fetchFn);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => {
      fireEvent.click(triggerBtn);
    });

    await waitFor(() => {
      expect(getByRole('alert')).toBeTruthy();
    });
    const resetBtn = getByRole('button', { name: /zurücksetzen/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    await waitFor(() => {
      expect(queryByRole('alert')).toBeNull();
    });
  });
});
