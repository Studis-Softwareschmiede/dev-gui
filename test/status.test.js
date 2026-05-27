/**
 * status.test.js — tests for GET /api/status (Item #9, AC1, AC2, AC4)
 *
 * Covers:
 *   AC1 — response shape: projects[].{name, openItems, lastCi}, previews[].{name, url, status}
 *   AC2 — agent-flow and dev-gui excluded; lastCi mapping; Docker label filter
 *   AC4 — GitHub throws → projects: [], endpoint still 200 with previews
 *         Docker fails  → previews: [], endpoint still 200 with projects
 *         One repo CI fails → that repo.lastCi = 'unknown', others fine
 *         No GH_TOKEN → GitHub degrades, no crash, no token in output
 *
 * Strategy:
 *   - Inject fake fetch into GitHubReader (no real HTTP)
 *   - Inject fake execFn into DockerReader (no real Docker)
 *   - Run through real Express app with DEV_NO_ACCESS=1
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createAccessGuard } from '../src/AccessGuard.js';
import { GitHubReader } from '../src/GitHubReader.js';
import { DockerReader } from '../src/DockerReader.js';
import { statusRouter } from '../src/statusRouter.js';

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
 * Build a minimal Express app with AccessGuard (dev bypass) + statusRouter.
 * Accepts pre-constructed reader instances so tests can inject fakes.
 */
function makeApp({ githubReader, dockerReader }) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(statusRouter({ githubReader, dockerReader }));
  return app;
}

// ── GitHub fake fetch builders ─────────────────────────────────────────────────

/**
 * Build a fake fetch that serves GitHub API responses.
 *
 * openItems are served via the Search API (`/search/issues?q=…is:issue…`)
 * so that pull requests are explicitly excluded — matching GitHubReader's
 * use of `is:issue` in the query.
 *
 * @param {object} opts
 * @param {string[]} opts.repos          - Repo names to return from org/repos
 * @param {Record<string, number>} [opts.openItems]  - name→count (default 0)
 * @param {Record<string, {conclusion?:string, status?:string}>} [opts.ciRuns] - name→run fields
 * @param {boolean} [opts.failRepoList]  - throw on repo list call
 * @param {string|null} [opts.failCiFor]  - return error for that repo's CI
 * @param {string|null} [opts.failIssuesFor] - return error for that repo's issues (search API)
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
    if (u.pathname.includes('/repos') && u.pathname.includes(`/orgs/`)) {
      if (failRepoList) throw new Error('network error');
      return fakeJson(repos.map((name) => ({ name })));
    }

    // Search API: open issues for a repo (is:issue is:open — excludes PRs)
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q') ?? '';
      // Extract repo name from query string fragment `repo:{org}/{repo}`
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

    // Unknown URL
    return fakeResponse(404, null);
  };
}

/** Helper: return a fake Response with JSON body. */
function fakeJson(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

/** Helper: return a fake Response with given status and no body. */
function fakeResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

// ── Docker fake exec builder ───────────────────────────────────────────────────

/**
 * Build a fake exec function that returns docker ps output.
 *
 * @param {Array<{name:string, ports:string, status:string}>} containers
 * @param {boolean} [fail] - if true, throw to simulate Docker unreachable
 */
function buildFakeExec(containers = [], fail = false) {
  return async function fakeExec(_cmd, _args, _timeout) {
    if (fail) throw new Error('Cannot connect to Docker daemon');
    const lines = containers.map((c) => `${c.name}\t${c.ports}\t${c.status}`);
    return lines.join('\n') + (lines.length ? '\n' : '');
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/status — AC1 response shape', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['project-alpha', 'project-beta'],
        openItems: { 'project-alpha': 3, 'project-beta': 0 },
        ciRuns: {
          'project-alpha': { conclusion: 'success', status: 'completed' },
          'project-beta': { conclusion: null, status: 'in_progress' },
        },
      }),
    });
    const dockerReader = new DockerReader({
      execFn: buildFakeExec([
        { name: 'preview-alpha', ports: '0.0.0.0:4001->3000/tcp', status: 'Up 2 hours' },
      ]),
    });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/status');
    expect(res.status).toBe(200);
  });

  it('response has projects array', async () => {
    const res = await get(port, '/api/status');
    expect(Array.isArray(res.body.projects)).toBe(true);
  });

  it('response has previews array', async () => {
    const res = await get(port, '/api/status');
    expect(Array.isArray(res.body.previews)).toBe(true);
  });

  it('each project has name, openItems, lastCi', async () => {
    const res = await get(port, '/api/status');
    for (const p of res.body.projects) {
      expect(typeof p.name).toBe('string');
      expect(p.openItems !== undefined).toBe(true);
      expect(p.lastCi !== undefined).toBe(true);
    }
  });

  it('each preview has name, url, status', async () => {
    const res = await get(port, '/api/status');
    for (const p of res.body.previews) {
      expect(typeof p.name).toBe('string');
      expect(p.url !== undefined).toBe(true);
      expect(typeof p.status).toBe('string');
    }
  });

  it('project-alpha has openItems=3 and lastCi=success', async () => {
    const res = await get(port, '/api/status');
    const alpha = res.body.projects.find((p) => p.name === 'project-alpha');
    expect(alpha).toBeDefined();
    expect(alpha.openItems).toBe(3);
    expect(alpha.lastCi).toBe('success');
  });

  it('project-beta has openItems=0 and lastCi=in_progress', async () => {
    const res = await get(port, '/api/status');
    const beta = res.body.projects.find((p) => p.name === 'project-beta');
    expect(beta).toBeDefined();
    expect(beta.openItems).toBe(0);
    expect(beta.lastCi).toBe('in_progress');
  });

  it('preview URL derived from host port', async () => {
    const res = await get(port, '/api/status');
    const preview = res.body.previews[0];
    expect(preview.url).toBe('http://localhost:4001');
  });
});

