/**
 * commandRouter — Express router for the Flow-Trigger API (AC1, AC2, AC3, AC5, AC6).
 *
 * Routes (all behind the AccessGuard middleware mounted in server.js):
 *   POST /api/command         — inject a slash-command into the PTY session
 *   POST /api/command/cancel  — send Ctrl-C, cancel running command, release lock
 *
 * Multi-session extension (AC5 / S-112):
 *   POST /api/command body may include an optional `projectPath` field:
 *     { command: string, projectPath?: string }
 *   When present and a PtySessionRegistry is configured in CommandService, the
 *   command is routed to the session for the given project path.  When absent or
 *   empty, the global/default session is used (backward compat).
 *
 * Security:
 *   - AccessGuard is applied upstream (in server.js) — req.identity is already set.
 *   - CommandService performs allowlist + sanitization before any PTY write.
 *   - projectPath is validated against WORKSPACE_DIR boundary (realpath-containment)
 *     before being passed to CommandService — prevents Path-Traversal via spawn-cwd
 *     (security/R02/R03).
 *   - No raw user input reaches the PTY or logs beyond the allowlisted command.
 */

import { Router } from 'express';
import { validateProjectPath, ProjectPathError } from './workspacePath.js';

/**
 * Create and return the command router.
 *
 * @param {import('./CommandService.js').CommandService} commandService
 * @param {object} [options]
 * @param {(path: string) => Promise<{ resolvedPath: string }>} [options.pathValidator]
 *   Injectable path validator (default: validateProjectPath). Inject a stub in tests.
 * @returns {import('express').Router}
 */
export function commandRouter(commandService, options = {}) {
  const _pathValidator = options.pathValidator ?? validateProjectPath;
  const router = Router();

  /**
   * POST /api/command
   * Body: { command: string, projectPath?: string }
   *
   * Responses:
   *   202 { commandId, status: "running" }  — accepted and injected
   *   400 { error: string }                 — not in allowlist / empty / control chars / audit failure
   *   409 { error: string }                 — another command is already running
   *   429 { error: string }                 — session cap reached (too many project sessions)
   *   500 { error: string }                 — PTY write failed (internal error)
   */
  router.post('/api/command', async (req, res) => {
    const { command, projectPath } = req.body ?? {};
    // req.identity is set by AccessGuard (or dev-bypass); may be { email } or null
    const identity = req.identity ?? null;

    // Workspace-boundary validation (security/R02/R03 — Path-Traversal via spawn-cwd).
    // Only validate when projectPath is present and non-empty; null/absent → global session.
    let validatedPath = projectPath ?? null;
    if (validatedPath !== null && typeof validatedPath === 'string' && validatedPath.trim() !== '') {
      try {
        const { resolvedPath } = await _pathValidator(validatedPath);
        validatedPath = resolvedPath;
      } catch (err) {
        const reason = err instanceof ProjectPathError ? err.message : 'Invalid project path';
        return res.status(400).json({ error: `Invalid projectPath: ${reason}` });
      }
    } else {
      validatedPath = null;
    }

    const result = commandService.tryRun({ command, identity, projectPath: validatedPath });

    if (!result.ok) {
      if (result.reason === 'locked') {
        return res.status(409).json({ error: 'A command is already running' });
      }
      if (result.reason === 'session-cap') {
        return res.status(429).json({ error: 'Session cap reached — too many concurrent project sessions' });
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
