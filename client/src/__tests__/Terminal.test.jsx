/**
 * Terminal.test.jsx — Light render test for Terminal component.
 *
 * @xterm/xterm and @xterm/addon-fit are replaced by stubs via moduleNameMapper.
 * TerminalConnection is mocked via jest.unstable_mockModule (ESM-compatible).
 *
 * All imports are dynamic (after mock declarations), required by
 * --experimental-vm-modules.
 *
 * Covers (vps-ssh-terminal AC2/AC4 — reused, opt-in Terminal.jsx capabilities):
 *   AC2 — `openPayload` prop is passed through verbatim to `TerminalConnection`.
 *   AC4 — `{type:"error"}` messages are written into the terminal output; a
 *          first-ever-disconnect (never reached CONNECTED) while `openPayload`
 *          is set shows a "Keine Berechtigung" message exactly once (WS-upgrade
 *          403 case, vps-ssh-terminal AC4) — absent for the default Claude-Terminal
 *          usage (no `openPayload`), regression-guarded explicitly below.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock wsClient ─────────────────────────────────────────────────────────
// Variables named "mock*" are allowed inside unstable_mockModule factories.
let mockOnStatusFn  = null;
let mockOnMessageFn = null;
const mockConnectFn    = jest.fn();
const mockDestroyFn    = jest.fn();
const mockSendResizeFn = jest.fn();
const mockTerminalConnectionCtor = jest.fn();

jest.unstable_mockModule('../wsClient.js', () => ({
  WS_STATUS: {
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    DISCONNECTED: 'disconnected',
  },
  TerminalConnection: jest.fn().mockImplementation((url, opts) => {
    mockTerminalConnectionCtor(url, opts);
    return {
      onStatus:   (fn) => { mockOnStatusFn  = fn; return () => {}; },
      onMessage:  (fn) => { mockOnMessageFn = fn; return () => {}; },
      connect:    mockConnectFn,
      send:       jest.fn(),
      sendResize: mockSendResizeFn,
      destroy:    mockDestroyFn,
    };
  }),
}));

// Dynamic imports AFTER mock declarations (ESM VM-modules requirement)
const { Terminal }          = await import('../Terminal.jsx');
const { Terminal: XTermStub } = await import('@xterm/xterm');
const { render, act }       = await import('@testing-library/react');
const React                 = (await import('react')).default;

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockOnStatusFn  = null;
  mockOnMessageFn = null;
  mockConnectFn.mockClear();
  mockDestroyFn.mockClear();
  mockSendResizeFn.mockClear();
  mockTerminalConnectionCtor.mockClear();
  XTermStub._reset();
});

describe('Terminal component — render', () => {
  it('renders status bar with initial connecting label', () => {
    const { getByRole } = render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const status = getByRole('status');
    expect(status.textContent).toContain('verbinde');
  });

  it('calls connect() on mount', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    expect(mockConnectFn).toHaveBeenCalled();
  });
});

describe('Terminal component — status updates', () => {
  it('updates status text when WS status changes to connected', () => {
    const { getByRole } = render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));

    act(() => { mockOnStatusFn('connected'); });

    const status = getByRole('status');
    expect(status.textContent).toContain('verbunden');
    expect(status.dataset.status).toBe('connected');
  });

  it('updates status text when WS status changes to disconnected', () => {
    const { getByRole } = render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));

    act(() => { mockOnStatusFn('disconnected'); });

    const status = getByRole('status');
    expect(status.textContent).toContain('getrennt');
    expect(status.dataset.status).toBe('disconnected');
  });
});

describe('Terminal component — message handling', () => {
  it('writes output messages to the xterm instance', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const xterm = XTermStub._lastInstance;

    act(() => {
      mockOnMessageFn({ type: 'output', data: '\x1b[32mHello\x1b[0m' });
    });

    expect(xterm.write).toHaveBeenCalledWith('\x1b[32mHello\x1b[0m');
  });

  it('does NOT write to xterm for non-output messages', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const xterm = XTermStub._lastInstance;

    act(() => {
      mockOnMessageFn({ type: 'state', state: 'running' });
    });

    expect(xterm.write).not.toHaveBeenCalled();
  });
});

describe('Terminal component — focus trap (WCAG 2.1 SC 2.1.2)', () => {
  it('registers attachCustomKeyEventHandler on xterm', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    expect(typeof XTermStub._lastKeyEventHandler).toBe('function');
  });

  it('returns false for Tab keydown so xterm skips it and browser Tab-nav works', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const handler = XTermStub._lastKeyEventHandler;
    expect(handler({ type: 'keydown', key: 'Tab' })).toBe(false);
  });

  it('returns true for non-Tab keys so xterm handles them normally', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const handler = XTermStub._lastKeyEventHandler;
    expect(handler({ type: 'keydown', key: 'Enter' })).toBe(true);
    expect(handler({ type: 'keyup',   key: 'Tab'   })).toBe(true);
  });
});

describe('Terminal component — cleanup on unmount', () => {
  it('calls connection destroy() and xterm dispose() when unmounted', () => {
    const { unmount } = render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const xterm = XTermStub._lastInstance;

    unmount();

    expect(mockDestroyFn).toHaveBeenCalled();
    expect(xterm.dispose).toHaveBeenCalled();
  });
});

describe('Terminal component — AC5 resize propagation', () => {
  it('calls sendResize with xterm cols/rows when WS status becomes connected', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnStatusFn('connected'); });

    expect(mockSendResizeFn).toHaveBeenCalledWith(xterm.cols, xterm.rows);
  });

  it('does not call sendResize when WS status is connecting or disconnected', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));

    act(() => { mockOnStatusFn('connecting'); });
    act(() => { mockOnStatusFn('disconnected'); });

    expect(mockSendResizeFn).not.toHaveBeenCalled();
  });
});

describe('Terminal component — openPayload (vps-ssh-terminal AC2)', () => {
  it('passes openPayload through to TerminalConnection verbatim', () => {
    const openPayload = { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' };
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/vps-terminal', openPayload }));

    expect(mockTerminalConnectionCtor).toHaveBeenCalledWith(
      'ws://localhost:8080/ws/vps-terminal',
      expect.objectContaining({ openPayload }),
    );
  });

  it('passes openPayload: undefined for the default (Claude-Terminal) usage', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));

    expect(mockTerminalConnectionCtor).toHaveBeenCalledWith(
      'ws://localhost:8080/ws/terminal',
      expect.objectContaining({ openPayload: undefined }),
    );
  });
});

describe('Terminal component — {type:"error"} messages (vps-ssh-terminal AC4)', () => {
  it('writes a geheimnisfreie error message into the terminal output', () => {
    render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));
    const xterm = XTermStub._lastInstance;

    act(() => {
      mockOnMessageFn({ type: 'error', errorClass: 'auth-failed', reason: 'SSH-Authentifizierung fehlgeschlagen' });
    });

    expect(xterm.write).toHaveBeenCalledWith(expect.stringContaining('SSH-Authentifizierung fehlgeschlagen'));
    expect(xterm.write).toHaveBeenCalledWith(expect.stringContaining('auth-failed'));
  });

  it('also renders the error text in a role="alert" element (WCAG AA — xterm canvas is not AT-accessible)', () => {
    const { getByRole } = render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));

    act(() => {
      mockOnMessageFn({ type: 'error', errorClass: 'auth-failed', reason: 'SSH-Authentifizierung fehlgeschlagen' });
    });

    const alert = getByRole('alert');
    expect(alert.textContent).toContain('SSH-Authentifizierung fehlgeschlagen');
    expect(alert.style.display).not.toBe('none');
  });

  it('does not affect output-message handling', () => {
    render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnMessageFn({ type: 'output', data: 'hello' }); });

    expect(xterm.write).toHaveBeenCalledWith('hello');
  });
});

describe('Terminal component — first-connect-never-succeeded ⇒ "Keine Berechtigung" (vps-ssh-terminal AC4, 403)', () => {
  it('writes a "Keine Berechtigung" message once, when openPayload is set and the connection never reached connected', () => {
    render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnStatusFn('disconnected'); }); // never was 'connected' before this

    expect(xterm.write).toHaveBeenCalledWith(expect.stringContaining('Keine Berechtigung'));
  });

  it('also renders "Keine Berechtigung" in a role="alert" element (WCAG AA)', () => {
    const { getByRole } = render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));

    act(() => { mockOnStatusFn('disconnected'); });

    const alert = getByRole('alert');
    expect(alert.textContent).toContain('Keine Berechtigung');
    expect(alert.style.display).not.toBe('none');
  });

  it('shows the message only once even across repeated retry-disconnects', () => {
    render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnStatusFn('disconnected'); });
    act(() => { mockOnStatusFn('connecting'); });
    act(() => { mockOnStatusFn('disconnected'); });

    const forbiddenWrites = xterm.write.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Keine Berechtigung'),
    );
    expect(forbiddenWrites).toHaveLength(1);
  });

  it('does NOT show the message once the connection has already succeeded before disconnecting', () => {
    render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnStatusFn('connected'); });
    act(() => { mockOnStatusFn('disconnected'); }); // normal drop after a real session

    const forbiddenWrites = xterm.write.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Keine Berechtigung'),
    );
    expect(forbiddenWrites).toHaveLength(0);
  });

  it('does NOT show the message for the default Claude-Terminal usage (no openPayload) — regression guard', () => {
    render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));
    const xterm = XTermStub._lastInstance;

    act(() => { mockOnStatusFn('disconnected'); });

    const forbiddenWrites = xterm.write.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Keine Berechtigung'),
    );
    expect(forbiddenWrites).toHaveLength(0);
  });
});

describe('Terminal component — role="alert" element (WCAG AA, vps-ssh-terminal AC4) — regression guards', () => {
  it('the alert element is present but empty/hidden by default (no error yet)', () => {
    const { getByRole, queryByRole } = render(React.createElement(Terminal, {
      wsUrl: 'ws://localhost:8080/ws/vps-terminal',
      openPayload: { type: 'open', provider: 'hetzner', serverId: '1', user: 'root' },
    }));

    // testing-library excludes display:none elements from role queries — hidden by default
    expect(queryByRole('alert')).toBeNull();
    // ...but present in the DOM (via container fallback query, ignoring visibility)
    act(() => { mockOnMessageFn({ type: 'error', errorClass: 'error', reason: 'x' }); });
    expect(getByRole('alert')).toBeDefined();
  });

  it('stays empty/hidden for the default Claude-Terminal usage (no openPayload, no error ever sent)', () => {
    const { queryByRole } = render(React.createElement(Terminal, { wsUrl: 'ws://localhost:8080/ws/terminal' }));

    act(() => { mockOnStatusFn('connecting'); });
    act(() => { mockOnStatusFn('disconnected'); }); // repeated backoff-retry disconnects too

    // Claude-Terminal never sends {type:"error"}; the alert node stays hidden/empty
    expect(queryByRole('alert')).toBeNull();
  });
});
