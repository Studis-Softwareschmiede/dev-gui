/**
 * SettingsKeyboardNav.test.jsx — settings-panel-navigation D12 (S-269).
 *
 * Covers:
 *   D12 — Pfeiltasten bewegen UND aktivieren sofort (automatic activation),
 *         inkl. Wrap-Around; Home/End springen zur ersten/letzten Kategorie;
 *         Roving Tabindex (genau ein Tab-Stopp: aktiver Tab tabIndex=0, übrige -1);
 *         Fokus folgt der Aktivierung.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { SettingsView, SETTINGS_CATEGORIES } = await import('../SettingsView.jsx');

function makeFetch() {
  return jest.fn(async (url) => {
    const isList = /\/api\/settings\/(credentials|ssh-keys)(\?|$)/.test(String(url));
    return { ok: true, status: 200, json: async () => (isList ? [] : {}) };
  });
}

afterEach(() => { window.location.hash = ''; delete globalThis.fetch; });

async function setup() {
  window.location.hash = '#/settings/workspace';
  globalThis.fetch = makeFetch();
  const utils = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn: globalThis.fetch }));
  await waitFor(() => {
    expect(utils.getByRole('tab', { name: /workspace/i })).toBeTruthy();
  });
  return utils;
}

describe('settings-tastatur-nav D12 (S-269)', () => {
  it('ArrowDown aktiviert die nächste Kategorie sofort und setzt den Fokus', async () => {
    const { getByRole } = await setup();
    const tablist = document.querySelector('[role="tablist"]');
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(getByRole('tab', { name: /zugänge/i }).getAttribute('aria-selected')).toBe('true');
    });
    expect(document.activeElement?.id).toBe('settings-tab-zugaenge');
  });

  it('ArrowUp vom ersten Eintrag wrappt zum letzten (diverses)', async () => {
    const { getByRole } = await setup();
    fireEvent.keyDown(document.querySelector('[role="tablist"]'), { key: 'ArrowUp' });
    await waitFor(() => {
      expect(getByRole('tab', { name: /diverses/i }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('Home/End springen zur ersten/letzten Kategorie', async () => {
    const { getByRole } = await setup();
    const tablist = document.querySelector('[role="tablist"]');
    fireEvent.keyDown(tablist, { key: 'End' });
    await waitFor(() => {
      expect(getByRole('tab', { name: /diverses/i }).getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.keyDown(tablist, { key: 'Home' });
    await waitFor(() => {
      expect(getByRole('tab', { name: /workspace/i }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('Roving Tabindex: genau der aktive Tab hat tabIndex=0', async () => {
    await setup();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(SETTINGS_CATEGORIES.length);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(tabs.filter((t) => t.tabIndex === -1)).toHaveLength(SETTINGS_CATEGORIES.length - 1);
  });
});
