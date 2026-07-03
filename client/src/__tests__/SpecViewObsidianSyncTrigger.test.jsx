/**
 * SpecViewObsidianSyncTrigger.test.jsx — Tests für obsidian-sync-trigger
 * AC1–AC7: „Notizen-Stand abgleichen"-Button (Obsidian-Sync) im
 * Spezifikation-Reiter (SpecView.jsx, ObsidianSyncTrigger).
 *
 * Covers (obsidian-sync-trigger):
 *   AC1 — Button „Notizen-Stand abgleichen" neben „Konzept/Spec nachziehen";
 *          Touch-Target ≥ 44 px; Hinweistext nennt /agent-flow:from-notes
 *          --sync UND „zeigt Widersprüche an, überschreibt nicht blind".
 *          Ohne Vault (GET /api/settings/obsidian-vault-path →
 *          configured:false) disabled + Text-Hinweis.
 *   AC2 — Klick (freie Session + Vault) öffnet Bestätigungsdialog
 *          (role="dialog"); noch kein POST.
 *   AC3 — „Starten" POSTet genau einmal { command: '/agent-flow:from-notes
 *          --sync <path>', projectPath } an /api/command; „Abbrechen" ohne
 *          POST. Löst A1 über explizite Ordner-Auswahl im Dialog
 *          (GET /api/settings/obsidian-vault/projects); ohne Auswahl bzw.
 *          bei leerer/fehlerhafter Ordner-Liste ist „Starten" deaktiviert
 *          (Edge-Case „kann nicht bestimmt werden" — kein POST).
 *   AC4 — Backend-Allowlist-Test (CommandService-Ebene) — siehe
 *          test/CommandService.test.js.
 *   AC5 — Bei GET /api/session → busy ist der Button deaktiviert; Klick
 *          öffnet keinen Dialog, kein POST.
 *   AC6 — 202 → onShowArbeiten() (schaltet CockpitView auf den "Arbeiten"-
 *          Reiter, KEIN App-Level onNavigate/Hash-Wechsel — Präzisierung
 *          Iteration 2, s. SpecView.jsx-Doku); kein stehengebliebenes Element.
 *   AC7 — 409 → Fehleranzeige ohne Navigate; 400/500/Netzwerkfehler →
 *          Fehleranzeige mit Reset, kein Navigate, kein Crash.
 *
 * Gespiegelt vom Test-Muster in SpecViewReconcileTrigger.test.jsx.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }  = await import('@testing-library/react');
const React        = (await import('react')).default;
const { SpecView } = await import('../SpecView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
];

const FAKE_FOLDERS = [
  { name: 'Mein-Projekt', path: 'Projekte/Mein-Projekt' },
];

/**
 * Build a fetch mock that handles the doc list, /api/settings/obsidian-vault-path,
 * /api/settings/obsidian-vault/projects, /api/session and POST /api/command.
 *
 * @param {object} opts
 * @param {boolean}        [opts.vaultConfigured=true]
 * @param {'busy'|'ready'} [opts.sessionState='ready']
 * @param {Array|null}     [opts.folders=FAKE_FOLDERS] — null → 500 on the projects endpoint
 * @param {number}         [opts.commandStatus=202]
 * @param {object}         [opts.commandBody={commandId:'cmd-1', status:'running'}]
 */
function makeFetchFn({
  vaultConfigured = true,
  sessionState = 'ready',
  folders = FAKE_FOLDERS,
  commandStatus = 202,
  commandBody = { commandId: 'cmd-1', status: 'running' },
} = {}) {
  return jest.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/settings/obsidian-vault-path') {
      return { ok: true, status: 200, json: async () => ({ vaultPath: vaultConfigured ? '/vault' : null, configured: vaultConfigured }) };
    }
    if (url === '/api/settings/obsidian-vault/projects') {
      if (folders === null) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ projects: folders }) };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (url === '/api/command' && opts?.method === 'POST') {
      return {
        ok: commandStatus === 202,
        status: commandStatus,
        json: async () => commandBody,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/**
 * Render SpecView, replacing globalThis.fetch so the ObsidianSyncTrigger
 * (default fetchFn = globalThis.fetch) picks it up.
 *
 * @param {Function} [fetchFn]  Optional fetch mock; defaults to makeFetchFn().
 * @returns {{ onShowArbeitenSpy: jest.Mock, fetchFn: jest.Mock }}
 */
function renderSpecView(fetchFn) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;

  const onShowArbeitenSpy = jest.fn();
  render(
    React.createElement(SpecView, {
      projectSlug: 'my-project',
      onShowArbeiten: onShowArbeitenSpy,
      obsidianSyncPollInterval: 50_000,
    }),
  );
  return { onShowArbeitenSpy, fetchFn: fn };
}

function commandCalls(fetchFn) {
  return fetchFn.mock.calls.filter((c) => c[0] === '/api/command' && c[1]?.method === 'POST');
}

async function openDialogWithFolder() {
  await waitFor(() => {
    expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
  });
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
  });
  await waitFor(() => {
    expect(document.querySelector('[data-testid="obsidian-sync-folder-select"]')).toBeTruthy();
  });
  await act(async () => {
    fireEvent.change(document.querySelector('[data-testid="obsidian-sync-folder-select"]'), {
      target: { value: FAKE_FOLDERS[0].path },
    });
  });
}

