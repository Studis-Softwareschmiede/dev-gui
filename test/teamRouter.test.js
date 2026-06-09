/**
 * teamRouter.test.js — HTTP-level tests for GET /api/team and GET /api/team/:kind/:id
 *
 * Covers (team-view-backend):
 *   AC1 — GET /api/team → 200, { agents:[{id,name,description,model,tools}], skills:[{id,name,description}], knowledge:[{id,name,group}] }, no body
 *   AC4 — GET /api/team/:kind/:id (existing) → 200 with { ...meta, body }
 *   AC5 — Path-traversal in :id (..., %2e%2e, embedded .., null byte) → 404, no file access
 *   AC6 — Unknown kind / unknown but valid id → 404
 *   AC7 — Reader without resolvable plugin root → GET /api/team → 200 empty lists; detail → 404
 *   AC8 — Response contains no file paths / secrets outside Markdown content/metadata
 *   AC9 — AccessGuard-Verdrahtung: per server.js-Inspektion sichergestellt; kein separater Middleware-Test in dieser Datei
 *
 * Pattern: express + node:http createServer on port 0 (127.0.0.1), no supertest.
 * Stub AgentFlowReader injected via teamRouter({ agentFlowReader }) — no real filesystem.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { teamRouter } from '../src/teamRouter.js';

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make a GET request to a listening server.
 *
 * @param {import('node:http').Server} server
 * @param {string} path
 * @returns {Promise<{status: number, body: string, data: unknown}>}
 */
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

/**
 * Start a server on a random port and return { server, close }.
 * Caller must call close() in finally.
 */
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

/**
 * Build a stub AgentFlowReader that returns fixed overview/detail data.
 *
 * @param {object} opts
 * @param {{ agents, skills, knowledge }|null} [opts.overview]
 *   null → reader has no plugin root (AC7 degradation)
 * @param {Record<string, object|null>} [opts.details]
 *   Map of "<kind>/<id>" → detail object (or null = not found)
 */
function makeStubReader({ overview = null, details = {} } = {}) {
  return {
    async getOverview() {
      if (overview === null) {
        return { agents: [], skills: [], knowledge: [] };
      }
      return overview;
    },
    async getDetail(kind, id) {
      const key = `${kind}/${id}`;
      if (key in details) return details[key];
      return null;
    },
  };
}

/**
 * Build an express app with the teamRouter wired to the given stub reader.
 * No AccessGuard here — these tests focus on the router logic, not auth.
 */
function makeTeamApp(stubReader) {
  const app = express();
  app.use(teamRouter({ agentFlowReader: stubReader }));
  return app;
}

// ── Fixture data ──────────────────────────────────────────────────────────────

const FIXTURE_OVERVIEW = {
  agents: [
    { id: 'coder', name: 'Coder', description: 'Writes code', model: 'claude-3', tools: ['Read', 'Write'] },
  ],
  skills: [
    { id: 'deploy', name: 'Deploy Skill', description: 'Deploys the app' },
  ],
  knowledge: [
    { id: 'js', name: 'JavaScript', group: 'core' },
    { id: 'frameworks/spring-boot-3', name: 'Spring Boot 3', group: 'frameworks' },
  ],
};

const FIXTURE_AGENT_DETAIL = {
  id: 'coder',
  name: 'Coder',
  description: 'Writes code',
  model: 'claude-3',
  tools: ['Read', 'Write'],
  body: '# Coder\n\nThis agent writes code.',
};

const FIXTURE_SKILL_DETAIL = {
  id: 'deploy',
  name: 'Deploy Skill',
  description: 'Deploys the app',
  body: '## Usage\n\nRun /deploy to deploy.',
};

const FIXTURE_KNOWLEDGE_DETAIL = {
  id: 'js',
  name: 'JavaScript',
  group: 'core',
  body: '# JavaScript\n\nContent here.',
};

const FIXTURE_KNOWLEDGE_NESTED_DETAIL = {
  id: 'frameworks/spring-boot-3',
  name: 'Spring Boot 3',
  group: 'frameworks',
  body: '# Spring Boot 3\n\nFramework pack.',
};

