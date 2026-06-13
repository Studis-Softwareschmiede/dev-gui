/**
 * retroRouter.test.js — HTTP-level tests for GET /api/retro/runs and GET /api/retro/runs/:slug
 *
 * Covers (retro-view-backend):
 *   AC1 — GET /api/retro/runs → 200, { runs: [...] }, no detail fields in overview.
 *   AC2 — (grouping tested in retroReader.test.js; here: response shape).
 *   AC3 — source field present in runs response.
 *   AC5 — GET /api/retro/runs/:slug → 200 with full report shape.
 *   AC7 — Phase 0: metric: null throughout (mocked at reader level).
 *   AC8 — Slug traversal → 404; backslash → 404; null byte → 404; valid unknown slug → 404.
 *   AC9 — Degradation: runs endpoint returns empty list; report → 404.
 *   AC10 — Router is read-only; routes behind existing AccessGuard (documented, not re-tested here).
 *
 * Pattern: express + node:http createServer on port 0 (127.0.0.1), no supertest.
 * Stub RetroReader injected via retroRouter({ retroReader }) — no real filesystem.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { retroRouter } from '../src/retroRouter.js';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(server, path) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, body: raw, data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(app) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── Stub builder ──────────────────────────────────────────────────────────────

function makeStubRetroReader({ runs = [], reports = {} } = {}) {
  return {
    async getRuns() {
      return { runs };
    },
    async getRunReport(slug) {
      if (slug in reports) return reports[slug];
      return null;
    },
  };
}

function makeRetroApp(stubReader) {
  const app = express();
  app.use(retroRouter({ retroReader: stubReader }));
  return app;
}

// ── Fixture data ──────────────────────────────────────────────────────────────

const FIXTURE_RUNS = [
  {
    slug: 'retro/PR-Q003',
    date: '2025-03-01',
    source: 'retro',
    counts: { agents: 1, skills: 0, knowledge: 0 },
    statusMix: { Merged: 1 },
  },
  {
    slug: 'train/PR-Q002',
    date: '2025-02-10',
    source: 'train',
    counts: { agents: 0, skills: 1, knowledge: 0 },
    statusMix: { Proposed: 1 },
  },
  {
    slug: 'retro/PR-Q001',
    date: '2025-01-15',
    source: 'retro',
    counts: { agents: 1, skills: 0, knowledge: 1 },
    statusMix: { Merged: 2 },
  },
];

const FIXTURE_REPORT = {
  slug: 'retro/PR-Q001',
  date: '2025-01-15',
  source: 'retro',
  statusMix: { Merged: 2 },
  agents: [{ id: 'R01', rule: 'Coder rule one', status: 'Merged', provenance: 'agents/coder.md', metric: null }],
  skills: [],
  knowledge: [{ id: 'R02', rule: 'JS knowledge rule', status: 'Merged', provenance: 'knowledge/js.md', metric: null }],
};

// ── AC1 — GET /api/retro/runs ─────────────────────────────────────────────────

describe('AC1 — GET /api/retro/runs → 200 with { runs: [...] }', () => {
  it('responds 200', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('response has runs array', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      expect(Array.isArray(res.data.runs)).toBe(true);
      expect(res.data.runs.length).toBe(3);
    } finally {
      await close();
    }
  });

  it('run entry has slug, date, source, counts, statusMix', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      const run = res.data.runs[0];
      expect(run).toHaveProperty('slug');
      expect(run).toHaveProperty('date');
      expect(run).toHaveProperty('source');
      expect(run).toHaveProperty('counts');
      expect(run).toHaveProperty('statusMix');
    } finally {
      await close();
    }
  });

  it('counts has agents, skills, knowledge', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      const run = res.data.runs[0];
      expect(run.counts).toHaveProperty('agents');
      expect(run.counts).toHaveProperty('skills');
      expect(run.counts).toHaveProperty('knowledge');
    } finally {
      await close();
    }
  });

  it('AC1 — overview run does NOT include rule/agents/skills/knowledge (no detail fields)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      for (const run of res.data.runs) {
        expect(run).not.toHaveProperty('rule');
        expect(run).not.toHaveProperty('agents');
        expect(run).not.toHaveProperty('skills');
        expect(run).not.toHaveProperty('knowledge');
      }
    } finally {
      await close();
    }
  });

  it('AC3 — source field is present and one of known values', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: FIXTURE_RUNS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      const sources = new Set(['retro', 'train', 'teamLeader', 'other']);
      for (const run of res.data.runs) {
        expect(sources.has(run.source)).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

// ── AC5 — GET /api/retro/runs/:slug ──────────────────────────────────────────

describe('AC5 — GET /api/retro/runs/:slug → 200 with full report', () => {
  const app = makeRetroApp(makeStubRetroReader({
    runs: FIXTURE_RUNS,
    reports: { 'retro/PR-Q001': FIXTURE_REPORT },
  }));

  it('responds 200 for existing slug', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-Q001');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('response has slug, date, source, statusMix, agents, skills, knowledge', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-Q001');
      expect(res.data).toHaveProperty('slug', 'retro/PR-Q001');
      expect(res.data).toHaveProperty('date', '2025-01-15');
      expect(res.data).toHaveProperty('source', 'retro');
      expect(res.data).toHaveProperty('statusMix');
      expect(Array.isArray(res.data.agents)).toBe(true);
      expect(Array.isArray(res.data.skills)).toBe(true);
      expect(Array.isArray(res.data.knowledge)).toBe(true);
    } finally {
      await close();
    }
  });

  it('entry has id, rule, status, provenance, metric', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-Q001');
      const entry = res.data.agents[0];
      expect(entry).toHaveProperty('id', 'R01');
      expect(entry).toHaveProperty('rule', 'Coder rule one');
      expect(entry).toHaveProperty('status', 'Merged');
      expect(entry).toHaveProperty('provenance', 'agents/coder.md');
      expect(entry).toHaveProperty('metric');
    } finally {
      await close();
    }
  });

  it('AC7 — metric: null when no baseline data', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-Q001');
      // All entries in FIXTURE_REPORT have metric: null
      for (const e of [...res.data.agents, ...res.data.skills, ...res.data.knowledge]) {
        expect(e.metric).toBeNull();
      }
    } finally {
      await close();
    }
  });
});

// ── AC8 — Slug-Traversal → 404 ────────────────────────────────────────────────

describe('AC8 — Slug traversal → 404, no reader access', () => {
  let getRunReportCalled = false;
  const spyReader = {
    async getRuns() { return { runs: [] }; },
    async getRunReport() {
      getRunReportCalled = true;
      return null;
    },
  };

  it('slug with .. → 404, no reader access', async () => {
    getRunReportCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/..%2Fevil');
      expect([400, 404]).toContain(res.status);
      expect(getRunReportCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('slug with backslash → 404, no reader access', async () => {
    getRunReportCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro%5Cevil');
      expect([400, 404]).toContain(res.status);
      expect(getRunReportCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('slug with null byte → 404 or 400, no reader access', async () => {
    getRunReportCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro%2FPR%00evil');
      expect([400, 404]).toContain(res.status);
      expect(getRunReportCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('valid but non-existent slug → 404', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: [] }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-DOES-NOT-EXIST');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('slug with spaces (URL-encoded %20) → 404, invalid chars', async () => {
    getRunReportCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro%20evil');
      expect([400, 404]).toContain(res.status);
      expect(getRunReportCalled).toBe(false);
    } finally {
      await close();
    }
  });
});

// ── AC9 — Degradation ─────────────────────────────────────────────────────────

describe('AC9 — Degradation: no LEARNINGS data', () => {
  it('GET /api/retro/runs → 200 with empty runs list', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: [] }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ runs: [] });
    } finally {
      await close();
    }
  });

  it('GET /api/retro/runs/:slug → 404 when no data', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: [] }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs/retro/PR-Q001');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('does not crash / throw 500', async () => {
    const app = makeRetroApp(makeStubRetroReader({ runs: [] }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/runs');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});
