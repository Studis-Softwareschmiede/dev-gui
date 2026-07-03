/**
 * @file wsUpgradeHandler.test.js
 *
 * Unit tests for the WS-upgrade pathname-match logic (S-124, AC8 + vps-ssh-terminal
 * AC5/AC9, S-263).
 *
 * The upgrade handler in server.js now uses:
 *   const { pathname } = new URL(req.url, 'ws://localhost');
 *   if (pathname === '/ws/terminal') { wsGuard(...) }
 *   else if (pathname === '/ws/vps-terminal') { wsVpsTerminalGuard(...) }
 *   else { socket.destroy() }
 *
 * These tests verify the extraction logic directly (the exact same expression
 * used in server.js) — no live HTTP server needed.
 *
 * Covers (projekt-cockpit-navigation AC8):
 *   AC8 — /ws/terminal with ?project=<x> yields pathname === '/ws/terminal'
 *         (not destroyed before handshake)
 *   AC8 — /ws/terminal without query also passes (backward compat)
 *   AC8 — a different pathname (e.g. /ws/other) is rejected
 *   AC8 — malformed req.url (new URL throws) → graceful destroy, no unhandled throw
 *
 * Covers (vps-ssh-terminal, S-263):
 *   AC5/AC9 — /ws/vps-terminal reaches its OWN guard (wsVpsTerminalGuard), distinct
 *             from /ws/terminal's wsGuard — verifies the three-way pathname dispatch
 *             (Verdrahtung only; the guard's own AccessGuard/Rollen-403-Verhalten ist
 *             in test/AccessGuard.test.js abgedeckt, kein Doppel-Test hier).
 */

import { describe, it, expect } from '@jest/globals';

/**
 * Mirrors the exact logic from server.js upgrade handler:
 *   try { pathname = new URL(req.url, 'ws://localhost').pathname }
 *   catch { socket.destroy(); return; }
 *   if (pathname === '/ws/terminal') { wsGuard(...) }
 *   else if (pathname === '/ws/vps-terminal') { wsVpsTerminalGuard(...) }
 *   else { socket.destroy() }
 *
 * Returns 'guard' for /ws/terminal, 'vps-guard' for /ws/vps-terminal,
 * 'destroy' for everything else (or a malformed URL).
 */
function simulateUpgradeDecision(reqUrl) {
  let pathname;
  try {
    pathname = new URL(reqUrl, 'ws://localhost').pathname;
  } catch {
    return 'destroy';
  }
  if (pathname === '/ws/terminal') return 'guard';
  if (pathname === '/ws/vps-terminal') return 'vps-guard';
  return 'destroy';
}

describe('WS-upgrade handler — AC8: pathname-match (S-124)', () => {
  describe('connections that must reach the WS guard (not destroyed)', () => {
    it('/ws/terminal without query string → guard (backward compat)', () => {
      expect(simulateUpgradeDecision('/ws/terminal')).toBe('guard');
    });

    it('/ws/terminal?project=dev-gui → guard (AC8 main case)', () => {
      expect(simulateUpgradeDecision('/ws/terminal?project=dev-gui')).toBe('guard');
    });

    it('/ws/terminal?project=<encoded-slug> → guard', () => {
      const url = `/ws/terminal?project=${encodeURIComponent('my-repo')}`;
      expect(simulateUpgradeDecision(url)).toBe('guard');
    });

    it('/ws/terminal?project=x&extra=y → guard (multiple query params)', () => {
      expect(simulateUpgradeDecision('/ws/terminal?project=x&extra=y')).toBe('guard');
    });
  });

  describe('vps-ssh-terminal AC5/AC9 — /ws/vps-terminal reaches its own guard (S-263)', () => {
    it('/ws/vps-terminal → vps-guard (distinct from /ws/terminal)', () => {
      expect(simulateUpgradeDecision('/ws/vps-terminal')).toBe('vps-guard');
    });

    it('/ws/vps-terminal never routes to the Claude-terminal guard', () => {
      expect(simulateUpgradeDecision('/ws/vps-terminal')).not.toBe('guard');
    });
  });

  describe('connections that must be destroyed (wrong pathname)', () => {
    it('/ws/other → destroy', () => {
      expect(simulateUpgradeDecision('/ws/other')).toBe('destroy');
    });

    it('/ (root) → destroy', () => {
      expect(simulateUpgradeDecision('/')).toBe('destroy');
    });

    it('/api/command → destroy', () => {
      expect(simulateUpgradeDecision('/api/command')).toBe('destroy');
    });

    it('/ws/terminal/extra → destroy (trailing segment)', () => {
      expect(simulateUpgradeDecision('/ws/terminal/extra')).toBe('destroy');
    });

    it('/ws/terminal-extra → destroy (adjacent, not same path)', () => {
      expect(simulateUpgradeDecision('/ws/terminal-extra')).toBe('destroy');
    });

    it('empty string → destroy (new URL resolves to ws://localhost/, pathname "/")', () => {
      // new URL('', 'ws://localhost') does NOT throw — it resolves to ws://localhost/
      // with pathname '/', which is not /ws/terminal → destroy via pathname mismatch.
      expect(simulateUpgradeDecision('')).toBe('destroy');
    });
  });

  describe('malformed URL → graceful destroy (catch-branch, no unhandled throw)', () => {
    it('"http://" (absolute-URL-only that new URL cannot parse with base) → destroy', () => {
      // new URL('http://', 'ws://localhost') throws "Invalid URL" in Node.
      // The catch-branch in server.js calls socket.destroy() and returns.
      // Verify that simulateUpgradeDecision (same logic) returns 'destroy' — not a throw.
      expect(simulateUpgradeDecision('http://')).toBe('destroy');
    });

    it('"////" (multiple-slash invalid URL) → destroy', () => {
      // new URL('////', 'ws://localhost') throws "Invalid URL" in Node.
      // Also exercises the catch-branch.
      expect(simulateUpgradeDecision('////')).toBe('destroy');
    });
  });
});
