/**
 * workspaceRepos.test.js — Tests for GET /api/workspace/repos (Item #64, AC1, AC2)
 *
 * Covers:
 *   AC1 — endpoint lists live clones from WORKSPACE_DIR (direct subdirs with .git);
 *         response shape: { repos: [{ name, branch, dirty, lastCommit, originUrl }] };
 *         non-git subdirs are NOT listed; no value from a persisted store.
 *   AC2 — originUrl is credential-free: embedded token/password stripped before response;
 *         token in original origin URL does NOT appear in the response body.
 *   Edge-cases — WORKSPACE_DIR unset/missing → repos: []; no crash.
 *
 * Strategy:
 *   - WorkspaceScanner: inject fake execFn + fsDeps (no real git/FS calls).
 *   - workspaceReposRouter: wire through real Express with AccessGuard dev-bypass.
 *   - HTTP via Node http.request (same pattern as status.test.js).
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createAccessGuard } from '../src/AccessGuard.js';
import { WorkspaceScanner, stripCredentials } from '../src/WorkspaceScanner.js';
import { workspaceReposRouter } from '../src/workspaceReposRouter.js';

// ── HTTP helpers (same pattern as status.test.js) ─────────────────────────────

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

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

// ── App builder ───────────────────────────────────────────────────────────────

function makeApp(workspaceScanner) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(workspaceReposRouter(workspaceScanner));
  return app;
}

// ── Fake fsDeps builder ───────────────────────────────────────────────────────

/**
 * Build fake fsDeps ({ stat, readdir }) for injecting into WorkspaceScanner.
 *
 * @param {object} opts
 * @param {string[]} opts.dirs          - Subdirectory names that exist
 * @param {string[]} [opts.gitDirs]     - Which of those dirs have a .git entry
 * @param {boolean}  [opts.readdirFail] - If true, readdir throws (simulates missing WORKSPACE_DIR)
 */
function buildFakeFsDeps({ dirs = [], gitDirs = [], readdirFail = false } = {}) {
  const gitSet = new Set(gitDirs);

  return {
    readdir: async (_path, _opts) => {
      if (readdirFail) throw new Error('ENOENT: no such file or directory');
      return dirs.map((name) => ({
        name,
        isDirectory: () => true,
      }));
    },
    stat: async (path) => {
      // path ends with '.git' — check if parent dir is in gitSet
      const parts = path.replace(/\\/g, '/').split('/');
      const gitEntry = parts[parts.length - 1]; // '.git'
      const dirName = parts[parts.length - 2];  // the clone dir name
      if (gitEntry === '.git' && gitSet.has(dirName)) {
        return { isFile: () => false }; // exists
      }
      throw new Error('ENOENT');
    },
  };
}

// ── Fake execFn builder ───────────────────────────────────────────────────────

/**
 * Build a fake execFn for injecting into WorkspaceScanner.
 *
 * @param {object} cloneData  Map of clone name → { branch, dirty, lastCommit, originUrl }
 *   - branch:     string | null (null → git command fails)
 *   - dirty:      boolean
 *   - lastCommit: { hash, subject, date } | null
 *   - originUrl:  string | null
 */
function buildFakeExecFn(cloneData = {}) {
  return async function fakeExec(cmd, args, opts = {}) {
    const cwd = opts.cwd ?? '';
    // Extract clone name from the last path segment of cwd
    const cloneName = cwd.replace(/\\/g, '/').split('/').pop();
    const data = cloneData[cloneName];

    if (!data) throw new Error(`fakeExec: unknown clone "${cloneName}"`);

    const subCmd = args[0];

    // git rev-parse --abbrev-ref HEAD → branch
    if (subCmd === 'rev-parse' && args.includes('--abbrev-ref')) {
      if (data.branch === null) throw new Error('not a git repo');
      return { stdout: data.branch };
    }

    // git status --porcelain → dirty check
    if (subCmd === 'status' && args.includes('--porcelain')) {
      return { stdout: data.dirty ? 'M modified-file.js\n' : '' };
    }

    // git log -1 --format=... → last commit
    if (subCmd === 'log') {
      if (!data.lastCommit) throw new Error('no commits');
      const { hash, subject, date } = data.lastCommit;
      return { stdout: `${hash}\x1f${subject}\x1f${date}` };
    }

    // git remote get-url origin → originUrl
    if (subCmd === 'remote' && args.includes('get-url')) {
      if (!data.originUrl) throw new Error('no remote');
      return { stdout: data.originUrl };
    }

    throw new Error(`fakeExec: unhandled git command: ${args.join(' ')}`);
  };
}

