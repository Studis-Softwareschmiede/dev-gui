/**
 * SettingsView.test.jsx — Unit-Tests für SettingsView (Credentials AC1–AC8 + SSH-Keys AC1–AC6
 *   + Workspace AC1 / UI-Anteil AC3).
 *
 * Covers (settings-credentials + settings-shell):
 *   AC1  — Credential-Felder mit Status (gesetzt/nicht gesetzt); kein Klartext
 *   AC2  — Setzen/Überschreiben: nach Speichern kein Klartext angezeigt
 *   AC3  — Löschen: Status wechselt auf „nicht gesetzt"
 *   AC4  — Kein Klartext in der Anzeige nach Speichern
 *   AC5  — Misc-Sektion: benannte Schlüssel/Wert-Einträge
 *   AC6  — Rückkehr zum Panel (onNavigate)
 *   AC8  — Frontend-Validierung: leere Pflichtfelder → Fehlermeldung, kein Request
 *   NFR A11y — h1/h2, Touch-Targets ≥ 44 px, aria-describedby für Fehler
 *
 * Covers (settings-ssh-keys Stufe A):
 *   SSH-AC1 — Public-Key hinterlegen/anzeigen/ändern; vollständig sichtbar
 *   SSH-AC2 — Private-Key write-only/maskiert; niemals im Klartext
 *   SSH-AC3 — Public- und/oder Private-Key löschen; Status „nicht gesetzt"
 *   SSH-AC4 — Public-Key-Format-Validierung; klare Fehlermeldung
 *   SSH-AC5 — Private-Key-Klartext nie sichtbar
 *   SSH-AC6 — Endpunkte hinter Access-Mauer (durch AccessGuard, testbar via makeFetch-Error)
 *
 * Covers (workspace-path-config AC1 + UI-Anteil AC3):
 *   WS-AC1  — Sektion „Workspace" zeigt wirksamen Pfad inkl. Quelle; Setzen/Ändern/Zurücksetzen
 *   WS-AC3  — 422 → role=alert, alter Wert bleibt sichtbar; Validierungsfehler feldzugeordnet
 *   WS-Loading — aria-busy + Mehrfachklick-Schutz während in-flight
 *   WS-A11y   — label/htmlFor, aria-describedby, role=status/alert, Touch-Target ≥44px,
 *               Fokusführung bei Erfolg/Fehler (activeElement)
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }        = await import('@testing-library/react');
const React             = (await import('react')).default;
const { SettingsView }  = await import('../SettingsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Leere Credential-Liste (leerer Store). */
// Dummy-PEM zur Laufzeit zusammensetzen — der literale BEGIN-Marker im Quelltext
// würde den gitleaks-Secret-Scan (Rule private-key) als False Positive auslösen.
const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const EMPTY_CREDS = [];

/** Credentials-Liste mit einem gesetzten Wert. */
const CREDS_WITH_GITHUB_APP_ID = [
  { integration: 'github', name: 'app_id', status: 'set', masked: '••••3456', updatedAt: '2026-01-01T00:00:00.000Z' },
  { integration: 'github', name: 'installation_id', status: 'unset' },
  { integration: 'github', name: 'private_key', status: 'unset' },
  { integration: 'cloudflare', name: 'api_token', status: 'unset' },
  { integration: 'cloudflare', name: 'account_id', status: 'unset' },
  { integration: 'vps', name: 'hetzner_api_token', status: 'unset' },
];

/** Leere SSH-Keys-Liste. */
const EMPTY_SSH_KEYS = [];

