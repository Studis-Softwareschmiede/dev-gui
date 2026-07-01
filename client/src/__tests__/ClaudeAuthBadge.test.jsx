/**
 * ClaudeAuthBadge.test.jsx — Unit tests for the panel Claude-Auth-Health badge.
 *
 * Covers (claude-auth-health):
 *   AC5 — drei Zustände (ok/expired/unknown) mit Text-Label, gespeist über
 *         mockbaren fetchFn; expired zeigt zusätzlich die Erneuerungs-Anleitung
 *         (`claude setup-token`, Claude-Abo nötig).
 *   AC6 — kein Token-Wert im gerenderten Text; Badge über injizierbaren
 *         fetchFn reproduzierbar ohne echten `claude`-Aufruf.
 *
 * Edge-Case (Spec „/api/status-Fehler im Frontend"): Netzwerkfehler und eine
 * unerwartete Antwortform degradieren die Badge auf unsichtbar (kein Crash,
 * kein roter Alarm).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { waitFor } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { ClaudeAuthBadge } = await import('../ClaudeAuthBadge.jsx');

/** Builds a fetchFn stub that resolves with the given /api/status-shaped payload. */
function makeFetchFn(payload) {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ClaudeAuthBadge — AC5: claudeAuth=ok → neutrale Badge, kein Alarm', () => {
  it('rendert Text "Claude-Auth: ok"', async () => {
    const fetchFn = makeFetchFn({ claudeAuth: 'ok', lastCheckedAt: '2026-07-01T10:00:00.000Z' });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status');
      expect(badge.textContent).toMatch(/Claude-Auth: ok/);
    });
  });

  it('zeigt KEINEN Erneuerungs-Hinweis bei ok', async () => {
    const fetchFn = makeFetchFn({ claudeAuth: 'ok', lastCheckedAt: '2026-07-01T10:00:00.000Z' });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status');
      expect(badge.textContent).not.toMatch(/setup-token/);
    });
  });
});

describe('ClaudeAuthBadge — AC5: claudeAuth=expired → auffällige Badge + Erneuerungs-Anleitung', () => {
  it('rendert Text "Claude-Auth: abgelaufen" mit `claude setup-token`-Hinweis', async () => {
    const fetchFn = makeFetchFn({ claudeAuth: 'expired', lastCheckedAt: '2026-07-01T09:00:00.000Z' });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status');
      expect(badge.textContent).toMatch(/Claude-Auth: abgelaufen/);
      expect(badge.textContent).toMatch(/setup-token/);
      expect(badge.textContent).toMatch(/Claude-Abo/);
    });
  });

  it('aria-label trägt die volle Bedeutung (Text, nicht nur Farbe)', async () => {
    const fetchFn = makeFetchFn({ claudeAuth: 'expired', lastCheckedAt: null });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status', { name: /claude-auth: abgelaufen/i });
      expect(badge).toBeTruthy();
    });
  });
});

describe('ClaudeAuthBadge — AC5: claudeAuth=unknown → dezenter neutraler Hinweis, kein roter Alarm', () => {
  it('rendert Text "Claude-Auth: unbekannt" ohne Erneuerungs-Hinweis', async () => {
    const fetchFn = makeFetchFn({ claudeAuth: 'unknown', lastCheckedAt: null });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status');
      expect(badge.textContent).toMatch(/Claude-Auth: unbekannt/);
      expect(badge.textContent).not.toMatch(/setup-token/);
    });
  });
});

describe('ClaudeAuthBadge — Edge-Case: Netzwerkfehler/unerwartete Antwortform degradiert neutral (unsichtbar)', () => {
  it('fetchFn wirft (Netzwerkfehler) → keine Badge gerendert (kein Crash)', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('Netzwerkfehler'); });
    const { queryByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      expect(queryByRole('status')).toBeNull();
    });
  });

  it('HTTP-Fehlerstatus → keine Badge gerendert', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const { queryByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      expect(queryByRole('status')).toBeNull();
    });
  });

  it('unerwartete Antwortform (kein claudeAuth-Feld) → keine Badge gerendert', async () => {
    const fetchFn = makeFetchFn({ projects: [], previews: [] });
    const { queryByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      expect(queryByRole('status')).toBeNull();
    });
  });
});

describe('ClaudeAuthBadge — AC6: kein Token-Wert im gerenderten Text', () => {
  it('gerenderter Text enthält keinen Token-artigen String, auch wenn die Response viel Metadaten trägt', async () => {
    const fetchFn = makeFetchFn({
      claudeAuth: 'ok',
      lastCheckedAt: '2026-07-01T10:00:00.000Z',
      projects: [],
      previews: [],
    });
    const { getByRole } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
    await waitFor(() => {
      const badge = getByRole('status');
      expect(badge.textContent).not.toMatch(/sk-ant/);
      expect(badge.textContent).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    });
  });

  it('ist ohne echten `claude`-Aufruf reproduzierbar (fetchFn-Stub genügt für alle drei Zustände)', async () => {
    for (const state of ['ok', 'expired', 'unknown']) {
      const fetchFn = makeFetchFn({ claudeAuth: state, lastCheckedAt: null });
      const { getByRole, unmount } = render(React.createElement(ClaudeAuthBadge, { fetchFn }));
      await waitFor(() => expect(getByRole('status')).toBeTruthy());
      unmount();
    }
  });
});