// ── Unit tests: stripCredentials ──────────────────────────────────────────────

describe('stripCredentials — AC2 credential stripping', () => {
  it('strips token from https://user:token@host/path', () => {
    const url = 'https://x-access-token:ghs_abc123TOKEN@github.com/org/repo.git';
    const result = stripCredentials(url);
    expect(result).toBe('https://github.com/org/repo.git');
    expect(result).not.toContain('ghs_abc123TOKEN');
    expect(result).not.toContain('x-access-token');
  });

  it('strips password from https://user:password@host/path', () => {
    const url = 'https://myuser:secretpassword@gitlab.com/org/repo.git';
    const result = stripCredentials(url);
    expect(result).not.toContain('secretpassword');
    expect(result).not.toContain('myuser');
    expect(result).toBe('https://gitlab.com/org/repo.git');
  });

  it('strips user-only from https://user@host/path', () => {
    const url = 'https://myuser@github.com/org/repo.git';
    const result = stripCredentials(url);
    expect(result).not.toContain('myuser');
    expect(result).toBe('https://github.com/org/repo.git');
  });

  it('leaves plain https URL unchanged', () => {
    const url = 'https://github.com/org/repo.git';
    expect(stripCredentials(url)).toBe(url);
  });

  it('leaves SSH remote URL unchanged (no credentials to strip)', () => {
    const url = 'git@github.com:org/repo.git';
    expect(stripCredentials(url)).toBe(url);
  });

  it('returns null for null input', () => {
    expect(stripCredentials(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(stripCredentials(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(stripCredentials('')).toBeNull();
  });

  it('token containing characters like _/- does not appear after stripping', () => {
    const token = 'ghs_aB3-xY9_zQR';
    const url = `https://x-access-token:${token}@github.com/org/repo.git`;
    const result = stripCredentials(url);
    expect(result).not.toContain(token);
  });
});

// ── Unit tests: WorkspaceScanner.listClones ───────────────────────────────────

describe('WorkspaceScanner.listClones — AC1 basic listing', () => {
  it('returns empty array when WORKSPACE_DIR is empty string', async () => {
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const clones = await scanner.listClones();
    expect(clones).toEqual([]);
  });

  it('returns empty array when readdir fails (WORKSPACE_DIR missing)', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/does/not/exist',
      fsDeps: buildFakeFsDeps({ readdirFail: true }),
      execFn: async () => { throw new Error('should not be called'); },
    });
    const clones = await scanner.listClones();
    expect(clones).toEqual([]);
  });

  it('returns empty array when no subdirectories have .git', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['not-a-repo', 'also-not'], gitDirs: [] }),
      execFn: async () => ({ stdout: '' }),
    });
    const clones = await scanner.listClones();
    expect(clones).toEqual([]);
  });

  it('returns only git clone dirs (with .git), not plain dirs', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['repo-a', 'plain-dir', 'repo-b'], gitDirs: ['repo-a', 'repo-b'] }),
      execFn: buildFakeExecFn({
        'repo-a': { branch: 'main', dirty: false, lastCommit: { hash: 'abc1234', subject: 'init', date: '2026-01-01T00:00:00Z' }, originUrl: 'https://github.com/org/repo-a.git' },
        'repo-b': { branch: 'dev', dirty: true, lastCommit: { hash: 'def5678', subject: 'wip', date: '2026-01-02T00:00:00Z' }, originUrl: null },
      }),
    });
    const clones = await scanner.listClones();
    expect(clones).toHaveLength(2);
    const names = clones.map((c) => c.name);
    expect(names).toContain('repo-a');
    expect(names).toContain('repo-b');
    expect(names).not.toContain('plain-dir');
  });

  it('each clone has required fields: name, branch, dirty, lastCommit, originUrl', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['my-repo'], gitDirs: ['my-repo'] }),
      execFn: buildFakeExecFn({
        'my-repo': {
          branch: 'main',
          dirty: false,
          lastCommit: { hash: 'a1b2c3d', subject: 'feat: add thing', date: '2026-06-01T10:00:00Z' },
          originUrl: 'https://github.com/org/my-repo.git',
        },
      }),
    });
    const [clone] = await scanner.listClones();
    expect(clone.name).toBe('my-repo');
    expect(clone.branch).toBe('main');
    expect(typeof clone.dirty).toBe('boolean');
    expect(clone.dirty).toBe(false);
    expect(clone.lastCommit).toEqual({ hash: 'a1b2c3d', subject: 'feat: add thing', date: '2026-06-01T10:00:00Z' });
    expect(clone.originUrl).toBe('https://github.com/org/my-repo.git');
  });

  it('dirty flag is true when git status --porcelain returns output', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['dirty-repo'], gitDirs: ['dirty-repo'] }),
      execFn: buildFakeExecFn({
        'dirty-repo': {
          branch: 'main',
          dirty: true,
          lastCommit: { hash: 'abc', subject: 'hi', date: '2026-01-01T00:00:00Z' },
          originUrl: null,
        },
      }),
    });
    const [clone] = await scanner.listClones();
    expect(clone.dirty).toBe(true);
  });

  it('lastCommit is null when repo has no commits', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['empty-repo'], gitDirs: ['empty-repo'] }),
      execFn: buildFakeExecFn({
        'empty-repo': { branch: 'main', dirty: false, lastCommit: null, originUrl: null },
      }),
    });
    const [clone] = await scanner.listClones();
    expect(clone.lastCommit).toBeNull();
  });

  it('originUrl is null when no origin remote', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['local-only'], gitDirs: ['local-only'] }),
      execFn: buildFakeExecFn({
        'local-only': { branch: 'main', dirty: false, lastCommit: null, originUrl: null },
      }),
    });
    const [clone] = await scanner.listClones();
    expect(clone.originUrl).toBeNull();
  });

  it('branch is null when git rev-parse fails (empty / detached)', async () => {
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['detached-repo'], gitDirs: ['detached-repo'] }),
      execFn: buildFakeExecFn({
        'detached-repo': { branch: null, dirty: false, lastCommit: null, originUrl: null },
      }),
    });
    const [clone] = await scanner.listClones();
    expect(clone.branch).toBeNull();
  });
});