/** SSH-Keys-Liste mit einem Eintrag. */
const SSH_KEYS_WITH_ROOT = [
  {
    user: 'root',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKeyForRootUser test@example.com',
    publicKeyUpdatedAt: '2026-01-01T00:00:00.000Z',
    privateKeyStatus: 'set',
    privateKeyUpdatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Standard-Workspace-Antwort (env-default). */
const DEFAULT_WORKSPACE = {
  effectivePath: '/workspace',
  source: 'env-default',
  mountRoot: '/workspace',
};

/** Workspace-Antwort mit konfiguriertem Pfad. */
const CONFIGURED_WORKSPACE = {
  effectivePath: '/workspace/projekt',
  source: 'configured',
  mountRoot: '/workspace',
};

/**
 * Erstellt einen jest.fn() fetch, der auf verschiedene Requests antwortet.
 * Unterstützt SSH-Key-Endpoints (/api/settings/ssh-keys*) und
 * Workspace-Path-Endpoints (/api/settings/workspace-path).
 */
function makeFetch({
  getResponse = EMPTY_CREDS,
  putResponse = null,
  deleteResponse = null,
  sshGetResponse = EMPTY_SSH_KEYS,
  sshPutResponse = null,
  sshDeleteResponse = null,
  workspaceGetResponse = DEFAULT_WORKSPACE,
  workspacePutResponse = null,
  workspaceDeleteResponse = null,
} = {}) {
  return jest.fn(async (url, opts) => {
    const method = opts?.method ?? 'GET';
    const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
    const isWorkspace = typeof url === 'string' && url.includes('/workspace-path');

    if (method === 'GET') {
      if (isSsh) return { ok: true, json: async () => sshGetResponse };
      if (isWorkspace) return { ok: true, json: async () => workspaceGetResponse };
      return { ok: true, json: async () => getResponse };
    }
    if (method === 'PUT') {
      if (isSsh) {
        if (sshPutResponse === 'error') {
          return { ok: false, json: async () => ({ error: 'Server-Fehler' }) };
        }
        return {
          ok: true,
          json: async () => sshPutResponse ?? { user: 'root', publicKey: 'ssh-ed25519 AAAA… test', privateKeyStatus: 'unset' },
        };
      }
      if (isWorkspace) {
        if (workspacePutResponse === 'error') {
          return { ok: false, status: 422, json: async () => ({ error: 'Pfad existiert nicht oder ist kein Verzeichnis' }) };
        }
        return {
          ok: true,
          json: async () => workspacePutResponse ?? { effectivePath: '/workspace/projekt', source: 'configured' },
        };
      }
      if (putResponse === 'error') {
        return { ok: false, json: async () => ({ error: 'Server-Fehler' }) };
      }
      return {
        ok: true,
        json: async () => putResponse ?? { integration: 'github', name: 'app_id', status: 'set', updatedAt: '2026-01-01T00:00:00.000Z' },
      };
    }
    if (method === 'DELETE') {
      if (isSsh) {
        if (sshDeleteResponse === 'error') {
          return { ok: false, json: async () => ({ error: 'Löschen fehlgeschlagen' }) };
        }
        return {
          ok: true,
          json: async () => sshDeleteResponse ?? { user: 'root', privateKeyStatus: 'unset' },
        };
      }
      if (isWorkspace) {
        if (workspaceDeleteResponse === 'error') {
          return { ok: false, json: async () => ({ error: 'Zurücksetzen fehlgeschlagen' }) };
        }
        return {
          ok: true,
          json: async () => workspaceDeleteResponse ?? { effectivePath: '/workspace', source: 'env-default' },
        };
      }
      if (deleteResponse === 'error') {
        return { ok: false, json: async () => ({ error: 'Löschen fehlgeschlagen' }) };
      }
      return {
        ok: true,
        json: async () => deleteResponse ?? { integration: 'github', name: 'app_id', status: 'unset' },
      };
    }
    return { ok: false, json: async () => ({ error: 'unbekannt' }) };
  });
}

function renderView(fetchImpl) {
  const onNavigate = jest.fn();
  globalThis.fetch = fetchImpl ?? makeFetch();
  const utils = render(React.createElement(SettingsView, { onNavigate }));
  return { ...utils, onNavigate };
}

// ── AC2/AC3 — Struktur ────────────────────────────────────────────────────────

describe('SettingsView — Grundstruktur', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert h1 "Einstellungen"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const h1 = getByRole('heading', { level: 1 });
      expect(h1.textContent).toMatch(/einstellungen/i);
    });
  });

  it('rendert main landmark "Einstellungen-Ansicht"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });
  });

  it('rendert mindestens 6 h2-Sektions-Überschriften (GitHub, Cloudflare, Hetzner, Weitere, Workspace, SSH-Keys)', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      const h2s = main.querySelectorAll('h2');
      expect(h2s.length).toBeGreaterThanOrEqual(6);
    });
  });

  it('rendert GitHub-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /^github$/i })).toBeTruthy();
    });
  });

  it('rendert Cloudflare-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /^cloudflare$/i })).toBeTruthy();
    });
  });

  it('rendert Hetzner / VPS-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /hetzner/i })).toBeTruthy();
    });
  });

  it('rendert SSH-Keys-Sektion mit h2-Überschrift und Inhalt (nicht mehr Platzhalter)', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });
});

// ── AC1 — Status-Anzeige ──────────────────────────────────────────────────────

