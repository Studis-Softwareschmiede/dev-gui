/**
 * commandRouter — Express router for the Flow-Trigger API (AC1, AC2, AC3, AC5, AC6).
 *
 * Routes (all behind the AccessGuard middleware mounted in server.js):
 *   POST /api/command         — inject a slash-command into the PTY session
 *   POST /api/command/cancel  — send Ctrl-C, cancel running command, release lock
 *
 * Security:
 *   - AccessGuard is applied upstream (in server.js) — req.identity is already set.
 *   - CommandService performs allowlist + sanitization before any PTY write.
 *   - No raw user input reaches the PTY or logs.
 */

import { Router } from 'express';

/**
 * Create and return the command router.
 *
 * @param {import('./CommandService.js').CommandService} commandService
 * @returns {import('express').Router}
 */
export function commandRouter(commandService) {
  const router = Router();

  /**
   * POST /api/command
   * Body: { command: string }
   *
   * Responses:
   *   202 { commandId, status: "running" }  — accepted and injected
   *   400 { error: string }                 — not in allowlist / empty / control chars / audit failure
   *   409 { error: string }                 — another command is already running
   *   500 { error: string }                 — PTY write failed (internal error)
   */
  router.post('/api/command', (req, res) => {
    const { command } = req.body ?? {};
    // req.identity is set by AccessGuard (or dev-bypass); may be { email } or null
    const identity = req.identity ?? null;

    const result = commandService.tryRun({ command, identity });

    if (!result.ok) {
      if (result.reason === 'locked') {
        return res.status(409).json({ error: 'A command is already running' });
      }
      if (result.reason === 'internal') {
        return res.status(500).json({ error: 'Internal error writing to session' });
      }
      // 'invalid' covers: not in allowlist, empty, control chars, audit failure
      return res.status(400).json({ error: 'Command not allowed or invalid' });
    }

    return res.status(202).json({ commandId: result.commandId, status: result.status });
  });

  /**
   * POST /api/command/cancel
   *
   * Responses:
   *   200 { cancelled: boolean }
   */
  router.post('/api/command/cancel', (req, res) => {
    const result = commandService.cancel();
    return res.status(200).json({ cancelled: result.cancelled });
  });

  return router;
}
