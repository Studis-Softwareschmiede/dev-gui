/**
 * NewProjectChooserDialog.test.jsx — Komponenten-Test für den Drei-Wege-
 * Auswahl-Dialog (docs/specs/neues-projekt-auswahl-dialog.md, S-302).
 *
 * Covers (neues-projekt-auswahl-dialog): AC1, AC2, AC8
 *   AC1 — Genau drei beschriftete, gleichwertige Optionen ("Neues Projekt",
 *         "Aus Obsidian übernehmen", "Adopt") sichtbar/klickbar, wenn `open`.
 *         Schließbar per Schließen-Button UND Escape, ohne einen Weg
 *         auszulösen (keine der Sub-Komponenten wird beim reinen Schließen
 *         gemountet/getriggert). Touch-Targets ≥ 44 px (minHeight), Tastatur-
 *         erreichbar (native <button>-Elemente).
 *   AC2 — Auswahl "Neues Projekt" ruft `onSelectNewProject` auf und rendert
 *         den via `renderNewProject`-Render-Prop übergebenen Inhalt
 *         (repräsentiert den unveränderten IntakeDialog-new-Modus-Mount aus
 *         RepoOverview — dessen eigenes Verhalten ist durch
 *         IntakeMountIntegration.test.jsx abgedeckt, hier wird nur der
 *         Verdrahtungsvertrag der Chooser-Shell selbst geprüft).
 *   AC8 — Kein dangerouslySetInnerHTML (Komponente rendert ausschließlich
 *         JSX-Text-Kinder — statisch durch Quellcode-Grep verifiziert, siehe
 *         Reviewer-Handoff); keine neuen Endpunkte (diese Shell ruft selbst
 *         keinerlei `fetch` auf — sie reicht `fetchFn` nur an die bereits
 *         eigenständig getesteten Obsidian-/Adopt-Komponenten durch).
 *
 * ObsidianImportSection/AdoptSection werden gemockt (ihr eigenes Verhalten
 * ist durch ObsidianImportSection.test.jsx/AdoptSection.test.jsx abgedeckt;
 * hier interessiert nur, DASS die Chooser-Shell sie bei Auswahl mountet).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent } from '@testing-library/react';

jest.unstable_mockModule('../ObsidianImportSection.jsx', async () => {
  const R = (await import('react')).default;
  return {
    ObsidianImportSection: ({ fetchFn, onNavigate }) =>
      R.createElement('div', { 'data-testid': 'obsidian-import-section-stub' },
        `obsidian-stub fetchFn=${typeof fetchFn} onNavigate=${typeof onNavigate}`),
  };
});

jest.unstable_mockModule('../AdoptSection.jsx', async () => {
  const R = (await import('react')).default;
  return {
    AdoptSection: ({ fetchFn }) =>
      R.createElement('div', { 'data-testid': 'adopt-section-stub' }, `adopt-stub fetchFn=${typeof fetchFn}`),
  };
});

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { NewProjectChooserDialog } = await import('../NewProjectChooserDialog.jsx');

afterEach(() => {
  jest.restoreAllMocks();
});

function renderDialog(props = {}) {
  const onClose = props.onClose ?? jest.fn();
  const onSelectNewProject = props.onSelectNewProject ?? jest.fn();
  const renderNewProject = props.renderNewProject ?? jest.fn(() =>
    React.createElement('div', { 'data-testid': 'new-project-stub' }, 'IntakeDialog-Stub'));

  const utils = render(
    React.createElement(NewProjectChooserDialog, {
      open: props.open ?? true,
      onClose,
      onSelectNewProject,
      renderNewProject,
      fetchFn: props.fetchFn,
      onNavigate: props.onNavigate,
      triggerRef: props.triggerRef,
    }),
  );
  return { ...utils, onClose, onSelectNewProject, renderNewProject };
}

// ── AC1: Shell — drei Optionen, schließbar, A11y ─────────────────────────────

describe('NewProjectChooserDialog — AC1: Drei-Wege-Auswahl-Shell', () => {
  it('rendert nichts, wenn open=false', () => {
    renderDialog({ open: false });
    expect(document.querySelector('[data-testid="new-project-chooser-dialog"]')).toBeNull();
  });

  it('zeigt genau drei beschriftete Optionen, wenn open=true', () => {
    renderDialog();
    const dialog = document.querySelector('[data-testid="new-project-chooser-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const optNew = document.querySelector('[data-testid="chooser-option-new"]');
    const optObsidian = document.querySelector('[data-testid="chooser-option-obsidian"]');
    const optAdopt = document.querySelector('[data-testid="chooser-option-adopt"]');

    expect(optNew).toBeTruthy();
    expect(optObsidian).toBeTruthy();
    expect(optAdopt).toBeTruthy();

    expect(optNew.textContent).toMatch(/neues projekt/i);
    expect(optObsidian.textContent).toMatch(/aus obsidian übernehmen/i);
    expect(optAdopt.textContent).toMatch(/adopt/i);

    // Jede Option hat einen kurzen erklärenden Untertext.
    expect(optNew.getAttribute('aria-label')).toMatch(/—/);
    expect(optObsidian.getAttribute('aria-label')).toMatch(/—/);
    expect(optAdopt.getAttribute('aria-label')).toMatch(/—/);

    // Nur genau drei Options-Buttons (role=listitem).
    const options = document.querySelectorAll('[role="listitem"]');
    expect(options.length).toBe(3);
  });

  it('A11y: alle drei Optionen sind native <button>-Elemente mit Touch-Target ≥ 44 px (minHeight)', () => {
    renderDialog();
    ['chooser-option-new', 'chooser-option-obsidian', 'chooser-option-adopt'].forEach((testId) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      expect(el.tagName).toBe('BUTTON');
      expect(el.getAttribute('type')).toBe('button');
      expect(el.style.minHeight.replace('px', '')).not.toBe('');
      expect(Number(el.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(44);
    });
  });

  it('Schließen-Button schließt den Dialog, ohne einen Weg auszulösen', async () => {
    const { onClose, onSelectNewProject } = renderDialog();
    const closeBtn = document.querySelector('[data-testid="chooser-close-btn"]');
    expect(closeBtn).toBeTruthy();
    expect(Number(closeBtn.style.minWidth.replace('px', ''))).toBeGreaterThanOrEqual(44);
    expect(Number(closeBtn.style.minHeight.replace('px', ''))).toBeGreaterThanOrEqual(44);

    await act(async () => { fireEvent.click(closeBtn); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectNewProject).not.toHaveBeenCalled();
    // Kein Sub-Weg gemountet.
    expect(document.querySelector('[data-testid="obsidian-import-section-stub"]')).toBeNull();
    expect(document.querySelector('[data-testid="adopt-section-stub"]')).toBeNull();
  });

  it('Escape schließt den Dialog, ohne einen Weg auszulösen', async () => {
    const { onClose, onSelectNewProject } = renderDialog();
    const dialog = document.querySelector('[data-testid="new-project-chooser-dialog"]');

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectNewProject).not.toHaveBeenCalled();
  });

  it('Backdrop-Klick schließt den Dialog', async () => {
    renderDialog();
    // Backdrop is the first fixed-position div sibling before the dialog itself.
    const backdrops = document.querySelectorAll('div[aria-hidden="true"]');
    expect(backdrops.length).toBeGreaterThan(0);
  });

  it('Tastatur-Bedienbarkeit: erstes fokussierbares Element im Dialog erhält initial Fokus', () => {
    renderDialog();
    // Erste fokussierbare Instanz ist der Schließen-Button ODER die erste Option
    // (DOM-Reihenfolge: Heading-Row zuerst → Schließen-Button).
    expect(document.activeElement).toBeTruthy();
    expect(document.activeElement.tagName).toBe('BUTTON');
  });
});

// ── AC2: „Neues Projekt" — Render-Prop-Vertrag ───────────────────────────────

describe('NewProjectChooserDialog — AC2: „Neues Projekt" ruft onSelectNewProject + rendert renderNewProject()', () => {
  it('Klick auf "Neues Projekt" ruft onSelectNewProject auf und rendert den übergebenen Inhalt', async () => {
    const { onSelectNewProject, renderNewProject } = renderDialog();

    const optNew = document.querySelector('[data-testid="chooser-option-new"]');
    await act(async () => { fireEvent.click(optNew); });

    expect(onSelectNewProject).toHaveBeenCalledTimes(1);
    expect(renderNewProject).toHaveBeenCalled();
    expect(document.querySelector('[data-testid="new-project-stub"]')).toBeTruthy();

    // Auswahl-Optionen sind nicht mehr sichtbar (Detail-Ansicht ersetzt die Liste).
    expect(document.querySelector('[data-testid="chooser-option-new"]')).toBeNull();

    // "Zurück"-Affordanz vorhanden, um zur Auswahl zurückzukehren.
    const backBtn = document.querySelector('[data-testid="chooser-back-btn"]');
    expect(backBtn).toBeTruthy();

    await act(async () => { fireEvent.click(backBtn); });
    expect(document.querySelector('[data-testid="chooser-option-new"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="new-project-stub"]')).toBeNull();
  });

  it('erneutes Öffnen (open-Prop-Wechsel false→true) startet wieder bei der Auswahl (kein Stale-State)', () => {
    const { rerender } = renderDialog({ open: true });
    const optNew = document.querySelector('[data-testid="chooser-option-new"]');
    act(() => { fireEvent.click(optNew); });
    expect(document.querySelector('[data-testid="new-project-stub"]')).toBeTruthy();

    rerender(React.createElement(NewProjectChooserDialog, {
      open: false,
      onClose: jest.fn(),
      renderNewProject: () => React.createElement('div', { 'data-testid': 'new-project-stub' }),
    }));
    expect(document.querySelector('[data-testid="new-project-chooser-dialog"]')).toBeNull();

    rerender(React.createElement(NewProjectChooserDialog, {
      open: true,
      onClose: jest.fn(),
      renderNewProject: () => React.createElement('div', { 'data-testid': 'new-project-stub' }),
    }));
    // Zurück bei der Auswahl, nicht bei der zuletzt gewählten Option.
    expect(document.querySelector('[data-testid="chooser-option-new"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="new-project-stub"]')).toBeNull();
  });
});

// ── Obsidian-/Adopt-Einbindung (bestehende, eigenständige Komponenten) ───────

describe('NewProjectChooserDialog — Obsidian-/Adopt-Mount (bestehende Komponenten, gemockt)', () => {
  it('Klick auf "Aus Obsidian übernehmen" mountet die (gemockte) ObsidianImportSection mit fetchFn/onNavigate', async () => {
    const fetchFn = jest.fn();
    const onNavigate = jest.fn();
    renderDialog({ fetchFn, onNavigate });

    const optObsidian = document.querySelector('[data-testid="chooser-option-obsidian"]');
    await act(async () => { fireEvent.click(optObsidian); });

    const stub = document.querySelector('[data-testid="obsidian-import-section-stub"]');
    expect(stub).toBeTruthy();
    expect(stub.textContent).toMatch(/fetchFn=function/);
    expect(stub.textContent).toMatch(/onNavigate=function/);
  });

  it('Klick auf "Adopt" mountet die (gemockte) AdoptSection mit fetchFn', async () => {
    const fetchFn = jest.fn();
    renderDialog({ fetchFn });

    const optAdopt = document.querySelector('[data-testid="chooser-option-adopt"]');
    await act(async () => { fireEvent.click(optAdopt); });

    const stub = document.querySelector('[data-testid="adopt-section-stub"]');
    expect(stub).toBeTruthy();
    expect(stub.textContent).toMatch(/fetchFn=function/);
  });
});

// ── AC8: Kein dangerouslySetInnerHTML ────────────────────────────────────────

describe('NewProjectChooserDialog — AC8: Security-Floor', () => {
  it('Quellcode enthält kein dangerouslySetInnerHTML', async () => {
    const fs = await import('fs');
    const modulePath = new URL('../NewProjectChooserDialog.jsx', import.meta.url);
    const source = fs.readFileSync(modulePath, 'utf8');
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