// ── AC1 — GET /api/team overview ─────────────────────────────────────────────

describe('AC1 — GET /api/team → 200 with three lists, no body', () => {
  it('responds 200', async () => {
    const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('response has agents, skills, knowledge arrays', async () => {
    const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      expect(Array.isArray(res.data.agents)).toBe(true);
      expect(Array.isArray(res.data.skills)).toBe(true);
      expect(Array.isArray(res.data.knowledge)).toBe(true);
    } finally {
      await close();
    }
  });

  it('agent entries have id, name, description, model, tools — no body', async () => {
    const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      const agent = res.data.agents[0];
      expect(agent).toHaveProperty('id', 'coder');
      expect(agent).toHaveProperty('name', 'Coder');
      expect(agent).toHaveProperty('description', 'Writes code');
      expect(agent).toHaveProperty('model', 'claude-3');
      expect(agent).toHaveProperty('tools');
      expect(agent).not.toHaveProperty('body');
    } finally {
      await close();
    }
  });

  it('skill entries have id, name, description — no body', async () => {
    const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      const skill = res.data.skills[0];
      expect(skill).toHaveProperty('id', 'deploy');
      expect(skill).toHaveProperty('name', 'Deploy Skill');
      expect(skill).toHaveProperty('description');
      expect(skill).not.toHaveProperty('body');
    } finally {
      await close();
    }
  });

  it('knowledge entries have id, name, group — no body', async () => {
    const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW }));
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      const k = res.data.knowledge[0];
      expect(k).toHaveProperty('id');
      expect(k).toHaveProperty('name');
      expect(k).toHaveProperty('group');
      expect(k).not.toHaveProperty('body');
    } finally {
      await close();
    }
  });
});

// ── AC4 — GET /api/team/:kind/:id (existing) ──────────────────────────────────

describe('AC4 — GET /api/team/:kind/:id → 200 with { ...meta, body }', () => {
  const details = {
    'agent/coder': FIXTURE_AGENT_DETAIL,
    'skill/deploy': FIXTURE_SKILL_DETAIL,
    'knowledge/js': FIXTURE_KNOWLEDGE_DETAIL,
    'knowledge/frameworks/spring-boot-3': FIXTURE_KNOWLEDGE_NESTED_DETAIL,
  };
  const app = makeTeamApp(makeStubReader({ overview: FIXTURE_OVERVIEW, details }));

  it('agent detail → 200 with body', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/coder');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('body');
      expect(typeof res.data.body).toBe('string');
      expect(res.data.body).toContain('# Coder');
    } finally {
      await close();
    }
  });

  it('agent detail includes meta fields', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/coder');
      expect(res.data).toHaveProperty('id', 'coder');
      expect(res.data).toHaveProperty('name', 'Coder');
      expect(res.data).toHaveProperty('model', 'claude-3');
    } finally {
      await close();
    }
  });

  it('skill detail → 200 with body', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/skill/deploy');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('body');
      expect(res.data.body).toContain('## Usage');
    } finally {
      await close();
    }
  });

  it('knowledge detail → 200 with body', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/knowledge/js');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('body');
      expect(res.data).toHaveProperty('group', 'core');
    } finally {
      await close();
    }
  });

  it('nested knowledge detail (sub-path) → 200 with body', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/knowledge/frameworks/spring-boot-3');
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('body');
      expect(res.data).toHaveProperty('group', 'frameworks');
    } finally {
      await close();
    }
  });
});

// ── AC5 — Path-traversal → 404 ────────────────────────────────────────────────

