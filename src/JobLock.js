/**
 * JobLock — process-wide single-job concurrency lock (AC4).
 *
 * Exactly ONE instance is exported as the module-level singleton (`jobLock`).
 * The CommandService (item #8) imports this singleton to enforce the global
 * 1-job limit.
 *
 * API:
 *   tryAcquire() → boolean   true if lock was free and is now held; false if already held
 *   release()                releases the lock (no-op if already free)
 *   isHeld() → boolean       true when the lock is currently held
 *
 * Thread-safety note: Node.js is single-threaded; no atomics needed.
 * The lock is process-wide because this module is a singleton (ESM module
 * cache — same instance for every importer in the same process).
 */

export class JobLock {
  #held = false;

  /**
   * Attempt to acquire the lock.
   * @returns {boolean} `true` if acquired, `false` if already held
   */
  tryAcquire() {
    if (this.#held) return false;
    this.#held = true;
    return true;
  }

  /**
   * Release the lock.
   * Safe to call even if not currently held (no-op).
   */
  release() {
    this.#held = false;
  }

  /**
   * @returns {boolean} `true` when the lock is held
   */
  isHeld() {
    return this.#held;
  }
}

/**
 * Process-wide singleton instance.
 * Import this — do NOT construct a new JobLock per-request or per-connection.
 */
export const jobLock = new JobLock();
