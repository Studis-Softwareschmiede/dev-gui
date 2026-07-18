/**
 * ObsidianVaultFolderBrowserOverlay.test.jsx — Tests für das Ordner-Browser-Overlay
 * (docs/specs/obsidian-vault-folder-browser.md AC6/AC9, S-379).
 *
 * Covers (obsidian-vault-folder-browser):
 *   AC6 — Öffnet die Unterordner-Liste des aktuellen Pfads (Mount-Root ohne Pfad-Param),
 *          Breadcrumb-Navigation, „Zurück" navigiert zum Eltern-Pfad, Klick auf einen
 *          Unterordner navigiert hinein (neuer `browseFetch`-Aufruf mit dessen `path`);
 *          „Diesen Ordner verwenden" ruft `onSelect(path)` mit dem AKTUELLEN Pfad auf und
 *          schließt das Overlay.
 *   AC9 — `role="dialog"`/`aria-modal`, `Escape` schließt und gibt den Fokus an
 *          `triggerRef` zurück; Lade-/Fehler-/Leer-Zustand über `role="status"`/`role="alert"`
 *          (nicht nur Text-Absenz); „Zurück" ist am Mount-Root (`parent:null`) deaktiviert
 *          (`aria-disabled` + `disabled`); Retry-Button nach Fehler lädt denselben Pfad neu.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { ObsidianVaultFolderBrowserOverlay } = await import('../ObsidianVaultFolderBrowserOverlay.jsx');

const ROOT_RESULT = {
  root: '/obsidian-vault',
  path: '/obsidian-vault',
  parent: null,
  breadcrumb: [{ name: 'obsidian-vault', path: '/obsidian-vault' }],
  entries: [
    { name: 'Projekte', path: '/obsidian-vault/Projekte' },
    { name: 'Archiv', path: '/obsidian-vault/Archiv' },
  ],
};

const SUB_RESULT = {
  root: '/obsidian-vault',
  path: '/obsidian-vault/Projekte',
  parent: '/obsidian-vault',
  breadcrumb: [
    { name: 'obsidian-vault', path: '/obsidian-vault' },
    { name: 'Projekte', path: '/obsidian-vault/Projekte' },
  ],
  entries: [],
};

/** browseFetch-Double: mappt `path` (bzw. undefined für Root) auf ein Ergebnis-Objekt. */
function makeBrowseFetch(map) {
  const calls = [];
  const fn = jest.fn(async (path) => {
    calls.push(path);
    const key = path ?? '__root__';
    const entry = map[key];
    if (!entry) throw new Error(`unerwarteter Pfad im Test-Double: ${key}`);
    if (entry.throw) throw entry.throw;
    return entry;
  });
  fn.calls = calls;
  return fn;
}

