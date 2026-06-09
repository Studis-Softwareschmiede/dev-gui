/**
 * versionRouter — GET /api/version
 *
 * Returns the image build version baked in at build time via APP_VERSION env var.
 * Fallback: "dev" (used in local development or when the env var is not set).
 *
 * Response shape: { version: string }
 *
 * Security: no secrets exposed — APP_VERSION contains only the timestamp string.
 *
 * @module versionRouter
 */

import { Router } from 'express';

/**
 * Create the version router.
 *
 * @returns {import('express').Router}
 */
export function versionRouter() {
  const router = Router();

  /**
   * GET /api/version
   *
   * Returns the build version from APP_VERSION or "dev" as fallback.
   * Always 200.
   */
  router.get('/api/version', (_req, res) => {
    res.json({ version: process.env.APP_VERSION || 'dev' });
  });

  return router;
}