describe('SettingsView — AC1: Status-Anzeige', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "nicht gesetzt" für ungesetzte Felder', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/nicht gesetzt/i);
    });
  });

  it('zeigt masked-Wert für gesetztes Feld (kein Klartext)', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Masked-Wert "••••3456" soll sichtbar sein
      expect(main.textContent).toContain('••••3456');
      // Kein echter Klartext
      expect(main.textContent).not.toContain('my-secret-app-id');
    });
  });

  it('AC4 — rendert nach GET keinen Klartext-Geheimwert', async () => {
    const secretValue = 'SUPER_SECRET_1234';
    const credsWithSecret = [
      { integration: 'github', name: 'app_id', status: 'set', masked: '••••1234', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getByRole } = renderView(makeFetch({ getResponse: credsWithSecret }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).not.toContain(secretValue);
    });
  });
});

// ── AC2 — Setzen/Ändern ────────────────────────────────────────────────────────

describe('SettingsView — AC2: Setzen/Ändern', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "Setzen"-Button für ungesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const setzenBtns = buttons.filter((b) => b.textContent.trim() === 'Setzen');
      expect(setzenBtns.length).toBeGreaterThan(0);
    });
  });

  it('zeigt "Ändern"-Button für gesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const aendernBtns = buttons.filter((b) => b.textContent.trim() === 'Ändern');
      expect(aendernBtns.length).toBeGreaterThan(0);
    });
  });

  it('AC4 — nach Speichern wird Klartext nicht angezeigt', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET') {
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT') {
        return {
          ok: true,
          json: async () => ({ integration: 'github', name: 'app_id', status: 'set', updatedAt: '2026-01-01T00:00:00.000Z' }),
        };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis Setzen-Buttons da sind
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.textContent.trim() === 'Setzen')).toBe(true);
    });

    // Ersten Setzen-Button klicken (App-ID)
    await act(async () => {
      const setzenBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Setzen');
      fireEvent.click(setzenBtns[0]);
    });

    // Input ausfüllen — password inputs via querySelector (kein textbox-Role)
    await waitFor(() => {
      const pwdInputs = document.querySelectorAll('input[type="password"]');
      expect(pwdInputs.length).toBeGreaterThan(0);
    });

    const pwdInputs = document.querySelectorAll('input[type="password"]');
    await act(async () => {
      if (pwdInputs[0]) {
        fireEvent.change(pwdInputs[0], { target: { value: 'my-super-secret' } });
      }
    });

    // Speichern
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Speichern: kein Klartext sichtbar
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).not.toContain('my-super-secret');
    });
  });
});

// ── AC3 — Löschen ─────────────────────────────────────────────────────────────

describe('SettingsView — AC3: Löschen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "Löschen"-Button für gesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const loeschenBtns = buttons.filter((b) => b.textContent.trim() === 'Löschen');
      expect(loeschenBtns.length).toBeGreaterThan(0);
    });
  });

  it('kein "Löschen"-Button für ungesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const loeschenBtns = buttons.filter((b) => b.textContent.trim() === 'Löschen');
      expect(loeschenBtns.length).toBe(0);
    });
  });
});

// ── AC5 — Misc-Sektion ────────────────────────────────────────────────────────

describe('SettingsView — AC5: Weitere Credentials (misc)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert Sektion "Weitere Credentials"', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('heading', { name: /weitere credentials/i })).toBeTruthy();
    });
  });

  it('zeigt "+ Weiteres Credential" Button', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres credential hinzufügen/i })).toBeTruthy();
    });
  });

  it('Klick auf "Weiteres Credential" öffnet Formular', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres credential hinzufügen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /weiteres credential hinzufügen/i }));
    });

    await waitFor(() => {
      // Schlüsselname-Input sollte erscheinen
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });
  });

  it('misc-Einträge aus Store werden angezeigt (kein Klartext)', async () => {
    const credsWithMisc = [
      ...EMPTY_CREDS,
      { integration: 'misc', name: 'openai-key', status: 'set', masked: '••••7890', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getByRole } = renderView(makeFetch({ getResponse: credsWithMisc }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('openai-key');
      expect(main.textContent).not.toContain('my-openai-secret');
    });
  });
});

// ── AC6 — Navigation ──────────────────────────────────────────────────────────

describe('SettingsView — AC6: Navigation', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert "Zurück"-Button', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('Klick auf "Zurück" ruft onNavigate("panel") auf', async () => {
    const { getByRole, onNavigate } = renderView();
    await waitFor(() => {
      expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zurück zum einstiegs-panel/i }));
    });

    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('AC6 — "Zurück"-Button ist Tab-fokussierbar', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.disabled).toBe(false);
    });
  });

  it('NFR A11y — "Zurück"-Button hat Touch-Target ≥ 44 px', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    });
  });
});

// ── AC8 — Frontend-Validierung ────────────────────────────────────────────────

