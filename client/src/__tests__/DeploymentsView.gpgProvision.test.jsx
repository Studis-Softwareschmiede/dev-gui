/**
 * DeploymentsView.gpgProvision.test.jsx
 *
 * Covers (per-app-gpg-passphrase-provisioning): AC7, AC8
 *   AC7 — Knopf je App ("GPG-Passphrase in Bitwarden anlegen") ruft POST
 *         /api/deployments/:app/gpg-provision auf; `already-exists` wird als
 *         No-Op sichtbar quittiert (kein Überschreiben-Hinweis, keine Fehlermeldung).
 *   AC8 — Rückmeldung geheimnisfrei: nur `created`|`already-exists`|
 *         `access-not-ready`|`failed` (+ Klartext-Hinweis) werden gerendert;
 *         kein Passphrasen-Wert taucht im gerenderten DOM/Response-Handling auf
 *         (auch nicht, wenn die Response ausnahmsweise ein Fremdfeld enthielte).
 *   NFR A11y (unit-testbar) — Label/aria-label pro Knopf, role="alert"/
 *         aria-live für die Quittung, Touch-Target ≥ 44px (btnSecondary
 *         minHeight), aria-busy + disabled während des Requests (Loading-State).
 *   Styling-Semantik (Review-Fix Iteration 2) — die Erfolg/Fehler-Farbe der
 *         Quittungszeile wird aus dem `result`-Wert abgeleitet (nicht nur aus
 *         `errorMsg`): auch eine 200-Antwort mit `result: "failed"` bzw.
 *         `"access-not-ready"` rendert Fehler-Styling, nie Erfolgs-Styling.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { DeploymentsView } = await import('../DeploymentsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderView(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(DeploymentsView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

function gpgButton(container, app) {
  return container.querySelector(`[aria-label="GPG-Passphrase für ${app} in Bitwarden anlegen"]`);
}

/**
 * Fetch-Stub: dropdown-Quellen (mit konfigurierbaren packages) + konfigurierbare
 * Antwort auf POST /api/deployments/:app/gpg-provision.
 *
 * @param {{ packages?: Array<{name:string}>, gpgProvisionFn?: (app: string) => object }} opts
 */
