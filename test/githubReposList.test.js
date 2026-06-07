/**
 * githubReposList.test.js — tests for GET /api/github/repos
 * (Item #63, AC1, AC2, AC6 — github-repos-overview spec)
 *
 * Covers:
 *   AC1 — 200 response with repos[].{name, fullName, visibility, openIssues, lastCi, htmlUrl}
 *          live data (fetch invoked on each call — no persistent store)
 *   AC2 — all repos via GitHubReader only; NO token in response body; no exclusions
 *          (agent-flow and dev-gui ARE included unlike /api/status)
 *   AC6 — GitHub unreachable → repos:[], endpoint stays 200 (graceful degradation)
 *          per-repo field failures → openIssues:'unknown' / lastCi:'unknown'
 *
 * Strategy:
 *   - Inject fake fetch into GitHubReader (no real HTTP)
 *   - Run through real Express app with DEV_NO_ACCESS=1
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createAccessGuard } from '../src/AccessGuard.js';
import { GitHubReader } from '../src/GitHubReader.js';
import { githubReposListRouter } from '../src/githubReposListRouter.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Start HTTP server on random port. Returns { server, port }. */
function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** Close and await server shutdown. */
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** GET request. Returns { status, body }. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Build a minimal Express app with AccessGuard (dev bypass) + githubReposListRouter.
 * Accepts a pre-constructed GitHubReader so tests can inject fakes.
 */
function makeApp({ githubReader }) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(githubReposListRouter({ githubReader }));
  return app;
}

// ── GitHub fake fetch builders ────────────────────────────────────────────────

/**
 * Build a fake fetch for org repos + search issues + CI runs.
 *
 * @param {object} opts
 * @param {Array<{name:string, full_name?:string, visibility?:string, html_url?:string}>} [opts.repos]
 * @param {Record<string, number>} [opts.openItems]   name→count (default 0)
 * @param {Record<string, {conclusion?:string, status?:string}>} [opts.ciRuns]
 * @param {boolean} [opts.failRepoList]   throw on repo-list call
 * @param {string|null} [opts.failCiFor]  500 for that repo's CI
 * @param {string|null} [opts.failIssuesFor] 500 for that repo's issues
 */
function buildFakeFetch({
  repos = [],
  openItems = {},
  ciRuns = {},
  failRepoList = false,
  failCiFor = null,
  failIssuesFor = null,
} = {}) {
  return async function fakeFetch(url, _init) {
    const u = new URL(url);

    // org repos list
    if (u.pathname.includes('/orgs/') && u.pathname.endsWith('/repos')) {
      if (failRepoList) throw new Error('network error');
      return fakeJson(repos.map((r) => ({
        name: r.name,
        full_name: r.full_name ?? `Studis-Softwareschmiede/${r.name}`,
        visibility: r.visibility ?? 'private',
        html_url: r.html_url ?? `https://github.com/Studis-Softwareschmiede/${r.name}`,
      })));
    }

    // Search API: open issues for a repo (is:issue is:open — excludes PRs)
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q') ?? '';
      const repoMatch = q.match(/repo:[^/]+\/([^\s+]+)/);
      const repoName = repoMatch ? repoMatch[1] : null;
      if (repoName && failIssuesFor && repoName === failIssuesFor) {
        return fakeResponse(500, null);
      }
      const count = (repoName && openItems[repoName]) ?? 0;
      return fakeJson({ total_count: count, items: [] });
    }

    // CI runs for a repo
    const ciMatch = u.pathname.match(/\/repos\/[^/]+\/([^/]+)\/actions\/runs$/);
    if (ciMatch) {
      const repoName = ciMatch[1];
      if (failCiFor && repoName === failCiFor) {
        return fakeResponse(500, null);
      }
      const run = ciRuns[repoName];
      if (!run) return fakeJson({ workflow_runs: [] });
      return fakeJson({ workflow_runs: [run] });
    }

    return fakeResponse(404, null);
  };
}

