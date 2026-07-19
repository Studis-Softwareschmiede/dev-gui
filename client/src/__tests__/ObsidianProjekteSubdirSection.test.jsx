/**
 * ObsidianProjekteSubdirSection.test.jsx — Tests für die Obsidian-Projekt-Unterordner-
 * Sektion (docs/specs/obsidian-vault-config.md v3, S-381) — Fokus auf AC13 (Ordner-
 * Browser-Ableitung eines vault-relativen Segments). AC8/AC15 (Anzeige/Quelle,
 * Setzen/Zurücksetzen, Fehlerpfade, A11y-Grundcheck über die volle Verdrahtung) sind
 * in SettingsView.test.jsx (OBS-AC8/OBS-AC15-Suiten) abgedeckt — hier NUR der
 * Ordner-Browser-Anteil + die reine `deriveVaultRelativeSegment`-Herleitung.
 *
 * Covers (obsidian-vault-config v3):
 *   AC13 — „Durchsuchen…"-Button öffnet den BESTEHENDEN Ordner-Browser
 *          (`ObsidianVaultFolderBrowserOverlay`, kein neuer Browser). „Diesen Ordner
 *          verwenden" liefert einen absoluten Container-Pfad; liegt er innerhalb des
 *          konfigurierten Vaults, wird das vault-relative Segment abgeleitet und als
 *          Kandidat in das Freitext-Feld übernommen (Bearbeiten-Modus öffnet,
 *          Fokus auf dem Feld) — Speichern bleibt ein expliziter Klick (kein
 *          Auto-Save). Liegt der gewählte Ordner außerhalb des Vaults, ist kein Vault
 *          konfiguriert, ODER wurde der Vault-Root selbst gewählt, erscheint eine EIGENE,
 *          dem Fall angemessene Meldung (role=alert) statt eines ungültigen Segments —
 *          die Vault-Root-Meldung ist textlich verschieden von der „außerhalb"-Meldung;
 *          das Freitext-Feld bleibt in jedem Fall unverändert nutzbar.
 *   deriveVaultRelativeSegment (reine Herleitungsfunktion, AC13-Ausgestaltung A4):
 *          korrekte Segment-Ableitung bei Mehrebenen-Pfaden, Trailing-Slash-Toleranz;
 *          liefert einen unterscheidbaren `reason` ('no-vault'|'is-vault-root'|
 *          'outside-vault') bei Ablehnung, den die Sektion auf drei separate,
 *          textlich verschiedene Meldungen mappt.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const {
  ObsidianProjekteSubdirSection,
  deriveVaultRelativeSegment,
} = await import('../ObsidianProjekteSubdirSection.jsx');

const BROWSE_RE = /\/api\/settings\/obsidian-vault\/browse/;

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

const DEFAULT_SUBDIR_PROPS = {
  effective: 'Projekte',
  source: 'default',
  persisted: null,
};

/** fetch-Double für den Browse-Endpunkt — liefert immer denselben Ordner. */
function makeFetchFn({ browseBody } = {}) {
  const body = browseBody ?? {
    root: '/obsidian-vault',
    path: '/obsidian-vault/300 Projekte/Studis Softwareschmiede',
    parent: '/obsidian-vault/300 Projekte',
    breadcrumb: [
      { name: 'obsidian-vault', path: '/obsidian-vault' },
      { name: '300 Projekte', path: '/obsidian-vault/300 Projekte' },
      { name: 'Studis Softwareschmiede', path: '/obsidian-vault/300 Projekte/Studis Softwareschmiede' },
    ],
    entries: [],
  };
  return jest.fn(async (url) => {
    if (BROWSE_RE.test(url)) {
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe('deriveVaultRelativeSegment — reine Herleitungsfunktion (AC13, A4)', () => {
  it('leitet ein Mehrebenen-Segment relativ zum Vault ab', () => {
    expect(deriveVaultRelativeSegment('/obsidian-vault', '/obsidian-vault/300 Projekte/Studis Softwareschmiede')).toEqual({
      ok: true,
      segment: '300 Projekte/Studis Softwareschmiede',
    });
  });

  it('toleriert einen Trailing-Slash am Vault-Pfad', () => {
    expect(deriveVaultRelativeSegment('/obsidian-vault/', '/obsidian-vault/Projekte')).toEqual({
      ok: true,
      segment: 'Projekte',
    });
  });

  it('lehnt die Auswahl des Vault-Roots selbst ab (leeres Segment, eigener Reason "is-vault-root")', () => {
    expect(deriveVaultRelativeSegment('/obsidian-vault', '/obsidian-vault')).toEqual({ ok: false, reason: 'is-vault-root' });
    // Trailing-Slash-Toleranz gilt symmetrisch auch für den Vault-Root-Fall selbst.
    expect(deriveVaultRelativeSegment('/obsidian-vault/', '/obsidian-vault')).toEqual({ ok: false, reason: 'is-vault-root' });
  });

  it('lehnt einen Ordner außerhalb des Vaults ab (Reason "outside-vault")', () => {
    expect(deriveVaultRelativeSegment('/obsidian-vault', '/anderer-mount/foo')).toEqual({ ok: false, reason: 'outside-vault' });
  });

  it('lehnt ab, wenn kein Vault konfiguriert ist (Reason "no-vault")', () => {
    expect(deriveVaultRelativeSegment(null, '/obsidian-vault/Projekte')).toEqual({ ok: false, reason: 'no-vault' });
    expect(deriveVaultRelativeSegment('', '/obsidian-vault/Projekte')).toEqual({ ok: false, reason: 'no-vault' });
  });
});

describe('ObsidianProjekteSubdirSection — AC13: Durchsuchen öffnet Overlay + Segment-Übernahme', () => {
  it('öffnet das bestehende Overlay (kein neuer Browser) und übernimmt ein vault-relatives Segment ins Freitext-Feld', async () => {
    const fetchFn = makeFetchFn();
    const { container } = render(
      <ObsidianProjekteSubdirSection
        {...DEFAULT_SUBDIR_PROPS}
        vaultPath="/obsidian-vault"
        vaultConfigured
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

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]'));
    });

    // Overlay geschlossen, Bearbeiten-Modus offen mit dem ABGELEITETEN (vault-relativen)
    // Segment vorbelegt — NICHT dem absoluten Container-Pfad (Nicht-Ziel: kein absoluter Pfad).
    expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeNull();
    const input = document.getElementById('obsidian-projekte-subdir-input');
    expect(input).toBeTruthy();
    expect(input.value).toBe('300 Projekte/Studis Softwareschmiede');
    expect(document.activeElement).toBe(input);
    // Speichern ist NICHT automatisch ausgelöst worden (kein Auto-Save).
    expect(fetchFn.mock.calls.some(([, o]) => (o?.method ?? 'GET') === 'PUT')).toBe(false);
  });

  it('AC13 — gewählter Ordner außerhalb des konfigurierten Vaults: klare Meldung statt ungültigem Segment', async () => {
    const fetchFn = makeFetchFn({
      browseBody: {
        root: '/obsidian-vault',
        path: '/obsidian-vault',
        parent: null,
        breadcrumb: [{ name: 'obsidian-vault', path: '/obsidian-vault' }],
        entries: [],
      },
    });
    const { container } = render(
      <ObsidianProjekteSubdirSection
        {...DEFAULT_SUBDIR_PROPS}
        vaultPath="/anderer-vault-pfad"
        vaultConfigured
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

    expect(container.querySelector('[data-testid="obsidian-vault-browser-overlay"]')).toBeNull();
    // Kein Bearbeiten-Modus mit ungültigem Segment geöffnet.
    expect(document.getElementById('obsidian-projekte-subdir-input')).toBeNull();
    const errorEl = container.querySelector('#obsidian-projekte-subdir-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.getAttribute('role')).toBe('alert');
    expect(errorEl.textContent).toMatch(/außerhalb des konfigurierten vaults/i);
  });

  it('AC13 — kein Vault konfiguriert: klare Meldung statt ungültigem Segment', async () => {
    const fetchFn = makeFetchFn();
    const { container } = render(
      <ObsidianProjekteSubdirSection
        {...DEFAULT_SUBDIR_PROPS}
        vaultPath={null}
        vaultConfigured={false}
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

    expect(document.getElementById('obsidian-projekte-subdir-input')).toBeNull();
    const errorEl = container.querySelector('#obsidian-projekte-subdir-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toMatch(/kein obsidian-vault konfiguriert/i);
  });

  it('AC13 — Vault-Root selbst gewählt: eigene, präzisere Meldung statt „außerhalb des Vaults"', async () => {
    const fetchFn = makeFetchFn({
      browseBody: {
        root: '/obsidian-vault',
        path: '/obsidian-vault',
        parent: null,
        breadcrumb: [{ name: 'obsidian-vault', path: '/obsidian-vault' }],
        entries: [],
      },
    });
    const { container } = render(
      <ObsidianProjekteSubdirSection
        {...DEFAULT_SUBDIR_PROPS}
        vaultPath="/obsidian-vault"
        vaultConfigured
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

    expect(document.getElementById('obsidian-projekte-subdir-input')).toBeNull();
    const errorEl = container.querySelector('#obsidian-projekte-subdir-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.getAttribute('role')).toBe('alert');
    // Eigene, präzisere Meldung — NICHT die generische „außerhalb des konfigurierten Vaults".
    expect(errorEl.textContent).toMatch(/vault selbst kann nicht als unterordner verwendet werden/i);
    expect(errorEl.textContent).not.toMatch(/außerhalb des konfigurierten vaults/i);
  });

  it('Escape im Overlay schließt es wieder, ohne das Feld zu verändern', async () => {
    const fetchFn = makeFetchFn();
    const { container } = render(
      <ObsidianProjekteSubdirSection
        {...DEFAULT_SUBDIR_PROPS}
        vaultPath="/obsidian-vault"
        vaultConfigured
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
    expect(document.getElementById('obsidian-projekte-subdir-input')).toBeNull();
  });
});
