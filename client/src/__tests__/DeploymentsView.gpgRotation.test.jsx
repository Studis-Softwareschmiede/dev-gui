/**
 * DeploymentsView.gpgRotation.test.jsx
 *
 * Covers (per-app-gpg-passphrase-rotation.md): AC8, AC9
 *   AC8 — Die UI löst die Rotation über eine zweistufige Quittung aus (Stufe 1
 *         "Kandidat + Beweis-Runde" via POST .../gpg-rotate/start, Stufe 2
 *         "umgeschaltet" via POST .../gpg-rotate/commit). Stufe 2 ist erst nach
 *         grüner Stufe 1 aufrufbar. Bleibt eine Stufe aus/fehlerhaft, erscheint
 *         eine stufen-genaue, geheimnisfreie Warnung statt grüner Quittung.
 *   AC9 — Der Rollback-Anker-Aufräum-Knopf (POST .../gpg-rotate/discard-previous)
 *         ist eine getrennte, explizit bestätigte Aktion (nicht Teil der
 *         Rotations-Stufen) und ist deaktiviert/mit Warnung versehen, solange
 *         kein Deploy mit der neuen Passphrase bestätigt wurde (Checkbox) UND
 *         kein type-to-confirm-Match (App-Name) vorliegt.
 *   NFR A11y (unit-testbar) — Labels/aria-label, role="alert"/aria-live für
 *         jede Quittung, Touch-Target ≥ 44px, aria-busy während Requests.
 *   Security-Floor — kein Passphrasen-/Secret-Wert taucht im DOM auf, auch
 *         nicht bei einem (hypothetischen) Fremdfeld in der Response.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor, within } from '@testing-library/react';

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

// Hinweis: jsdoms CSS-Selector-Engine (nwsapi) hat einen bekannten Parser-Bug bei
// `+` innerhalb geklammerter Attribut-Werte in `querySelector` (reiner Test-Tooling-
// Defekt, kein Produktivcode-Fehler — live gegen ein Minimal-jsdom-Fixture
// verifiziert). Daher hier `getByRole`(accessible-name-Matching) statt
// CSS-Attribut-Selektoren für die Button-Locators.
function stage1Button(container, app) {
  return within(container).queryByRole('button', {
    name: `Rotation für ${app}: Stufe 1 starten (Kandidat + Beweis-Runde)`,
  });
}
function stage2Button(container, app) {
  return within(container).queryByRole('button', { name: `Rotation für ${app}: Stufe 2 umschalten` });
}
function discardButton(container, app) {
  return within(container).queryByRole('button', { name: `Rollback-Anker für ${app} entsorgen` });
}
function deployConfirmCheckbox(container, app) {
  return container.querySelector(`#gpg-discard-deploy-confirmed-${app}`);
}
function discardConfirmInput(container, app) {
  return container.querySelector(`#gpg-discard-confirm-${app}`);
}

/**
 * Fetch-Stub: dropdown-Quellen (mit konfigurierbaren packages) + konfigurierbare
 * Antworten für die drei Rotations-Endpunkte.
 *
 * @param {{ packages?: Array<{name:string}>, startFn?: (app:string)=>object,
 *           commitFn?: (app:string)=>object, discardFn?: (app:string)=>object }} opts
 */