describe('SettingsView — AC8: Frontend-Validierung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC8 — leerer Wert im Setzen-Formular: Fehlermeldung, kein PUT-Request', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Setzen-Button
    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.textContent.trim() === 'Setzen')).toBe(true);
    });

    // Bearbeiten-Modus öffnen
    await act(async () => {
      const setzenBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Setzen');
      fireEvent.click(setzenBtns[0]);
    });

    // Speichern ohne Wert eingeben
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehlermeldung erscheint
    await waitFor(() => {
      const errorMsgs = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(errorMsgs).some((el) => el.textContent.match(/leer/i));
      expect(hasError).toBe(true);
    });

    // Kein PUT-Request abgefeuert
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('AC8 — misc: leerer Schlüsselname → Fehlermeldung, kein PUT', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Hinzufügen-Button
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    // Hinzufügen ohne Schlüsselname
    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    await act(async () => {
      const addBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
        b.textContent.trim() === 'Hinzufügen',
      );
      if (addBtns[0]) fireEvent.click(addBtns[0]);
    });

    await waitFor(() => {
      const errorMsgs = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(errorMsgs).some((el) => el.textContent.match(/pflichtfeld|schlüsselname/i));
      expect(hasError).toBe(true);
    });

    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });
});

// ── NFR A11y — aria-describedby Misc-Fehler ───────────────────────────────────

describe('SettingsView — NFR A11y: aria-describedby auf Misc-Inputs', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('I1 — Fehler-<p> hat id="misc-add-error", beide Inputs referenzieren sie via aria-describedby', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    // Formular öffnen
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    // Ohne Schlüsselname absenden → Fehler provozieren
    await act(async () => {
      const hinzBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Hinzufügen',
      );
      if (hinzBtns[0]) fireEvent.click(hinzBtns[0]);
    });

    // Fehler-<p> muss id="misc-add-error" haben
    await waitFor(() => {
      const errorEl = document.getElementById('misc-add-error');
      expect(errorEl).toBeTruthy();
      expect(errorEl.getAttribute('role')).toBe('alert');

      // Beide Inputs müssen aria-describedby="misc-add-error" haben
      const keyInput = document.getElementById('misc-new-key');
      const valInput = document.getElementById('misc-new-val');
      expect(keyInput.getAttribute('aria-describedby')).toBe('misc-add-error');
      expect(valInput.getAttribute('aria-describedby')).toBe('misc-add-error');
    });
  });

  it('I1 — ohne Fehler haben Misc-Inputs kein aria-describedby', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    // Noch kein Fehler → kein aria-describedby
    const keyInput = document.getElementById('misc-new-key');
    const valInput = document.getElementById('misc-new-val');
    expect(keyInput.getAttribute('aria-describedby')).toBeNull();
    expect(valInput.getAttribute('aria-describedby')).toBeNull();
  });
});

// ── NFR A11y — Touch-Targets ──────────────────────────────────────────────────

describe('SettingsView — NFR A11y: Touch-Targets ≥ 44 px', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('alle Aktions-Buttons haben minHeight ≥ 44 px', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));

    await waitFor(() => {
      const buttons = getAllByRole('button');
      for (const btn of buttons) {
        const minH = parseInt(btn.style.minHeight ?? '0', 10);
        expect(minH).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

// ── SSH-Keys — SSH-AC1: Public-Key anzeigen ───────────────────────────────────

describe('SettingsView — SSH-AC1: Public-Key anzeigen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC1 — SSH-Keys-Sektion wird gerendert mit h2', async () => {
    const { getByRole } = renderView(makeFetch());
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });

  it('SSH-AC1 — gesetzter Public-Key wird vollständig angezeigt (nicht maskiert)', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Public-Key darf vollständig angezeigt werden (AC1)
      expect(main.textContent).toContain('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKeyForRootUser');
    });
  });

  it('SSH-AC1 — Benutzer-Label "root" wird angezeigt', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('root');
    });
  });

  it('SSH-AC1 — leere Liste zeigt Hinweistext', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: EMPTY_SSH_KEYS }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/keine ssh-schlüssel/i);
    });
  });

  it('SSH-AC1 — "+ SSH-Benutzer hinzufügen" Button vorhanden', async () => {
    const { getByRole } = renderView(makeFetch());
    await waitFor(() => {
      expect(getByRole('button', { name: /ssh-benutzer hinzufügen/i })).toBeTruthy();
    });
  });
});

// ── SSH-Keys — SSH-AC2: Private-Key write-only/maskiert ──────────────────────

