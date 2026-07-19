/**
 * GitHubViewObsidianIngestDocking.test.jsx — Andockung des Fragenkatalog-
 * Overlays (`ObsidianIngestOverlay.jsx`) an die dritte "Neues Projekt"-Option
 * in `GitHubView.jsx` (docs/specs/obsidian-question-catalog.md, S-251).
 *
 * Prüft NUR die Integrations-Naht (Button → Overlay-Öffnen → projectFolderPath
 * → onIngestComplete → onNavigate). Das Overlay-Verhalten selbst (Katalog-
 * Rendering, Senden-Gate, Resume-Zyklus, Fehler/Retry, Esc/Fokus) ist in
 * `ObsidianIngestOverlay.test.jsx` abgedeckt (dort AC3/AC4/AC5/AC7 vollständig).
 * Der bestehende PTY-Fallback-Pfad (`obsidian-project-intake` AC3/AC5-AC7)
 * bleibt UNVERÄNDERT und ist in `GitHubViewObsidianImport.test.jsx` getestet
 * (dort weiterhin grün, hier nicht erneut geprüft).
 *
 * Covers (obsidian-question-catalog):
 *   AC3/AC4/AC5/AC7 — Integrations-Anteil: der neue "Strukturiert starten"-
 *          Button (eigener, von "Auslösen" unterscheidbarer aria-label-Text,
 *          kein `/auslösen/i`-Match) öffnet `ObsidianIngestOverlay` mit dem
 *          ausgewählten `projectFolderPath`; `onIngestComplete` navigiert zu
 *          `onNavigate('factory')` (GitHubView hat keinen eigenen Board-Store
 *          — Re-Fetch geschieht beim Mount der Factory-Ansicht, analog dem
 *          bestehenden PTY-Erfolgspfad AC6 obsidian-project-intake).
 *   AC7  — Review-Fix Iteration 2 (Important reviewer/R06): ein Auswahlwechsel
 *          (Projekt A → Projekt B) NACH Start eines Ingest-Jobs für Projekt A
 *          (Overlay geschlossen, Job läuft detached weiter) verwirft den
 *          gemerkten Wiedereinstiegs-Job — der Button zeigt sofort wieder
 *          "Strukturiert starten" (nicht "Fortsetzen") und ein erneuter Klick
 *          löst einen NEUEN `POST /start` für Projekt B aus, statt lautlos
 *          den Job von Projekt A zu resumen.
 *   AC10 — Ziel-Projekt-Auswahl (BESTEHENDES Workspace-Projekt, v3 S-388: das
 *          `<select>` selbst trägt seit v3 zusätzlich einen "Neues Projekt
 *          erstellen"-Sentinel + Freitext-Neuanlage — dieser Pfad UND die
 *          AC15-Ziel-Repo-Vorbereitung sind ausschließlich in
 *          `ObsidianImportSection.test.jsx` getestet, da sie NICHT die
 *          Integrations-Naht zu `GitHubView.jsx` betreffen) ist zusätzliche
 *          Voraussetzung für "Strukturiert starten"; der `POST /start`-Body
 *          enthält `targetProjectSlug` aus der GET-/api/workspace/repos-Liste.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }     = await import('@testing-library/react');
const React          = (await import('react')).default;
const { GitHubView } = await import('../GitHubView.jsx');

const REPOS_EMPTY = { repos: [] };
const WORKSPACE_REPOS_EMPTY = { repos: [] };
// obsidian-question-catalog v2 AC10 (S-384): Ziel-Projekt-Auswahlgrundlage.
const WORKSPACE_REPOS_ONE = { repos: [{ name: 'ziel-repo' }] };
const VAULT_CONFIGURED = { vaultPath: '/vault', configured: true };
const PROJECTS_RESPONSE = {
  projects: [{ name: 'mein-projekt', path: '/vault/Projekte/mein-projekt' }],
};
const PROJECTS_TWO = {
  projects: [
    { name: 'projekt-a', path: '/vault/Projekte/projekt-a' },
    { name: 'projekt-b', path: '/vault/Projekte/projekt-b' },
  ],
};
const SESSION_READY = { state: 'ready' };

const START_RE = /\/api\/obsidian-ingest\/start$/;
const STATUS_RE = /\/api\/obsidian-ingest\/[^/]+$/;

function makeFetchFn({ ingestStatusSequence = [{ status: 'done' }] } = {}) {
  const calls = [];
  let idx = 0;
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });

    if (url === '/api/github/repos') return { ok: true, status: 200, json: async () => REPOS_EMPTY };
    if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_ONE };
    if (url === '/api/settings/obsidian-vault-path') return { ok: true, status: 200, json: async () => VAULT_CONFIGURED };
    if (url === '/api/settings/obsidian-vault/projects') return { ok: true, status: 200, json: async () => PROJECTS_RESPONSE };
    if (url === '/api/session') return { ok: true, status: 200, json: async () => SESSION_READY };
    if (START_RE.test(url) && method === 'POST') {
      return { status: 202, json: async () => ({ jobId: 'job-1', status: 'running' }) };
    }
    if (STATUS_RE.test(url) && method === 'GET') {
      const s = ingestStatusSequence[Math.min(idx, ingestStatusSequence.length - 1)];
      idx += 1;
      return { status: 200, json: async () => s };
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });
  return { fetchFn, calls };
}

function renderView(fetchFn) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(GitHubView, { onNavigate, fetchFn }));
  return { ...utils, onNavigate };
}

async function openObsidianPanel(getByRole) {
  const toggleBtn = getByRole('button', { name: /aus obsidian-notizen/i });
  await act(async () => { fireEvent.click(toggleBtn); });
}

async function selectProject(getByLabelText, path) {
  const select = await waitFor(() => getByLabelText(/^projekt-ordner$/i));
  fireEvent.change(select, { target: { value: path } });
  return select;
}

/** obsidian-question-catalog v2 AC10 (S-384): wählt das Ziel-Projekt aus. */
async function selectTargetProject(getByLabelText, slug) {
  const select = await waitFor(() => getByLabelText(/^ziel-projekt$/i));
  fireEvent.change(select, { target: { value: slug } });
  return select;
}