function makeGpgRotationFetch({
  packages = [{ name: 'brew-assistent' }],
  startFn,
  commitFn,
  discardFn,
} = {}) {
  return jest.fn(async (url, init) => {
    const u = String(url);

    const startMatch = u.match(/^\/api\/deployments\/([^/]+)\/gpg-rotate\/start$/);
    if (startMatch && init?.method === 'POST') {
      const app = decodeURIComponent(startMatch[1]);
      if (startFn) return startFn(app);
      return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) };
    }

    const commitMatch = u.match(/^\/api\/deployments\/([^/]+)\/gpg-rotate\/commit$/);
    if (commitMatch && init?.method === 'POST') {
      const app = decodeURIComponent(commitMatch[1]);
      if (commitFn) return commitFn(app);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }

    const discardMatch = u.match(/^\/api\/deployments\/([^/]+)\/gpg-rotate\/discard-previous$/);
    if (discardMatch && init?.method === 'POST') {
      const app = decodeURIComponent(discardMatch[1]);
      if (discardFn) return discardFn(app);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
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

describe('DeploymentsView — Per-App-GPG-Passphrase-Rotation (F-073/S-339 AC8/AC9)', () => {
  it('AC8: rendert je in /api/github/packages gelisteter App Stufe-1- und Stufe-2-Knöpfe; Stufe 2 initial disabled', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      packages: [{ name: 'brew-assistent' }, { name: 'zweite-app' }],
    });
    const { container } = renderView();

    await waitFor(() => {
      expect(stage1Button(container, 'brew-assistent')).toBeTruthy();
      expect(stage1Button(container, 'zweite-app')).toBeTruthy();
    });
    expect(stage2Button(container, 'brew-assistent').disabled).toBe(true);
  });

  it('AC8: Stufe 1 erfolgreich → grüne Quittung + Stufe 2 wird aufrufbar', async () => {
    const fetchMock = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
    });
    globalThis.fetch = fetchMock;
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(stage1Button(container, 'brew-assistent'));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Kandidat erzeugt, Beweis-Runde erfolgreich');
    });
    expect(stage2Button(container, 'brew-assistent').disabled).toBe(false);

    const call = fetchMock.mock.calls.find(([u, init]) =>
      String(u) === '/api/deployments/brew-assistent/gpg-rotate/start' && init?.method === 'POST',
    );
    expect(call).toBeTruthy();
  });

  it('AC8: Stufe 1 fehlgeschlagen (verify-failed) → stufen-genaue Warnung statt grüner Quittung, Stufe 2 bleibt disabled', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, phase: 'aborted', errorClass: 'verify-failed' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => {
      fireEvent.click(stage1Button(container, 'brew-assistent'));
    });

    await waitFor(() => {
      const alerts = container.querySelectorAll('[role="alert"]');
      const warn = Array.from(alerts).find((el) => el.textContent.includes('Stufe 1 fehlgeschlagen'));
      expect(warn).toBeTruthy();
      expect(warn.textContent).toMatch(/Beweis-Runde: Vergleich/);
      // Warn-Styling (Amber), nicht Erfolgs-Grün
      expect(warn.querySelector('p').style.color).toBe('rgb(252, 211, 77)');
    });
    expect(stage2Button(container, 'brew-assistent').disabled).toBe(true);
  });

  it('AC8: Stufe 2 erfolgreich → grüne Quittung "umgeschaltet"; Rollback-Anker-Block wird freigeschaltet', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));

    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('umgeschaltet — neue Passphrase ist aktiv');
    });
    // Rollback-Anker-Block ist jetzt sichtbar (Checkbox existiert)
    expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeTruthy();
  });

  it('AC8: Stufe 2 fehlgeschlagen (push-failed) → stufen-genaue Warnung, Rollback-Anker-Block bleibt gesperrt', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: false, errorClass: 'push-failed' }) }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));

    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('Stufe 2 fehlgeschlagen');
      expect(container.textContent).toMatch(/Bitwarden wurde zurückgerollt/);
    });
    expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeFalsy();
    expect(container.textContent).toContain('Erst verfügbar, nachdem Stufe 2 (Umschalten) für brew-assistent erfolgreich war.');
  });

  it('AC9: Rollback-Anker-Aufräum-Knopf bleibt disabled ohne Deploy-Bestätigung + ohne type-to-confirm-Match', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));
    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });
    await waitFor(() => expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeTruthy());

    // Ohne Checkbox + ohne Text: disabled
    expect(discardButton(container, 'brew-assistent').disabled).toBe(true);

    // Checkbox gesetzt, aber Text falsch: weiterhin disabled
    await act(async () => {
      fireEvent.click(deployConfirmCheckbox(container, 'brew-assistent'));
    });
    await act(async () => {
      fireEvent.change(discardConfirmInput(container, 'brew-assistent'), { target: { value: 'falscher-name' } });
    });
    expect(discardButton(container, 'brew-assistent').disabled).toBe(true);

    // Exakter App-Name: jetzt enabled
    await act(async () => {
      fireEvent.change(discardConfirmInput(container, 'brew-assistent'), { target: { value: 'brew-assistent' } });
    });
    expect(discardButton(container, 'brew-assistent').disabled).toBe(false);
  });

  it('AC9: Klick auf freigeschalteten Aufräum-Knopf ruft POST .../gpg-rotate/discard-previous auf und quittiert grün', async () => {
    const fetchMock = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      discardFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    });
    globalThis.fetch = fetchMock;
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));
    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });
    await waitFor(() => expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeTruthy());

    await act(async () => { fireEvent.click(deployConfirmCheckbox(container, 'brew-assistent')); });
    await act(async () => {
      fireEvent.change(discardConfirmInput(container, 'brew-assistent'), { target: { value: 'brew-assistent' } });
    });
    await waitFor(() => expect(discardButton(container, 'brew-assistent').disabled).toBe(false));

    await act(async () => { fireEvent.click(discardButton(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('Rollback-Anker entsorgt.');
    });
    const call = fetchMock.mock.calls.find(([u, init]) =>
      String(u) === '/api/deployments/brew-assistent/gpg-rotate/discard-previous' && init?.method === 'POST',
    );
    expect(call).toBeTruthy();

    // Nach erfolgreichem Entsorgen wird die Freischaltung wieder zurückgesetzt (kein zweiter Anker mehr).
    await waitFor(() => {
      expect(container.textContent).toContain('Erst verfügbar, nachdem Stufe 2 (Umschalten) für brew-assistent erfolgreich war.');
    });
  });

  it('AC9: Entsorgen fehlgeschlagen (bw-update-failed) → Fehler-Quittung, Freischaltung bleibt erhalten', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      discardFn: () => ({ ok: true, status: 200, json: async () => ({ ok: false, errorClass: 'bw-update-failed' }) }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));
    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });
    await waitFor(() => expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(deployConfirmCheckbox(container, 'brew-assistent')); });
    await act(async () => {
      fireEvent.change(discardConfirmInput(container, 'brew-assistent'), { target: { value: 'brew-assistent' } });
    });
    await waitFor(() => expect(discardButton(container, 'brew-assistent').disabled).toBe(false));

    await act(async () => { fireEvent.click(discardButton(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('Entsorgen fehlgeschlagen');
      expect(container.textContent).toMatch(/Bitwarden-Item ließ sich nicht aktualisieren/);
    });
    // Weiterhin freigeschaltet (kein Reset bei Fehler) — Checkbox bleibt sichtbar+bestätigt
    expect(deployConfirmCheckbox(container, 'brew-assistent').checked).toBe(true);
  });

  it('Security-Floor: enthält eine Response ausnahmsweise ein Fremdfeld, landet dessen Wert NIE im DOM', async () => {
    const FAKE_SECRET = 'TESTWERT-secret-darf-nie-im-dom-erscheinen';
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, phase: 'candidate-proved', naechste: FAKE_SECRET }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('Kandidat erzeugt, Beweis-Runde erfolgreich');
    });
    expect(container.textContent).not.toContain(FAKE_SECRET);
  });

  it('AC8: 403 (ohne Berechtigung) bei Stufe 1 zeigt Fehlermeldung, kein Crash', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Keine Berechtigung für diese Aktion' }),
      }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });

    await waitFor(() => {
      expect(container.textContent).toContain('Stufe 1 fehlgeschlagen');
    });
  });

  it('NFR A11y: Stufe-1-Knopf ist während des Requests disabled + aria-busy (Loading-State)', async () => {
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => pending.then(() => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) })),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    fireEvent.click(stage1Button(container, 'brew-assistent'));

    await waitFor(() => {
      const btn = stage1Button(container, 'brew-assistent');
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-busy')).toBe('true');
    });

    await act(async () => {
      resolveFetch();
      await pending;
    });
  });

  it('NFR A11y: Touch-Targets ≥ 44px (Stufe 1/2- und Aufräum-Knopf)', async () => {
    globalThis.fetch = makeGpgRotationFetch({
      startFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true, phase: 'candidate-proved' }) }),
      commitFn: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    });
    const { container } = renderView();

    await waitFor(() => expect(stage1Button(container, 'brew-assistent')).toBeTruthy());
    expect(stage1Button(container, 'brew-assistent').style.minHeight).toBe('44px');
    expect(stage2Button(container, 'brew-assistent').style.minHeight).toBe('44px');

    await act(async () => { fireEvent.click(stage1Button(container, 'brew-assistent')); });
    await waitFor(() => expect(stage2Button(container, 'brew-assistent').disabled).toBe(false));
    await act(async () => { fireEvent.click(stage2Button(container, 'brew-assistent')); });
    await waitFor(() => expect(deployConfirmCheckbox(container, 'brew-assistent')).toBeTruthy());

    expect(discardButton(container, 'brew-assistent').style.minHeight).toBe('44px');
  });

  it('kein Rotations-Abschnitt ohne geladene Apps (packages leer)', async () => {
    globalThis.fetch = makeGpgRotationFetch({ packages: [] });
    const { container } = renderView();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="GPG-Passphrasen-Rotation"]')).toBeFalsy();
    });
  });
});
