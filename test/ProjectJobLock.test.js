/**
 * ProjectJobLock tests (taktgeber-nachtwaechter AC6/AC7)
 *
 * Covers (taktgeber-nachtwaechter): AC6, AC7
 *
 *   AC6 — per-project lock keyed by absolute project path:
 *     - tryAcquire(path) returns true when free for that path
 *     - second tryAcquire(path) for the SAME path returns false while held
 *     - tryAcquire() for a DIFFERENT path is unaffected (no cross-project blocking)
 *     - release(path) frees the lock for that path only
 *     - isHeld(path) reflects current per-path state
 *     - lock survives release-on-error discipline (try/finally pattern, "kein Dauer-Lock")
 *     - projectJobLock singleton is the same instance across two imports
 *     - invalid (non-string/empty) projectPath is rejected (defensive input validation)
 *
 *   AC7 — isProjectBusy(): busy = lock-held ∪ active session ∪ active command
 *     - busy when ProjectJobLock is held for the path
 *     - busy when commandService.getStatus().status === 'running' (manual UI run)
 *     - busy when sessionRegistry.hasSession(path) is true
 *     - NOT busy when none of the three signals apply
 *     - missing optional collaborators do not throw / do not contribute
 */

import { describe, it, beforeEach, expect } from '@jest/globals';
import { ProjectJobLock, projectJobLock, isProjectBusy } from '../src/ProjectJobLock.js';

const PATH_A = '/workspace/project-a';
const PATH_B = '/workspace/project-b';

describe('ProjectJobLock — instance API (AC6)', () => {
  let lock;

  beforeEach(() => {
    lock = new ProjectJobLock();
  });

  it('tryAcquire(path) returns true when free for that path', () => {
    expect(lock.tryAcquire(PATH_A)).toBe(true);
    lock.release(PATH_A); // cleanup
  });

  it('second tryAcquire(path) for the same path returns false while held', () => {
    lock.tryAcquire(PATH_A);
    expect(lock.tryAcquire(PATH_A)).toBe(false);
    lock.release(PATH_A);
  });

  it('tryAcquire() for a different path is unaffected (no cross-project blocking)', () => {
    expect(lock.tryAcquire(PATH_A)).toBe(true);
    expect(lock.tryAcquire(PATH_B)).toBe(true);
    expect(lock.isHeld(PATH_A)).toBe(true);
    expect(lock.isHeld(PATH_B)).toBe(true);
    lock.release(PATH_A);
    lock.release(PATH_B);
  });

  it('release(path) frees the lock for that path only', () => {
    lock.tryAcquire(PATH_A);
    lock.tryAcquire(PATH_B);
    lock.release(PATH_A);
    expect(lock.isHeld(PATH_A)).toBe(false);
    expect(lock.isHeld(PATH_B)).toBe(true);
    lock.release(PATH_B);
  });

  it('isHeld(path) is false initially', () => {
    expect(lock.isHeld(PATH_A)).toBe(false);
  });

  it('isHeld(path) is true after tryAcquire(path)', () => {
    lock.tryAcquire(PATH_A);
    expect(lock.isHeld(PATH_A)).toBe(true);
    lock.release(PATH_A);
  });

  it('isHeld(path) is false after release(path)', () => {
    lock.tryAcquire(PATH_A);
    lock.release(PATH_A);
    expect(lock.isHeld(PATH_A)).toBe(false);
  });

  it('release(path) is a no-op when not held for that path', () => {
    expect(() => lock.release(PATH_A)).not.toThrow();
    expect(lock.isHeld(PATH_A)).toBe(false);
  });

  it('lock is always released after an error in the protected section (try/finally discipline, "kein Dauer-Lock")', () => {
    lock.tryAcquire(PATH_A);
    try {
      throw new Error('drain failed mid-flight');
    } catch {
      // swallow — simulate the drain's own error handling
    } finally {
      lock.release(PATH_A);
    }
    expect(lock.isHeld(PATH_A)).toBe(false);
    // lock is acquirable again immediately — no permanent lock left behind
    expect(lock.tryAcquire(PATH_A)).toBe(true);
    lock.release(PATH_A);
  });

  it('multiple acquire+release cycles work correctly per path', () => {
    for (let i = 0; i < 5; i++) {
      expect(lock.tryAcquire(PATH_A)).toBe(true);
      expect(lock.isHeld(PATH_A)).toBe(true);
      expect(lock.tryAcquire(PATH_A)).toBe(false); // already held
      lock.release(PATH_A);
      expect(lock.isHeld(PATH_A)).toBe(false);
    }
  });

  it('rejects a non-string projectPath', () => {
    expect(() => lock.tryAcquire(null)).toThrow(TypeError);
    expect(() => lock.tryAcquire(undefined)).toThrow(TypeError);
    expect(() => lock.tryAcquire(42)).toThrow(TypeError);
  });

  it('rejects an empty/whitespace-only projectPath', () => {
    expect(() => lock.tryAcquire('')).toThrow(TypeError);
    expect(() => lock.tryAcquire('   ')).toThrow(TypeError);
  });
});