/**
 * fetch-Mock mit ZWEI wählbaren Projekten (`projekt-a`/`projekt-b`); der
 * gestartete Ingest-Job bleibt `running` (nicht terminal) — nötig, um das
 * Overlay VOR dem `done`-Zustand zu schließen (Regressionstest: Auswahlwechsel
 * nach Job-Start).
 */
function makeMultiProjectFetchFn() {
  const calls = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    let parsedBody;
    try { parsedBody = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsedBody = opts.body; }
    calls.push({ url, method, body: parsedBody });

    if (url === '/api/github/repos') return { ok: true, status: 200, json: async () => REPOS_EMPTY };
    if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_ONE };
    if (url === '/api/settings/obsidian-vault-path') return { ok: true, status: 200, json: async () => VAULT_CONFIGURED };
    if (url === '/api/settings/obsidian-vault/projects') return { ok: true, status: 200, json: async () => PROJECTS_TWO };
    if (url === '/api/session') return { ok: true, status: 200, json: async () => SESSION_READY };
    if (START_RE.test(url) && method === 'POST') {
      return { status: 202, json: async () => ({ jobId: `job-for-${parsedBody.projectFolderPath}`, status: 'running' }) };
    }
    if (STATUS_RE.test(url) && method === 'GET') {
      return { status: 200, json: async () => ({ status: 'running' }) }; // nie terminal in diesem Test
    }
    throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
  });
  return { fetchFn, calls };
}

afterEach(() => { jest.clearAllMocks(); });

