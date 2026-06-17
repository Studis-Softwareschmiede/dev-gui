/**
 * LockoutGuard.test.js — Unit-Tests für LockoutGuard (ADR-011).
 *
 * Covers:
 *   ADR-011 isProtected() Erkennungsregeln:
 *     - (a) devgui-Hostname aus DEVGUI_HOSTNAME → protected
 *     - (b) Cloudflare-Access-Mauer-Hostname → protected
 *     - AC13/S-159: ohne DEVGUI_HOSTNAME → normale Hostnames NICHT protected,
 *       nur Access-Mauer-Patterns bleiben protected
 *     - normale (nicht-protected) Route → false
 *     - null/undefined/leer → fail-closed (protected)
 *     - Case-insensitive matching
 *     - Custom protectedPatterns
 */

import { describe, it, expect } from '@jest/globals';
import { LockoutGuard } from '../src/cloudflare/LockoutGuard.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEVGUI_HOST = 'devgui.example.com';
const NORMAL_HOST = 'app.example.com';
const ANOTHER_HOST = 'api.example.com';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LockoutGuard — (a) devgui-Hostname protected', () => {
  it('returns true for exact devgui hostname match', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(DEVGUI_HOST)).toBe(true);
  });

  it('is case-insensitive for devgui hostname', () => {
    const guard = new LockoutGuard({ devguiHostname: 'DevGui.Example.COM' });
    expect(guard.isProtected('devgui.example.com')).toBe(true);
    expect(guard.isProtected('DEVGUI.EXAMPLE.COM')).toBe(true);
  });

  it('reads DEVGUI_HOSTNAME from env when not passed in constructor', () => {
    const original = process.env.DEVGUI_HOSTNAME;
    process.env.DEVGUI_HOSTNAME = DEVGUI_HOST;
    try {
      const guard = new LockoutGuard();
      expect(guard.isProtected(DEVGUI_HOST)).toBe(true);
      expect(guard.isProtected(NORMAL_HOST)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.DEVGUI_HOSTNAME;
      } else {
        process.env.DEVGUI_HOSTNAME = original;
      }
    }
  });
});

describe('LockoutGuard — (b) Cloudflare Access wall hostname protected', () => {
  it('returns true for *.cloudflareaccess.com suffix', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected('auth.cloudflareaccess.com')).toBe(true);
    expect(guard.isProtected('login.cloudflareaccess.com')).toBe(true);
    expect(guard.isProtected('team.cloudflareaccess.com')).toBe(true);
  });

  it('is case-insensitive for Access wall patterns', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected('AUTH.CLOUDFLAREACCESS.COM')).toBe(true);
  });
});

describe('LockoutGuard — fail-closed on target (null/empty/non-string)', () => {
  it('returns true for null target', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(null)).toBe(true);
  });

  it('returns true for undefined target', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(undefined)).toBe(true);
  });

  it('returns true for empty string target', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected('')).toBe(true);
  });

  it('returns true for whitespace-only target', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected('   ')).toBe(true);
  });

  it('returns true for non-string target', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(42)).toBe(true);
    expect(guard.isProtected({})).toBe(true);
    expect(guard.isProtected([])).toBe(true);
  });
});

// ── AC13/S-159: ohne DEVGUI_HOSTNAME → kein pauschal-protected ───────────────

describe('LockoutGuard — AC13/S-159: ohne DEVGUI_HOSTNAME nur Access-Mauer protected', () => {
  it('normaler App-Hostname ist NICHT protected wenn DEVGUI_HOSTNAME nicht gesetzt', () => {
    const original = process.env.DEVGUI_HOSTNAME;
    delete process.env.DEVGUI_HOSTNAME;
    try {
      const guard = new LockoutGuard({ devguiHostname: '' });
      // Normal hostnames must NOT be falsely protected (AC13 fix)
      expect(guard.isProtected(NORMAL_HOST)).toBe(false);
      expect(guard.isProtected('any.hostname.com')).toBe(false);
      expect(guard.isProtected(ANOTHER_HOST)).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.DEVGUI_HOSTNAME = original;
      }
    }
  });

  it('Access-Mauer-Pattern (*.cloudflareaccess.com) IST protected — auch ohne DEVGUI_HOSTNAME', () => {
    const original = process.env.DEVGUI_HOSTNAME;
    delete process.env.DEVGUI_HOSTNAME;
    try {
      const guard = new LockoutGuard({ devguiHostname: '' });
      expect(guard.isProtected('x.cloudflareaccess.com')).toBe(true);
      expect(guard.isProtected('auth.cloudflareaccess.com')).toBe(true);
    } finally {
      if (original !== undefined) {
        process.env.DEVGUI_HOSTNAME = original;
      }
    }
  });

  it('mit gesetztem DEVGUI_HOSTNAME ist der eigene Hostname protected', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(DEVGUI_HOST)).toBe(true);
  });

  it('mit gesetztem DEVGUI_HOSTNAME ist ein anderer Hostname NICHT protected', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(NORMAL_HOST)).toBe(false);
  });
});

describe('LockoutGuard — normal (non-protected) routes', () => {
  it('returns false for a normal app hostname', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(NORMAL_HOST)).toBe(false);
  });

  it('returns false for another normal hostname', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    expect(guard.isProtected(ANOTHER_HOST)).toBe(false);
  });

  it('returns false for a hostname that contains the devgui name as substring but is not equal', () => {
    const guard = new LockoutGuard({ devguiHostname: DEVGUI_HOST });
    // "not-devgui.example.com" is NOT equal to "devgui.example.com"
    expect(guard.isProtected(`not-${DEVGUI_HOST}`)).toBe(false);
    expect(guard.isProtected(`${DEVGUI_HOST}.extra`)).toBe(false);
  });
});

describe('LockoutGuard — custom protectedPatterns', () => {
  it('treats exact string match in custom patterns as protected', () => {
    const guard = new LockoutGuard({
      devguiHostname: DEVGUI_HOST,
      protectedPatterns: ['custom-protected.example.com'],
    });
    expect(guard.isProtected('custom-protected.example.com')).toBe(true);
    expect(guard.isProtected('other.example.com')).toBe(false);
  });

  it('treats RegExp match in custom patterns as protected', () => {
    const guard = new LockoutGuard({
      devguiHostname: DEVGUI_HOST,
      protectedPatterns: [/\.internal\.example\.com$/i],
    });
    expect(guard.isProtected('db.internal.example.com')).toBe(true);
    expect(guard.isProtected('public.example.com')).toBe(false);
  });
});