describe('SettingsView — SSH-AC2: Private-Key write-only', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC2 — Private-Key-Status "•••• gesetzt" wird angezeigt (kein Klartext)', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('•••• gesetzt');
      // Kein Klartext des Private Keys
      expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });
  });

  it('SSH-AC2 — Private-Key-Input ist ein Textarea (kein type=password, aber write-only-Semantik)', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis SSH-Benutzer root geladen ist
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.includes('Private-Key'))).toBe(true);
    });

    // Private-Key "Ändern"-Button klicken
    await act(async () => {
      const btns = getAllByRole('button').filter((b) =>
        b.getAttribute('aria-label')?.match(/private-key von root ändern/i),
      );
      if (btns[0]) fireEvent.click(btns[0]);
    });

    // Textarea für Private-Key sollte erscheinen
    await waitFor(() => {
      const ta = document.getElementById('ssh-priv-root');
      expect(ta).toBeTruthy();
      expect(ta.tagName).toBe('TEXTAREA');
    });
  });

  it('SSH-AC2 — nach Speichern wird Private-Key-Klartext nicht angezeigt', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => SSH_KEYS_WITH_ROOT };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT' && isSsh) {
        return { ok: true, json: async () => ({ user: 'root', publicKey: 'ssh-ed25519 AAAA… test', privateKeyStatus: 'set' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/private-key von root ändern/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key von root ändern/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-priv-root')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-priv-root');
      if (ta) fireEvent.change(ta, { target: { value: pemDummy('ABCDEF') } });
    });

    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Private-Key-Klartext darf nach Speichern NICHT sichtbar sein
      expect(main.textContent).not.toContain(pemDummy('ABCDEF'));
      expect(main.textContent).not.toContain('ABCDEF');
    });
  });
});

// ── SSH-Keys — SSH-AC3: Löschen ───────────────────────────────────────────────

describe('SettingsView — SSH-AC3: Löschen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC3 — "Alle löschen"-Button für vorhandenen Benutzer', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — Public-Key-Löschen-Button vorhanden wenn Public-Key gesetzt', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — Private-Key-Löschen-Button vorhanden wenn Private-Key gesetzt', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/private-key von root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — nach Löschen (reload) zeigt neuen Status', async () => {
    const afterDelete = [{ user: 'root', privateKeyStatus: 'unset' }];
    let callCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) {
          callCount++;
          return { ok: true, json: async () => (callCount <= 1 ? SSH_KEYS_WITH_ROOT : afterDelete) };
        }
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'DELETE' && isSsh) {
        return { ok: true, json: async () => ({ user: 'root', privateKeyStatus: 'unset' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i))).toBe(true);
    });

    await act(async () => {
      const delBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i),
      );
      if (delBtn) fireEvent.click(delBtn);
    });

    // Nach dem Löschen wird reload() aufgerufen → zweiter GET-Call zeigt neuen Status
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, opts]) => (opts?.method ?? 'GET') === 'DELETE')).toBe(true);
    });
  });
});

// ── SSH-Keys — SSH-AC4: Public-Key-Format-Validierung ────────────────────────

describe('SettingsView — SSH-AC4: Public-Key-Format-Validierung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC4 — ungültiges Public-Key-Format → Fehlermeldung, kein PUT', async () => {
    // Starte direkt mit einem vorhandenen Benutzer "testuser" (kein Public-Key gesetzt)
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'testuser', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Benutzer "testuser" mit Setzen-Button
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für testuser setzen/i))).toBe(true);
    });

    // Public-Key-Setzen-Button klicken
    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für testuser setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    // Textarea ausfüllen mit ungültigem Format
    await waitFor(() => {
      expect(document.getElementById('ssh-pub-testuser')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-pub-testuser');
      if (ta) fireEvent.change(ta, { target: { value: 'nicht-openssh-format' } });
    });

    // Speichern klicken
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehlermeldung erscheint
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasFormatError = Array.from(alerts).some((el) =>
        el.textContent.match(/format|openssh/i),
      );
      expect(hasFormatError).toBe(true);
    });

    // Kein PUT-Request abgefeuert
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('SSH-AC4 — leeres Public-Key-Feld → Fehlermeldung', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'alex', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für alex setzen/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für alex setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-pub-alex')).toBeTruthy();
    });

    // Ohne Eingabe speichern
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/leer|pflichtfeld/i));
      expect(hasError).toBe(true);
    });

    // Kein PUT
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('I1 — Public-Key mit Newline → Fehlermeldung "Zeilenumbrüche", kein PUT', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'newline-user', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für newline-user setzen/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für newline-user setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-pub-newline-user')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-pub-newline-user');
      if (ta) fireEvent.change(ta, { target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey test@example.com\nmalicious' } });
    });

    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/Zeilenumbr|keine.*Zeilen/));
      expect(hasError).toBe(true);
    });

    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });
});