describe('ObsidianVaultFolderBrowserOverlay — AC6: Navigation + Übernahme', () => {
  it('lädt beim Öffnen das Mount-Root (kein path-Parameter) und zeigt Breadcrumb + Unterordner', async () => {
    const browseFetch = makeBrowseFetch({ __root__: ROOT_RESULT });
    const onClose = jest.fn();
    const onSelect = jest.fn();

    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={onClose} onSelect={onSelect} browseFetch={browseFetch} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });

    expect(browseFetch.calls[0]).toBeUndefined();
    expect(container.textContent).toContain('/obsidian-vault');
    expect(container.textContent).toContain('Projekte');
    expect(container.textContent).toContain('Archiv');

    // Zurück ist am Root deaktiviert (parent:null)
    const upBtn = container.querySelector('[data-testid="obsidian-vault-browser-up-btn"]');
    expect(upBtn.disabled).toBe(true);
    expect(upBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('Klick auf einen Unterordner navigiert hinein (neuer browseFetch-Aufruf mit dessen path)', async () => {
    const browseFetch = makeBrowseFetch({
      __root__: ROOT_RESULT,
      '/obsidian-vault/Projekte': SUB_RESULT,
    });
    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={jest.fn()} onSelect={jest.fn()} browseFetch={browseFetch} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });

    const entryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Projekte'),
    );
    await act(async () => { fireEvent.click(entryBtn); });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-empty"]')).toBeTruthy();
    });
    expect(browseFetch.calls).toContain('/obsidian-vault/Projekte');
    expect(container.textContent).toContain('Keine Unterordner vorhanden.');
  });

  it('„Zurück" navigiert zum Eltern-Pfad', async () => {
    // Overlay startet am Root, navigiert per Klick zu Projekte, dann zurück.
    const browseFetch = makeBrowseFetch({
      __root__: ROOT_RESULT,
      '/obsidian-vault/Projekte': SUB_RESULT,
      '/obsidian-vault': ROOT_RESULT,
    });
    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={jest.fn()} onSelect={jest.fn()} browseFetch={browseFetch} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });
    const entryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Projekte'),
    );
    await act(async () => { fireEvent.click(entryBtn); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-empty"]')).toBeTruthy();
    });

    const upBtn = container.querySelector('[data-testid="obsidian-vault-browser-up-btn"]');
    expect(upBtn.disabled).toBe(false);
    await act(async () => { fireEvent.click(upBtn); });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });
    expect(browseFetch.calls).toContain('/obsidian-vault');
  });

  it('„Diesen Ordner verwenden" ruft onSelect mit dem aktuellen Pfad auf und schließt', async () => {
    const browseFetch = makeBrowseFetch({ __root__: ROOT_RESULT });
    const onClose = jest.fn();
    const onSelect = jest.fn();
    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={onClose} onSelect={onSelect} browseFetch={browseFetch} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="obsidian-vault-browser-use-btn"]'));
    });

    expect(onSelect).toHaveBeenCalledWith('/obsidian-vault');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ObsidianVaultFolderBrowserOverlay — AC9: A11y (Dialog, Escape, Fehler/Leer-Zustand)', () => {
  it('rendert role=dialog + aria-modal; Ladezustand über role=status', async () => {
    let resolveLoad;
    const browseFetch = jest.fn(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={jest.fn()} onSelect={jest.fn()} browseFetch={browseFetch} />,
    );

    const dialog = container.querySelector('[data-testid="obsidian-vault-browser-overlay"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelector('[data-testid="obsidian-vault-browser-loading"]').getAttribute('role')).toBe('status');

    await act(async () => { resolveLoad(ROOT_RESULT); });
  });

  it('Escape schließt das Overlay und gibt den Fokus an triggerRef zurück', async () => {
    const browseFetch = makeBrowseFetch({ __root__: ROOT_RESULT });
    const onClose = jest.fn();
    const triggerBtn = document.createElement('button');
    document.body.appendChild(triggerBtn);
    const triggerRef = { current: triggerBtn };

    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={onClose} onSelect={jest.fn()} browseFetch={browseFetch} triggerRef={triggerRef} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });

    const dialog = container.querySelector('[data-testid="obsidian-vault-browser-overlay"]');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(triggerBtn);
    triggerBtn.remove();
  });

  it('zeigt einen Fehler (role=alert) bei einem fehlgeschlagenen Ladevorgang; Retry lädt denselben Pfad neu', async () => {
    let attempt = 0;
    const browseFetch = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('Mount-Schranke nicht nutzbar');
        throw err;
      }
      return ROOT_RESULT;
    });

    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={jest.fn()} onSelect={jest.fn()} browseFetch={browseFetch} />,
    );

    await waitFor(() => {
      const el = container.querySelector('[data-testid="obsidian-vault-browser-error"]');
      expect(el).toBeTruthy();
      expect(el.getAttribute('role')).toBe('alert');
      expect(el.textContent).toContain('Mount-Schranke nicht nutzbar');
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="obsidian-vault-browser-retry-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });
    expect(attempt).toBe(2);
  });

  it('Klick auf den Backdrop schließt das Overlay', async () => {
    const browseFetch = makeBrowseFetch({ __root__: ROOT_RESULT });
    const onClose = jest.fn();
    const { container } = render(
      <ObsidianVaultFolderBrowserOverlay onClose={onClose} onSelect={jest.fn()} browseFetch={browseFetch} />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="obsidian-vault-browser-entries"]')).toBeTruthy();
    });
    // Backdrop ist das erste Div im Fragment (aria-hidden, kein data-testid nötig).
    const backdrop = container.querySelector('div[aria-hidden="true"]');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