describe('obsidian-question-catalog — Andockung "Strukturiert starten" in GitHubView', () => {
  it('Button ist eindeutig von "Auslösen" unterscheidbar (kein Namens-Kollision)', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      expect(getByRole('button', { name: /strukturiert starten/i })).toBeTruthy();
      expect(getByRole('button', { name: /auslösen/i })).toBeTruthy();
    });
  });

  it('ohne Auswahl ist "Strukturiert starten" disabled', async () => {
    const { fetchFn } = makeFetchFn();
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await waitFor(() => {
      const btn = getByRole('button', { name: /strukturiert starten/i });
      expect(btn.disabled).toBe(true);
    });
  });

  it('mit Auswahl öffnet Klick das Overlay + startet den Ingest mit dem gewählten Pfad', async () => {
    const { fetchFn, calls } = makeFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectTargetProject(getByLabelText, 'ziel-repo');

    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    await waitFor(() => expect(startBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeTruthy();
      const startCall = calls.find((c) => START_RE.test(c.url) && c.method === 'POST');
      expect(startCall).toBeTruthy();
      expect(JSON.parse(startCall.body)).toEqual({
        projectFolderPath: '/vault/Projekte/mein-projekt',
        targetProjectSlug: 'ziel-repo',
      });
    });
  });

  it('bei done navigiert onIngestComplete zu onNavigate("factory")', async () => {
    const { fetchFn } = makeFetchFn({ ingestStatusSequence: [{ status: 'done' }] });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');
    await selectTargetProject(getByLabelText, 'ziel-repo');

    const startBtn = getByRole('button', { name: /strukturiert starten/i });
    await waitFor(() => expect(startBtn.disabled).toBe(false));
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => expect(document.querySelector('[data-testid="obsidian-ingest-done"]')).toBeTruthy());
    // Overlay nutzt hier den Default-`successLingerMs` (1200ms, GitHubView
    // übergibt keinen Test-Override) — Timeout entsprechend großzügig.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('factory'), { timeout: 2500 });
  });

  it('der bestehende PTY-"Auslösen"-Button bleibt unverändert nutzbar (kein POST /api/obsidian-ingest/start)', async () => {
    const calls = [];
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/github/repos') return { ok: true, status: 200, json: async () => REPOS_EMPTY };
      if (url === '/api/workspace/repos') return { ok: true, status: 200, json: async () => WORKSPACE_REPOS_EMPTY };
      if (url === '/api/settings/obsidian-vault-path') return { ok: true, status: 200, json: async () => VAULT_CONFIGURED };
      if (url === '/api/settings/obsidian-vault/projects') return { ok: true, status: 200, json: async () => PROJECTS_RESPONSE };
      if (url === '/api/session') return { ok: true, status: 200, json: async () => SESSION_READY };
      if (url === '/api/command' && method === 'POST') {
        return { ok: true, status: 202, json: async () => ({ commandId: 'cmd-1', status: 'accepted' }) };
      }
      throw new Error(`Unerwarteter fetch-Aufruf: ${method} ${url}`);
    });
    const { getByRole, getByLabelText, onNavigate } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/mein-projekt');

    const triggerBtn = getByRole('button', { name: /auslösen/i });
    await act(async () => { fireEvent.click(triggerBtn); });

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('factory'));
    expect(calls.some((c) => c.url === '/api/command' && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => START_RE.test(c.url))).toBe(false);
  });

  // Review-Fix Iteration 2 (Important reviewer/R06): Auswahlwechsel nach
  // Job-Start darf den gemerkten Wiedereinstiegs-Job NICHT für das neu
  // gewählte Projekt übernehmen (sonst "Fortsetzen" + lautloses Resume des
  // FALSCHEN Jobs — kein neuer POST /start, keine Fehlermeldung).
  it('Auswahlwechsel nach Job-Start verwirft den gemerkten Wiedereinstiegs-Job (kein stilles Resume des falschen Projekts)', async () => {
    const { fetchFn, calls } = makeMultiProjectFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);
    await waitFor(() => expect(getByRole('button', { name: /aus obsidian-notizen/i }).disabled).toBe(false));
    await openObsidianPanel(getByRole);
    await selectProject(getByLabelText, '/vault/Projekte/projekt-a');
    await selectTargetProject(getByLabelText, 'ziel-repo');

    // Projekt A starten (Job bleibt "running", also nicht terminal).
    const startBtnA = getByRole('button', { name: /strukturiert starten/i });
    await waitFor(() => expect(startBtnA.disabled).toBe(false));
    await act(async () => { fireEvent.click(startBtnA); });
    await waitFor(() => expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeTruthy());

    // Overlay schließen, OHNE dass der Job terminal wurde — läuft detached weiter.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-ingest-close-btn"]'));
    });
    await waitFor(() => expect(document.querySelector('[data-testid="obsidian-ingest-overlay"]')).toBeFalsy());

    // Für Projekt A (unverändert gewählt) zeigt der Button jetzt "Fortsetzen".
    const ingestBtn = () => document.querySelector('[data-testid="obsidian-ingest-open-btn"]');
    await waitFor(() => expect(ingestBtn().textContent).toBe('Fortsetzen'));

    // Auswahlwechsel auf Projekt B.
    const select = getByLabelText(/^projekt-ordner$/i);
    await act(async () => { fireEvent.change(select, { target: { value: '/vault/Projekte/projekt-b' } }); });

    // Der Button muss SOFORT wieder "Strukturiert starten" zeigen (kein
    // "Fortsetzen" für einen Job, der zu einem anderen Projekt gehört).
    await waitFor(() => expect(ingestBtn().textContent).toBe('Strukturiert starten'));
    expect(ingestBtn().getAttribute('aria-label')).not.toMatch(/fortsetzen/i);

    const startCallsBefore = calls.filter((c) => START_RE.test(c.url)).length;
    await act(async () => { fireEvent.click(ingestBtn()); });

    // Klick löst einen NEUEN POST /start für Projekt B aus (kein stilles
    // Resume des Jobs von Projekt A).
    await waitFor(() => {
      const startCallsAfter = calls.filter((c) => START_RE.test(c.url));
      expect(startCallsAfter.length).toBe(startCallsBefore + 1);
      const lastCall = startCallsAfter[startCallsAfter.length - 1];
      expect(lastCall.body).toEqual({ projectFolderPath: '/vault/Projekte/projekt-b', targetProjectSlug: 'ziel-repo' });
    });
  });
});