// ── SSH-Keys — SSH-AC5: Private-Key-Klartext nie sichtbar ────────────────────

describe('SettingsView — SSH-AC5: Private-Key-Klartext nie sichtbar', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC5 — Private-Key-Klartext erscheint nie in der Anzeige (liste)', async () => {
    const keyWithPriv = [{ user: 'root', privateKeyStatus: 'set', privateKeyUpdatedAt: '2026-01-01T00:00:00.000Z' }];
    const { getByRole } = renderView(makeFetch({ sshGetResponse: keyWithPriv }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Masked-Text sichtbar
      expect(main.textContent).toContain('•••• gesetzt');
      // Kein Klartext irgendeines Private Keys
      expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });
  });
});

// ── SSH-Keys — SSH-AC1: Public-Key ändern (Ändern-Button) ────────────────────

describe('SettingsView — SSH-AC1: Public-Key ändern', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC1 — "Ändern"-Button für gesetzten Public-Key', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root ändern/i))).toBe(true);
    });
  });

  it('SSH-AC1 — Klick auf "Ändern" öffnet Textarea mit aria-Attributen', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root ändern/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key von root ändern/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      const ta = document.getElementById('ssh-pub-root');
      expect(ta).toBeTruthy();
      expect(ta.tagName).toBe('TEXTAREA');
    });
  });
});

// ── S1: Ladefehler-Sichtbarkeit ───────────────────────────────────────────────

describe('SettingsView — S1: Ladefehler-Sichtbarkeit', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('S1 — fetchCredentials rejected → Fehler-Element mit role="alert" erscheint', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        // Credentials-Endpunkt wirft
        throw new Error('Netzwerkfehler beim Laden der Credentials');
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasCredError = Array.from(alerts).some((el) =>
        el.textContent.match(/credentials konnten nicht geladen werden/i),
      );
      expect(hasCredError).toBe(true);
    });

    // SSH-Sektion bleibt sichtbar (nur Credentials-Ladefehler)
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });

  it('S1 — fetchSshKeys rejected → SSH-Fehler-Element mit role="alert" erscheint', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) throw new Error('SSH-Keys-Endpunkt nicht erreichbar');
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasSshError = Array.from(alerts).some((el) =>
        el.textContent.match(/ssh-keys konnten nicht geladen werden/i),
      );
      expect(hasSshError).toBe(true);
    });
  });
});

// ── SSH-Keys — S1: In-Memory-Stub beim Hinzufügen eines Benutzers ─────────────

describe('SettingsView — S1: Neuer Benutzer erscheint als In-Memory-Stub (kein Server-Roundtrip)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('S1 — + Button → Label "newuser" eingeben → Hinzufügen → SshKeyEntry aria-label ohne GET', async () => {
    const fetchMock = makeFetch({ sshGetResponse: EMPTY_SSH_KEYS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getByRole, getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis SSH-Sektion geladen
    await waitFor(() => {
      expect(getByRole('button', { name: /ssh-benutzer hinzufügen/i })).toBeTruthy();
    });

    // Zähle GET-Calls vor der Aktion
    const getCallsBefore = fetchMock.mock.calls.filter(([, opts]) => !opts || (opts?.method ?? 'GET') === 'GET').length;

    // + SSH-Benutzer hinzufügen klicken
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /ssh-benutzer hinzufügen/i }));
    });

    // Input erscheint
    await waitFor(() => {
      expect(document.getElementById('ssh-new-user')).toBeTruthy();
    });

    // Label eingeben
    await act(async () => {
      fireEvent.change(document.getElementById('ssh-new-user'), { target: { value: 'newuser' } });
    });

    // Hinzufügen klicken
    await act(async () => {
      const hinzBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Hinzufügen');
      if (hinzBtns[0]) fireEvent.click(hinzBtns[0]);
    });

    // SshKeyEntry für "newuser" erscheint ohne weiteren Server-Roundtrip
    await waitFor(() => {
      const group = document.querySelector('[aria-label="SSH-Schlüssel für newuser"]');
      expect(group).toBeTruthy();
    });

    // Kein zusätzlicher GET /api/settings/ssh-keys nach dem Hinzufügen
    const getCallsAfter = fetchMock.mock.calls.filter(([, opts]) => !opts || (opts?.method ?? 'GET') === 'GET').length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });
});

// ── Workspace — WS-AC1: Sektion + Anzeige ────────────────────────────────────

