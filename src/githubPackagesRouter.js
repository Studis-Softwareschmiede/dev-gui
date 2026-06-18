/**
 * githubPackagesRouter — GET /api/github/packages + GET /api/github/packages/{name}/tags
 *
 * Read-only endpoints: lists Org container packages + tags live via GitHubPackagesReader.
 * Hinter AccessGuard (montiert via app.use('/api', accessGuard) in server.js).
 *
 * Response shapes (Spec ghcr-image-list AC2, AC3, Verträge; S-165 Reparatur):
 *   GET /api/github/packages
 *     200 { packages: [{ name, fullImageRef, visibility, htmlUrl, updatedAt }], errors? }
 *     List-path: Variante (c) — /installation/repositories + single-package probes.
 *     errors[] only contains { scope, errorClass } — no token, no internal detail (AC5).
 *
 *   GET /api/github/packages/{name}/tags
 *     200 { tags: [{ tag, digest, updatedAt }], errors? }
 *     400 { error } — when {name} fails validation (^[A-Za-z0-9._-]+$)
 *
 * Graceful degradation (AC4/AC5):
 *   - GitHub unreachable / no token / 401/404 → packages:[] or tags:[] (kein Crash, kein Secret-Leak)
 *
 * Security (security/R01, AC2/AC5):
 *   - App-Token erscheint NIE in Response, Log oder WS-Stream.
 *   - Kein POST/PATCH/PUT/DELETE auf diesem Router.
 *   - {name}-Parameter wird validiert (AC5).
 *
 * @module githubPackagesRouter
 */

import { Router } from 'express';
import { isValidPackageName } from './GitHubPackagesReader.js';

/**
 * Create the GitHub Packages router.
 *
 * @param {object} options
 * @param {import('./GitHubPackagesReader.js').GitHubPackagesReader} options.githubPackagesReader
 * @returns {import('express').Router}
 */
export function githubPackagesRouter({ githubPackagesReader }) {
  const router = Router();

  /**
   * GET /api/github/packages
   *
   * Returns all org container packages with shape
   * { name, fullImageRef, visibility, htmlUrl, updatedAt }.
   * Uses listPackagesWithErrors() to surface partial-error info (AC3).
   * Always 200 — on source failure packages:[] is returned (AC4, graceful degradation).
   * errors[] entries contain only { scope, errorClass } — no token, no internal detail (AC5).
   */
  router.get('/api/github/packages', async (_req, res) => {
    let packages;
    let errors;
    try {
      ({ packages, errors } = await githubPackagesReader.listPackagesWithErrors());
    } catch {
      // Unexpected rejection (should not happen — listPackagesWithErrors degrades internally)
      // Degrade gracefully: return empty list (AC4), never expose internals or token
      packages = [];
      errors = [];
    }

    // Security: token is only ever in GitHubPackagesReader internals — nothing sensitive here
    const body = { packages };
    if (errors.length > 0) body.errors = errors;
    return res.json(body);
  });

  /**
   * GET /api/github/packages/:name/tags
   *
   * Returns tags for a named container package with shape { tag, digest, updatedAt }.
   * Always 200 on source errors — 400 only for invalid {name} parameter (AC5).
   *
   * {name} is validated against ^[A-Za-z0-9._-]+$ before any API call is made.
   */
  router.get('/api/github/packages/:name/tags', async (req, res) => {
    const { name } = req.params;

    // AC5: validate {name} — reject path-traversal / injection chars immediately
    if (!isValidPackageName(name)) {
      return res.status(400).json({ error: 'Invalid package name' });
    }

    let tags;
    try {
      tags = await githubPackagesReader.listTags(name);
    } catch {
      // Unexpected rejection — degrade gracefully (AC5)
      tags = [];
    }

    // Security: token is only ever in GitHubPackagesReader internals — nothing sensitive here
    return res.json({ tags });
  });

  return router;
}
