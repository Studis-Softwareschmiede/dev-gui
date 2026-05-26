/**
 * AuditStore — append-only in-memory audit log (AC3).
 *
 * Records {time, identity, command} entries for every accepted command.
 * The store is intentionally append-only: no delete/update methods exposed.
 *
 * Integration contract:
 *   - `record({identity, command})` stamps `time` (ISO-8601) and appends.
 *   - If the write cannot complete (e.g. an error is thrown), the caller MUST
 *     NOT execute the command (spec: "audit write fails → command not executed").
 *   - `getAll()` returns a shallow copy of all entries in append order.
 *   - The Express route handler `auditRouter` mounts at GET /api/audit.
 *
 * Security (AC5 / security/R01):
 *   - Entries contain only time, identity (email), and command string.
 *   - No secrets, tokens, or JWTs are stored or returned.
 */

import { Router } from 'express';

/**
 * @typedef {object} AuditEntry
 * @property {string} time      - ISO-8601 timestamp
 * @property {string|null} identity - Access email of the triggering user
 * @property {string} command   - The slash-command that was executed
 */

export class AuditStore {
  /** @type {AuditEntry[]} */
  #entries = [];

  /**
   * Record an accepted command.
   * Stamps the current UTC time automatically.
   *
   * @param {object} params
   * @param {string|null} params.identity - Access email claim
   * @param {string} params.command       - Command string
   * @returns {AuditEntry} The appended entry (for callers that need confirmation)
   * @throws {Error} if identity or command are invalid (prevents silent misconfiguration)
   */
  record({ identity, command }) {
    // Validate inputs — guard against accidental undefined (security/R02)
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('[AuditStore] record() requires a non-empty command string');
    }
    // identity may legitimately be null (dev bypass), but must not be some object
    if (identity !== null && typeof identity !== 'string') {
      throw new Error('[AuditStore] record() identity must be a string or null');
    }

    /** @type {AuditEntry} */
    const entry = {
      time: new Date().toISOString(),
      identity: identity ?? null,
      command,
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Returns a shallow copy of all audit entries in append order.
   * @returns {AuditEntry[]}
   */
  getAll() {
    return [...this.#entries];
  }
}

/**
 * Returns an Express Router that serves GET /api/audit.
 * Mount with: app.use(auditRouter(store))
 *
 * @param {AuditStore} store
 * @returns {import('express').Router}
 */
export function auditRouter(store) {
  const router = Router();

  router.get('/api/audit', (_req, res) => {
    res.json(store.getAll());
  });

  return router;
}