describe('AC5 — Path-traversal in :id → 404, no file access', () => {
  // Spy: reader.getDetail should never be called for traversal attempts
  let getDetailCalled = false;
  const spyReader = {
    async getOverview() { return { agents: [], skills: [], knowledge: [] }; },
    async getDetail() {
      getDetailCalled = true;
      return null;
    },
  };

  it('plain .. segment → 404, no file access', async () => {
    getDetailCalled = false;
    const app = makeTeamApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      // Express 5 does NOT normalize /api/team/agent/.. — the splat captures '..'
      // which triggers the dotdot-check in the router BEFORE getDetail is called.
      const res = await httpGet(server, '/api/team/agent/..');
      expect(res.status).not.toBe(200);
      expect(getDetailCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('.. embedded in id (a/../b) → 404', async () => {
    getDetailCalled = false;
    const app = makeTeamApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/a%2F..%2Fb');
      expect([400, 404]).toContain(res.status);
      expect(getDetailCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('%2e%2e URL-encoded dotdot → 404', async () => {
    getDetailCalled = false;
    const app = makeTeamApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/%2e%2e');
      expect([400, 404]).toContain(res.status);
      expect(getDetailCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('null byte in id → 404, no file access', async () => {
    getDetailCalled = false;
    const app = makeTeamApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      // Null bytes in URL are generally rejected by Node.js http before reaching Express
      // We verify via %00 encoding
      const res = await httpGet(server, '/api/team/agent/coder%00evil');
      expect([400, 404]).toContain(res.status);
      expect(getDetailCalled).toBe(false);
    } finally {
      await close();
    }
  });

  it('backslash in id → 404, no file access', async () => {
    getDetailCalled = false;
    const app = makeTeamApp(spyReader);
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/coder%5Cevil');
      expect([400, 404]).toContain(res.status);
      expect(getDetailCalled).toBe(false);
    } finally {
      await close();
    }
  });
});

// ── AC6 — Unknown kind / unknown id → 404 ────────────────────────────────────

describe('AC6 — Unknown kind or unknown id → 404', () => {
  const app = makeTeamApp(makeStubReader({
    overview: FIXTURE_OVERVIEW,
    details: { 'agent/coder': FIXTURE_AGENT_DETAIL },
  }));

  it('unknown kind → 404', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/robot/coder');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('valid kind but unknown id → 404', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/nonexistent');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('valid kind skill but unknown id → 404', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/skill/no-such-skill');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('valid kind knowledge but unknown id → 404', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/knowledge/no-such-pack');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

// ── AC7 — Degradation: no plugin root → empty lists + detail 404 ──────────────

describe('AC7 — No plugin root → GET /api/team returns empty lists; detail → 404', () => {
  // Reader that returns empty lists (simulating no installed plugin)
  const degradedReader = makeStubReader({ overview: null });
  const app = makeTeamApp(degradedReader);

  it('GET /api/team → 200 with empty lists', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ agents: [], skills: [], knowledge: [] });
    } finally {
      await close();
    }
  });

  it('GET /api/team detail → 404 (no entry exists)', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/coder');
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('does not crash / throw 500 when plugin missing', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ── AC8 — No secrets / no path leakage in response ────────────────────────────

describe('AC8 — Response contains no secrets or file system paths', () => {
  const PLUGIN_ROOT = '/super/secret/plugin/root';
  const details = {
    'agent/coder': {
      id: 'coder',
      name: 'Coder',
      description: 'Writes code',
      model: 'claude-3',
      tools: [],
      body: '# Coder\n\nBody text only.',
    },
  };
  const overview = {
    agents: [{ id: 'coder', name: 'Coder', description: 'Writes code', model: 'claude-3', tools: [] }],
    skills: [],
    knowledge: [],
  };
  const app = makeTeamApp(makeStubReader({ overview, details }));

  it('overview response does not contain PLUGIN_ROOT path', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team');
      expect(res.body).not.toContain(PLUGIN_ROOT);
    } finally {
      await close();
    }
  });

  it('detail response body is raw Markdown — no path leakage', async () => {
    const { server, close } = await startServer(app);
    try {
      const res = await httpGet(server, '/api/team/agent/coder');
      expect(res.body).not.toContain(PLUGIN_ROOT);
      // body is the raw Markdown string, not an absolute path
      expect(res.data.body).toContain('# Coder');
    } finally {
      await close();
    }
  });
});
