/**
 * boardRouterArchiveQuery.test.js — HTTP-/Router-Ebenen-Test für das
 * `includeArchived`-Query-Signal (board-feature-archive, V3).
 *
 * Covers (board-feature-archive, S-234 — includeArchived-Query-Verdrahtung):
 *   AC3/AC6 (V3) — Die GET-Routen `/api/board/projects` und
 *          `/api/board/projects/:slug` reichen das explizite Query-Signal
 *          `?includeArchived=true` als `getIndex({ includeArchived: true })` an
 *          den Aggregator durch; ohne Query (bzw. bei jedem anderen Wert) gilt
 *          `includeArchived: false` (Standardansicht). Das Frontend „Archiv
 *          anzeigen"-Schalter (S-234, BoardView) sendet dieses Signal.
 *
 * Hintergrund: S-232 lieferte den Filter im Aggregator (`getIndex({includeArchived})`,
 * belegt in boardAggregator.test.js), verdrahtete das HTTP-Query-Signal aber noch
 * nicht in den Router — dieser Test schließt die HTTP-Ebene (coder/R06).
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { boardRouter } from '../src/boardRouter.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DEMO_PROJECT = {
  slug: 'demo',
  repo_path: '/tmp/demo',
  project_slug: 'demo',
  schema_version: 1,
  features: [],
};

/**
 * Baut eine Express-App mit einem getIndex-Spy, der jedes übergebene Options-
 * Objekt aufzeichnet. Antwortet stets mit dem Demo-Projekt (Inhalt hier egal —
 * geprüft wird die Weitergabe der Option).
 */
function makeApp() {
  const calls = [];
  const boardAggregator = {
    getIndex: async (opts) => {
      calls.push(opts);
      return [DEMO_PROJECT];
    },
    scan: async () => {},
  };
  const app = express();
  app.use(express.json());
  app.use(boardRouter({ boardAggregator }));
  return { app, calls };
}

/** GET-Helfer: startet einen ephemeren Server, ruft den Pfad ab, liefert Status+Body. */
async function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      http
        .get(`http://127.0.0.1:${port}${path}`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('boardRouter — includeArchived-Query-Signal (board-feature-archive AC3/AC6)', () => {
  it('GET /api/board/projects/:slug?includeArchived=true → getIndex({ includeArchived: true })', async () => {
    const { app, calls } = makeApp();
    const res = await get(app, '/api/board/projects/demo?includeArchived=true');
    expect(res.status).toBe(200);
    expect(res.body.project.slug).toBe('demo');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ includeArchived: true });
  });

  it('GET /api/board/projects/:slug ohne Query → getIndex({ includeArchived: false }) (Standardansicht)', async () => {
    const { app, calls } = makeApp();
    const res = await get(app, '/api/board/projects/demo');
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({ includeArchived: false });
  });

  it('GET /api/board/projects/:slug?includeArchived=1 (Nicht-"true") → includeArchived: false', async () => {
    const { app, calls } = makeApp();
    await get(app, '/api/board/projects/demo?includeArchived=1');
    expect(calls[0]).toEqual({ includeArchived: false });
  });

  it('GET /api/board/projects?includeArchived=true → getIndex({ includeArchived: true }) (Fallback-Liste)', async () => {
    const { app, calls } = makeApp();
    const res = await get(app, '/api/board/projects?includeArchived=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(calls[0]).toEqual({ includeArchived: true });
  });

  it('GET /api/board/projects ohne Query → getIndex({ includeArchived: false })', async () => {
    const { app, calls } = makeApp();
    await get(app, '/api/board/projects');
    expect(calls[0]).toEqual({ includeArchived: false });
  });
});
