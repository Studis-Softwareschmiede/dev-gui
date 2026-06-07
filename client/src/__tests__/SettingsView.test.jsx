/**
 * SettingsView.test.jsx — Unit tests for the SettingsView component.
 *
 * Covers (settings-shell):
 *   - AC2: Renders title "Einstellungen" as an h1 heading; main landmark present.
 *   - AC4: Exactly four sections (h2), labelled GitHub / Cloudflare / Hetzner / VPS /
 *          SSH-Keys; each section contains a "folgt" placeholder; no backend call.
 *   - AC6: Home button calls onNavigate('panel'); button is keyboard-reachable
 *          (Tab-focusable) with touch-target ≥ 44 px.
 *   - AC7: No fetch / XHR calls on render.
 *   - NFR A11y: h1 for title, h2 for sections; Home button minHeight ≥ 44 px.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent } from '@testing-library/react';

const { render }         = await import('@testing-library/react');
const React              = (await import('react')).default;
const { SettingsView }   = await import('../SettingsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderView() {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(SettingsView, { onNavigate }));
  return { ...utils, onNavigate };
}

// ── AC2 — Title "Einstellungen" ───────────────────────────────────────────────

describe('SettingsView — AC2: Title', () => {
  it('renders an h1 heading "Einstellungen"', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /^einstellungen$/i });
    expect(heading).toBeTruthy();
    expect(heading.tagName).toBe('H1');
  });

  it('renders the Einstellungen-Ansicht main landmark', () => {
    const { getByRole } = renderView();
    expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
  });
});

// ── AC4 — Exactly four sections ───────────────────────────────────────────────

describe('SettingsView — AC4: Four sections', () => {
  it('renders exactly four h2 section headings', () => {
    const { getByRole } = renderView();
    const main = getByRole('main', { name: /einstellungen-ansicht/i });
    const h2s = main.querySelectorAll('h2');
    expect(h2s).toHaveLength(4);
  });

  it('has a GitHub section', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /^github$/i });
    expect(heading).toBeTruthy();
    expect(heading.tagName).toBe('H2');
  });

  it('has a Cloudflare section', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /^cloudflare$/i });
    expect(heading).toBeTruthy();
    expect(heading.tagName).toBe('H2');
  });

  it('has a Hetzner / VPS section', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /hetzner/i });
    expect(heading).toBeTruthy();
    expect(heading.tagName).toBe('H2');
  });

  it('has a SSH-Keys section', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /ssh-keys/i });
    expect(heading).toBeTruthy();
    expect(heading.tagName).toBe('H2');
  });

  it('each section contains a "folgt" placeholder text', () => {
    const { getByRole } = renderView();
    const main = getByRole('main', { name: /einstellungen-ansicht/i });
    const count = (main.textContent.match(/folgt/gi) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

// ── AC4/AC7 — No backend calls ────────────────────────────────────────────────

describe('SettingsView — AC4/AC7: No backend call', () => {
  let originalFetch;
  let originalXHR;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new Error('SettingsView must not call fetch'))
    );
    originalXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = jest.fn(function () {
      this.open = jest.fn(() => { throw new Error('SettingsView must not open XHR'); });
      this.send = jest.fn(() => { throw new Error('SettingsView must not send XHR'); });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
  });

  it('does not call fetch on render', () => {
    renderView();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not instantiate XMLHttpRequest on render', () => {
    renderView();
    expect(globalThis.XMLHttpRequest).not.toHaveBeenCalled();
  });
});

// ── AC6 — Navigation back to panel ───────────────────────────────────────────

describe('SettingsView — AC6: Home button', () => {
  it('renders a Home button', () => {
    const { getByRole } = renderView();
    expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
  });

  it('clicking Home button calls onNavigate("panel")', async () => {
    const { getByRole, onNavigate } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('Home button is a <button> (Tab-focusable by default)', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.disabled).toBe(false);
  });

  it('Home button has touch-target minHeight >= 44px', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });
});
