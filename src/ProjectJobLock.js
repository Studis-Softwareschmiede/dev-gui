/**
 * ProjectJobLock — per-project concurrency lock + busy-detection
 * (docs/specs/taktgeber-nachtwaechter.md AC6/AC7).
 *
 * The process-wide `JobLock` (src/JobLock.js) allows at most ONE running job
 * across the entire process. That is sufficient for the legacy single-command
 * CommandService usage, but NOT for the future ProjectDrain engine (S-192),
 * which needs up to `maxParallel` PROJECTS to drain concurrently while still
 * guaranteeing at most one active drain per individual project
 * (Nicht-Ziel: "Kein paralleles Drainen desselben Projekts").
 *
 * `ProjectJobLock` replaces the global `JobLock` for that purpose: the lock
 * key is the absolute project path, so acquiring the lock for project A never
 * blocks project B (AC6). This module only provides the lock + busy-detection
 * primitive — wiring it into the ProjectDrain engine / CommandService is out
 * of scope here (S-192, "Neu zu bauen").
 *
 * API (mirrors JobLock.js, keyed by projectPath):
 *   tryAcquire(projectPath) → boolean   true if free and now held; false if already held
 *   release(projectPath)                releases the lock for this path (no-op if free)
 *   isHeld(projectPath) → boolean       true when the lock for this path is currently held
 *
 * Lock release discipline (Edge-Cases, "Projekt-Lock bei Crash" — analogous to
 * the lock-release discipline in CommandService): callers MUST release the
 * lock in a try/finally (or equivalent) around the drain so a crash/exception
 * never leaves a permanent lock. This module itself never auto-releases —
 * that is the caller's responsibility (same contract as JobLock).
 *
 * Security: projectPath is only ever used as a Map key, never passed to a
 * shell or filesystem call here — no injection surface.
 */

/**
 * Validate + normalise a projectPath into a Map key.
 * @param {unknown} projectPath
 * @returns {string}
 */
function normalizeKey(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw new TypeError('ProjectJobLock: projectPath must be a non-empty string (absolute project path)');
  }
  return projectPath;
}

export class ProjectJobLock {
  /** @type {Set<string>} keys of currently-held projects */
  #held = new Set();

  /**
   * Attempt to acquire the lock for a project.
   * @param {string} projectPath  absolute project path (lock key, AC6)
   * @returns {boolean} `true` if acquired, `false` if already held for this path
   */
  tryAcquire(projectPath) {
    const key = normalizeKey(projectPath);
    if (this.#held.has(key)) return false;
    this.#held.add(key);
    return true;
  }

  /**
   * Release the lock for a project.
   * Safe to call even if not currently held for this path (no-op).
   * @param {string} projectPath
   */
  release(projectPath) {
    const key = normalizeKey(projectPath);
    this.#held.delete(key);
  }

  /**
   * @param {string} projectPath
   * @returns {boolean} `true` when the lock for this path is held
   */
  isHeld(projectPath) {
    const key = normalizeKey(projectPath);
    return this.#held.has(key);
  }
}

/**
 * Process-wide singleton instance.
 * Import this — do NOT construct a new ProjectJobLock per-request when shared
 * state across the process is required (same convention as `jobLock`).
 */
export const projectJobLock = new ProjectJobLock();

/**
 * isProjectBusy — "Arbeitet jemand dran?" je Projekt (AC7).
 *
 * Busy = the project-wide lock is held for `projectPath` OR a session/command
 * is already active for that project — combining independent signals so a
 * manually-started UI run (which never touches `ProjectJobLock`) is not
 * missed (no double-trigger):
 *
 *   1. `lock.isHeld(projectPath)`                        — drain-owned lock (AC6)
 *   2. `commandService.getStatus().status === 'running'`  — a command is
 *      currently running (manual OR drain-triggered). `CommandService` today
 *      only tracks a single process-wide running command (its own `JobLock`
 *      enforces single-flight), so this signal is conservative — it does not
 *      distinguish which project the running command belongs to — but it is
 *      correct given `CommandService` exposes no per-project status yet.
 *   3. `sessionRegistry.hasSession(projectPath)`          — a live PTY session
 *      already exists for this exact project (e.g. opened in the UI).
 *
 * Any optional collaborator may be omitted (e.g. partial wiring); a missing
 * collaborator simply does not contribute to the busy result.
 *
 * @param {string} projectPath
 * @param {object} [deps]
 * @param {ProjectJobLock} [deps.lock]  default: the module singleton
 * @param {{ getStatus: () => { status: string|null } }} [deps.commandService]
 * @param {{ hasSession: (projectPath: string) => boolean }} [deps.sessionRegistry]
 * @returns {boolean}
 */
export function isProjectBusy(projectPath, { lock = projectJobLock, commandService, sessionRegistry } = {}) {
  if (lock.isHeld(projectPath)) return true;
  if (commandService && commandService.getStatus().status === 'running') return true;
  if (sessionRegistry && sessionRegistry.hasSession(projectPath)) return true;
  return false;
}
