/**
 * JobLock tests (AC4)
 *
 * Verifies:
 *   - tryAcquire() returns true when free
 *   - second tryAcquire() returns false while held
 *   - release() frees the lock (tryAcquire() returns true again)
 *   - isHeld() reflects current state
 *   - jobLock singleton is the same instance across two imports
 */

import { describe, it, beforeEach, expect } from '@jest/globals';
import { JobLock, jobLock } from '../src/JobLock.js';

describe('JobLock — instance API', () => {
  let lock;

  beforeEach(() => {
    lock = new JobLock();
  });

  it('tryAcquire() returns true when free', () => {
    expect(lock.tryAcquire()).toBe(true);
    lock.release(); // cleanup
  });

  it('tryAcquire() returns false while held', () => {
    lock.tryAcquire();
    expect(lock.tryAcquire()).toBe(false);
    lock.release(); // cleanup
  });

  it('release() frees the lock; subsequent tryAcquire() returns true', () => {
    lock.tryAcquire();
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
    lock.release(); // cleanup
  });

  it('isHeld() is false initially', () => {
    expect(lock.isHeld()).toBe(false);
  });

  it('isHeld() is true after tryAcquire()', () => {
    lock.tryAcquire();
    expect(lock.isHeld()).toBe(true);
    lock.release();
  });

  it('isHeld() is false after release()', () => {
    lock.tryAcquire();
    lock.release();
    expect(lock.isHeld()).toBe(false);
  });

  it('release() is a no-op when lock is already free', () => {
    expect(() => lock.release()).not.toThrow();
    expect(lock.isHeld()).toBe(false);
  });

  it('multiple acquire+release cycles work correctly', () => {
    for (let i = 0; i < 5; i++) {
      expect(lock.tryAcquire()).toBe(true);
      expect(lock.isHeld()).toBe(true);
      expect(lock.tryAcquire()).toBe(false); // already held
      lock.release();
      expect(lock.isHeld()).toBe(false);
    }
  });
});

describe('jobLock — global singleton', () => {
  // Reset the singleton state before these tests (it may have been
  // left held by a previous test run in the same process)
  beforeEach(() => {
    jobLock.release();
  });

  it('exported jobLock is a JobLock instance', () => {
    expect(jobLock).toBeInstanceOf(JobLock);
  });

  it('is process-wide: same reference re-imported', async () => {
    // ESM module cache ensures the same instance is returned
    const { jobLock: jobLock2 } = await import('../src/JobLock.js');
    expect(jobLock2).toBe(jobLock);
  });

  it('singleton state is shared: acquire in one reference, check in another', async () => {
    const { jobLock: ref2 } = await import('../src/JobLock.js');
    jobLock.tryAcquire();
    expect(ref2.isHeld()).toBe(true);
    ref2.release();
    expect(jobLock.isHeld()).toBe(false);
  });
});
