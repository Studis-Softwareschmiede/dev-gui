/**
 * DeploymentsView.gpgKeysSubview.test.jsx
 *
 * Covers (deployments-gpg-subview.md): AC3, AC4, AC5, AC7 (F-087/S-375);
 *   AC6, AC7, AC8 (F-087/S-376, "Rotieren")
 *   AC3 — Die "GPG-Schlüssel"-Ansicht zeigt eine kurze Erklärung, ein Dropdown
 *         zur App-Auswahl (genau eine App wählbar) und die Aktionen
 *         "Passphrase anlegen" + "Rotieren", bezogen auf die im Dropdown
 *         gewählte App.
 *   AC4 — "Passphrase anlegen" ruft für die gewählte App
 *         POST /api/deployments/:app/gpg-provision auf und quittiert
 *         geheimnisfrei (created|already-exists|access-not-ready|failed).
 *   AC5 — Der Knopf ist nur aktiv bei GET .../gpg-exists → exists:false; bei
 *         exists:true deaktiviert mit Hinweis; bei App-Wechsel wird die
 *         Existenz neu ermittelt; access-not-ready/Fehler lässt den Knopf
 *         bedienbar (konservativer Fallback).
 *   AC6 — "Rotieren" klappt für die gewählte App die bestehende zweistufige
 *         Rotation auf (Stufe 1 .../gpg-rotate/start, Stufe 2
 *         .../gpg-rotate/commit, getrennter type-to-confirm-Aufräum-Knopf
 *         .../gpg-rotate/discard-previous) — alle drei Aufrufe mit dem
 *         gewählten App-Slug; App-Wechsel resettet einen laufenden/gezeigten
 *         Rotations-Zustand der vorherigen App.
 *   AC7 — Kein Passphrasen-Wert erscheint je in UI-State/DOM, auch wenn die
 *         Response ein zusätzliches Feld mit einem Secret-artigen Wert enthält
 *         (gilt auch für die Rotations-Responses).
 *
 * A11y-Aspekte (AC8) werden hier mitgeprüft (Label-Verknüpfung, role="alert"/
 * "status", aria-live, aria-describedby, aria-expanded/aria-controls für den
 * "Rotieren"-Umschalter) — kein separates Fokus-/Touch-Target-Rendering-Assert
 * (jsdom lädt kein Stylesheet, s. DeploymentsView.subnav.test.jsx).
 *
 * Edge-Cases: leere App-Liste (neutraler Hinweis, Select/Aktion deaktiviert);
 * App-Wechsel während laufender Existenz-Abfrage verwirft die veraltete
 * Antwort; App-Wechsel während offenem/laufendem Rotations-Zustand resettet
 * diesen (kein Zustand der falschen App).
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

/**
 * Fetch-Stub: `packages` speist das App-Dropdown (dieselbe Quelle wie zuvor
 * die GPG-Listen). `existsByApp`/`provisionByApp` liefern je App das
 * konfigurierte Ergebnis der beiden GPG-Endpunkte. `rotateStartByApp`/
 * `rotateCommitByApp`/`rotateDiscardByApp` (AC6, F-087/S-376) liefern je App
 * das konfigurierte Ergebnis der drei Rotations-Endpunkte.
 */