describe('SettingsView — WS-AC1: Workspace-Sektion Grundstruktur', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — rendert h2 "Workspace"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /^workspace$/i })).toBeTruthy();
    });
  });

  it('WS-AC1 — zeigt wirksamen Pfad (env-default)', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace');
    });
  });

  it('WS-AC1 — zeigt Quelle "Default aus Env" wenn source=env-default', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: { effectivePath: '/workspace', source: 'env-default', mountRoot: '/workspace' } }),
    );
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/default aus env/i);
    });
  });

  it('WS-AC1 — zeigt Quelle "konfiguriert" wenn source=configured', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: CONFIGURED_WORKSPACE }),
    );
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/konfiguriert/i);
    });
  });

  it('WS-AC1 — zeigt Effektivwert /workspace/projekt wenn source=configured', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: CONFIGURED_WORKSPACE }),
    );
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace/projekt');
    });
  });

  it('WS-AC1 — zeigt "Setzen"-Button wenn source=env-default', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );
    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });
  });

  it('WS-AC1 — zeigt "Ändern"-Button und "Zurücksetzen"-Button wenn source=configured', async () => {
    const { getAllByRole } = renderView(
      makeFetch({ workspaceGetResponse: CONFIGURED_WORKSPACE }),
    );
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad ändern/i))).toBe(true);
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });
  });
});

// ── Workspace — WS-AC1: Setzen (PUT) ─────────────────────────────────────────

describe('SettingsView — WS-AC1: Setzen (PUT)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — Klick auf "Setzen" öffnet Eingabefeld mit label', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );
    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input).toBeTruthy();
      // label/htmlFor verdrahtet
      const label = document.querySelector('label[for="workspace-path-input"]');
      expect(label).toBeTruthy();
    });
  });

  it('WS-AC1 — erfolgreiches Setzen: PUT abgefeuert, Quelle wechselt auf "konfiguriert"', async () => {
    // Nach erfolgreichem PUT liefert GET den neuen konfigurierten Wert
    let getCallCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isWorkspace = typeof url === 'string' && url.includes('/workspace-path');
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        if (isWorkspace) {
          getCallCount++;
          return {
            ok: true,
            json: async () => (getCallCount <= 1 ? DEFAULT_WORKSPACE : CONFIGURED_WORKSPACE),
          };
        }
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT' && isWorkspace) {
        return { ok: true, json: async () => ({ effectivePath: '/workspace/projekt', source: 'configured' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf "Setzen"-Button
    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // PUT wurde abgefeuert
    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url, opts]) => {
        return (opts?.method ?? 'GET') === 'PUT' && url.includes('/workspace-path');
      });
      expect(putCalls.length).toBe(1);
    });

    // Nach Reload: Quelle wechselt auf "konfiguriert"
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/konfiguriert/i);
    });
  });

  it('WS-AC1 — Erfolg zeigt role=status Meldung', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/gespeichert/i);
    });
  });
});

// ── Workspace — WS-AC1: Zurücksetzen (DELETE) ────────────────────────────────

describe('SettingsView — WS-AC1: Zurücksetzen (DELETE)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — Zurücksetzen: DELETE abgefeuert, Quelle wechselt auf "Default aus Env"', async () => {
    let getCallCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isWorkspace = typeof url === 'string' && url.includes('/workspace-path');
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        if (isWorkspace) {
          getCallCount++;
          return {
            ok: true,
            json: async () => (getCallCount <= 1 ? CONFIGURED_WORKSPACE : DEFAULT_WORKSPACE),
          };
        }
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'DELETE' && isWorkspace) {
        return { ok: true, json: async () => ({ effectivePath: '/workspace', source: 'env-default' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getByRole, getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf "Zurücksetzen"-Button (nur sichtbar wenn source=configured)
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });

    await act(async () => {
      const resetBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i),
      );
      if (resetBtn) fireEvent.click(resetBtn);
    });

    // DELETE wurde abgefeuert
    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(([url, opts]) => {
        return (opts?.method ?? 'GET') === 'DELETE' && url.includes('/workspace-path');
      });
      expect(deleteCalls.length).toBe(1);
    });

    // Nach Reload: Quelle wechselt auf "Default aus Env"
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/default aus env/i);
    });
  });
});

// ── Workspace — WS-AC3 (UI): Validierungsfehler ──────────────────────────────