// ── AC2 — agent-flow and dev-gui excluded ─────────────────────────────────────

describe('AC2 — agent-flow and dev-gui excluded from projects', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['agent-flow', 'dev-gui', 'my-project'],
        openItems: { 'my-project': 1 },
        ciRuns: { 'my-project': { conclusion: 'success', status: 'completed' } },
      }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('agent-flow is not in projects', async () => {
    const res = await get(port, '/api/status');
    const names = res.body.projects.map((p) => p.name);
    expect(names).not.toContain('agent-flow');
  });

  it('dev-gui is not in projects', async () => {
    const res = await get(port, '/api/status');
    const names = res.body.projects.map((p) => p.name);
    expect(names).not.toContain('dev-gui');
  });

  it('my-project IS in projects', async () => {
    const res = await get(port, '/api/status');
    const names = res.body.projects.map((p) => p.name);
    expect(names).toContain('my-project');
  });
});

// ── AC2 — lastCi mapping ──────────────────────────────────────────────────────

describe('AC2 — lastCi status mapping', () => {
  const cases = [
    { conclusion: 'success',   status: 'completed', expected: 'success' },
    { conclusion: 'failure',   status: 'completed', expected: 'failure' },
    { conclusion: 'timed_out', status: 'completed', expected: 'failure' },
    { conclusion: 'cancelled', status: 'completed', expected: 'failure' },
    { conclusion: null,        status: 'in_progress', expected: 'in_progress' },
    { conclusion: null,        status: 'queued',       expected: 'in_progress' },
  ];

  for (const { conclusion, status: runStatus, expected } of cases) {
    it(`conclusion=${conclusion}, status=${runStatus} → lastCi=${expected}`, async () => {
      process.env.DEV_NO_ACCESS = '1';
      const githubReader = new GitHubReader({
        tokenProvider: () => 'test-token',
        fetchFn: buildFakeFetch({
          repos: ['repo-x'],
          ciRuns: { 'repo-x': { conclusion, status: runStatus } },
        }),
      });
      const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
      const app = makeApp({ githubReader, dockerReader });
      const { server: srv, port: p } = await startServer(app);
      try {
        const res = await get(p, '/api/status');
        const proj = res.body.projects.find((x) => x.name === 'repo-x');
        expect(proj?.lastCi).toBe(expected);
      } finally {
        await closeServer(srv);
        delete process.env.DEV_NO_ACCESS;
      }
    });
  }

  it('no CI runs → lastCi=none', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({ repos: ['repo-norun'] }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/status');
      const proj = res.body.projects.find((x) => x.name === 'repo-norun');
      expect(proj?.lastCi).toBe('none');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

// ── AC4 — graceful degradation ────────────────────────────────────────────────

describe('AC4 — GitHub provider throws → projects:[], previews still returned', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    // fetchFn throws on repo list → GitHubReader returns []
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: async () => { throw new Error('GitHub unreachable'); },
    });
    const dockerReader = new DockerReader({
      execFn: buildFakeExec([
        { name: 'preview-x', ports: '0.0.0.0:5001->3000/tcp', status: 'Up 1 hour' },
      ]),
    });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/status');
    expect(res.status).toBe(200);
  });

  it('projects is empty array (degraded)', async () => {
    const res = await get(port, '/api/status');
    expect(res.body.projects).toEqual([]);
  });

  it('previews still returned', async () => {
    const res = await get(port, '/api/status');
    expect(Array.isArray(res.body.previews)).toBe(true);
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0].name).toBe('preview-x');
  });
});