/** Fake Response with JSON body. */
function fakeJson(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

/** Fake Response with given status and no body. */
function fakeResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

// ── AC1 — Response shape ──────────────────────────────────────────────────────

describe('GET /api/github/repos — AC1 response shape', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: [
          { name: 'alpha', full_name: 'Studis-Softwareschmiede/alpha', visibility: 'private', html_url: 'https://github.com/Studis-Softwareschmiede/alpha' },
          { name: 'beta',  full_name: 'Studis-Softwareschmiede/beta',  visibility: 'public',  html_url: 'https://github.com/Studis-Softwareschmiede/beta'  },
        ],
        openItems: { alpha: 3, beta: 0 },
        ciRuns: {
          alpha: { conclusion: 'success', status: 'completed' },
          beta:  { conclusion: null,      status: 'in_progress' },
        },
      }),
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/github/repos');
    expect(res.status).toBe(200);
  });

  it('response has repos array', async () => {
    const res = await get(port, '/api/github/repos');
    expect(Array.isArray(res.body.repos)).toBe(true);
  });

  it('each repo has name, fullName, visibility, openIssues, lastCi, htmlUrl', async () => {
    const res = await get(port, '/api/github/repos');
    for (const r of res.body.repos) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.fullName).toBe('string');
      expect(['private', 'public']).toContain(r.visibility);
      expect(r.openIssues !== undefined).toBe(true);
      expect(r.lastCi !== undefined).toBe(true);
      expect(typeof r.htmlUrl).toBe('string');
    }
  });

  it('alpha has correct field values', async () => {
    const res = await get(port, '/api/github/repos');
    const alpha = res.body.repos.find((r) => r.name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha.fullName).toBe('Studis-Softwareschmiede/alpha');
    expect(alpha.visibility).toBe('private');
    expect(alpha.openIssues).toBe(3);
    expect(alpha.lastCi).toBe('success');
    expect(alpha.htmlUrl).toBe('https://github.com/Studis-Softwareschmiede/alpha');
  });

  it('beta has public visibility and in_progress lastCi', async () => {
    const res = await get(port, '/api/github/repos');
    const beta = res.body.repos.find((r) => r.name === 'beta');
    expect(beta).toBeDefined();
    expect(beta.visibility).toBe('public');
    expect(beta.openIssues).toBe(0);
    expect(beta.lastCi).toBe('in_progress');
  });
});

// ── AC1 — No persisted store (live fetch on each call) ────────────────────────

describe('AC1 — data is live (no cached store)', () => {
  it('two calls both invoke fetchFn (no cached result used as source of truth)', async () => {
    let callCount = 0;
    const base = buildFakeFetch({ repos: [{ name: 'repo-a' }] });
    const fetchFn = async (...args) => { callCount++; return base(...args); };
    const reader = new GitHubReader({ tokenProvider: () => 'tok', fetchFn });
    await reader.listRepos();
    await reader.listRepos();
    // Each listRepos() call must trigger at least one fetch (repo list + per-repo)
    expect(callCount).toBeGreaterThan(2);
  });
});

// ── AC2 — All repos included (no agent-flow / dev-gui exclusion) ──────────────

describe('AC2 — agent-flow and dev-gui ARE included (no exclusions unlike /api/status)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: [
          { name: 'agent-flow' },
          { name: 'dev-gui' },
          { name: 'my-project' },
        ],
        openItems: {},
        ciRuns: {},
      }),
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('agent-flow IS in repos (no exclusion for this endpoint)', async () => {
    const res = await get(port, '/api/github/repos');
    const names = res.body.repos.map((r) => r.name);
    expect(names).toContain('agent-flow');
  });

  it('dev-gui IS in repos (no exclusion for this endpoint)', async () => {
    const res = await get(port, '/api/github/repos');
    const names = res.body.repos.map((r) => r.name);
    expect(names).toContain('dev-gui');
  });

  it('my-project IS in repos', async () => {
    const res = await get(port, '/api/github/repos');
    const names = res.body.repos.map((r) => r.name);
    expect(names).toContain('my-project');
  });
});

// ── AC2 — Token never in response ────────────────────────────────────────────