function makeGpgProvisionFetch({
  packages = [{ name: 'brew-assistent', fullImageRef: 'ghcr.io/org/brew-assistent' }],
  gpgProvisionFn,
} = {}) {
  return jest.fn(async (url, init) => {
    const u = String(url);

    const gpgMatch = u.match(/^\/api\/deployments\/([^/]+)\/gpg-provision$/);
    if (gpgMatch && init?.method === 'POST') {
      const app = decodeURIComponent(gpgMatch[1]);
      if (gpgProvisionFn) return gpgProvisionFn(app);
      return { ok: true, status: 200, json: async () => ({ result: 'created' }) };
    }

    if (u.includes('/api/github/packages') && !u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ packages }) };
    }
    if (u.includes('/api/github/packages') && u.includes('/tags')) {
      return { ok: true, status: 200, json: async () => ({ tags: [] }) };
    }
    if (u.includes('/api/deployments/vps-targets')) {
      return { ok: true, status: 200, json: async () => ({ vpsIds: [], tunnelIds: {} }) };
    }
    if (u.includes('/api/deployments/vps-tunnel-status')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.includes('/api/cloudflare/zones')) {
      return { ok: true, status: 200, json: async () => ({ configured: false, zones: [] }) };
    }
    if (u.includes('/api/deployments')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeploymentsView — GPG-Passphrasen-Provisionierung je App (F-073/S-337 AC7/AC8)', () => {
  it('AC7: rendert je in /api/github/packages gelisteter App einen Knopf "GPG-Passphrase in Bitwarden anlegen"', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      packages: [{ name: 'brew-assistent' }, { name: 'zweite-app' }],
    });
    const { container } = renderView();

    await waitFor(() => {
      expect(gpgButton(container, 'brew-assistent')).toBeTruthy();
      expect(gpgButton(container, 'zweite-app')).toBeTruthy();
    });
  });

  it('AC7: Klick löst POST /api/deployments/:app/gpg-provision aus und zeigt "created" als Erfolg', async () => {
    const fetchMock = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({ ok: true, status: 200, json: async () => ({ result: 'created' }) }),
    });
    globalThis.fetch = fetchMock;
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Angelegt — GPG-Passphrase wurde in Bitwarden hinterlegt.');
    });

    const call = fetchMock.mock.calls.find(([u, init]) =>
      String(u) === '/api/deployments/brew-assistent/gpg-provision' && init?.method === 'POST',
    );
    expect(call).toBeTruthy();
  });

  it('AC7: "already-exists" wird als No-Op sichtbar quittiert (kein Fehler-Styling)', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'already-exists', reason: 'Bitwarden-Item „env.gpg-passphrase-brew-assistent" existiert bereits — unverändert.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      const status = container.querySelector('[role="alert"]');
      expect(status).toBeTruthy();
      expect(status.textContent).toMatch(/existiert bereits/);
      // Review-Fix: "already-exists" ist Erfolgs-Styling (Grün), kein Fehler.
      expect(status.style.color).toBe('rgb(134, 239, 172)');
    });
  });

  it('Review-Fix: "failed" bei 200-Antwort rendert Fehler-Styling (nie Erfolgs-Grün)', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'failed', reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      const status = container.querySelector('[role="alert"]');
      expect(status).toBeTruthy();
      expect(status.textContent).toMatch(/fehlgeschlagen/);
      expect(status.style.color).toBe('rgb(252, 165, 165)');
    });
  });

  it('Review-Fix: "access-not-ready" bei 200-Antwort rendert Fehler-Styling (nie Erfolgs-Grün)', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'access-not-ready', reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      const status = container.querySelector('[role="alert"]');
      expect(status).toBeTruthy();
      expect(status.textContent).toMatch(/Deploy-Zugang/);
      expect(status.style.color).toBe('rgb(252, 165, 165)');
    });
  });

  it('AC8: "access-not-ready" zeigt Klartext-Hinweis, kein Passphrasen-Wert im DOM', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'access-not-ready', reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.');
    });
  });

  it('AC8: enthält die Response ausnahmsweise ein zusätzliches Secret-Feld, landet dessen Wert NIE im DOM (nur result/reason werden übernommen)', async () => {
    const FAKE_SECRET = 'xJ9k2q7ZpL8vN3wR5tY1uB6cD0eF4gH-nicht-anzeigen';
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'created', passphrase: FAKE_SECRET, reason: 'Angelegt.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Angelegt — GPG-Passphrase wurde in Bitwarden hinterlegt.');
    });
    expect(container.textContent).not.toContain(FAKE_SECRET);
  });

  it('AC8: 403 (ohne Berechtigung) zeigt Fehlermeldung, kein Crash', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Keine Berechtigung für diese Aktion' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Keine Berechtigung für diese Aktion');
    });
  });

  it('AC8/failed: sanitisierter reason wird angezeigt', async () => {
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'failed', reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(gpgButton(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.');
    });
  });

  it('NFR A11y: Knopf ist während des Requests disabled + aria-busy (Loading-State)', async () => {
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    globalThis.fetch = makeGpgProvisionFetch({
      gpgProvisionFn: () => pending.then(() => ({ ok: true, status: 200, json: async () => ({ result: 'created' }) })),
    });
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    fireEvent.click(gpgButton(container, 'brew-assistent'));

    await waitFor(() => {
      const btn = gpgButton(container, 'brew-assistent');
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-busy')).toBe('true');
    });

    await act(async () => {
      resolveFetch();
      await pending;
    });
  });

  it('NFR A11y: Touch-Target ≥ 44px (minHeight des Knopfs)', async () => {
    globalThis.fetch = makeGpgProvisionFetch();
    const { container } = renderView();

    await waitFor(() => expect(gpgButton(container, 'brew-assistent')).toBeTruthy());
    const btn = gpgButton(container, 'brew-assistent');
    expect(btn.style.minHeight).toBe('44px');
  });

  it('kein Provisionierungs-Abschnitt ohne geladene Apps (packages leer)', async () => {
    globalThis.fetch = makeGpgProvisionFetch({ packages: [] });
    const { container } = renderView();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="GPG-Passphrasen provisionieren"]')).toBeFalsy();
    });
  });
});
