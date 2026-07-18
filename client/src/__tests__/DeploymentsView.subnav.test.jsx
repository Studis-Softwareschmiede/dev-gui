/**
 * DeploymentsView.subnav.test.jsx
 *
 * Covers (deployments-gpg-subview.md): AC1, AC2, AC8 (F-087/S-374)
 *   AC1 — Beim Öffnen des Deployments-Bereichs erscheint links ein Untermenü mit
 *         genau zwei Einträgen „Deployment" und „GPG-Schlüssel"; „Deployment" ist
 *         beim Öffnen die Standard-Auswahl und aktiv (rechts die bestehende
 *         Deployment-Ansicht). Umschalten wechselt den Inhalt ohne Voll-Reload;
 *         aktiver Eintrag per aria-current erkennbar.
 *   AC2 — Die beiden bisherigen GPG-Sektionen („GPG-Passphrasen (Bitwarden)" /
 *         „GPG-Passphrasen-Rotation") erscheinen nicht mehr in der
 *         „Deployment"-Ansicht; das gpgBwItem-Feld im „Neues Deployment"-
 *         Formular bleibt unverändert vorhanden.
 *   AC8 — A11y: Untermenü ist ein <nav>-Landmark (kein role=tablist/tab, s.
 *         docs/design.md „Bereichs-Untermenü" §0); jeder Eintrag ein natives
 *         <button> (normaler Tab-Stopp, kein Roving-Tabindex); aktiver Eintrag
 *         hat aria-current="page"; Content-Region ist programmatisch mit dem
 *         aktiven Eintrag verknüpft (aria-labelledby). Touch-Target ≥ 44px und
 *         Fokus-Ring leben als CSS-Klasse `.subnav-item` in client/index.html —
 *         nicht per jsdom prüfbar (kein Stylesheet geladen); visuell/per
 *         Quellcode-Review verifiziert (client/index.html `.subnav-item`
 *         min-height: 44px, `.subnav-item:focus-visible` Outline).
 *
 * Hinweis: ein zusätzlicher Test prüft, dass die "GPG-Schlüssel"-Ansicht in
 * dieser Story nur einen Platzhalter-Erklärungstext zeigt (kein Dropdown/keine
 * Aktionen) — AC3–AC7 (App-Auswahl, Provisionieren, Rotieren) sind NICHT Teil
 * dieser Story (Folge-Stories S-375/S-376) und werden hier bewusst NICHT getestet.
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

/** Fetch-Stub mit konfigurierbaren packages (sonst leere Dropdown-Quellen). */
function makeFetch({ packages = [{ name: 'brew-assistent' }] } = {}) {
  return jest.fn(async (url) => {
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
    if (u.includes('/api/deployments')) {
      return { ok: true, status: 200, json: async () => ({ deployments: [], errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function subnavItem(container, slug) {
  return container.querySelector(`[data-testid="subnav-item-${slug}"]`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeploymentsView — Bereichs-Untermenü Deployment/GPG-Schlüssel (F-087/S-374)', () => {
  it('AC1: rendert genau zwei Untermenü-Einträge; "Deployment" ist Standard-Auswahl (aria-current)', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => {
      expect(subnavItem(container, 'deployment')).toBeTruthy();
      expect(subnavItem(container, 'gpg')).toBeTruthy();
    });

    const nav = container.querySelector('[data-testid="subnav"]');
    expect(nav).toBeTruthy();
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Deployments-Unterbereiche');

    expect(container.querySelectorAll('[data-testid^="subnav-item-"]').length).toBe(2);
    expect(subnavItem(container, 'deployment').textContent).toBe('Deployment');
    expect(subnavItem(container, 'gpg').textContent).toBe('GPG-Schlüssel');

    expect(subnavItem(container, 'deployment').getAttribute('aria-current')).toBe('page');
    expect(subnavItem(container, 'gpg').getAttribute('aria-current')).toBeNull();
  });

  it('AC1/AC8: kein role=tablist/tab (bewusste Abgrenzung zur Settings-Nav) — echte <button>-Elemente', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => expect(subnavItem(container, 'deployment')).toBeTruthy());

    expect(container.querySelector('[data-testid="subnav"]').getAttribute('role')).toBeNull();
    expect(subnavItem(container, 'deployment').tagName).toBe('BUTTON');
    expect(subnavItem(container, 'deployment').getAttribute('role')).toBeNull();
    expect(subnavItem(container, 'deployment').getAttribute('type')).toBe('button');
  });

  it('AC1: Klick auf "GPG-Schlüssel" wechselt Inhalt + aria-current, ohne Voll-Reload (kein onNavigate-Aufruf)', async () => {
    globalThis.fetch = makeFetch();
    const { container, onNavigate } = renderView();

    await waitFor(() => expect(subnavItem(container, 'gpg')).toBeTruthy());
    // Deployment-Inhalt initial sichtbar (Mode-Umschalter ist Deployment-exklusiv)
    expect(container.querySelector('[aria-label="Deployment-Modus wählen"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(subnavItem(container, 'gpg'));
    });

    expect(subnavItem(container, 'gpg').getAttribute('aria-current')).toBe('page');
    expect(subnavItem(container, 'deployment').getAttribute('aria-current')).toBeNull();
    expect(container.querySelector('[aria-label="GPG-Schlüssel"]')).toBeTruthy();
    // Deployment-Inhalt ist unmounted (genau eine Unteransicht gleichzeitig, D8)
    expect(container.querySelector('[aria-label="Deployment-Modus wählen"]')).toBeFalsy();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('AC1: Zurück-Wechsel zu "Deployment" zeigt den Deployment-Inhalt wieder', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => expect(subnavItem(container, 'gpg')).toBeTruthy());
    await act(async () => { fireEvent.click(subnavItem(container, 'gpg')); });
    await act(async () => { fireEvent.click(subnavItem(container, 'deployment')); });

    expect(subnavItem(container, 'deployment').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[aria-label="Deployment-Modus wählen"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="GPG-Schlüssel"]')).toBeFalsy();
  });

  it('AC8: Content-Region ist programmatisch mit dem aktiven Untermenü-Eintrag verknüpft (aria-labelledby)', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => expect(subnavItem(container, 'deployment')).toBeTruthy());
    const content = container.querySelector('[data-testid="subnav-content"]');
    expect(content.getAttribute('aria-labelledby')).toBe('subnav-deployment');
    expect(content.getAttribute('tabindex')).toBe('-1');

    await act(async () => { fireEvent.click(subnavItem(container, 'gpg')); });
    expect(content.getAttribute('aria-labelledby')).toBe('subnav-gpg');
  });

  it('AC2: "Deployment"-Ansicht enthält keine der beiden bisherigen GPG-Sektionen mehr', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => expect(subnavItem(container, 'deployment')).toBeTruthy());
    expect(container.querySelector('[aria-label="GPG-Passphrasen provisionieren"]')).toBeFalsy();
    expect(container.querySelector('[aria-label="GPG-Passphrasen-Rotation"]')).toBeFalsy();
    expect(container.textContent).not.toContain('GPG-Passphrasen (Bitwarden)');
    expect(container.textContent).not.toContain('GPG-Passphrasen-Rotation');
  });

  it('AC2: das gpgBwItem-Feld ("Neues Deployment"-Formular) bleibt unverändert vorhanden', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => {
      expect(container.querySelector('#deploy-gpg-bw-item')).toBeTruthy();
    });
    expect(container.querySelector('label[for="deploy-gpg-bw-item"]').textContent).toBe('GPG-Bitwarden-Item');
  });

  it('AC3 (Platzhalter, Nicht-Ziel dieser Story): "GPG-Schlüssel"-Ansicht zeigt einen Erklärungstext ohne Dropdown/Aktionen', async () => {
    globalThis.fetch = makeFetch();
    const { container } = renderView();

    await waitFor(() => expect(subnavItem(container, 'gpg')).toBeTruthy());
    await act(async () => { fireEvent.click(subnavItem(container, 'gpg')); });

    const section = container.querySelector('[aria-label="GPG-Schlüssel"]');
    expect(section).toBeTruthy();
    expect(section.textContent).toMatch(/Passphrase.*Bitwarden/i);
    // Kein Dropdown/keine Aktionen in dieser Story (S-375/S-376 folgen)
    expect(section.querySelector('select')).toBeFalsy();
    expect(section.querySelector('button')).toBeFalsy();
  });
});
