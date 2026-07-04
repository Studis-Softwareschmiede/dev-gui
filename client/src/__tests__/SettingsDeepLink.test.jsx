/**
 * SettingsDeepLink.test.jsx — settings-panel-navigation D13/D14 (S-268).
 *
 * Covers:
 *   D13 — #/settings/<slug> aktiviert die Kategorie; unbekanntes/fehlendes
 *         Sub-Segment → Default workspace; Tab-Klick schreibt den Hash.
 *   D14 — hashchange (Browser Vor/Zurück) wechselt die Kategorie.
 *
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor, fireEvent, act } from '@testing-library/react';

const React = (await import('react')).default;
const { SettingsView, parseSettingsHash } = await import('../SettingsView.jsx');
const { parseHashFull } = await import('../useHashRouter.js');

function makeFetch() {
  // Minimal-Mock: Credentials-Liste ist ein Array, alles andere ein Objekt.
  return jest.fn(async (url) => {
    const isList = /\/api\/settings\/credentials(\?|$)/.test(String(url));
    return { ok: true, status: 200, json: async () => (isList ? [] : {}) };
  });
}

afterEach(() => { window.location.hash = ''; delete globalThis.fetch; });

describe('settings-deep-link (S-268)', () => {
  it('D13 — parseSettingsHash: gültiger Slug, unbekannter Slug, fehlendes Segment', () => {
    expect(parseSettingsHash('#/settings/zugaenge')).toBe('zugaenge');
    expect(parseSettingsHash('#/settings/unbekannt')).toBe('workspace');
    expect(parseSettingsHash('#/settings')).toBe('workspace');
  });

  it('D13 — useHashRouter erkennt settings/<slug> weiterhin als settings-View', () => {
    expect(parseHashFull('#/settings/zugaenge').view).toBe('settings');
    expect(parseHashFull('#/settings/zugaenge').settingsCategory).toBe('zugaenge');
    expect(parseHashFull('#/settings').view).toBe('settings');
  });

  it('D13 — Mount mit #/settings/sicherung aktiviert die Kategorie; Tab-Klick schreibt Hash', async () => {
    window.location.hash = '#/settings/sicherung';
    globalThis.fetch = makeFetch();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn: globalThis.fetch }));
    await waitFor(() => {
      expect(getByRole('tab', { name: /sicherung/i }).getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.click(getByRole('tab', { name: /diverses/i }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/settings/diverses');
      expect(getByRole('tab', { name: /diverses/i }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('D14 — hashchange wechselt die Kategorie (Browser Vor/Zurück)', async () => {
    window.location.hash = '#/settings/workspace';
    globalThis.fetch = makeFetch();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn: globalThis.fetch }));
    await waitFor(() => {
      expect(getByRole('tab', { name: /workspace/i }).getAttribute('aria-selected')).toBe('true');
    });
    await act(async () => {
      window.location.hash = '#/settings/integrationen';
      window.dispatchEvent(new Event('hashchange'));
    });
    await waitFor(() => {
      expect(getByRole('tab', { name: /integrationen/i }).getAttribute('aria-selected')).toBe('true');
    });
  });
});