// ── AC2: credential-stripping in WorkspaceScanner ────────────────────────────

describe('WorkspaceScanner — AC2: originUrl is always credential-free', () => {
  it('strips https token from originUrl before returning', async () => {
    const rawToken = 'ghs_SECRET_TOKEN_XYZ';
    const rawUrl = `https://x-access-token:${rawToken}@github.com/org/repo.git`;

    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['token-repo'], gitDirs: ['token-repo'] }),
      execFn: buildFakeExecFn({
        'token-repo': {
          branch: 'main',
          dirty: false,
          lastCommit: { hash: 'abc1234', subject: 'init', date: '2026-01-01T00:00:00Z' },
          originUrl: rawUrl,
        },
      }),
    });

    const [clone] = await scanner.listClones();
    expect(clone.originUrl).not.toContain(rawToken);
    expect(clone.originUrl).not.toContain('x-access-token');
    expect(clone.originUrl).toBe('https://github.com/org/repo.git');
  });

  it('originUrl with password:token strips both user and password', async () => {
    const secret = 'my_secret_pass_123';
    const rawUrl = `https://myuser:${secret}@bitbucket.org/org/repo.git`;

    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['bb-repo'], gitDirs: ['bb-repo'] }),
      execFn: buildFakeExecFn({
        'bb-repo': {
          branch: 'main',
          dirty: false,
          lastCommit: null,
          originUrl: rawUrl,
        },
      }),
    });

    const [clone] = await scanner.listClones();
    expect(clone.originUrl).not.toContain(secret);
    expect(clone.originUrl).not.toContain('myuser');
  });
});

