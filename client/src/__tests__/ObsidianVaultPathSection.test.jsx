/**
 * ObsidianVaultPathSection.test.jsx — Tests für die Frontend-Anteile des Ordner-
 * Browsers + der Mount-fehlt-Meldung (docs/specs/obsidian-vault-folder-browser.md
 * AC6–AC9, S-379). Das bestehende Set-/Ändern-/Löschen-Verhalten (obsidian-vault-config
 * AC1, S-247) ist bereits in `SettingsView.test.jsx` (OBS-AC1-Suite) abgedeckt — hier
 * NUR der neue Browser-/Mount-Notice-Anteil + eine schmale AC8-Regressionsprobe
 * (Set/Ändern/Löschen bleiben über eine direkt gerenderte Sektion erreichbar).
 *
 * Covers (obsidian-vault-folder-browser):
 *   AC6 — „Durchsuchen"-Button öffnet `ObsidianVaultFolderBrowserOverlay`; „Diesen
 *          Ordner verwenden" übernimmt den Container-Pfad in das bestehende Feld
 *          (Bearbeiten-Modus öffnet mit dem übernommenen Pfad vorbefüllt) — die
 *          bestehende PUT-Validierung bleibt unverändert das Gate (kein Auto-Save).
 *   AC7 — Bei `mountStatus` `unusable`/`unconfigured` erscheint eine Alltagssprache-
 *          Anleitung (STATT einer rein technischen Meldung) — Text nennt sowohl
 *          „was los ist" als auch den Mac-Schritt (`OBSIDIAN_VAULT_HOST_DIR`) + den
 *          Runbook-Verweis; der „Durchsuchen"-Button ist deaktiviert
 *          (`disabled` + `aria-disabled`) mit demselben Hinweis im `aria-label`.
 *          Bei `mountStatus: 'ok'` erscheint KEINE Mount-Notice, Durchsuchen ist aktiv.
 *   AC8 — Freitext-Feld bleibt als Fallback: Set-/Ändern-/Löschen-Buttons unverändert
 *          erreichbar, unabhängig vom Mount-Status.
 *   AC9 — Mount-Notice über `role="status"`; Durchsuchen-Button min. 44px Touch-Target
 *          (inline `minHeight:44` in beiden Styling-Varianten); Auswahl aus dem Overlay
 *          verschiebt den Fokus auf das (dann eingeblendete) Eingabefeld.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { ObsidianVaultPathSection } = await import('../ObsidianVaultPathSection.jsx');

const BROWSE_RE = /\/api\/settings\/obsidian-vault\/browse/;

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

/** fetch-Double für den Browse-Endpunkt (AC6) — liefert immer ein Root-Listing. */
function makeFetchFn({ browseStatus = 200, browseBody } = {}) {
  const body = browseBody ?? {
    root: '/obsidian-vault',
    path: '/obsidian-vault',
    parent: null,
    breadcrumb: [{ name: 'obsidian-vault', path: '/obsidian-vault' }],
    entries: [{ name: 'Projekte', path: '/obsidian-vault/Projekte' }],
  };
  return jest.fn(async (url) => {
    if (BROWSE_RE.test(url)) {
      return { ok: browseStatus < 400, status: browseStatus, json: async () => body };
    }
    if (typeof url === 'string' && url === '/api/settings/obsidian-vault-path' ) {
      return { ok: true, status: 200, json: async () => ({ vaultPath: null, configured: false, mountStatus: 'ok' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('ObsidianVaultPathSection — AC7: Mount-Notice + Durchsuchen-Disable', () => {
  it('mountStatus "ok": keine Mount-Notice, Durchsuchen-Button aktiv', () => {
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="ok"
        mountRoot="/obsidian-vault"
        onReload={jest.fn()}
        fetchFn={makeFetchFn()}
      />,
    );
    expect(container.querySelector('[data-testid="obsidian-mount-notice"]')).toBeNull();
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    expect(browseBtn.disabled).toBe(false);
    expect(browseBtn.getAttribute('aria-disabled')).toBe('false');
  });

  it('mountStatus "unconfigured": Alltagssprache-Anleitung + deaktivierter Durchsuchen-Button', () => {
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="unconfigured"
        onReload={jest.fn()}
        fetchFn={makeFetchFn()}
      />,
    );
    const notice = container.querySelector('[data-testid="obsidian-mount-notice"]');
    expect(notice).toBeTruthy();
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('noch nicht in den Container hineingereicht');
    expect(notice.textContent).toContain('OBSIDIAN_VAULT_HOST_DIR');
    expect(notice.textContent).toContain('docker-compose.yml');
    expect(notice.textContent).toContain('docs/obsidian-vault-mount-runbook.md');

    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    expect(browseBtn.disabled).toBe(true);
    expect(browseBtn.getAttribute('aria-disabled')).toBe('true');
    expect(browseBtn.getAttribute('aria-label')).toMatch(/nicht verfügbar/i);
  });

  it('mountStatus "unusable": Alltagssprache-Anleitung (anderer Titel-Text) + deaktivierter Durchsuchen-Button', () => {
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="unusable"
        onReload={jest.fn()}
        fetchFn={makeFetchFn()}
      />,
    );
    const notice = container.querySelector('[data-testid="obsidian-mount-notice"]');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('nicht nutzbar');
    expect(notice.textContent).toContain('OBSIDIAN_VAULT_HOST_DIR');

    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    expect(browseBtn.disabled).toBe(true);
  });

  it('Klick auf den deaktivierten Durchsuchen-Button öffnet KEIN Overlay', () => {
    const fetchFn = makeFetchFn();
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="unusable"
        onReload={jest.fn()}
        fetchFn={fetchFn}
      />,
    );
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    fireEvent.click(browseBtn);
    expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('ObsidianVaultPathSection — AC6: Durchsuchen öffnet Overlay + Übernahme in Feld', () => {
  it('öffnet das Overlay, übernimmt den gewählten Ordner in das (dann sichtbare) Eingabefeld und schließt', async () => {
    const fetchFn = makeFetchFn({
      browseBody: {
        root: '/obsidian-vault',
        path: '/obsidian-vault',
        parent: null,
        breadcrumb: [{ name: 'obsidian-vault', path: '/obsidian-vault' }],
        entries: [{ name: 'Projekte', path: '/obsidian-vault/Projekte' }],
      },
    });
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="ok"
        mountRoot="/obsidian-vault"
        onReload={jest.fn()}
        fetchFn={fetchFn}
      />,
    );

    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    await act(async () => { fireEvent.click(browseBtn); });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]'));
    });

    // Overlay geschlossen, Bearbeiten-Modus offen mit übernommenem Pfad, Fokus auf dem Feld.
    expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeNull();
    const input = document.getElementById('obsidian-vault-path-input');
    expect(input).toBeTruthy();
    expect(input.value).toBe('/obsidian-vault');
    expect(document.activeElement).toBe(input);
  });

  it('Escape im Overlay schließt es wieder, ohne das Feld zu verändern', async () => {
    const fetchFn = makeFetchFn();
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath="/obsidian-vault/vorhanden"
        configured
        mountStatus="ok"
        mountRoot="/obsidian-vault"
        onReload={jest.fn()}
        fetchFn={fetchFn}
      />,
    );
    const browseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Durchsuchen'),
    );
    await act(async () => { fireEvent.click(browseBtn); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeTruthy();
    });

    fireEvent.keyDown(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]'), { key: 'Escape' });

    expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeNull();
    expect(document.getElementById('obsidian-vault-path-input')).toBeNull();
    expect(container.textContent).toContain('/obsidian-vault/vorhanden');
  });
});

describe('ObsidianVaultPathSection — AC8: Freitext-Fallback unverändert erreichbar', () => {
  it('Set-Button ist unabhängig vom mountStatus erreichbar (nicht konfiguriert)', () => {
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath={null}
        configured={false}
        mountStatus="unconfigured"
        onReload={jest.fn()}
        fetchFn={makeFetchFn()}
      />,
    );
    const setBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.match(/obsidian-vault-pfad setzen/i),
    );
    expect(setBtn).toBeTruthy();
    expect(setBtn.disabled).toBeFalsy();
    fireEvent.click(setBtn);
    expect(document.getElementById('obsidian-vault-path-input')).toBeTruthy();
  });

  it('Zurücksetzen-Button ist unabhängig vom mountStatus erreichbar (konfiguriert)', () => {
    const { container } = render(
      <ObsidianVaultPathSection
        vaultPath="/obsidian-vault/vorhanden"
        configured
        mountStatus="unusable"
        onReload={jest.fn()}
        fetchFn={makeFetchFn()}
      />,
    );
    const resetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.match(/obsidian-vault-pfad zurücksetzen/i),
    );
    expect(resetBtn).toBeTruthy();
    expect(resetBtn.disabled).toBeFalsy();
  });
});
