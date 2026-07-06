/**
 * CockpitNewStory.test.jsx — Tests für new-story-chat AC1 auf CockpitView-Ebene:
 * der „Neue Story"-Button ersetzt „Änderung erfassen" (Fabrik-Panel, Reiter
 * „Arbeiten", rechte Sidebar) und öffnet das Chat-Overlay (IdeaSpecifyChatModal,
 * scratch-Modus).
 *
 * Covers (new-story-chat):
 *   AC1 — „Neue Story"-Button vorhanden (data-testid=new-story-btn); der frühere
 *          „Änderung erfassen"-Trigger (intake-change-btn) ist ENTFERNT; ein
 *          Klick öffnet das Overlay (role=dialog) im scratch-Modus (Start-Feld,
 *          new-story-compose) — ohne Idee-Karte.
 *
 *   Teilweise/nicht hier getestet:
 *          - AC6 (Board-Re-Fetch via Reiter-Wechsel) und AC7 (Fehlerpfade)
 *            leben im Overlay und sind in NewStoryChatScratch.test.jsx
 *            (IdeaSpecifyChatModal, scratch-Modus) abgedeckt; hier nur die
 *            Verdrahtung Button → Overlay.
 *
 * Terminal, Dashboard, BoardView, SpecView sind gemockt
 * (WS/DOM-Komplexität vermeiden); IdeaSpecifyChatModal bleibt real (scratch-
 * Start-Feld ruft beim Öffnen KEIN fetch auf).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent } from '@testing-library/react';

jest.unstable_mockModule('../Terminal.jsx', () => ({ Terminal: () => null }));
jest.unstable_mockModule('../Dashboard.jsx', () => ({ Dashboard: () => null }));
jest.unstable_mockModule('../BoardView.jsx', async () => {
  const R = (await import('react')).default;
  return {
    BoardView: ({ lockedProject }) =>
      R.createElement('main', { 'aria-label': 'Studis-Kanban-Board', 'data-locked': lockedProject ?? '' }, 'Board Mock'),
  };
});
jest.unstable_mockModule('../SpecView.jsx', async () => {
  const R = (await import('react')).default;
  return { SpecView: () => R.createElement('div', { 'data-testid': 'spec-view-stub' }, 'Spec Mock') };
});

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { CockpitView } = await import('../CockpitView.jsx');

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; window.location.hash = ''; });

function renderCockpit() {
  // /api/session poll + alles andere neutral beantworten.
  const fn = jest.fn(async (url) => {
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', restarts: 0 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  globalThis.fetch = fn;
  render(
    React.createElement(CockpitView, {
      activeRepo: 'my-project',
      navigateFactory: jest.fn(),
      onNavigate: jest.fn(),
    }),
  );
  return { fetchFn: fn };
}

const q = (id) => document.querySelector(`[data-testid="${id}"]`);

describe('CockpitView — new-story-chat AC1: „Neue Story" ersetzt „Änderung erfassen"', () => {
  it('renders the „Neue Story"-Button and NOT the former „Änderung erfassen"-Trigger', () => {
    renderCockpit();
    const btn = q('new-story-btn');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/neue story/i);
    // Der frühere IntakeDialog-change-Trigger ist entfernt.
    expect(q('intake-change-btn')).toBeNull();
  });

  it('clicking „Neue Story" opens the scratch chat overlay with the start-field', () => {
    renderCockpit();
    expect(q('idea-specify-chat-modal')).toBeNull(); // noch nicht offen
    act(() => { fireEvent.click(q('new-story-btn')); });

    const modal = q('idea-specify-chat-modal');
    expect(modal).toBeTruthy();
    expect(modal.getAttribute('role')).toBe('dialog');
    // scratch-Modus: Start-Feld statt Auto-Seed.
    expect(q('new-story-compose')).toBeTruthy();
    expect(q('new-story-title-input')).toBeTruthy();
  });
});
