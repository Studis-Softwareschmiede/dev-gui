/**
 * VpsView.test.jsx — Unit tests for the VpsView placeholder component.
 *
 * Covers (view-vps spec AC1–AC3):
 *   - AC1: View renders title "VPS" as a semantic heading (<h1>/<h2>);
 *          reachability via tile click and deep-link (#/vps) is verified in AppShell.
 *   - AC2: Renders a "folgt / in Arbeit" placeholder hint; no fetch/XHR call is made.
 *   - AC3: Home button navigates back to the entry panel; NavBar (in AppShell) enables
 *          switching to any other view — the onNavigate('panel') path is tested here.
 *   - NFR A11y: Title uses <h1> heading; Home button is keyboard-reachable.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent } from '@testing-library/react';

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { VpsView }   = await import('../VpsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Renders VpsView with a jest-mocked onNavigate. */
function renderView() {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(VpsView, { onNavigate }));
  return { ...utils, onNavigate };
}

// ── AC1 — Title "VPS" as semantic heading ─────────────────────────────────────

describe('VpsView — AC1: Title', () => {
  it('renders a heading with text "VPS"', () => {
    const { getByRole } = renderView();
    // heading level 1 or 2 is acceptable per spec NFR (h1/h2)
    const heading = getByRole('heading', { name: /^vps$/i });
    expect(heading).toBeTruthy();
  });

  it('heading is an <h1> element', () => {
    const { getByRole } = renderView();
    const heading = getByRole('heading', { name: /^vps$/i });
    expect(heading.tagName).toBe('H1');
  });

  it('renders the VPS main landmark', () => {
    const { getByRole } = renderView();
    expect(getByRole('main', { name: /vps-ansicht/i })).toBeTruthy();
  });
});

// ── AC2 — Placeholder hint; no backend/external call ─────────────────────────

describe('VpsView — AC2: Placeholder, no backend call', () => {
  let originalFetch;
  let originalXHR;

  beforeEach(() => {
    // Spy on fetch — must not be called
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new Error('VpsView must not call fetch'))
    );

    // Spy on XMLHttpRequest — must not be opened
    originalXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = jest.fn(function () {
      this.open  = jest.fn(() => { throw new Error('VpsView must not open XHR'); });
      this.send  = jest.fn(() => { throw new Error('VpsView must not send XHR'); });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
  });

  it('renders a "folgt" placeholder hint', () => {
    const { getByRole } = renderView();
    const main = getByRole('main', { name: /vps-ansicht/i });
    expect(main.textContent).toMatch(/folgt/i);
  });

  it('renders an "in Arbeit" or "in arbeit" text (placeholder wording)', () => {
    const { getByRole } = renderView();
    const main = getByRole('main', { name: /vps-ansicht/i });
    expect(main.textContent).toMatch(/in arbeit/i);
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

// ── AC3 — Return to panel; switch to other views ─────────────────────────────

describe('VpsView — AC3: Navigation back to panel', () => {
  it('renders a Home button', () => {
    const { getByRole } = renderView();
    expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
  });

  it('clicking the Home button calls onNavigate("panel")', async () => {
    const { getByRole, onNavigate } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('Home button is a <button> element (Tab-focusable by default)', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.disabled).toBe(false);
  });

  it('Home button has touch-target height >= 44px (minHeight style)', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    // minHeight is set as an inline style; jsdom exposes it via style attribute
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });
});