// ── Integration tests: GET /api/workspace/repos ───────────────────────────────

describe('GET /api/workspace/repos — AC1 response shape (HTTP)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({
        dirs: ['repo-alpha', 'plain-dir', 'repo-beta'],
        gitDirs: ['repo-alpha', 'repo-beta'],
      }),
      execFn: buildFakeExecFn({
        'repo-alpha': {
          branch: 'main',
          dirty: false,
          lastCommit: { hash: 'aaaa111', subject: 'feat: alpha init', date: '2026-05-01T09:00:00Z' },
          originUrl: 'https://github.com/org/repo-alpha.git',
        },
        'repo-beta': {
          branch: 'feature/x',
          dirty: true,
          lastCommit: { hash: 'bbbb222', subject: 'wip: beta stuff', date: '2026-05-02T10:00:00Z' },
          originUrl: 'https://github.com/org/repo-beta.git',
        },
      }),
    });
    const app = makeApp(scanner);
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns HTTP 200', async () => {
    const res = await get(port, '/api/workspace/repos');
    expect(res.status).toBe(200);
  });

  it('response has repos array', async () => {
    const res = await get(port, '/api/workspace/repos');
    expect(Array.isArray(res.body.repos)).toBe(true);
  });

  it('lists only git clones (not plain-dir)', async () => {
    const res = await get(port, '/api/workspace/repos');
    const names = res.body.repos.map((r) => r.name);
    expect(names).toContain('repo-alpha');
    expect(names).toContain('repo-beta');
    expect(names).not.toContain('plain-dir');
  });

  it('each repo has all required fields', async () => {
    const res = await get(port, '/api/workspace/repos');
    for (const repo of res.body.repos) {
      expect(typeof repo.name).toBe('string');
      expect('branch' in repo).toBe(true);
      expect(typeof repo.dirty).toBe('boolean');
      expect('lastCommit' in repo).toBe(true);
      expect('originUrl' in repo).toBe(true);
    }
  });

  it('repo-alpha has correct field values', async () => {
    const res = await get(port, '/api/workspace/repos');
    const alpha = res.body.repos.find((r) => r.name === 'repo-alpha');
    expect(alpha).toBeDefined();
    expect(alpha.branch).toBe('main');
    expect(alpha.dirty).toBe(false);
    expect(alpha.lastCommit).toEqual({
      hash: 'aaaa111',
      subject: 'feat: alpha init',
      date: '2026-05-01T09:00:00Z',
    });
    expect(alpha.originUrl).toBe('https://github.com/org/repo-alpha.git');
  });

  it('repo-beta is dirty and has feature branch', async () => {
    const res = await get(port, '/api/workspace/repos');
    const beta = res.body.repos.find((r) => r.name === 'repo-beta');
    expect(beta).toBeDefined();
    expect(beta.dirty).toBe(true);
    expect(beta.branch).toBe('feature/x');
  });
});

// ── AC2 Integration: token must NOT appear in HTTP response ───────────────────