// ── AC1: Button + Hinweistext ──────────────────────────────────────────────────

describe('SpecView — obsidian-sync-trigger AC1: Button + Hinweistext', () => {
  it('rendert „Notizen-Stand abgleichen"-Button im Spezifikation-Reiter', async () => {
    renderSpecView();
    await waitFor(() => {
      const btn = document.querySelector('[data-testid="obsidian-sync-btn"]');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toMatch(/Notizen-Stand abgleichen/i);
    });
  });

  it('Button hat minHeight≥44px (Touch-Target, WCAG 2.1 AA)', async () => {
    renderSpecView();
    await waitFor(() => {
      const btn = document.querySelector('[data-testid="obsidian-sync-btn"]');
      const px = parseInt(btn.style.minHeight, 10);
      expect(px).toBeGreaterThanOrEqual(44);
    });
  });

  it('Hinweistext nennt /agent-flow:from-notes --sync UND „überschreibt nicht blind"', async () => {
    renderSpecView();
    await waitFor(() => {
      const box = document.querySelector('[data-testid="obsidian-sync-box"]');
      expect(box.textContent).toMatch(/\/agent-flow:from-notes --sync/);
      expect(box.textContent).toMatch(/überschreibt nicht blind/i);
      expect(box.textContent).toMatch(/Widersprüche/i);
    });
  });

  it('Ohne Vault (configured:false) ist der Button deaktiviert + Text-Hinweis', async () => {
    renderSpecView(makeFetchFn({ vaultConfigured: false }));

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="obsidian-sync-btn"]');
      expect(btn.disabled).toBe(true);
      const hint = document.querySelector('[data-testid="obsidian-sync-vault-hint"]');
      expect(hint).toBeTruthy();
      expect(hint.textContent).toMatch(/kein.*vault|einstellungen/i);
    });
  });
});

// ── AC2: Bestätigungsdialog ─────────────────────────────────────────────────────

describe('SpecView — obsidian-sync-trigger AC2: Bestätigungsdialog', () => {
  it('Klick (Session frei, Vault konfiguriert) öffnet Bestätigungsdialog (role="dialog"); noch kein POST', async () => {
    const fetchFn = makeFetchFn();
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });

    const dialog = document.querySelector('[data-testid="obsidian-sync-confirm-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });
});

// ── AC3: Starten/Abbrechen + Ordner-Auswahl (löst A1) ──────────────────────────

describe('SpecView — obsidian-sync-trigger AC3: Starten POSTet genau einmal, Abbrechen nicht', () => {
  it('Abbrechen schließt Dialog ohne POST', async () => {
    const fetchFn = makeFetchFn();
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });
    expect(document.querySelector('[data-testid="obsidian-sync-confirm-dialog"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-no"]'));
    });
    expect(document.querySelector('[data-testid="obsidian-sync-confirm-dialog"]')).toBeNull();
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });

  it('Starten ist ohne Ordner-Auswahl deaktiviert (kein POST möglich)', async () => {
    const fetchFn = makeFetchFn();
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-folder-select"]')).toBeTruthy();
    });

    const startBtn = document.querySelector('[data-testid="obsidian-sync-confirm-yes"]');
    expect(startBtn.disabled).toBe(true);

    await act(async () => {
      fireEvent.click(startBtn);
    });
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });

  it('Starten POSTet genau einmal { command: "/agent-flow:from-notes --sync <path>", projectPath } an /api/command', async () => {
    const fetchFn = makeFetchFn();
    renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      const calls = commandCalls(fetchFn);
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body.command).toBe(`/agent-flow:from-notes --sync ${FAKE_FOLDERS[0].path}`);
      expect(body.projectPath).toBe('my-project');
    });
  });

  it('Leere Vault-Projektordner-Liste → Fehlerhinweis im Dialog, kein POST möglich (Edge-Case A1)', async () => {
    const fetchFn = makeFetchFn({ folders: [] });
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });

    await waitFor(() => {
      const empty = document.querySelector('[data-testid="obsidian-sync-folders-empty"]');
      expect(empty).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="obsidian-sync-folder-select"]')).toBeNull();
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });

  it('Fehler beim Laden der Ordner-Liste → Fehlerhinweis im Dialog, kein POST möglich (Edge-Case A1)', async () => {
    const fetchFn = makeFetchFn({ folders: null });
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="obsidian-sync-folders-error"]');
      expect(err).toBeTruthy();
    });
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });
});

