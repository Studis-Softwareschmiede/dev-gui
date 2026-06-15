/**
 * PtySessionRegistry unit tests (AC4 — S-111)
 *
 * Covers:
 *   - Multiple sessions keyed by project path
 *   - cwd per session (verified via spawnConfig)
 *   - Global fallback session (backward compat)
 *   - Session cap enforcement
 *   - Idle-close: sessions destroyed after idle timeout
 *   - Session isolation: destroy one session, others remain
 *
 * All tests use stub commands / no real PTY spawned where possible.
 * For cwd verification, PtyManager.spawnConfig is used (no real spawn needed).
 */

import { describe, it, afterEach, expect } from '@jest/globals';
import { resolve } from 'node:path';
import { PtySessionRegistry } from '../src/PtySessionRegistry.js';

// Use the current working directory so the path exists on any machine
// (avoids hardcoded worktree absolute paths that break on different setups).
const WORKTREE = resolve('.');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for a project session to be closed (emits 'session-closed'). */
function waitForSessionClosed(registry, key, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for session-closed for "${key}"`)), timeoutMs);
    const onClose = (closedKey) => {
      if (closedKey === key) {
        clearTimeout(timer);
        registry.off('session-closed', onClose);
        resolve();
      }
    };
    registry.on('session-closed', onClose);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PtySessionRegistry — AC4: multi-session keyed by project path', () => {
  let registry;
  afterEach(() => { try { registry?.destroy(); } catch { /* ignore */ } });

  it('getOrCreate() returns null before start() (global session not yet created)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000 });
    // Without start(), the global session does not exist yet
    // getOrCreate(null) delegates to global — returns null if not started
    const result = registry.getOrCreate(null);
    expect(result).toBeNull();
  });

  it('start() creates the global session; getDefault() returns it', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const global = registry.getDefault();
    expect(global).not.toBeNull();
    expect(global).toBeDefined();
  });

  it('getOrCreate(null) returns the global session (backward compat)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const a = registry.getDefault();
    const b = registry.getOrCreate(null);
    expect(a).toBe(b);
  });

  it('getOrCreate(undefined) returns the global session', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const a = registry.getDefault();
    const b = registry.getOrCreate(undefined);
    expect(a).toBe(b);
  });

  it('getOrCreate(\'\') returns the global session (empty string = global)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const a = registry.getDefault();
    const b = registry.getOrCreate('');
    expect(a).toBe(b);
  });

  it('getOrCreate(path) creates a new project session', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const session = registry.getOrCreate('/project/alpha');
    expect(session).not.toBeNull();
    // A new session is returned (different from the global session)
    expect(session).not.toBe(registry.getDefault());
  });

  it('getOrCreate(path) returns the SAME session on repeated calls (same key)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const s1 = registry.getOrCreate('/project/alpha');
    const s2 = registry.getOrCreate('/project/alpha');
    expect(s1).toBe(s2);
  });

  it('different paths → different sessions', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const alpha = registry.getOrCreate('/project/alpha');
    const beta  = registry.getOrCreate('/project/beta');
    expect(alpha).not.toBe(beta);
  });

  it('each project session has cwd set to the project path (via spawnConfig)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const session = registry.getOrCreate('/project/myrepo');
    expect(session.spawnConfig.cwd).toBe('/project/myrepo');
  });

  it('global session has cwd = undefined (inherits process.cwd)', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    const global = registry.getDefault();
    expect(global.spawnConfig.cwd).toBeUndefined();
  });

  it('sessionCount includes global + project sessions', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    expect(registry.sessionCount).toBe(1); // global only
    registry.getOrCreate('/project/alpha');
    expect(registry.sessionCount).toBe(2);
    registry.getOrCreate('/project/beta');
    expect(registry.sessionCount).toBe(3);
  });
});

describe('PtySessionRegistry — AC4: session cap', () => {
  let registry;
  afterEach(() => { try { registry?.destroy(); } catch { /* ignore */ } });

  it('returns null when session cap is reached', () => {
    // cap=2: can create 2 project sessions; 3rd → null
    registry = new PtySessionRegistry({ cap: 2, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();

    const s1 = registry.getOrCreate('/p1');
    const s2 = registry.getOrCreate('/p2');
    const s3 = registry.getOrCreate('/p3');

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).toBeNull(); // cap exceeded
  });

  it('cap does not count global session', () => {
    // cap=1: 1 project session is allowed (+ the global)
    registry = new PtySessionRegistry({ cap: 1, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();

    const s1 = registry.getOrCreate('/p1');
    const s2 = registry.getOrCreate('/p2');

    expect(s1).not.toBeNull();
    expect(s2).toBeNull(); // cap=1 reached
  });

  it('existing session returned without cap check (same key)', () => {
    registry = new PtySessionRegistry({ cap: 1, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();

    const s1 = registry.getOrCreate('/p1');
    expect(s1).not.toBeNull();

    // Same path — must return same session, no cap violation
    const s1Again = registry.getOrCreate('/p1');
    expect(s1Again).toBe(s1);

    // cap is still exhausted for new paths
    const s2 = registry.getOrCreate('/p2');
    expect(s2).toBeNull();
  });
});

describe('PtySessionRegistry — AC4: idle-close', () => {
  let registry;
  afterEach(() => { try { registry?.destroy(); } catch { /* ignore */ } });

  it('project session is auto-closed after idle timeout', async () => {
    // Use very short idleMs for test speed
    registry = new PtySessionRegistry({ cap: 3, idleMs: 100, cmd: 'echo', args: ['hi'] });
    registry.start();

    const path = '/project/ephemeral';
    registry.getOrCreate(path);
    expect(registry.sessionCount).toBe(2); // global + project

    // Wait for the idle timer to fire
    await waitForSessionClosed(registry, path, 2000);

    // Session should now be gone
    expect(registry.sessionCount).toBe(1); // only global remains
  }, 5000);

  it('idle timer is reset on getOrCreate() call for the same session', async () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 200, cmd: 'echo', args: ['hi'] });
    registry.start();

    const path = '/project/active';
    registry.getOrCreate(path);

    // Call getOrCreate again at 100ms — should reset the 200ms timer
    await new Promise((r) => setTimeout(r, 100));
    registry.getOrCreate(path); // reset timer

    // At 250ms total (100 + 150ms after reset), session should still be alive
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.sessionCount).toBe(2); // both sessions present

    // Wait for eventual close
    await waitForSessionClosed(registry, path, 2000);
    expect(registry.sessionCount).toBe(1);
  }, 5000);

  it('global session is NOT auto-closed (no idle timer)', async () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 100, cmd: 'echo', args: ['hi'] });
    registry.start();

    // Wait long enough that if the global had an idle timer it would fire
    await new Promise((r) => setTimeout(r, 300));

    // Global session must still exist
    expect(registry.getDefault()).not.toBeNull();
    expect(registry.sessionCount).toBe(1);
  }, 3000);
});

describe('PtySessionRegistry — AC4: session isolation (destroy one, others remain)', () => {
  let registry;
  afterEach(() => { try { registry?.destroy(); } catch { /* ignore */ } });

  it('closeSession() removes one project session, others untouched', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();

    const alpha = registry.getOrCreate('/p/alpha');
    const beta  = registry.getOrCreate('/p/beta');
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();
    expect(registry.sessionCount).toBe(3); // global + alpha + beta

    registry.closeSession('/p/alpha');
    expect(registry.sessionCount).toBe(2); // global + beta

    // beta session is still the same object
    expect(registry.getOrCreate('/p/beta')).toBe(beta);

    // alpha can be re-created (new session)
    const alphaNew = registry.getOrCreate('/p/alpha');
    expect(alphaNew).not.toBeNull();
    expect(alphaNew).not.toBe(alpha); // it's a fresh session
  });

  it('destroy() kills all sessions including global', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();

    registry.getOrCreate('/p/alpha');
    registry.getOrCreate('/p/beta');
    expect(registry.sessionCount).toBe(3);

    registry.destroy();
    expect(registry.sessionCount).toBe(0);
  });

  it('getOrCreate() after destroy() returns null', () => {
    registry = new PtySessionRegistry({ cap: 3, idleMs: 60_000, cmd: 'echo', args: ['hi'] });
    registry.start();
    registry.destroy();

    const s = registry.getOrCreate('/p/alpha');
    expect(s).toBeNull();
  });
});

describe('PtySessionRegistry — AC4: PtyManager cwd integration (live spawn)', () => {
  let registry;
  afterEach(() => { try { registry?.destroy(); } catch { /* ignore */ } });

  it('project session spawns in the project cwd (env output check)', async () => {
    // Use a real spawn that prints PWD to verify cwd is set correctly
    const projectPath = WORKTREE; // must exist on this machine

    registry = new PtySessionRegistry({
      cap: 3,
      idleMs: 60_000,
      cmd: '/bin/sh',
      args: ['-c', 'pwd; exit 0'],
      restartMax: 0,
      restartWindowMs: 1000,
    });
    registry.start();

    const session = registry.getOrCreate(projectPath);
    expect(session).not.toBeNull();

    // Collect output
    const chunks = [];
    session.on('output', (d) => chunks.push(d));

    session.start();

    // Wait for output to arrive (the command exits immediately)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const out = chunks.join('');
    // pwd output should contain the project path (or at least its last segment)
    expect(out).toContain(projectPath.split('/').pop());
  }, 8000);
});