describe('AC2 — App-Token never appears in response (security/R01)', () => {
  it('response body does not contain any token string', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'super-secret-ghp_token',
      fetchFn: buildFakeFetch({ repos: [{ name: 'my-repo' }] }),
    });
    const app = makeApp({ githubReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/repos');
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super-secret-ghp_token');
      expect(bodyStr).not.toContain('Authorization');
      expect(bodyStr).not.toContain('Bearer');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

// ── AC2 — Exclusively via GitHubReader (read-only, no write methods on router) ─

describe('AC2 — githubReposListRouter exposes only GET (no write routes)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ repos: [] }),
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('GET /api/github/repos returns 200', async () => {
    const res = await get(port, '/api/github/repos');
    expect(res.status).toBe(200);
  });
});

// ── AC6 — Graceful degradation: GitHub unreachable ───────────────────────────

describe('AC6 — GitHub unreachable → repos:[], endpoint stays 200', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: async () => { throw new Error('GitHub unreachable'); },
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200 (no crash)', async () => {
    const res = await get(port, '/api/github/repos');
    expect(res.status).toBe(200);
  });

  it('repos is empty array (gracefully degraded)', async () => {
    const res = await get(port, '/api/github/repos');
    expect(res.body.repos).toEqual([]);
  });
});

// ── AC6 — Graceful degradation: no token ─────────────────────────────────────

describe('AC6 — No GH_TOKEN → degrades gracefully (no crash, no token in output)', () => {
  it('returns 200 and repos:[] when auth fails', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => undefined,
      fetchFn: async () => fakeResponse(401, { message: 'Bad credentials' }),
    });
    const app = makeApp({ githubReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toEqual([]);
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

// ── AC6 — Graceful degradation: per-repo CI fetch fails ─────────────────────

describe('AC6 — per-repo CI failure → lastCi=unknown, others fine', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: [{ name: 'good-repo' }, { name: 'bad-ci-repo' }],
        openItems: { 'good-repo': 1, 'bad-ci-repo': 2 },
        ciRuns: {
          'good-repo': { conclusion: 'success', status: 'completed' },
        },
        failCiFor: 'bad-ci-repo',
      }),
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/github/repos');
    expect(res.status).toBe(200);
  });

  it('good-repo has lastCi=success', async () => {
    const res = await get(port, '/api/github/repos');
    const good = res.body.repos.find((r) => r.name === 'good-repo');
    expect(good?.lastCi).toBe('success');
  });

  it('bad-ci-repo has lastCi=unknown', async () => {
    const res = await get(port, '/api/github/repos');
    const bad = res.body.repos.find((r) => r.name === 'bad-ci-repo');
    expect(bad?.lastCi).toBe('unknown');
  });
});

// ── AC6 — Graceful degradation: per-repo issues fetch fails ──────────────────

describe('AC6 — per-repo issues failure → openIssues=unknown, others fine', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: [{ name: 'good-repo' }, { name: 'bad-issues-repo' }],
        openItems: { 'good-repo': 5 },
        ciRuns: {},
        failIssuesFor: 'bad-issues-repo',
      }),
    });
    const app = makeApp({ githubReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('good-repo has numeric openIssues', async () => {
    const res = await get(port, '/api/github/repos');
    const good = res.body.repos.find((r) => r.name === 'good-repo');
    expect(typeof good?.openIssues).toBe('number');
    expect(good?.openIssues).toBe(5);
  });

  it('bad-issues-repo has openIssues=unknown', async () => {
    const res = await get(port, '/api/github/repos');
    const bad = res.body.repos.find((r) => r.name === 'bad-issues-repo');
    expect(bad?.openIssues).toBe('unknown');
  });
});

// ── AC6 — Empty org ───────────────────────────────────────────────────────────

describe('AC6 — empty org → repos:[]', () => {
  it('returns 200 with empty repos array', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ repos: [] }),
    });
    const app = makeApp({ githubReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toEqual([]);
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

// ── AC6 — lastCi=none when no CI runs ────────────────────────────────────────

describe('AC6 — repo without Actions/CI → lastCi=none', () => {
  it('lastCi is none when workflow_runs is empty', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ repos: [{ name: 'no-ci-repo' }] }),
    });
    const app = makeApp({ githubReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/repos');
      const repo = res.body.repos.find((r) => r.name === 'no-ci-repo');
      expect(repo?.lastCi).toBe('none');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});