// ── AC5: Busy-Guard ───────────────────────────────────────────────────────────

describe('SpecView — obsidian-sync-trigger AC5: Busy-Guard (Session state:"busy")', () => {
  it('Button ist disabled wenn Session busy', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'busy' }));

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="obsidian-sync-btn"]');
      expect(btn.disabled).toBe(true);
    });
  });

  it('Lock-Hinweis sichtbar wenn Session busy (Text, nicht nur Farbe)', async () => {
    renderSpecView(makeFetchFn({ sessionState: 'busy' }));

    await waitFor(() => {
      const notice = document.querySelector('[data-testid="obsidian-sync-lock-notice"]');
      expect(notice).toBeTruthy();
      expect(notice.textContent).toMatch(/job läuft|gesperrt/i);
    });
  });

  it('Klick auf deaktivierten Button öffnet keinen Dialog, löst keinen POST aus', async () => {
    const fetchFn = makeFetchFn({ sessionState: 'busy' });
    renderSpecView(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-btn"]').disabled).toBe(true);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-btn"]'));
    });

    expect(document.querySelector('[data-testid="obsidian-sync-confirm-dialog"]')).toBeNull();
    expect(commandCalls(fetchFn)).toHaveLength(0);
  });
});

// ── AC6: 202 → onShowArbeiten() (Tab-Wechsel, kein Hash-Navigate) ──────────────

describe('SpecView — obsidian-sync-trigger AC6: 202 → onShowArbeiten()', () => {
  it('202 → onShowArbeiten() wird aufgerufen; Dialog/Fehler-Element verschwindet', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 202 });
    const { onShowArbeitenSpy } = renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(onShowArbeitenSpy).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-testid="obsidian-sync-confirm-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="obsidian-sync-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="obsidian-sync-starting"]')).toBeNull();
  });
});

// ── AC7: 409/400/500/Netzwerkfehler ─────────────────────────────────────────────

describe('SpecView — obsidian-sync-trigger AC7: 409/400/500/Netzwerkfehler → Fehleranzeige mit Reset', () => {
  it('409 → sichtbare Fehleranzeige, onShowArbeiten NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 409 });
    const { onShowArbeitenSpy } = renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="obsidian-sync-error"]');
      expect(err).toBeTruthy();
      expect(err.textContent).toMatch(/läuft bereits/i);
    });
    expect(onShowArbeitenSpy).not.toHaveBeenCalled();
  });

  it('400 → sichtbare Fehleranzeige, onShowArbeiten NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 400 });
    const { onShowArbeitenSpy } = renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-error"]')).toBeTruthy();
    });
    expect(onShowArbeitenSpy).not.toHaveBeenCalled();
  });

  it('500 → sichtbare Fehleranzeige, onShowArbeiten NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ commandStatus: 500 });
    const { onShowArbeitenSpy } = renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-error"]')).toBeTruthy();
    });
    expect(onShowArbeitenSpy).not.toHaveBeenCalled();
  });

  it('Netzwerkfehler → Fehleranzeige mit Reset-Möglichkeit, kein onShowArbeiten, kein Crash', async () => {
    const baseFn = makeFetchFn();
    const fetchFn = jest.fn(async (url, opts) => {
      if (url === '/api/command' && opts?.method === 'POST') {
        throw new Error('network down');
      }
      return baseFn(url, opts);
    });
    const { onShowArbeitenSpy } = renderSpecView(fetchFn);

    await openDialogWithFolder(fetchFn);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-confirm-yes"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="obsidian-sync-error"]')).toBeTruthy();
    });
    expect(onShowArbeitenSpy).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="obsidian-sync-error-reset"]'));
    });
    expect(document.querySelector('[data-testid="obsidian-sync-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="obsidian-sync-btn"]')).toBeTruthy();
  });
});
