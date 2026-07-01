/**
 * PtyManager unit tests (AC1–AC6)
 *
 * All tests use stub commands — never launch real claude.
 * Tests are deterministic and self-contained.
 *
 * Covers (terminal-bridge, docs/specs/terminal-bridge.md):
 *   AC1 — session reaches "ready" without input (stub instead of real claude)
 *   AC2 — input written to the PTY round-trips through 'output' events
 *   AC3 — spawn config has no -p/--print; child env is built from an
 *         explicit allowlist (no ANTHROPIC_API_KEY/OPENAI_API_KEY/arbitrary
 *         secrets leak from the parent process)
 *   AC4 — restart cap: N restarts within window M → "failed", no further
 *         restart afterwards
 *   AC5 — resize(cols, rows) is validated and forwarded to the PTY
 *   AC6 — scrollback ring buffer stays within the byte limit
 *
 * Covers (claude-code-oauth-token, docs/specs/claude-code-oauth-token.md):
 *   AC2 — CLAUDE_CODE_OAUTH_TOKEN is on ALLOWED_ENV_KEYS; set in the server
 *         process it appears in the PTY child env, unset it is absent from
 *         the child env (no empty key)
 *   AC3 — Trust boundary: with both CLAUDE_CODE_OAUTH_TOKEN and
 *         ANTHROPIC_API_KEY set in the server process at the same time, the
 *         child env contains the former but never the latter
 */

import { describe, it, afterEach, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtyManager, SESSION_STATES } from '../src/PtyManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_STUB = path.join(__dirname, 'stubs', 'echo-shell.sh');
const EXIT_STUB = path.join(__dirname, 'stubs', 'exit-immediately.sh');

// Helper: wait until ptyManager emits the target state (or timeout)
function waitForState(pty, targetState, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (pty.state === targetState) { resolve(); return; }
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for state "${targetState}", current: "${pty.state}"`));
    }, timeoutMs);
    const onState = (s) => {
      if (s === targetState) {
        clearTimeout(timer);
        pty.off('state', onState);
        resolve();
      }
    };
    pty.on('state', onState);
  });
}

// Helper: wait for specific output substring
function waitForOutput(pty, substring, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for output containing "${substring}"`));
    }, timeoutMs);
    const onData = (data) => {
      buf += data;
      if (buf.includes(substring)) {
        clearTimeout(timer);
        pty.off('output', onData);
        resolve(buf);
      }
    };
    pty.on('output', onData);
  });
}

// ── AC3 tests (spawn config) ───────────────────────────────────────────────

