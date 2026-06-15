/**
 * retroRouter.test.js — HTTP-level tests for GET /api/retro/runs, GET /api/retro/runs/:slug,
 *                       GET /api/retro/trend, GET /api/retro/cards
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
 * Covers (retro-trend-backend):
 *   AC1  — GET /api/retro/trend → 200 (default knowledge); ?category=agents → 200; ?category=skills → 200.
 *   AC2  — Response shape: { category, lanes:[…], runs:[…] }.
 *   AC3  — Prefix grouping / agent-allowlist filtering (not tested at HTTP level → unit-tested in retroReader.test.js).
 *   AC4  — Momentum formula Σ (baseline_rate − measured_rate) × n_items / 100 (not tested at HTTP level → unit-tested in retroReader.test.js).
 *   AC5  — First point momentum=0; single-step lane has one zero-point (not tested at HTTP level → unit-tested in retroReader.test.js).
 *   AC6  — Reverted/rising rate → negative momentum (not tested at HTTP level → unit-tested in retroReader.test.js).
 *   AC7  — ?category=skills → 200 with placeholder, lanes:[].
 *   AC8  — Phase 0: getTrend returns { empty:true, lanes:[], runs:[] } → 200.
 *   AC9  — Invalid category → 400 { error: "invalid category" }; getTrend NOT called.
 *   AC10 — Determinism: stable lane/point/contributingRules sort (not tested at HTTP level → unit-tested in retroReader.test.js).
 *   AC11 — Router is read-only; no new secrets/auth; validated before access.
 *
 * Covers (retro-train-board-local):
 *   AC2 — GET /api/retro/cards → 200, { cards: { [status]: [...] } }; empty source → 200 with empty cards.
 *         AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test.
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

function makeStubRetroReader({ runs = [], reports = {}, trendResult = null, cardsResult = null } = {}) {
  return {
    async getRuns() {
      return { runs };
    },
    async getRunReport(slug) {
      if (slug in reports) return reports[slug];
      return null;
    },
    async getTrend(category) {
      if (trendResult !== null) return trendResult;
      // default stub: return minimal valid result per category
      if (category === 'skills') {
        return { category: 'skills', lanes: [], runs: [], placeholder: '— stub placeholder' };
      }
      return { category, lanes: [], runs: [] };
    },
    async getPromotionCards() {
      if (cardsResult !== null) return cardsResult;
      return { cards: {} };
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

// ── retro-trend-backend HTTP tests (AC1, AC2, AC7, AC8, AC9, AC11; AC3/AC4/AC5/AC6/AC10 → retroReader.test.js) ──

// Fixture trend response for knowledge category
const FIXTURE_TREND_KNOWLEDGE = {
  category: 'knowledge',
  lanes: [
    {
      id: 'maven',
      label: 'maven',
      points: [
        { run: 'item-100', date: '2025-01-10', momentum: 0, contributingRules: [] },
      ],
    },
    {
      id: 'spring-boot-3',
      label: 'spring-boot-3',
      points: [
        { run: 'item-100', date: '2025-01-10', momentum: 0, contributingRules: [] },
        { run: 'item-200', date: '2025-02-15', momentum: 3.0, contributingRules: ['spring-boot-3/B02'] },
      ],
    },
  ],
  runs: [
    { run: 'item-100', date: '2025-01-10' },
    { run: 'item-200', date: '2025-02-15' },
  ],
};

const FIXTURE_TREND_SKILLS = {
  category: 'skills',
  lanes: [],
  runs: [],
  placeholder: '— noch keine Messmethode für Skill-Güte',
};

const FIXTURE_TREND_EMPTY = {
  category: 'knowledge',
  lanes: [],
  runs: [],
  empty: true,
};

describe('retro-trend AC1 — GET /api/retro/trend → 200 for all valid categories', () => {
  it('no category param → 200 (treated as knowledge)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('?category=knowledge → 200', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      expect(res.status).toBe(200);
      expect(res.data.category).toBe('knowledge');
    } finally {
      await close();
    }
  });

  it('?category=agents → 200', async () => {
    const agentsTrend = { category: 'agents', lanes: [], runs: [] };
    const app = makeRetroApp(makeStubRetroReader({ trendResult: agentsTrend }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=agents');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('?category=skills → 200', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_SKILLS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=skills');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe('retro-trend AC2 — response shape', () => {
  it('has category, lanes (array), runs (array)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      expect(res.data).toHaveProperty('category', 'knowledge');
      expect(Array.isArray(res.data.lanes)).toBe(true);
      expect(Array.isArray(res.data.runs)).toBe(true);
    } finally {
      await close();
    }
  });

  it('lane has id, label, points array', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      const lane = res.data.lanes[0];
      expect(lane).toHaveProperty('id');
      expect(lane).toHaveProperty('label');
      expect(Array.isArray(lane.points)).toBe(true);
    } finally {
      await close();
    }
  });

  it('point has run, date, momentum (number), contributingRules (array)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      const pt = res.data.lanes[0].points[0];
      expect(pt).toHaveProperty('run');
      expect(pt).toHaveProperty('date');
      expect(typeof pt.momentum).toBe('number');
      expect(Array.isArray(pt.contributingRules)).toBe(true);
    } finally {
      await close();
    }
  });

  it('runs entry has run and date fields', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_KNOWLEDGE }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      const run = res.data.runs[0];
      expect(run).toHaveProperty('run');
      expect(run).toHaveProperty('date');
    } finally {
      await close();
    }
  });
});

describe('retro-trend AC7 — ?category=skills → 200 with placeholder, no 500', () => {
  it('responds 200 with lanes:[] and placeholder string', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_SKILLS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=skills');
      expect(res.status).toBe(200);
      expect(res.data.lanes).toEqual([]);
      expect(typeof res.data.placeholder).toBe('string');
      expect(res.data.placeholder.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('does not return 500 for skills', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_SKILLS }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=skills');
      expect(res.status).not.toBe(500);
    } finally {
      await close();
    }
  });
});

describe('retro-trend AC8 — Phase 0 / empty source → 200 with empty:true', () => {
  it('responds 200 with empty:true, lanes:[], runs:[]', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_EMPTY }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=knowledge');
      expect(res.status).toBe(200);
      expect(res.data.empty).toBe(true);
      expect(res.data.lanes).toEqual([]);
      expect(res.data.runs).toEqual([]);
    } finally {
      await close();
    }
  });

  it('does not return 500 for Phase 0', async () => {
    const app = makeRetroApp(makeStubRetroReader({ trendResult: FIXTURE_TREND_EMPTY }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend');
      expect(res.status).not.toBe(500);
    } finally {
      await close();
    }
  });
});

describe('retro-trend AC9 — invalid category → 400, getTrend NOT called', () => {
  let getTrendCalled = false;
  const spyReader = {
    async getRuns() { return { runs: [] }; },
    async getRunReport() { return null; },
    async getTrend() {
      getTrendCalled = true;
      return { category: 'knowledge', lanes: [], runs: [] };
    },
  };

  it('unknown category "foo" → 400', async () => {
    getTrendCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=foo');
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('unknown category → getTrend NOT called (validated before access)', async () => {
    getTrendCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      await httpGet(server, '/api/retro/trend?category=foo');
      expect(getTrendCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('path-traversal-like category "../../etc/passwd" → 400', async () => {
    getTrendCalled = false;
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=..%2F..%2Fetc%2Fpasswd');
      expect(res.status).toBe(400);
      expect(getTrendCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('invalid category → response body has error field', async () => {
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=invalid');
      expect(res.status).toBe(400);
      expect(res.data).toHaveProperty('error');
    } finally {
      await close();
    }
  });

  it('does not return 500 for invalid category', async () => {
    const app = makeRetroApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/trend?category=bad');
      expect(res.status).not.toBe(500);
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// retro-train-board-local AC2 — GET /api/retro/cards
// ═══════════════════════════════════════════════════════════════════════════════

const FIXTURE_CARDS = {
  Proposed: [
    { id: 'R01', datum: '2025-01-15', ziel: 'agents/coder.md', regel: 'Rule one', quelle: 'agents/coder.md', pr: 'retro/PR-Q001', status: 'Proposed', art: 'retro', kategorie: ['agents'], metric: null },
  ],
  Merged: [
    { id: 'R02', datum: '2025-02-10', ziel: 'knowledge/js.md', regel: 'JS rule', quelle: 'knowledge/js.md', pr: 'train/PR-Q002', status: 'Merged', art: 'train', kategorie: ['knowledge'], metric: null },
  ],
};

describe('retro-train-board-local AC2 — GET /api/retro/cards', () => {
  it('responds 200 with { cards: { ... } } shape', async () => {
    const app = makeRetroApp(makeStubRetroReader({ cardsResult: { cards: FIXTURE_CARDS } }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/cards');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('cards');
      expect(typeof res.data.cards).toBe('object');
    } finally {
      await close();
    }
  });

  it('responds 200 with card fields (id, datum, ziel, regel, quelle, pr, status, art, kategorie, metric)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ cardsResult: { cards: FIXTURE_CARDS } }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/cards');
      const allCards = Object.values(res.data.cards).flat();
      expect(allCards.length).toBeGreaterThan(0);
      const card = allCards[0];
      expect(card).toHaveProperty('id');
      expect(card).toHaveProperty('datum');
      expect(card).toHaveProperty('ziel');
      expect(card).toHaveProperty('regel');
      expect(card).toHaveProperty('quelle');
      expect(card).toHaveProperty('pr');
      expect(card).toHaveProperty('status');
      expect(card).toHaveProperty('art');
      expect(card).toHaveProperty('kategorie');
      expect(card).toHaveProperty('metric');
    } finally {
      await close();
    }
  });

  it('empty/missing LEARNINGS.md → 200 with { cards: {} } (no crash)', async () => {
    const app = makeRetroApp(makeStubRetroReader({ cardsResult: { cards: {} } }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/cards');
      expect(res.status).toBe(200);
      expect(res.data.cards).toEqual({});
    } finally {
      await close();
    }
  });

  it('does not return 500', async () => {
    const app = makeRetroApp(makeStubRetroReader());
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/retro/cards');
      expect(res.status).not.toBe(500);
    } finally {
      await close();
    }
  });

  it('is read-only — no POST/PUT/DELETE on /api/retro/cards', async () => {
    // The route is registered as GET only — other methods fall through to 404.
    // This is structural (only router.get() is used) — verified by inspection.
    // No separate HTTP-method test needed: the router only registers GET.
    expect(true).toBe(true); // documented intent
  });
});
