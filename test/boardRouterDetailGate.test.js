/**
 * boardRouterDetailGate.test.js — Lauf-Metrik-Gate der Story-Detail-Route.
 *
 * Regression: Eine Story im Status "To Do" wurde nie gestartet und darf daher
 * KEINE Lauf-Daten (Start/Ende/Dauer/Agenten-Flow) zeigen. Das robuste ID-Matching
 * im StoryMetricReader (Zahl ↔ "S-###") konnte sonst alte Ledger-Zeilen einer
 * wiederverwendeten Nummer fälschlich der noch nicht umgesetzten Story zuordnen.
 * Schätzungen (ep_est/size_est) bleiben sichtbar.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { boardRouter } from '../src/boardRouter.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Ein StoryDetail mit vollständig befüllten Lauf-Daten (simuliert die Kollision). */
function ledgerDetailWithRun() {
  return {
    started_at: '2026-06-13T09:33:33.000Z',
    ended_at: '2026-06-13T09:39:34.000Z',
    duration: 361,
    flow: [
      { seq: 1, agent: 'coder', iter: 1, gate: null, secs: 177, tok: null },
      { seq: 2, agent: 'reviewer', iter: 1, gate: 'PASS', secs: 126, tok: null },
    ],
    ep_est: null,
    ep_act: null,
    tok_est: null,
    tok_total: null,
    size_est: null,
    ep_dev: null,
    ep_dev_pct: null,
    tok_dev: null,
    tok_dev_pct: null,
  };
}

function makeApp({ storyStatus, detail }) {
  const project = {
    slug: 'demo',
    repo_path: '/tmp/demo',
    features: [
      {
        id: 'F-024',
        stories: [{ id: 'S-179', status: storyStatus, dispo_est: 5 }],
      },
    ],
  };
  const boardAggregator = {
    getIndex: async () => [project],
    scan: async () => {},
  };
  const storyMetricReader = {
    getDetail: async () => detail,
  };
  const app = express();
  app.use(express.json());
  app.use(boardRouter({ boardAggregator, storyMetricReader }));
  return app;
}

async function getDetail(app, slug, id) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      http
        .get(`http://127.0.0.1:${port}/api/board/projects/${slug}/stories/${id}/detail`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Story-Detail Lauf-Metrik-Gate (boardRouter)', () => {
  it('unterdrückt Start/Ende/Dauer/Flow bei Status "To Do" trotz Ledger-Treffer', async () => {
    const app = makeApp({ storyStatus: 'To Do', detail: ledgerDetailWithRun() });
    const { status, body } = await getDetail(app, 'demo', 'S-179');

    expect(status).toBe(200);
    expect(body.detail.status).toBe('To Do');
    expect(body.detail.started_at).toBeNull();
    expect(body.detail.ended_at).toBeNull();
    expect(body.detail.duration).toBeNull();
    expect(body.detail.flow).toEqual([]);
    // Schätzung bleibt sichtbar (YAML-Fallback aus dispo_est)
    expect(body.detail.ep_est).toBe(5);
    expect(body.detail.ep_est_source).toBe('yaml');
  });

  it('zeigt Lauf-Daten bei gestarteter Story (Status "Done")', async () => {
    const app = makeApp({ storyStatus: 'Done', detail: ledgerDetailWithRun() });
    const { status, body } = await getDetail(app, 'demo', 'S-179');

    expect(status).toBe(200);
    expect(body.detail.status).toBe('Done');
    expect(body.detail.started_at).toBe('2026-06-13T09:33:33.000Z');
    expect(body.detail.duration).toBe(361);
    expect(body.detail.flow).toHaveLength(2);
  });
});
