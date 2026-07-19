/**
 * Router-Wrapper: Ziel-Repo-Vorbereitung für den Obsidian-Ingest.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/obsidian-ingest/ensure-target,
 *           GET /api/obsidian-ingest/ensure-target/:jobId
 * (docs/specs/obsidian-question-catalog.md AC11/AC13/AC14, v3)
 *
 * Läuft strikt VOR dem unveränderten `POST .../obsidian-ingest/start`
 * (obsidianIngest.js Router) — wiederverwendet den bestehenden, bereits mit
 * `provisioningService` verdrahteten `HeadlessNewProjectRunner`
 * (`deps.newProjectRunner`, F-073/S-343) über dessen ADR-021-Naht
 * `runWithAutoProvisioning`, KEIN neuer Anlage-Mechanismus.
 */
import { obsidianTargetRouter } from '../obsidianTargetRouter.js';
import { ObsidianTargetPreparer } from '../ObsidianTargetPreparer.js';

export const order = 91;

/**
 * @param {{
 *   newProjectRunner: import('../HeadlessNewProjectRunner.js').HeadlessNewProjectRunner,
 *   resolveWorkspaceRoot: () => Promise<{ path: string, source: string }>,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ newProjectRunner, resolveWorkspaceRoot }) {
  const preparer = new ObsidianTargetPreparer({
    newProjectRunner,
    workspaceRootResolver: resolveWorkspaceRoot,
  });
  return obsidianTargetRouter(preparer);
}
