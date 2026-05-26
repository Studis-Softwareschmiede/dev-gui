/**
 * Terminal.test.jsx — Light render test for Terminal component.
 *
 * @xterm/xterm and @xterm/addon-fit are replaced by stubs via moduleNameMapper.
 * TerminalConnection is mocked via jest.unstable_mockModule (ESM-compatible).
 *
 * All imports are dynamic (after mock declarations), required by
 * --experimental-vm-modules.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock wsClient ─────────────────────────────────────────────────────────
// Variables named "mock*" are allowed inside unstable_mockModule factories.
let mockOnStatusFn  = null;
let mockOnMessageFn = null;
const mockConnectFn = jest.fn();
const mockDestroyFn = jest.fn();

jest.unstable_mockModule('../wsClient.js', () => ({
  WS_STATUS: {
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    DISCONNECTED: 'disconnected',
  },
  TerminalConnection: jest.fn().mockImplementation(() => ({
    onStatus:  (fn) => { mockOnStatusFn  = fn; return () => {}; },
    onMessage: (fn) => { mockOnMessageFn = fn; return () => {}; },
    connect:   mockConnectFn,
    send:      jest.fn(),
    destroy:   mockDestroyFn,
  })),
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
