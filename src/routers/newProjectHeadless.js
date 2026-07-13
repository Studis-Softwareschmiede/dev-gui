/**
 * Router-Wrapper: headless Anlage-Auslöser der Fabrik-Übersicht
 * (per-app-gpg-passphrase-provisioning AC12–AC15, F-073/S-343).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/new-project/start, POST /api/adopt/start
 */
import { newProjectHeadlessRouter } from '../newProjectHeadlessRouter.js';

export const order = 141;

/**
 * @param {{
 *   newProjectRunner: import('../HeadlessNewProjectRunner.js').HeadlessNewProjectRunner,
 *   adoptRunner: import('../HeadlessAdoptRunner.js').HeadlessAdoptRunner,
 *   resolveWorkspaceRoot: () => Promise<{ path: string, source: string }>,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ newProjectRunner, adoptRunner, resolveWorkspaceRoot }) {
  return newProjectHeadlessRouter(newProjectRunner, adoptRunner, {
    workspaceRootResolver: resolveWorkspaceRoot,
  });
}