describe('AC4 — Docker unreachable → previews:[], projects still returned', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['my-app'],
        ciRuns: { 'my-app': { conclusion: 'success', status: 'completed' } },
      }),
    });
    const dockerReader = new DockerReader({
      execFn: buildFakeExec([], /* fail= */ true),
    });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/status');
    expect(res.status).toBe(200);
  });

  it('previews is empty array (degraded)', async () => {
    const res = await get(port, '/api/status');
    expect(res.body.previews).toEqual([]);
  });

  it('projects still returned', async () => {
    const res = await get(port, '/api/status');
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe('my-app');
  });
});

describe('AC4 — one repo CI fetch fails → that repo lastCi=unknown, others fine', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['good-repo', 'bad-repo'],
        openItems: { 'good-repo': 2, 'bad-repo': 1 },
        ciRuns: {
          'good-repo': { conclusion: 'success', status: 'completed' },
        },
        failCiFor: 'bad-repo',
      }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/status');
    expect(res.status).toBe(200);
  });

  it('good-repo has lastCi=success', async () => {
    const res = await get(port, '/api/status');
    const good = res.body.projects.find((p) => p.name === 'good-repo');
    expect(good?.lastCi).toBe('success');
  });

  it('bad-repo has lastCi=unknown', async () => {
    const res = await get(port, '/api/status');
    const bad = res.body.projects.find((p) => p.name === 'bad-repo');
    expect(bad?.lastCi).toBe('unknown');
  });
});

describe('AC4 — one repo issues fetch fails → that repo openItems=unknown, others fine', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['good-repo', 'issues-fail-repo'],
        openItems: { 'good-repo': 2 },
        ciRuns: {},
        failIssuesFor: 'issues-fail-repo',
      }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('good-repo has numeric openItems', async () => {
    const res = await get(port, '/api/status');
    const good = res.body.projects.find((p) => p.name === 'good-repo');
    expect(typeof good?.openItems).toBe('number');
  });

  it('issues-fail-repo has openItems=unknown', async () => {
    const res = await get(port, '/api/status');
    const bad = res.body.projects.find((p) => p.name === 'issues-fail-repo');
    expect(bad?.openItems).toBe('unknown');
  });
});

describe('AC4 — no GH_TOKEN → GitHub degrades gracefully (no crash, no token in output)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    // No tokenProvider → falls back to GH_TOKEN env which is absent here
    const savedToken = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    // fetchFn returns 401 (no auth) for org repos
    const githubReader = new GitHubReader({
      tokenProvider: () => undefined,
      fetchFn: async () => fakeResponse(401, { message: 'Bad credentials' }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    ({ server, port } = await startServer(app));
    if (savedToken !== undefined) process.env.GH_TOKEN = savedToken;
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200 (no crash)', async () => {
    const res = await get(port, '/api/status');
    expect(res.status).toBe(200);
  });

  it('projects is empty array (degraded, no token)', async () => {
    const res = await get(port, '/api/status');
    expect(res.body.projects).toEqual([]);
  });

  it('response body does not contain any token string', async () => {
    const res = await get(port, '/api/status');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('ghp_');
    expect(bodyStr).not.toContain('test-token');
    expect(bodyStr).not.toContain('Authorization');
  });
});

