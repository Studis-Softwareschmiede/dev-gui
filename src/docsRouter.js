/**
 * docsRouter — Projekt-Doku-Endpunkte (read-only, lazy, hinter accessGuard).
 *
 * Routes (AC2 — projekt-spezifikation-anzeige):
 *   GET /api/board/projects/:slug/docs
 *       → { docs: DocEntry[] }  (Doku-Struktur des Projekts)
 *   GET /api/board/projects/:slug/docs/raw?path=<relpfad>
 *       → Roh-Markdown einer Datei (text/markdown; UTF-8)
 *
 * Pfad-Sicherheit (AC3):
 *   Der raw-Endpunkt delegiert die Traversal-Prüfung vollständig an DocsReader.getRaw().
 *   Der slug-Parameter wird primär als Lookup-Schlüssel gegen den Board-Index verwendet
 *   (vertrauenswürdige Quelle). Fallback: slug → Workspace-Verzeichnis, nur nach
 *   strenger Validierung via validateProjectPath (realpath-Containment gegen WORKSPACE_DIR).
 *
 * Security:
 *   - Read-only; kein Schreiben.
 *   - Hinter /api AccessGuard (app.use('/api', accessGuard) in server.js).
 *   - Keine Secrets im Output; Content-Type text/plain (kein HTML-Render).
 *   - Slug validiert via SLUG_RE (analog boardRouter): verhindert '/' und führende '.'.
 *   - Slug→Pfad-Auflösung im Fallback NUR nach validateProjectPath (zweite Schranke).
 *
 * @module docsRouter
 */

import { join } from 'node:path';
import { Router } from 'express';
import { validateProjectPath, ProjectPathError } from './workspacePath.js';

/** Valid slug characters: alphanumeric, dash, underscore, dot. No leading slash. */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Create the docs router.
 *
 * @param {object} options
 * @param {import('./BoardAggregator.js').BoardAggregator} options.boardAggregator
 * @param {import('./DocsReader.js').DocsReader} options.docsReader
 * @param {() => Promise<{ path: string, source: string }>} options.resolveWorkspaceRoot
 *   Resolver für den effektiven Workspace-Root (aus workspacePath.js).
 * @param {object} [options._deps]
 *   Injectable test dependencies (validateProjectPath override).
 * @returns {import('express').Router}
 */
export function docsRouter({ boardAggregator, docsReader, resolveWorkspaceRoot, _deps = {} }) {
  const router = Router();

  // Allow test injection of validateProjectPath (for isolation)
  const _validateProjectPath = _deps.validateProjectPath ?? validateProjectPath;

  // ── Helper: Projekt-Repo-Pfad aus Slug ermitteln ────────────────────────────

  /**
   * Sucht den repo_path eines Projekts anhand des Slug.
   *
   * Strategie (zweistufig):
   *   1. Board-Index (boardAggregator.getIndex()) — vertrauenswürdig, kein Fallback nötig.
   *   2. Fallback: slug als Workspace-Verzeichnis-Name, validiert via validateProjectPath
   *      (realpath-Containment gegen WORKSPACE_DIR). Verhindert Path-Traversal.
   *      Nur erreichbar wenn resolveWorkspaceRoot injiziert wurde.
   *
   * @param {string} slug  Bereits via SLUG_RE validierter Slug.
   * @returns {Promise<string|null>}
   */
  async function findRepoPath(slug) {
    // (1) Board-Index — bestehende Board-Repos (dev-gui, agent-flow, …)
    const projects = await boardAggregator.getIndex();
    const project = projects.find((p) => p.slug === slug);
    if (project?.repo_path) {
      return project.repo_path;
    }

    // (2) Fallback: slug als Workspace-Verzeichnis (Nicht-Board-Repos)
    // Nur wenn ein resolveWorkspaceRoot-Resolver vorhanden ist.
    if (typeof resolveWorkspaceRoot !== 'function') {
      return null;
    }

    try {
      const { path: root } = await resolveWorkspaceRoot();
      if (!root || !root.trim()) {
        return null;
      }
      const candidate = join(root, slug);
      // validateProjectPath: realpath-Containment gegen WORKSPACE_DIR + Existenz + isDirectory
      const { resolvedPath } = await _validateProjectPath(candidate);
      return resolvedPath;
    } catch (err) {
      if (err instanceof ProjectPathError) {
        // Slug ist kein gültiges Workspace-Verzeichnis → 404
        return null;
      }
      // Unerwarteter Fehler (z.B. WORKSPACE_DIR nicht gesetzt) → sicher als null behandeln
      return null;
    }
  }

  // ── GET /api/board/projects/:slug/docs ────────────────────────────────────

  /**
   * GET /api/board/projects/:slug/docs
   *
   * Liefert die Doku-Struktur (Navigation/Metadaten) des Projekts.
   * Triggert kein neues Board-Scan — nutzt den vorhandenen Index.
   *
   * Response: { docs: DocEntry[] }
   * 404 wenn Slug unbekannt / ungültig.
   * 200 mit docs:[] wenn Projekt existiert aber keine Doku vorhanden.
   */
  router.get('/api/board/projects/:slug/docs', async (req, res) => {
    const { slug } = req.params;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const repoPath = await findRepoPath(slug);
    if (!repoPath) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const docs = await docsReader.getDocs(repoPath);
    return res.json({ docs });
  });

  // ── GET /api/board/projects/:slug/docs/raw ────────────────────────────────

  /**
   * GET /api/board/projects/:slug/docs/raw?path=<relpfad>
   *
   * Liefert den Roh-Markdown-Inhalt einer einzelnen Datei.
   * Pfad-Sicherheit (AC3): DocsReader.getRaw() prüft kein `..`, kein absoluter Pfad,
   * realpath-Containment. Unerlaubte Pfade → 400 Traversal-Fehler.
   *
   * Response: text/plain; charset=utf-8 (Markdown-Rohtext)
   * 404 wenn Slug unbekannt / Datei nicht vorhanden.
   * 400 wenn Pfad-Traversal erkannt.
   */
  router.get('/api/board/projects/:slug/docs/raw', async (req, res) => {
    const { slug } = req.params;
    const relPath = req.query.path;

    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    if (!relPath || typeof relPath !== 'string' || relPath.trim() === '') {
      return res.status(400).json({ error: 'path parameter required.' });
    }

    const repoPath = await findRepoPath(slug);
    if (!repoPath) {
      return res.status(404).json({ error: 'Projekt nicht gefunden.' });
    }

    const result = await docsReader.getRaw(repoPath, relPath);

    if (result.error) {
      if (result.code === 'traversal') {
        return res.status(400).json({ error: result.error });
      }
      return res.status(404).json({ error: result.error });
    }

    // Liefere als plain text (kein HTML-Render, kein dangerouslySetInnerHTML-Risiko)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(result.content);
  });

  return router;
}