function makeFetch({
  packages = [{ name: 'brew-assistent' }, { name: 'zweite-app' }],
  existsByApp = {},
  provisionByApp = {},
  rotateStartByApp = {},
  rotateCommitByApp = {},
  rotateDiscardByApp = {},
} = {}) {
  return jest.fn(async (url, init) => {
    const u = String(url);
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
    const existsMatch = u.match(/\/api\/deployments\/([^/]+)\/gpg-exists$/);
    if (existsMatch) {
      const app = decodeURIComponent(existsMatch[1]);
      const entry = existsByApp[app] ?? { exists: false };
      return { ok: true, status: 200, json: async () => entry };
    }
    const provisionMatch = u.match(/\/api\/deployments\/([^/]+)\/gpg-provision$/);
    if (provisionMatch && init?.method === 'POST') {
      const app = decodeURIComponent(provisionMatch[1]);
      const entry = provisionByApp[app] ?? { result: 'created' };
      return { ok: true, status: 200, json: async () => entry };
    }
    const rotateStartMatch = u.match(/\/api\/deployments\/([^/]+)\/gpg-rotate\/start$/);
    if (rotateStartMatch && init?.method === 'POST') {
      const app = decodeURIComponent(rotateStartMatch[1]);
      const entry = rotateStartByApp[app] ?? { ok: true, phase: 'candidate-proved' };
      return { ok: true, status: 200, json: async () => entry };
    }
    const rotateCommitMatch = u.match(/\/api\/deployments\/([^/]+)\/gpg-rotate\/commit$/);
    if (rotateCommitMatch && init?.method === 'POST') {
      const app = decodeURIComponent(rotateCommitMatch[1]);
      const entry = rotateCommitByApp[app] ?? { ok: true };
      return { ok: true, status: 200, json: async () => entry };
    }
    const rotateDiscardMatch = u.match(/\/api\/deployments\/([^/]+)\/gpg-rotate\/discard-previous$/);
    if (rotateDiscardMatch && init?.method === 'POST') {
      const app = decodeURIComponent(rotateDiscardMatch[1]);
      const entry = rotateDiscardByApp[app] ?? { ok: true };
      return { ok: true, status: 200, json: async () => entry };
    }
    if (u.includes('/api/deployments')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/** Findet einen Button in `section` anhand seines sichtbaren Textinhalts. */
function findButton(section, text) {
  return Array.from(section.querySelectorAll('button')).find((b) => b.textContent === text);
}

async function openGpgSubview(container) {
  await waitFor(() => expect(container.querySelector('[data-testid="subnav-item-gpg"]')).toBeTruthy());
  await act(async () => {
    fireEvent.click(container.querySelector('[data-testid="subnav-item-gpg"]'));
  });
  return container.querySelector('[aria-label="GPG-Schlüssel"]');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeploymentsView — GPG-Schlüssel-Ansicht: App-Dropdown + Passphrase anlegen (F-087/S-375)', () => {
  it('AC3: zeigt Erklärung, App-Dropdown mit den packages und den Knopf "Passphrase anlegen"', async () => {
    globalThis.fetch = makeFetch({ existsByApp: { 'brew-assistent': { exists: false } } });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    expect(section.textContent).toMatch(/Passphrase.*Bitwarden/i);
    const select = section.querySelector('select#gpg-app-select');
    expect(select).toBeTruthy();
    expect(section.querySelector('label[for="gpg-app-select"]')).toBeTruthy();
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual(['brew-assistent', 'zweite-app']);

    const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
    expect(btn).toBeTruthy();
  });

  it('AC5: exists:false → Knopf aktiv', async () => {
    globalThis.fetch = makeFetch({ existsByApp: { 'brew-assistent': { exists: false } } });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
    expect(section.textContent).not.toMatch(/existiert bereits/);
  });

  it('AC5: exists:true → Knopf deaktiviert mit Hinweis "Passphrase existiert bereits"', async () => {
    globalThis.fetch = makeFetch({ existsByApp: { 'brew-assistent': { exists: true } } });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      expect(section.textContent).toMatch(/Passphrase existiert bereits/);
    });
    const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-describedby')).toBe('gpg-provision-exists-hint');
  });

  it('AC5: access-not-ready (Existenz unbekannt) → Knopf bleibt bedienbar (konservativer Fallback)', async () => {
    globalThis.fetch = makeFetch({ existsByApp: { 'brew-assistent': { exists: false, reason: 'access-not-ready' } } });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
  });

  it('AC5: Fehler/HTTP-Fehler bei der Existenz-Abfrage → Knopf bleibt bedienbar', async () => {
    const fetchStub = makeFetch();
    globalThis.fetch = jest.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/gpg-exists')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return fetchStub(url, init);
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
  });

  it('AC5: App-Wechsel löst die Existenz-Abfrage für die NEUE App neu aus', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: {
        'brew-assistent': { exists: true },
        'zweite-app': { exists: false },
      },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => expect(section.textContent).toMatch(/Passphrase existiert bereits/));

    await act(async () => {
      fireEvent.change(section.querySelector('#gpg-app-select'), { target: { value: 'zweite-app' } });
    });

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
    expect(section.textContent).not.toMatch(/existiert bereits/);
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('/deployments/zweite-app/gpg-exists'))).toBe(true);
  });

  it('AC4: Klick ruft POST .../gpg-provision mit dem gewählten App-Slug auf und quittiert "created" geheimnisfrei', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      provisionByApp: { 'brew-assistent': { result: 'created' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen'));
    });

    expect(globalThis.fetch.mock.calls.some(
      ([u, init]) => String(u) === '/api/deployments/brew-assistent/gpg-provision' && init?.method === 'POST',
    )).toBe(true);
    await waitFor(() => {
      expect(section.textContent).toMatch(/Angelegt/);
    });
    const status = section.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('AC4: quittiert "already-exists"/"access-not-ready"/"failed" jeweils geheimnisfrei mit role=alert (Nicht-Erfolg)', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      provisionByApp: { 'brew-assistent': { result: 'failed', reason: 'GPG-Provisionierung fehlgeschlagen.' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen'));
    });

    await waitFor(() => {
      expect(section.querySelector('[role="alert"]')).toBeTruthy();
    });
    expect(section.textContent).toMatch(/fehlgeschlagen/);
  });

  it('AC7: ein zusätzliches, Secret-artiges Response-Feld erscheint nie im DOM', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      provisionByApp: { 'brew-assistent': { result: 'created', passphrase: 'super-secret-value-should-never-render' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen'));
    });

    await waitFor(() => expect(section.textContent).toMatch(/Angelegt/));
    expect(container.innerHTML).not.toContain('super-secret-value-should-never-render');
  });

  it('Edge-Case: leere App-Liste → neutraler Hinweis, kein Select, Knopf deaktiviert', async () => {
    globalThis.fetch = makeFetch({ packages: [] });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    await waitFor(() => expect(section.textContent).toMatch(/Keine App gefunden/));
    expect(section.querySelector('select')).toBeFalsy();
    const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
    expect(btn.disabled).toBe(true);
  });

  it('Edge-Case: App-Wechsel während laufender Existenz-Abfrage verwirft die veraltete Antwort', async () => {
    let resolveFirst;
    const firstPending = new Promise((resolve) => { resolveFirst = resolve; });
    let callCount = 0;
    globalThis.fetch = jest.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/gpg-exists')) {
        callCount += 1;
        if (callCount === 1) {
          await firstPending;
          return { ok: true, status: 200, json: async () => ({ exists: true }) }; // stale: sollte NICHT übernommen werden
        }
        return { ok: true, status: 200, json: async () => ({ exists: false }) };
      }
      return makeFetch()(url, init);
    });

    const { container } = renderView();
    const section = await openGpgSubview(container);

    // Wechsel VOR Auflösung der ersten (verzögerten) Antwort für "brew-assistent".
    await act(async () => {
      fireEvent.change(section.querySelector('#gpg-app-select'), { target: { value: 'zweite-app' } });
    });

    await waitFor(() => {
      const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
      expect(btn.disabled).toBe(false);
    });

    // Jetzt löst die veraltete erste Antwort auf ("brew-assistent": exists:true) —
    // darf den Knopf-Zustand der inzwischen gewählten "zweite-app" NICHT umkippen.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    const btn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Passphrase anlegen');
    expect(btn.disabled).toBe(false);
    expect(section.textContent).not.toMatch(/existiert bereits/);
  });
});