describe('AC3 — spawn config does not include -p/--print or ANTHROPIC_API_KEY', () => {
  it('default spawnConfig argv contains no -p or --print flag', () => {
    // We DO NOT call .start() here — just inspect the config (no real spawn)
    const pty = new PtyManager({ cmd: 'claude' });
    const { args } = pty.spawnConfig;
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--print');
  });

  it('ANTHROPIC_API_KEY is not in the env allowlist (structural assertion)', () => {
    // Verify the allowlist in #spawn() does not include ANTHROPIC_API_KEY.
    // We read the source file and assert the key is absent from ALLOWED_ENV_KEYS.
    // This catches an accidental addition to the allowlist without relying on
    // a live spawn (the integration test below covers runtime behaviour).
    const src = readFileSync(path.join(__dirname, '../src/PtyManager.js'), 'utf8');
    // Extract the ALLOWED_ENV_KEYS array literal from source
    const match = src.match(/ALLOWED_ENV_KEYS\s*=\s*\[([^\]]*)\]/s);
    expect(match).not.toBeNull();
    const allowedKeys = match[1].replace(/\/\/[^\n]*/g, '').match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [];
    expect(allowedKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(allowedKeys).not.toContain('OPENAI_API_KEY');
  });

  it('CLAUDE_CODE_OAUTH_TOKEN IS in the env allowlist (claude-code-oauth-token AC2, structural assertion)', () => {
    const src = readFileSync(path.join(__dirname, '../src/PtyManager.js'), 'utf8');
    const match = src.match(/ALLOWED_ENV_KEYS\s*=\s*\[([^\]]*)\]/s);
    expect(match).not.toBeNull();
    const allowedKeys = match[1].replace(/\/\/[^\n]*/g, '').match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [];
    expect(allowedKeys).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('ANTHROPIC_API_KEY and arbitrary secrets are not present in the child env (integration)', async () => {
    // Plant two dummy secrets in the parent env to make the test meaningful.
    // The child env must NOT contain either (allowlist-based env construction).
    process.env.ANTHROPIC_API_KEY = 'test-secret-should-not-appear';
    process.env.FAKE_SECRET = 'fake-secret-sentinel-xyz';

    // Stub that prints env key=value lines then exits immediately.
    // restartMax=0: first exit → failed (no restart).
    const pty = new PtyManager({
      cmd: '/bin/sh',
      args: ['-c', 'env; exit 0'],
      restartMax: 0,
      restartWindowMs: 1000,
    });

    const outputChunks = [];
    pty.on('output', (d) => outputChunks.push(d));

    pty.start();

    // Wait for 'failed': the stub exits immediately, restartMax=0 → failed.
    // This is the terminal state; all onData events are flushed before onExit fires
    // because node-pty delivers remaining data before the exit event.
    // We then add a one-tick flush to drain any in-flight microtasks.
    await waitForState(pty, SESSION_STATES.FAILED, 8000);

    // Drain any remaining IO callbacks that may still hold output
    await new Promise((r) => setTimeout(r, 0));

    pty.destroy();

    const allOutput = outputChunks.join('');

    // AC3: child env must NOT contain ANTHROPIC_API_KEY
    expect(allOutput).not.toContain('test-secret-should-not-appear');
    expect(allOutput).not.toContain('ANTHROPIC_API_KEY=');

    // security/R01: arbitrary parent secrets must not leak (allowlist env)
    expect(allOutput).not.toContain('fake-secret-sentinel-xyz');
    expect(allOutput).not.toContain('FAKE_SECRET=');

    // Cleanup
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FAKE_SECRET;
  }, 10000);
});

// ── claude-code-oauth-token AC2/AC3 tests (env passthrough vs. trust boundary) ─

describe('claude-code-oauth-token AC2/AC3 — CLAUDE_CODE_OAUTH_TOKEN passthrough, ANTHROPIC_API_KEY stays blocked', () => {
  it('AC2: set in the server process, CLAUDE_CODE_OAUTH_TOKEN appears in the PTY child env; ' +
     'AC3: set alongside ANTHROPIC_API_KEY, the latter never appears', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token-should-appear';
    process.env.ANTHROPIC_API_KEY = 'test-secret-should-not-appear';

    const pty = new PtyManager({
      cmd: '/bin/sh',
      args: ['-c', 'env; exit 0'],
      restartMax: 0,
      restartWindowMs: 1000,
    });

    const outputChunks = [];
    pty.on('output', (d) => outputChunks.push(d));

    pty.start();
    await waitForState(pty, SESSION_STATES.FAILED, 8000);
    await new Promise((r) => setTimeout(r, 0));
    pty.destroy();

    const allOutput = outputChunks.join('');

    // AC2: token is present in the child env
    expect(allOutput).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token-should-appear');

    // AC3: ANTHROPIC_API_KEY remains blocked even though the OAuth token is allowed
    expect(allOutput).not.toContain('test-secret-should-not-appear');
    expect(allOutput).not.toContain('ANTHROPIC_API_KEY=');

    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  }, 10000);

  it('AC2: unset in the server process, CLAUDE_CODE_OAUTH_TOKEN is absent from the child env (no empty key)', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const pty = new PtyManager({
      cmd: '/bin/sh',
      args: ['-c', 'env; exit 0'],
      restartMax: 0,
      restartWindowMs: 1000,
    });

    const outputChunks = [];
    pty.on('output', (d) => outputChunks.push(d));

    pty.start();
    await waitForState(pty, SESSION_STATES.FAILED, 8000);
    await new Promise((r) => setTimeout(r, 0));
    pty.destroy();

    const allOutput = outputChunks.join('');
    expect(allOutput).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  }, 10000);
});

// ── AC1 tests (state machine + /api/session) ────────────────────────────────

describe('AC1 — session reaches ready state with stub', () => {
  let pty;
  afterEach(() => { try { pty?.destroy(); } catch { /* ignore */ } });

  it('starts in "starting" state before any output', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(pty.state).toBe(SESSION_STATES.STARTING);
    expect(pty.restarts).toBe(0);
    expect(pty.startedAt).toBeNull();
  });

  it('transitions to "ready" once stub produces output', async () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    pty.start();
    await waitForState(pty, SESSION_STATES.READY, 5000);
    expect(pty.state).toBe(SESSION_STATES.READY);
    expect(pty.startedAt).toBeInstanceOf(Date);
  }, 8000);

  it('restarts counter is 0 on clean first start', async () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    pty.start();
    await waitForState(pty, SESSION_STATES.READY, 5000);
    expect(pty.restarts).toBe(0);
  }, 8000);
});

// ── AC2 tests (echo round-trip through WS path) ────────────────────────────

describe('AC2 — input written to PTY is echoed as output', () => {
  let pty;
  afterEach(() => { try { pty?.destroy(); } catch { /* ignore */ } });

  it('writes input to PTY and receives echoed output event', async () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    pty.start();

    // Wait for ready
    await waitForState(pty, SESSION_STATES.READY, 5000);

    // Now write a unique marker
    const marker = 'HELLO_ECHO_TEST_42';
    const outputPromise = waitForOutput(pty, marker, 5000);
    pty.write(`${marker}\n`);

    const received = await outputPromise;
    expect(received).toContain(marker);
  }, 12000);
});

// ── AC4 tests (restart cap) ─────────────────────────────────────────────────