describe('AC2 — DockerReader only returns containers with agent-flow.preview label (filter check)', () => {
  it('execFn receives docker ps with label filter', async () => {
    const calls = [];
    const execFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return '';
    };
    const reader = new DockerReader({ execFn });
    await reader.getPreviews();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('docker');
    expect(calls[0].args).toContain('--filter');
    const labelArg = calls[0].args[calls[0].args.indexOf('--filter') + 1];
    expect(labelArg).toBe('label=agent-flow.preview');
  });
});

// ── AC5 — DockerReader via DOCKER_HOST (socket-proxy) ────────────────────────
//
// DockerReader shells out to `docker` CLI without hardcoding a socket path or
// -H flag. The docker CLI automatically honours the DOCKER_HOST environment
// variable, so pointing DOCKER_HOST=tcp://socket-proxy:2375 (set in
// docker-compose.yml) routes all docker calls through the socket proxy with
// zero code changes. These tests document and verify that contract.

describe('AC5 — DockerReader does not hardcode socket path or -H flag (DOCKER_HOST honours)', () => {
  it('execFn cmd is "docker" (no hard-coded host flag)', async () => {
    const calls = [];
    const execFn = async (cmd, args) => { calls.push({ cmd, args }); return ''; };
    const reader = new DockerReader({ execFn });
    await reader.getPreviews();
    expect(calls[0].cmd).toBe('docker');
    // Must NOT contain -H or --host in the args (those would override DOCKER_HOST)
    expect(calls[0].args).not.toContain('-H');
    expect(calls[0].args).not.toContain('--host');
  });

  it('execFn args contain no socket path (no /var/run/docker.sock hardcode)', async () => {
    const calls = [];
    const execFn = async (cmd, args) => { calls.push({ cmd, args }); return ''; };
    const reader = new DockerReader({ execFn });
    await reader.getPreviews();
    const argsStr = calls[0].args.join(' ');
    expect(argsStr).not.toContain('/var/run/docker.sock');
    expect(argsStr).not.toContain('unix://');
    expect(argsStr).not.toContain('tcp://');
  });
});

describe('AC2 — openItems uses Search API (is:issue) so PRs are excluded', () => {
  it('fetches /search/issues with is:issue in query — not the issues list endpoint', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push(url);
      return buildFakeFetch({ repos: ['my-repo'], openItems: { 'my-repo': 5 } })(url, init);
    };
    const reader = new GitHubReader({ tokenProvider: () => 'tok', fetchFn });
    await reader.getProjects();
    // Must have called the search endpoint
    const searchCalls = calls.filter((u) => u.includes('/search/issues'));
    expect(searchCalls.length).toBeGreaterThan(0);
    // Must NOT have called the bare issues list endpoint (which includes PRs)
    const issueListCalls = calls.filter((u) => /\/repos\/[^/]+\/[^/]+\/issues/.test(u));
    expect(issueListCalls).toHaveLength(0);
    // Search query must contain is:issue to exclude PRs
    expect(searchCalls[0]).toContain('is%3Aissue');
  });

  it('openItems reflects total_count from search response', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const githubReader = new GitHubReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        repos: ['my-repo'],
        openItems: { 'my-repo': 7 },
      }),
    });
    const dockerReader = new DockerReader({ execFn: buildFakeExec([]) });
    const app = makeApp({ githubReader, dockerReader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/status');
      const proj = res.body.projects.find((x) => x.name === 'my-repo');
      expect(proj?.openItems).toBe(7);
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

describe('AC2 — GitHubReader does not persist data (no store)', () => {
  it('two calls both invoke fetchFn (no cached result used as source of truth)', async () => {
    let callCount = 0;
    const fetchFn = buildFakeFetch({ repos: ['repo-a'] });
    const wrapped = async (...args) => {
      callCount++;
      return fetchFn(...args);
    };
    const reader = new GitHubReader({ tokenProvider: () => 'tok', fetchFn: wrapped });
    await reader.getProjects();
    await reader.getProjects();
    // Each getProjects() call should trigger at least one fetch (repo list + per repo)
    expect(callCount).toBeGreaterThan(2);
  });
});
