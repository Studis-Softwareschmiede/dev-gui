/**
 * DeploymentsView.gpgKeysSubview.test.jsx
 *
 * Covers (deployments-gpg-subview.md): AC3, AC4, AC5, AC7 (F-087/S-375)
 *   AC3 — Die "GPG-Schlüssel"-Ansicht zeigt eine kurze Erklärung, ein Dropdown
 *         zur App-Auswahl (genau eine App wählbar) und die Aktion "Passphrase
 *         anlegen", bezogen auf die im Dropdown gewählte App. ("Rotieren",
 *         AC6, ist NICHT Teil dieser Story — S-376.)
 *   AC4 — "Passphrase anlegen" ruft für die gewählte App
 *         POST /api/deployments/:app/gpg-provision auf und quittiert
 *         geheimnisfrei (created|already-exists|access-not-ready|failed).
 *   AC5 — Der Knopf ist nur aktiv bei GET .../gpg-exists → exists:false; bei
 *         exists:true deaktiviert mit Hinweis; bei App-Wechsel wird die
 *         Existenz neu ermittelt; access-not-ready/Fehler lässt den Knopf
 *         bedienbar (konservativer Fallback).
 *   AC7 — Kein Passphrasen-Wert erscheint je in UI-State/DOM, auch wenn die
 *         Response ein zusätzliches Feld mit einem Secret-artigen Wert enthält.
 *
 * A11y-Aspekte (AC8) werden hier mitgeprüft (Label-Verknüpfung, role="alert"/
 * "status", aria-live, aria-describedby) — kein separates Fokus-/Touch-Target-
 * Rendering-Assert (jsdom lädt kein Stylesheet, s. DeploymentsView.subnav.test.jsx).
 *
 * Edge-Cases: leere App-Liste (neutraler Hinweis, Select/Aktion deaktiviert);
 * App-Wechsel während laufender Existenz-Abfrage verwirft die veraltete Antwort.
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
 * konfigurierte Ergebnis der beiden GPG-Endpunkte.
 */
function makeFetch({ packages = [{ name: 'brew-assistent' }, { name: 'zweite-app' }], existsByApp = {}, provisionByApp = {} } = {}) {
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
    if (u.includes('/api/deployments')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
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