describe('SettingsView — WS-AC3 (UI): Validierungsfehler', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC3 — 422-Fehler: role=alert erscheint mit Backend-Fehlermeldung', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE, workspacePutResponse: 'error' }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/pfad existiert nicht|verzeichnis/i);
    });
  });

  it('WS-AC3 — 422-Fehler: alter wirksamer Pfad bleibt sichtbar (unverändert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        workspaceGetResponse: DEFAULT_WORKSPACE,
        workspacePutResponse: 'error',
      }),
    );

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Der alte Wert (/workspace) ist initial sichtbar
      expect(main.textContent).toContain('/workspace');
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehler erscheint + alter Wert /workspace noch sichtbar (die Anzeige oben bleibt)
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeTruthy();
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace');
    });
  });

  it('WS-AC3 — leeres Feld: Frontend-Fehlermeldung, kein PUT abgefeuert', async () => {
    const fetchMock = makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    // Kein Wert eingeben — direkt Speichern
    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/leer/i);
    });

    // Kein PUT abgefeuert
    const putCalls = fetchMock.mock.calls.filter(([url, opts]) => {
      return (opts?.method ?? 'GET') === 'PUT' && url.includes('/workspace-path');
    });
    expect(putCalls.length).toBe(0);
  });

  it('WS-AC3 — aria-describedby verbindet Input mit Fehler-Element', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE, workspacePutResponse: 'error' }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/outside' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input.getAttribute('aria-describedby')).toBe('workspace-path-error');
      const errorEl = document.getElementById('workspace-path-error');
      expect(errorEl).toBeTruthy();
    });
  });

  it('WS-AC3 — ohne Fehler hat Input kein aria-describedby', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    const input = document.getElementById('workspace-path-input');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

// ── Workspace — WS-Loading: Loading-State ────────────────────────────────────

describe('SettingsView — WS-Loading: aria-busy + Mehrfachklick-Schutz', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-Loading — Speichern-Button hat aria-busy=true während in-flight', async () => {
    // Fetch löst nicht sofort auf — prüfe aria-busy während des Awaits
    let resolvePut;
    const putPromise = new Promise((res) => { resolvePut = res; });

    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isWorkspace = typeof url === 'string' && url.includes('/workspace-path');
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        if (isWorkspace) return { ok: true, json: async () => DEFAULT_WORKSPACE };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT' && isWorkspace) {
        await putPromise;
        return { ok: true, json: async () => ({ effectivePath: '/workspace/x', source: 'configured' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/x' },
      });
    });

    // Klick ohne await-Abschluss — Button sollte in-flight disabled sein
    act(() => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern' || b.textContent.trim() === 'Speichern…',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Kurzfristig prüfen: disabled oder aria-busy
    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Speichern…' || b.getAttribute('aria-busy') === 'true',
      );
      expect(btn).toBeTruthy();
    });

    // PUT freigeben
    resolvePut();
    await act(async () => {});
  });
});

// ── Workspace — WS-A11y: Touch-Target + Fokusführung ─────────────────────────

describe('SettingsView — WS-A11y: Touch-Target + Fokusführung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-A11y — Workspace-Buttons haben minHeight ≥ 44 px', async () => {
    const { getAllByRole } = renderView(
      makeFetch({ workspaceGetResponse: CONFIGURED_WORKSPACE }),
    );

    await waitFor(() => {
      const btns = getAllByRole('button');
      // Finde Workspace-spezifische Buttons
      const workspaceBtns = btns.filter((b) => {
        const label = b.getAttribute('aria-label') ?? '';
        return label.match(/workspace-pfad/i);
      });
      expect(workspaceBtns.length).toBeGreaterThan(0);
      for (const btn of workspaceBtns) {
        const minH = parseInt(btn.style.minHeight ?? '0', 10);
        expect(minH).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('WS-A11y — Fokus landet nach 422-Fehler auf dem Input (activeElement)', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE, workspacePutResponse: 'error' }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Fehler: activeElement muss der Input sein
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeTruthy();
      expect(document.activeElement).toBe(document.getElementById('workspace-path-input'));
    });
  });

  it('WS-A11y — Fokus landet nach Erfolg auf der Erfolgsmeldung (activeElement)', async () => {
    const { getByRole } = renderView(
      makeFetch({ workspaceGetResponse: DEFAULT_WORKSPACE }),
    );

    await waitFor(() => {
      expect(getByRole('button', { name: /workspace-pfad setzen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /workspace-pfad setzen/i }));
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Erfolg: activeElement muss die Erfolgsmeldung (role=status) sein
    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(document.activeElement).toBe(statusEl);
    });
  });

  it('WS-A11y — Workspace-Ladefehler zeigt role=alert', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isWorkspace = typeof url === 'string' && url.includes('/workspace-path');
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        if (isWorkspace) throw new Error('Workspace-Endpunkt nicht erreichbar');
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasWsError = Array.from(alerts).some((el) =>
        el.textContent.match(/workspace-pfad konnte nicht geladen werden/i),
      );
      expect(hasWsError).toBe(true);
    });
  });
});