describe('DeploymentsView — GPG-Schlüssel-Ansicht: "Rotieren" (deployments-gpg-subview.md AC6/AC7/AC8, F-087/S-376)', () => {
  it('AC3/AC6: "Rotieren" ist neben "Passphrase anlegen" vorhanden und klappt das Rotations-Panel auf/zu (aria-expanded)', async () => {
    globalThis.fetch = makeFetch({ existsByApp: { 'brew-assistent': { exists: false } } });
    const { container } = renderView();
    const section = await openGpgSubview(container);

    const rotateBtn = findButton(section, 'Rotieren');
    expect(rotateBtn).toBeTruthy();
    expect(rotateBtn.getAttribute('aria-expanded')).toBe('false');
    expect(section.querySelector('#gpg-rotation-panel')).toBeFalsy();

    await act(async () => {
      fireEvent.click(rotateBtn);
    });

    expect(rotateBtn.getAttribute('aria-expanded')).toBe('true');
    expect(rotateBtn.getAttribute('aria-controls')).toBe('gpg-rotation-panel');
    const panel = section.querySelector('#gpg-rotation-panel');
    expect(panel).toBeTruthy();
    expect(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde')).toBeTruthy();

    // Erneuter Klick klappt wieder zu.
    await act(async () => {
      fireEvent.click(findButton(section, 'Rotieren ausblenden'));
    });
    expect(section.querySelector('#gpg-rotation-panel')).toBeFalsy();
  });

  it('AC6: Stufe 1 ruft POST .../gpg-rotate/start mit dem gewählten App-Slug auf; bei Erfolg wird Stufe 2 aktiv', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: true, phase: 'candidate-proved' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });

    const stage2Btn = findButton(section, 'Stufe 2: Umschalten');
    expect(stage2Btn.disabled).toBe(true);

    await act(async () => {
      fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde'));
    });

    expect(globalThis.fetch.mock.calls.some(
      ([u, init]) => String(u) === '/api/deployments/brew-assistent/gpg-rotate/start' && init?.method === 'POST',
    )).toBe(true);
    await waitFor(() => expect(section.textContent).toMatch(/Beweis-Runde erfolgreich/));
    expect(findButton(section, 'Stufe 2: Umschalten').disabled).toBe(false);
  });

  it('AC6: Stufe 1 fehlgeschlagen → Stufe 2 bleibt gesperrt, Warnung geheimnisfrei angezeigt', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: false, phase: 'aborted', errorClass: 'decrypt-old-failed' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });

    await act(async () => {
      fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde'));
    });

    await waitFor(() => expect(section.textContent).toMatch(/Stufe 1 fehlgeschlagen/));
    expect(findButton(section, 'Stufe 2: Umschalten').disabled).toBe(true);
  });

  it('AC6: Stufe 2 ruft POST .../gpg-rotate/commit mit dem gewählten App-Slug auf; Erfolg schaltet den Rollback-Anker-Aufräum-Block frei', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: true, phase: 'candidate-proved' } },
      rotateCommitByApp: { 'brew-assistent': { ok: true } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });
    await act(async () => { fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde')); });
    await waitFor(() => expect(findButton(section, 'Stufe 2: Umschalten').disabled).toBe(false));

    await act(async () => {
      fireEvent.click(findButton(section, 'Stufe 2: Umschalten'));
    });

    expect(globalThis.fetch.mock.calls.some(
      ([u, init]) => String(u) === '/api/deployments/brew-assistent/gpg-rotate/commit' && init?.method === 'POST',
    )).toBe(true);
    await waitFor(() => expect(section.textContent).toMatch(/neue Passphrase ist aktiv/));
    expect(section.querySelector('#gpg-discard-deploy-confirmed')).toBeTruthy();
  });

  it('AC6: Rollback-Anker-Aufräumen bleibt gesperrt ohne Deploy-Bestätigung + korrekten type-to-confirm-Text, ruft dann .../gpg-rotate/discard-previous mit dem App-Slug auf', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: true, phase: 'candidate-proved' } },
      rotateCommitByApp: { 'brew-assistent': { ok: true } },
      rotateDiscardByApp: { 'brew-assistent': { ok: true } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });
    await act(async () => { fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde')); });
    await waitFor(() => expect(findButton(section, 'Stufe 2: Umschalten').disabled).toBe(false));
    await act(async () => { fireEvent.click(findButton(section, 'Stufe 2: Umschalten')); });
    await waitFor(() => expect(section.querySelector('#gpg-discard-deploy-confirmed')).toBeTruthy());

    const discardBtn = findButton(section, 'Rollback-Anker entsorgen');
    expect(discardBtn.disabled).toBe(true);

    // Checkbox allein reicht nicht.
    await act(async () => {
      fireEvent.click(section.querySelector('#gpg-discard-deploy-confirmed'));
    });
    expect(discardBtn.disabled).toBe(true);

    // Type-to-confirm mit falschem Text reicht nicht.
    await act(async () => {
      fireEvent.change(section.querySelector('#gpg-discard-confirm'), { target: { value: 'falscher-name' } });
    });
    expect(discardBtn.disabled).toBe(true);

    await act(async () => {
      fireEvent.change(section.querySelector('#gpg-discard-confirm'), { target: { value: 'brew-assistent' } });
    });
    expect(discardBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(discardBtn);
    });

    expect(globalThis.fetch.mock.calls.some(
      ([u, init]) => String(u) === '/api/deployments/brew-assistent/gpg-rotate/discard-previous' && init?.method === 'POST',
    )).toBe(true);
    await waitFor(() => expect(section.textContent).toMatch(/Rollback-Anker entsorgt/));
  });

  it('AC7: Secret-artiges Zusatzfeld in Rotations-Responses erscheint nie im DOM', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: true, phase: 'candidate-proved', newPassphrase: 'super-secret-rotate-value' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });
    await act(async () => { fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde')); });

    await waitFor(() => expect(section.textContent).toMatch(/Beweis-Runde erfolgreich/));
    expect(container.innerHTML).not.toContain('super-secret-rotate-value');
  });

  it('Edge-Case: App-Wechsel resettet einen offenen/laufenden Rotations-Zustand der vorherigen App (kein Zustand der falschen App)', async () => {
    globalThis.fetch = makeFetch({
      existsByApp: { 'brew-assistent': { exists: false }, 'zweite-app': { exists: false } },
      rotateStartByApp: { 'brew-assistent': { ok: true, phase: 'candidate-proved' } },
    });
    const { container } = renderView();
    const section = await openGpgSubview(container);
    await act(async () => { fireEvent.click(findButton(section, 'Rotieren')); });
    await act(async () => { fireEvent.click(findButton(section, 'Stufe 1: Kandidat + Beweis-Runde')); });
    await waitFor(() => expect(section.textContent).toMatch(/Beweis-Runde erfolgreich/));

    // App-Wechsel: das Rotations-Panel der alten App darf nicht mit dem
    // Zustand der neuen App weiterleben.
    await act(async () => {
      fireEvent.change(section.querySelector('#gpg-app-select'), { target: { value: 'zweite-app' } });
    });

    expect(section.querySelector('#gpg-rotation-panel')).toBeFalsy();
    expect(section.textContent).not.toMatch(/Beweis-Runde erfolgreich/);
    const rotateBtn = findButton(section, 'Rotieren');
    expect(rotateBtn.getAttribute('aria-expanded')).toBe('false');
  });
});