describe('projectJobLock — global singleton (AC6)', () => {
  beforeEach(() => {
    projectJobLock.release(PATH_A);
    projectJobLock.release(PATH_B);
  });

  it('exported projectJobLock is a ProjectJobLock instance', () => {
    expect(projectJobLock).toBeInstanceOf(ProjectJobLock);
  });

  it('is process-wide: same reference re-imported', async () => {
    const { projectJobLock: ref2 } = await import('../src/ProjectJobLock.js');
    expect(ref2).toBe(projectJobLock);
  });

  it('singleton state is shared per path: acquire in one reference, check in another', async () => {
    const { projectJobLock: ref2 } = await import('../src/ProjectJobLock.js');
    projectJobLock.tryAcquire(PATH_A);
    expect(ref2.isHeld(PATH_A)).toBe(true);
    expect(ref2.isHeld(PATH_B)).toBe(false);
    ref2.release(PATH_A);
    expect(projectJobLock.isHeld(PATH_A)).toBe(false);
  });
});

describe('isProjectBusy() — busy = lock ∪ active session ∪ active command (AC7)', () => {
  let lock;

  beforeEach(() => {
    lock = new ProjectJobLock();
  });

  it('is NOT busy when no signal applies', () => {
    const commandService = { getStatus: () => ({ commandId: null, status: null }) };
    const sessionRegistry = { hasSession: () => false };
    expect(isProjectBusy(PATH_A, { lock, commandService, sessionRegistry })).toBe(false);
  });

  it('is busy when the project lock is held', () => {
    lock.tryAcquire(PATH_A);
    const commandService = { getStatus: () => ({ commandId: null, status: null }) };
    const sessionRegistry = { hasSession: () => false };
    expect(isProjectBusy(PATH_A, { lock, commandService, sessionRegistry })).toBe(true);
    lock.release(PATH_A);
  });

  it('is busy when commandService reports a running command (manual UI run)', () => {
    const commandService = { getStatus: () => ({ commandId: 'cmd-1', status: 'running' }) };
    const sessionRegistry = { hasSession: () => false };
    expect(isProjectBusy(PATH_A, { lock, commandService, sessionRegistry })).toBe(true);
  });

  it('is NOT busy when commandService reports a "done" command (not running)', () => {
    const commandService = { getStatus: () => ({ commandId: 'cmd-1', status: 'done' }) };
    const sessionRegistry = { hasSession: () => false };
    expect(isProjectBusy(PATH_A, { lock, commandService, sessionRegistry })).toBe(false);
  });

  it('is busy when sessionRegistry reports an active session for the path', () => {
    const commandService = { getStatus: () => ({ commandId: null, status: null }) };
    const sessionRegistry = { hasSession: (p) => p === PATH_A };
    expect(isProjectBusy(PATH_A, { lock, commandService, sessionRegistry })).toBe(true);
    // A different project is unaffected
    expect(isProjectBusy(PATH_B, { lock, commandService, sessionRegistry })).toBe(false);
  });

  it('missing optional collaborators do not throw and do not contribute', () => {
    expect(() => isProjectBusy(PATH_A, { lock })).not.toThrow();
    expect(isProjectBusy(PATH_A, { lock })).toBe(false);
  });

  it('uses the projectJobLock singleton by default when no lock is injected', () => {
    projectJobLock.tryAcquire(PATH_A);
    expect(isProjectBusy(PATH_A)).toBe(true);
    projectJobLock.release(PATH_A);
    expect(isProjectBusy(PATH_A)).toBe(false);
  });
});