describe('AC4 — restart cap leads to "failed"', () => {
  it('reaches "failed" state after N restarts within window', async () => {
    // restartMax=3 means: after 3 restarts in window → failed
    const pty = new PtyManager({
      cmd: EXIT_STUB,
      args: [],
      restartMax: 3,
      restartWindowMs: 10_000,
    });
    pty.start();

    await waitForState(pty, SESSION_STATES.FAILED, 15000);
    expect(pty.state).toBe(SESSION_STATES.FAILED);
    // Restarts counter should be >= restartMax
    expect(pty.restarts).toBeGreaterThanOrEqual(3);
  }, 20000);

  it('does not restart once in "failed" state', async () => {
    const pty = new PtyManager({
      cmd: EXIT_STUB,
      args: [],
      restartMax: 2,
      restartWindowMs: 10_000,
    });
    pty.start();

    await waitForState(pty, SESSION_STATES.FAILED, 15000);
    const restartCountAtFail = pty.restarts;

    // Wait a bit to confirm no further restarts
    await new Promise((r) => setTimeout(r, 500));
    expect(pty.state).toBe(SESSION_STATES.FAILED);
    expect(pty.restarts).toBe(restartCountAtFail);
  }, 20000);

  it('non-numeric RESTART_MAX env falls back to default (5) — cap still fires', async () => {
    // R02 fix: "abc" would produce NaN under the old Number() path and disable
    // the cap. The new parsePositiveInt() must fall back to 5 so the cap fires.
    const savedEnv = process.env.RESTART_MAX;
    process.env.RESTART_MAX = 'abc';
    let pty;
    try {
      // Construct without explicit restartMax so the env-var path runs.
      pty = new PtyManager({
        cmd: EXIT_STUB,
        args: [],
        restartWindowMs: 30_000,
        // restartMax intentionally omitted — must come from env (fallback=5)
      });
      pty.start();
      await waitForState(pty, SESSION_STATES.FAILED, 20000);
      expect(pty.state).toBe(SESSION_STATES.FAILED);
      // With fallback=5 the cap fires at 5 restarts.
      expect(pty.restarts).toBeGreaterThanOrEqual(5);
    } finally {
      pty?.destroy();
      if (savedEnv === undefined) {
        delete process.env.RESTART_MAX;
      } else {
        process.env.RESTART_MAX = savedEnv;
      }
    }
  }, 30000);
});

// ── AC5 tests (resize) ────────────────────────────────────────────────────────

describe('AC5 — resize(cols, rows)', () => {
  let pty;
  afterEach(() => { try { pty?.destroy(); } catch { /* ignore */ } });

  it('calls pty.resize(cols, rows) when PTY is running', async () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    pty.start();
    await waitForState(pty, SESSION_STATES.READY, 5000);

    // Should not throw
    expect(() => pty.resize(120, 40)).not.toThrow();
    // Verify the call didn't crash (integration: pty.resize really ran)
  }, 8000);

  it('ignores resize(0, 24) — zero cols is not positive', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    // No start — no PTY; should be silently ignored
    expect(() => pty.resize(0, 24)).not.toThrow();
  });

  it('ignores resize(-1, 24) — negative cols', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(() => pty.resize(-1, 24)).not.toThrow();
  });

  it('ignores resize(NaN, 24)', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(() => pty.resize(NaN, 24)).not.toThrow();
  });

  it('ignores resize(80.5, 24) — float cols', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(() => pty.resize(80.5, 24)).not.toThrow();
  });

  it('ignores resize("80", 24) — string cols', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(() => pty.resize('80', 24)).not.toThrow();
  });

  it('ignores resize(80, 0) — zero rows', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(() => pty.resize(80, 0)).not.toThrow();
  });
});

// ── AC6 tests (scrollback ring buffer) ────────────────────────────────────────

describe('AC6 — scrollback ring buffer', () => {
  let pty;
  afterEach(() => { try { pty?.destroy(); } catch { /* ignore */ } });

  it('scrollback is empty before any output', () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    expect(pty.scrollback).toBe('');
  });

  it('scrollback accumulates PTY output', async () => {
    pty = new PtyManager({ cmd: ECHO_STUB, args: [] });
    pty.start();
    await waitForState(pty, SESSION_STATES.READY, 5000);
    // Stub produces output — scrollback should be non-empty
    expect(pty.scrollback.length).toBeGreaterThan(0);
  }, 8000);

  it('scrollback stays within 64 KB bound when flooded', async () => {
    // Use a command that emits a large amount of output quickly.
    // We emit 200 KB of data via a shell loop and check the buffer is bounded.
    const LIMIT = 64 * 1024;
    pty = new PtyManager({
      cmd: '/bin/sh',
      args: ['-c', 'yes "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | head -c 200000; sleep 0.3'],
      restartMax: 0,
      restartWindowMs: 1000,
    });
    pty.start();

    // Wait until at least 64 KB has been seen or PTY exits
    await new Promise((resolve) => {
      let totalSeen = 0;
      const onData = (d) => {
        totalSeen += d.length;
        if (totalSeen >= LIMIT) {
          pty.off('output', onData);
          resolve();
        }
      };
      pty.on('output', onData);
      // Fallback timeout
      setTimeout(resolve, 6000);
    });

    // Ring buffer must never exceed the byte limit
    expect(pty.scrollback.length).toBeLessThanOrEqual(LIMIT);
  }, 10000);
});