describe('GET /api/workspace/repos — AC2: token never in HTTP response body', () => {
  let server, port;
  const SECRET_TOKEN = 'ghs_VERY_SECRET_INSTALLATION_TOKEN_ABC123';

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['secure-repo'], gitDirs: ['secure-repo'] }),
      execFn: buildFakeExecFn({
        'secure-repo': {
          branch: 'main',
          dirty: false,
          lastCommit: { hash: 'abc1234', subject: 'init', date: '2026-01-01T00:00:00Z' },
          // Real git remote would have an embedded installation token:
          originUrl: `https://x-access-token:${SECRET_TOKEN}@github.com/org/secure-repo.git`,
        },
      }),
    });
    const app = makeApp(scanner);
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/workspace/repos');
    expect(res.status).toBe(200);
  });

  it('response body does NOT contain the raw token', async () => {
    const res = await get(port, '/api/workspace/repos');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SECRET_TOKEN);
  });

  it('response body does NOT contain "x-access-token"', async () => {
    const res = await get(port, '/api/workspace/repos');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('x-access-token');
  });

  it('originUrl in response is credential-free (no @ before host)', async () => {
    const res = await get(port, '/api/workspace/repos');
    const repo = res.body.repos[0];
    expect(repo.originUrl).toBe('https://github.com/org/secure-repo.git');
    // Paranoia: no userinfo@ pattern
    expect(repo.originUrl).not.toMatch(/https?:\/\/[^@]+@/);
  });
});

// ── Edge-cases ────────────────────────────────────────────────────────────────

describe('GET /api/workspace/repos — edge-cases', () => {
  it('WORKSPACE_DIR unset → repos: [] (no crash)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner);
    const { server, port } = await startServer(app);
    try {
      const res = await get(port, '/api/workspace/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toEqual([]);
    } finally {
      await closeServer(server);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('WORKSPACE_DIR not found (readdir fails) → repos: [] (no crash)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({
      workspaceDir: '/does/not/exist',
      fsDeps: buildFakeFsDeps({ readdirFail: true }),
      execFn: async () => { throw new Error('should not be called'); },
    });
    const app = makeApp(scanner);
    const { server, port } = await startServer(app);
    try {
      const res = await get(port, '/api/workspace/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toEqual([]);
    } finally {
      await closeServer(server);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('WORKSPACE_DIR contains no git dirs → repos: []', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: buildFakeFsDeps({ dirs: ['docs', 'tmp'], gitDirs: [] }),
      execFn: async () => ({ stdout: '' }),
    });
    const app = makeApp(scanner);
    const { server, port } = await startServer(app);
    try {
      const res = await get(port, '/api/workspace/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toEqual([]);
    } finally {
      await closeServer(server);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('endpoint is behind AccessGuard (missing header → 403 without DEV_NO_ACCESS)', async () => {
    // Use real AccessGuard without dev bypass
    delete process.env.DEV_NO_ACCESS;

    // Patch so AccessGuard runs in "production-like" mode but with injected keySet=undefined
    // By NOT setting DEV_NO_ACCESS and NOT providing a valid JWT, we get 403.
    // We need ACCESS_TEAM_DOMAIN absent too so keySet is undefined → fail-closed.
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner);
    const { server, port } = await startServer(app);
    try {
      const res = await get(port, '/api/workspace/repos');
      // No JWT header provided → 403 (AccessGuard fail-closed)
      expect(res.status).toBe(403);
    } finally {
      await closeServer(server);
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });
});

// ── AC1: live from filesystem (no store) — two calls both invoke fsDeps ───────

describe('WorkspaceScanner — AC1: live from FS (no cache)', () => {
  it('two listClones() calls both invoke readdir (no cached result)', async () => {
    let readdirCallCount = 0;
    const scanner = new WorkspaceScanner({
      workspaceDir: '/workspace',
      fsDeps: {
        readdir: async () => {
          readdirCallCount++;
          return [];
        },
        stat: async () => { throw new Error('ENOENT'); },
      },
      execFn: async () => ({ stdout: '' }),
    });
    await scanner.listClones();
    await scanner.listClones();
    expect(readdirCallCount).toBe(2);
  });
});
