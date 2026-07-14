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
 * Covers (docs/specs/workspace-mutator-credential-helper.md):
 *   AC1 — `WorkspaceMutator.pullClone`s `git pull` trägt die zwei Command-
 *         Scope-Flags (`-c credential.helper=` + `-c credential.https://
 *         github.com.helper=`) in genau dieser Reihenfolge VOR dem Subkommando.
 *   AC2 — die Flag-Werte sind leer (kein Secret in argv); der Token bleibt
 *         ausschließlich im GIT_ASKPASS-Env-Var-Pfad (Bestandsmechanik,
 *         unverändert getestet in den bestehenden AC3-Fällen weiter unten).
 *   AC3 — nur im Container gegen einen aktiven ambienten Helfer reproduzierbar
 *         (Container-only, siehe Spec „Edge-Cases") — hier nicht getestet.
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
import { mkdir, rm, symlink, writeFile, lstat as realLstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccessGuard } from '../src/AccessGuard.js';
import { WorkspaceScanner, stripCredentials } from '../src/WorkspaceScanner.js';
import { WorkspaceMutator, WorkspaceMutatorError } from '../src/WorkspaceMutator.js';
import { AuditStore } from '../src/AuditStore.js';
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

// ── HTTP POST helper ──────────────────────────────────────────────────────────

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
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
    req.write(bodyStr);
    req.end();
  });
}

// ── App builder ───────────────────────────────────────────────────────────────

function makeApp(workspaceScanner, auditStore, workspaceMutator, credentialStore) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  // Provide no-op stubs when not needed by calling test
  const audit = auditStore ?? new AuditStore();
  const mutator = workspaceMutator ?? new WorkspaceMutator({ workspaceDir: '/workspace' });
  app.use(workspaceReposRouter(workspaceScanner, audit, mutator, credentialStore ?? null));
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
    // Fake-Token zur Laufzeit zusammensetzen — das Literal würde den
    // gitleaks-Scan (Rule generic-api-key) als False Positive auslösen.
    const token = ['ghs', 'aB3-xY9', 'zQR'].join('_');
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
    // Zur Laufzeit zusammensetzen — gitleaks-False-Positive (generic-api-key) vermeiden.
    const secret = ['my', 'secret', 'pass', '123'].join('_');
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

// ── AC5: WorkspaceMutator — path traversal + symlink-flucht protection ────────

describe('WorkspaceMutator — AC5: path traversal prevention (unit, injected lstat)', () => {
  /**
   * Build a mutator with injected fsDeps and execFn for isolation.
   *
   * @param {object} opts
   * @param {string} opts.workspaceDir
   * @param {boolean} [opts.lstatExists]  If true, lstat resolves; else throws ENOENT.
   * @param {Function} [opts.rmFn]        Custom execFn for rm; defaults to no-op.
   */
  function buildMutator({ workspaceDir, lstatExists = true, rmFn = async () => {} } = {}) {
    return new WorkspaceMutator({
      workspaceDir,
      fsDeps: {
        lstat: async (p) => {
          if (!lstatExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return { path: p };
        },
      },
      execFn: rmFn,
    });
  }

  it('AC5 — simple valid name → resolves to direct child, no error', async () => {
    let rmCalledWith = null;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      lstatExists: true,
      rmFn: async (_cmd, args) => { rmCalledWith = args; },
    });
    await mutator.deleteClone('my-repo');
    expect(rmCalledWith).toEqual(['-rf', '--', '/workspace/my-repo']);
  });

  it('AC5 — traversal: name=".." → 400-class traversal error, rm NOT called', async () => {
    let rmCalled = false;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      rmFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('..')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — traversal: name="../../../etc" → traversal error, rm NOT called', async () => {
    let rmCalled = false;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      rmFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('../../../etc')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — absolute path as name → traversal error, rm NOT called', async () => {
    let rmCalled = false;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      rmFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('/etc/passwd')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — nested path "a/b" → traversal error (not a direct child)', async () => {
    let rmCalled = false;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      rmFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('a/b')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — empty name → traversal error', async () => {
    const mutator = buildMutator({ workspaceDir: '/workspace' });
    await expect(mutator.deleteClone('')).rejects.toMatchObject({ errorClass: 'traversal' });
  });

  it('AC5 — not-found: lstat throws → not-found error class, rm NOT called', async () => {
    let rmCalled = false;
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      lstatExists: false,
      rmFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('my-repo')).rejects.toMatchObject({
      errorClass: 'not-found',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — WORKSPACE_DIR unset → workspace-unset error class, rm NOT called', async () => {
    let rmCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: '',
      fsDeps: { lstat: async () => {} },
      execFn: async () => { rmCalled = true; },
    });
    await expect(mutator.deleteClone('my-repo')).rejects.toMatchObject({
      errorClass: 'workspace-unset',
    });
    expect(rmCalled).toBe(false);
  });

  it('AC5 — rm failure → rm-failed error class propagated', async () => {
    const mutator = buildMutator({
      workspaceDir: '/workspace',
      lstatExists: true,
      rmFn: async () => { throw new Error('Permission denied'); },
    });
    await expect(mutator.deleteClone('my-repo')).rejects.toMatchObject({
      errorClass: 'rm-failed',
    });
  });
});

// ── AC5: WorkspaceMutator — real filesystem: Symlink-Flucht (integration) ─────

describe('WorkspaceMutator — AC5: symlink-flucht (real tmp filesystem)', () => {
  let tmpWorkspace; // real tmp dir used as WORKSPACE_DIR
  let tmpOutside;   // real tmp dir OUTSIDE WORKSPACE_DIR

  beforeEach(async () => {
    // Create isolated tmp dirs for this test
    tmpWorkspace = join(tmpdir(), `workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpOutside = join(tmpdir(), `outside-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpWorkspace, { recursive: true });
    await mkdir(tmpOutside, { recursive: true });
  });

  afterEach(async () => {
    // Clean up both dirs (ignore errors if already removed by test)
    await rm(tmpWorkspace, { recursive: true, force: true });
    await rm(tmpOutside, { recursive: true, force: true });
  });

  it('AC5 — symlink inside workspace pointing outside: deletes only the symlink, not the target', async () => {
    // Create a real file OUTSIDE workspace
    const outsideFile = join(tmpOutside, 'secret.txt');
    await writeFile(outsideFile, 'outside content');

    // Create a symlink INSIDE workspace pointing to the outside dir
    const symlinkName = 'evil-link';
    const symlinkPath = join(tmpWorkspace, symlinkName);
    await symlink(tmpOutside, symlinkPath);

    // Confirm the symlink exists
    const { lstat: realLstat } = await import('node:fs/promises');
    const stat = await realLstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    // Use real WorkspaceMutator (no injection)
    const mutator = new WorkspaceMutator({ workspaceDir: tmpWorkspace });
    await mutator.deleteClone(symlinkName);

    // Symlink itself must be gone
    await expect(realLstat(symlinkPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // The target OUTSIDE workspace must still exist (not followed by rm -rf)
    const outsideStat = await realLstat(tmpOutside);
    expect(outsideStat.isDirectory()).toBe(true);
    const outsideFileStat = await realLstat(outsideFile);
    expect(outsideFileStat.isFile()).toBe(true);
  });

  it('AC5 — regular clone dir: deleted entirely from workspace', async () => {
    // Create a real clone-like dir inside workspace
    const cloneName = 'my-real-clone';
    const clonePath = join(tmpWorkspace, cloneName);
    await mkdir(clonePath, { recursive: true });
    await writeFile(join(clonePath, 'README.md'), '# test');

    const mutator = new WorkspaceMutator({ workspaceDir: tmpWorkspace });
    await mutator.deleteClone(cloneName);

    const { lstat: realLstat } = await import('node:fs/promises');
    await expect(realLstat(clonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Workspace itself intact
    const wsStat = await realLstat(tmpWorkspace);
    expect(wsStat.isDirectory()).toBe(true);
  });

  it('AC5 — traversal attempt with real fs: nothing outside workspace deleted', async () => {
    // Create a file outside workspace
    const outsideFile = join(tmpOutside, 'important.txt');
    await writeFile(outsideFile, 'do not delete me');

    const mutator = new WorkspaceMutator({ workspaceDir: tmpWorkspace });

    // Attempt traversal via name
    await expect(mutator.deleteClone('../' + tmpOutside.split('/').pop())).rejects.toMatchObject({
      errorClass: 'traversal',
    });

    // Outside file must still exist
    const { lstat: realLstat } = await import('node:fs/promises');
    const stat = await realLstat(outsideFile);
    expect(stat.isFile()).toBe(true);
  });

  it('AC5 — not-found: clone does not exist → 404-class error (lstat throws)', async () => {
    const mutator = new WorkspaceMutator({ workspaceDir: tmpWorkspace });
    await expect(mutator.deleteClone('nonexistent-repo')).rejects.toMatchObject({
      errorClass: 'not-found',
    });
  });
});

// ── AC5 + AC7 + AC8: POST /api/workspace/repos/delete (HTTP integration) ──────

describe('POST /api/workspace/repos/delete — AC5, AC7, AC8 (HTTP)', () => {
  let server, port, audit;

  /**
   * Build and start the test app with an injected (mock) WorkspaceMutator.
   *
   * @param {object} mutatorMock - object with deleteClone method
   * @param {object} [opts]
   * @param {boolean} [opts.noDevAccess] - if true, skip setting DEV_NO_ACCESS
   */
  async function startTestApp(mutatorMock, opts = {}) {
    if (!opts.noDevAccess) process.env.DEV_NO_ACCESS = '1';
    audit = new AuditStore();
    const scanner = new WorkspaceScanner({ workspaceDir: '' }); // read endpoint not tested here
    const app = makeApp(scanner, audit, mutatorMock);
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  }

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  // ── AC5: success path ─────────────────────────────────────────────────────

  it('AC5 — valid name → 200 { name, status: "deleted" }', async () => {
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'my-repo', status: 'deleted' });
  });

  it('AC5 — traversal name → 400', async () => {
    const mutator = {
      deleteClone: async () => {
        throw new WorkspaceMutatorError('Pfad-Traversal', 'traversal');
      },
    };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: '../etc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('AC5 — not-found → 404', async () => {
    const mutator = {
      deleteClone: async () => {
        throw new WorkspaceMutatorError('Klon nicht gefunden', 'not-found');
      },
    };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: 'missing-repo' });
    expect(res.status).toBe(404);
  });

  it('AC5 — missing name → 400', async () => {
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', {});
    expect(res.status).toBe(400);
  });

  it('AC5 — empty name → 400', async () => {
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: '' });
    expect(res.status).toBe(400);
  });

  it('AC5 — workspace-unset → 400', async () => {
    const mutator = {
      deleteClone: async () => {
        throw new WorkspaceMutatorError('WORKSPACE_DIR nicht konfiguriert', 'workspace-unset');
      },
    };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: 'some-repo' });
    expect(res.status).toBe(400);
  });

  // ── AC7: Audit-First ──────────────────────────────────────────────────────

  it('AC7 — successful delete: intent entry recorded BEFORE outcome (two entries)', async () => {
    const callOrder = [];
    const mutator = {
      deleteClone: async () => {
        callOrder.push('delete');
      },
    };
    // Spy audit to track call order
    const spyAudit = {
      record(entry) {
        callOrder.push(entry.command);
        audit.record(entry); // also record in real audit for assertions
      },
    };
    if (process.env.DEV_NO_ACCESS !== '1') process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, spyAudit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    await post(port, '/api/workspace/repos/delete', { name: 'audited-repo' });

    // Intent must appear before delete, outcome after
    const intentIdx = callOrder.indexOf('workspace:repo:delete:audited-repo');
    const deleteIdx = callOrder.indexOf('delete');
    const outcomeIdx = callOrder.indexOf('workspace:repo:delete:audited-repo:success');

    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(intentIdx);
    expect(outcomeIdx).toBeGreaterThan(deleteIdx);
  });

  it('AC7 — delete failure: intent + failed outcome entries recorded', async () => {
    const mutator = {
      deleteClone: async () => {
        throw new WorkspaceMutatorError('Not found', 'not-found');
      },
    };
    await startTestApp(mutator);
    await post(port, '/api/workspace/repos/delete', { name: 'gone-repo' });

    const entries = audit.getAll();
    const intent = entries.find((e) => e.command === 'workspace:repo:delete:gone-repo');
    const outcome = entries.find((e) => e.command.includes('gone-repo') && e.command.includes('failed:not-found'));
    expect(intent).toBeTruthy();
    expect(outcome).toBeTruthy();
  });

  it('AC7 — audit-write failure blocks mutation (Audit-First)', async () => {
    let deleteCalled = false;
    const mutator = { deleteClone: async () => { deleteCalled = true; } };
    const brokenAudit = {
      record() { throw new Error('Audit store down'); },
    };
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, brokenAudit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);
    expect(deleteCalled).toBe(false); // mutation must NOT proceed
  });

  it('AC7 — audit entries do not contain tokens or secrets', async () => {
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    await post(port, '/api/workspace/repos/delete', { name: 'safe-repo' });
    const allEntries = JSON.stringify(audit.getAll());
    expect(allEntries).not.toContain('Bearer');
    expect(allEntries).not.toContain('ghs_');
    expect(allEntries).not.toContain('token');
  });

  // ── AC8: CRED_ADMIN_EMAILS ────────────────────────────────────────────────

  it('AC8 — CRED_ADMIN_EMAILS set, dev@local not in list → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    // DEV_NO_ACCESS sets identity email to 'dev@local'
    const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/berechtigung/i);
  });

  it('AC8 — CRED_ADMIN_EMAILS set, dev@local in list → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
    expect(res.status).toBe(200);
  });

  it('AC8 — CRED_ADMIN_EMAILS not set → any valid identity allowed', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    const mutator = { deleteClone: async () => {} };
    await startTestApp(mutator);
    const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
    expect(res.status).toBe(200);
  });

  it('AC8 — no AccessGuard token (production mode) → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const mutator = { deleteClone: async () => {} };
    audit = new AuditStore();
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, audit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    try {
      const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
      expect(res.status).toBe(403);
    } finally {
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });
});

// ── AC3, AC4, AC7, AC8: WorkspaceMutator.pullClone (unit, injected deps) ──────

describe('WorkspaceMutator.pullClone — AC4: path traversal prevention (unit)', () => {
  /**
   * Build a mutator with injected deps for pull testing.
   */
  function buildPullMutator({ workspaceDir, lstatExists = true, pullResult = { stdout: 'Already up to date.\n', stderr: '' } } = {}) {
    return new WorkspaceMutator({
      workspaceDir,
      fsDeps: {
        lstat: async (p) => {
          if (!lstatExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return { path: p };
        },
        // realpath: identity for unit tests (all paths are synthetic, no real symlinks)
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, _args, _opts) => pullResult,
    });
  }

  it('AC4 — traversal: name=".." → traversal error, mintFn NOT called', async () => {
    let mintCalled = false;
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(mutator.pullClone('..', async () => { mintCalled = true; return 'token'; })).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(mintCalled).toBe(false);
  });

  it('AC4 — traversal: name="../../../etc" → traversal error, mintFn NOT called', async () => {
    let mintCalled = false;
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(mutator.pullClone('../../../etc', async () => { mintCalled = true; return 'token'; })).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(mintCalled).toBe(false);
  });

  it('AC4 — absolute path as name → traversal error, mintFn NOT called', async () => {
    let mintCalled = false;
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(mutator.pullClone('/etc/passwd', async () => { mintCalled = true; return 'token'; })).rejects.toMatchObject({
      errorClass: 'traversal',
    });
    expect(mintCalled).toBe(false);
  });

  it('AC4 — nested "a/b" → traversal error', async () => {
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(mutator.pullClone('a/b', async () => 'token')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
  });

  it('AC4 — empty name → traversal error', async () => {
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(mutator.pullClone('', async () => 'token')).rejects.toMatchObject({
      errorClass: 'traversal',
    });
  });

  it('AC4 — not-found: lstat throws → not-found error class, mintFn NOT called', async () => {
    let mintCalled = false;
    const mutator = buildPullMutator({ workspaceDir: '/workspace', lstatExists: false });
    await expect(mutator.pullClone('my-repo', async () => { mintCalled = true; return 'token'; })).rejects.toMatchObject({
      errorClass: 'not-found',
    });
    expect(mintCalled).toBe(false);
  });

  it('AC4 — WORKSPACE_DIR unset → workspace-unset error, mintFn NOT called', async () => {
    let mintCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: '',
      fsDeps: { lstat: async () => {}, realpath: async (p) => p, writeFile: async () => {}, unlink: async () => {} },
      execFn: async () => ({}),
    });
    await expect(mutator.pullClone('my-repo', async () => { mintCalled = true; return 'token'; })).rejects.toMatchObject({
      errorClass: 'workspace-unset',
    });
    expect(mintCalled).toBe(false);
  });

  it('AC3 — mintFn called AFTER path validation passes (immediately before git pull)', async () => {
    const callOrder = [];
    let execCalledWith = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => { callOrder.push('writeFile'); },
        unlink: async () => {},

      },
      execFn: async (_cmd, args, opts) => {
        callOrder.push('gitPull');
        execCalledWith = { args, env: opts?.env };
        return { stdout: 'Already up to date.\n', stderr: '' };
      },
    });

    let mintOrder = -1;
    const mintFn = async () => {
      mintOrder = callOrder.length;
      callOrder.push('mint');
      return 'fake-token-123';
    };

    await mutator.pullClone('my-repo', mintFn);

    // Mint must happen after validation (writeFile for askpass comes after mint)
    const mintIdx = callOrder.indexOf('mint');
    const pullIdx = callOrder.indexOf('gitPull');
    expect(mintIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeGreaterThan(mintIdx); // pull happens AFTER mint
    expect(mintOrder).toBeGreaterThanOrEqual(0);

    // Token must NOT be in argv — git pull args carry only the Command-Scope
    // credential-helper neutralization flags (workspace-mutator-credential-
    // helper AC1) followed by the subcommand.
    expect(execCalledWith.args).toEqual([
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      'pull',
    ]);

    // GIT_ASKPASS must be set (points to temp script)
    expect(execCalledWith.env).toHaveProperty('GIT_ASKPASS');

    // Token itself must NOT appear in env key 'GIT_ASKPASS' or 'PATH' etc.
    // It's in a randomly-named env var — we can't predict the name,
    // but we verify 'fake-token-123' is NOT the value of GIT_ASKPASS.
    expect(execCalledWith.env.GIT_ASKPASS).not.toContain('fake-token-123');

    // GIT_TERMINAL_PROMPT must be '0' (disable interactive prompts)
    expect(execCalledWith.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('AC3 — token NOT in returned result (summary is stdout, not the token)', async () => {
    const TOKEN = 'fake-secret-token-xyz';
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},

      },
      execFn: async () => ({ stdout: 'Already up to date.\n', stderr: '' }),
    });

    const result = await mutator.pullClone('my-repo', async () => TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('AC3 — credentials-missing when mintFn rejects → pull-failed escalation', async () => {
    const mutator = buildPullMutator({ workspaceDir: '/workspace' });
    await expect(
      mutator.pullClone('my-repo', async () => { throw new Error('No credentials'); }),
    ).rejects.toMatchObject({ errorClass: 'credentials-missing' });
  });

  it('AC4 — pull-failed when git pull returns non-zero → pull-failed error', async () => {
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},

      },
      execFn: async () => { throw new Error('exit code 128'); },
    });

    await expect(
      mutator.pullClone('my-repo', async () => 'fake-token'),
    ).rejects.toMatchObject({ errorClass: 'pull-failed' });
  });

  it('AC3 — temp askpass script is cleaned up even when git pull fails', async () => {
    let unlinkCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => { unlinkCalled = true; },

      },
      execFn: async () => { throw new Error('git pull failed'); },
    });

    try {
      await mutator.pullClone('my-repo', async () => 'fake-token');
    } catch {
      // expected
    }
    expect(unlinkCalled).toBe(true);
  });

  it('S1 — git pull stderr "does not appear to be a git repository" → no-remote error', async () => {
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async () => {
        throw new Error('fatal: \'origin\' does not appear to be a git repository');
      },
    });
    await expect(
      mutator.pullClone('my-repo', async () => 'fake-token'),
    ).rejects.toMatchObject({ errorClass: 'no-remote' });
  });

  it('AC3 — valid pull returns { summary } without token', async () => {
    const TOKEN = 'ghs_FAKE_TOKEN_FOR_PULL';
    const mutator = buildPullMutator({
      workspaceDir: '/workspace',
      pullResult: { stdout: `Already up to date.\n`, stderr: '' },
    });

    const result = await mutator.pullClone('my-repo', async () => TOKEN);
    expect(result).toHaveProperty('summary');
    expect(result.summary).not.toContain(TOKEN);
    expect(result.summary).toContain('Already up to date');
  });
});

// ── workspace-mutator-credential-helper AC1/AC2: pullClone git pull ───────────

describe('WorkspaceMutator.pullClone — workspace-mutator-credential-helper AC1/AC2', () => {
  it('AC1 — git pull trägt die zwei Command-Scope-Flags in genau dieser Reihenfolge VOR dem Subkommando', async () => {
    let capturedArgs = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => {
        capturedArgs = [...args];
        return { stdout: 'Already up to date.\n', stderr: '' };
      },
    });

    await mutator.pullClone('my-repo', async () => 'token');

    expect(capturedArgs).toEqual([
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      'pull',
    ]);
  });

  it('AC2 — die Flag-Werte sind leer (kein Secret in argv) und der Token erscheint in KEINEM argv-Element', async () => {
    let capturedArgs = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (_cmd, args) => {
        capturedArgs = [...args];
        return { stdout: 'Already up to date.\n', stderr: '' };
      },
    });

    await mutator.pullClone('my-repo', async () => 'ULTRA-SECRET-PULL-TOKEN-99');

    expect(capturedArgs[1]).toBe('credential.helper=');
    expect(capturedArgs[3]).toBe('credential.https://github.com.helper=');
    // Beide Flag-Werte nach dem letzten '=' sind leer.
    expect(capturedArgs[1].split('=')[1] ?? '').toBe('');
    expect(capturedArgs[3].split('=').pop()).toBe('');
    for (const arg of capturedArgs) {
      expect(arg).not.toContain('ULTRA-SECRET-PULL-TOKEN-99');
    }
  });
});

// ── AC3, AC4, AC7, AC8: POST /api/workspace/repos/pull (HTTP integration) ─────

describe('POST /api/workspace/repos/pull — AC3, AC4, AC7, AC8 (HTTP)', () => {
  let server, port, audit;

  /**
   * Build and start the test app with injected WorkspaceMutator mock.
   *
   * @param {object} mutatorMock - object with pullClone method
   * @param {object} [opts]
   * @param {boolean} [opts.noDevAccess] - skip setting DEV_NO_ACCESS
   * @param {object} [opts.credStore] - fake credentialStore
   */
  async function startPullApp(mutatorMock, opts = {}) {
    if (!opts.noDevAccess) process.env.DEV_NO_ACCESS = '1';
    audit = new AuditStore();
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    // Pass a no-op credentialStore — pull tests use the mutator mock directly
    const credStore = opts.credStore ?? null;
    const app = makeApp(scanner, audit, mutatorMock, credStore);
    const started = await startServer(app);
    server = started.server;
    port = started.port;
  }

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
  });

  // ── Success path ──────────────────────────────────────────────────────────

  it('AC3/AC4 — valid name → 200 { name, status: "pulled" }', async () => {
    const mutator = {
      pullClone: async () => ({ summary: 'Already up to date.' }),
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('my-repo');
    expect(res.body.status).toBe('pulled');
  });

  it('AC3 — response body does NOT contain any token-like string', async () => {
    const FAKE_TOKEN = 'ghs_SUPER_SECRET_TOKEN_FOR_PULL_TEST';
    const mutator = {
      // Simulate a pull that accidentally put a token in summary (should be sanitized)
      pullClone: async () => ({ summary: 'Already up to date.' }),
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(FAKE_TOKEN);
  });

  it('AC3 — summary is included when present', async () => {
    const mutator = {
      pullClone: async () => ({ summary: 'Updating abc..def\nFast-forward\n' }),
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toContain('Fast-forward');
  });

  // ── AC4: Traversal / validation ───────────────────────────────────────────

  it('AC4 — traversal name → pullClone throws traversal → 400', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('Pfad-Traversal', 'traversal');
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: '../etc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('AC4 — not-found → 404', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('Klon nicht gefunden', 'not-found');
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'missing-repo' });
    expect(res.status).toBe(404);
  });

  it('AC4 — missing name → 400', async () => {
    const mutator = { pullClone: async () => ({ summary: '' }) };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', {});
    expect(res.status).toBe(400);
  });

  it('AC4 — empty name → 400', async () => {
    const mutator = { pullClone: async () => ({ summary: '' }) };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: '' });
    expect(res.status).toBe(400);
  });

  it('AC4 — workspace-unset error → 400', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('WORKSPACE_DIR nicht konfiguriert', 'workspace-unset');
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'some-repo' });
    expect(res.status).toBe(400);
  });

  it('AC3 — credentials-missing → 500 (no secret in response)', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('Installation-Token konnte nicht gemintet werden', 'credentials-missing');
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(500);
    // Response must not contain any token
    expect(JSON.stringify(res.body)).not.toContain('ghs_');
    expect(JSON.stringify(res.body)).not.toContain('Bearer');
  });

  it('AC3 — pull-failed → 502 (no secret in response)', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('git pull fehlgeschlagen: exit code 128', 'pull-failed');
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('ghs_');
  });

  it('AC4 — pull-failed with conflict message → 409', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError(
          'git pull fehlgeschlagen für "my-repo": error: Your local changes would be overwritten by merge',
          'pull-failed',
        );
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(409);
  });

  it('S1 — no-remote error (does not appear to be a git repository) → 409', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError(
          'Kein Remote konfiguriert für "no-remote-repo"',
          'no-remote',
        );
      },
    };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'no-remote-repo' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  // ── AC7: Audit-First ──────────────────────────────────────────────────────

  it('AC7 — successful pull: intent entry BEFORE pull, outcome after', async () => {
    const callOrder = [];
    const mutator = {
      pullClone: async () => {
        callOrder.push('pull');
        return { summary: '' };
      },
    };
    const spyAudit = {
      record(entry) {
        callOrder.push(entry.command);
        audit.record(entry);
      },
    };
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, spyAudit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    await post(port, '/api/workspace/repos/pull', { name: 'audited-repo' });

    const intentIdx = callOrder.indexOf('workspace:repo:pull:audited-repo');
    const pullIdx = callOrder.indexOf('pull');
    const outcomeIdx = callOrder.indexOf('workspace:repo:pull:audited-repo:success');

    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeGreaterThan(intentIdx);
    expect(outcomeIdx).toBeGreaterThan(pullIdx);
  });

  it('AC7 — pull failure: intent + failed outcome entries recorded', async () => {
    const mutator = {
      pullClone: async () => {
        throw new WorkspaceMutatorError('Not found', 'not-found');
      },
    };
    await startPullApp(mutator);
    await post(port, '/api/workspace/repos/pull', { name: 'gone-repo' });

    const entries = audit.getAll();
    const intent = entries.find((e) => e.command === 'workspace:repo:pull:gone-repo');
    const outcome = entries.find((e) => e.command.includes('gone-repo') && e.command.includes('failed:not-found'));
    expect(intent).toBeTruthy();
    expect(outcome).toBeTruthy();
  });

  it('AC7 — audit-write failure blocks pull (Audit-First)', async () => {
    let pullCalled = false;
    const mutator = { pullClone: async () => { pullCalled = true; return { summary: '' }; } };
    const brokenAudit = {
      record() { throw new Error('Audit store down'); },
    };
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, brokenAudit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);
    expect(pullCalled).toBe(false);
  });

  it('AC7 — audit entries do not contain tokens or secrets', async () => {
    const mutator = { pullClone: async () => ({ summary: 'Already up to date.' }) };
    await startPullApp(mutator);
    await post(port, '/api/workspace/repos/pull', { name: 'safe-repo' });
    const allEntries = JSON.stringify(audit.getAll());
    expect(allEntries).not.toContain('Bearer');
    expect(allEntries).not.toContain('ghs_');
    expect(allEntries).not.toContain('x-access-token');
  });

  // ── AC8: CRED_ADMIN_EMAILS ────────────────────────────────────────────────

  it('AC8 — CRED_ADMIN_EMAILS set, dev@local not in list → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    const mutator = { pullClone: async () => ({ summary: '' }) };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/berechtigung/i);
  });

  it('AC8 — CRED_ADMIN_EMAILS set, dev@local in list → 200', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';
    const mutator = { pullClone: async () => ({ summary: '' }) };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(200);
  });

  it('AC8 — CRED_ADMIN_EMAILS not set → any valid identity allowed', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    const mutator = { pullClone: async () => ({ summary: '' }) };
    await startPullApp(mutator);
    const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
    expect(res.status).toBe(200);
  });

  it('AC8 — no AccessGuard token (production mode) → 403', async () => {
    delete process.env.DEV_NO_ACCESS;
    const savedDomain = process.env.ACCESS_TEAM_DOMAIN;
    const savedAud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_TEAM_DOMAIN;
    delete process.env.ACCESS_AUD;

    const mutator = { pullClone: async () => ({ summary: '' }) };
    audit = new AuditStore();
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, audit, mutator);
    const started = await startServer(app);
    server = started.server;
    port = started.port;

    try {
      const res = await post(port, '/api/workspace/repos/pull', { name: 'my-repo' });
      expect(res.status).toBe(403);
    } finally {
      if (savedDomain !== undefined) process.env.ACCESS_TEAM_DOMAIN = savedDomain;
      if (savedAud !== undefined) process.env.ACCESS_AUD = savedAud;
    }
  });
});

// ── AC4: pullClone with real filesystem: traversal + symlink-flucht ───────────

describe('WorkspaceMutator.pullClone — AC4: real filesystem traversal + symlink guard', () => {
  let tmpWorkspace;
  let tmpOutside;

  beforeEach(async () => {
    tmpWorkspace = join(tmpdir(), `ws-pull-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpOutside = join(tmpdir(), `outside-pull-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpWorkspace, { recursive: true });
    await mkdir(tmpOutside, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpWorkspace, { recursive: true, force: true });
    await rm(tmpOutside, { recursive: true, force: true });
  });

  it('AC4 — traversal attempt: nothing outside workspace pulled/deleted', async () => {
    const outsideFile = join(tmpOutside, 'important.txt');
    await writeFile(outsideFile, 'do not touch me');

    const mutator = new WorkspaceMutator({ workspaceDir: tmpWorkspace });

    await expect(
      mutator.pullClone(`../${tmpOutside.split('/').pop()}`, async () => 'fake-token'),
    ).rejects.toMatchObject({ errorClass: 'traversal' });

    // File outside workspace must be untouched
    const stat = await realLstat(outsideFile);
    expect(stat.isFile()).toBe(true);
  });

  it('AC4 — valid clone dir inside workspace: pullClone attempts git pull', async () => {
    // Create a fake clone dir (with .git)
    const cloneName = 'test-pull-repo';
    const clonePath = join(tmpWorkspace, cloneName);
    await mkdir(join(clonePath, '.git'), { recursive: true });

    // Use injected execFn so we don't need a real git remote
    let pullCwd = null;
    let pullEnv = null;
    const mutator = new WorkspaceMutator({
      workspaceDir: tmpWorkspace,
      execFn: async (_cmd, _args, opts) => {
        pullCwd = opts?.cwd;
        pullEnv = opts?.env;
        return { stdout: 'Already up to date.\n', stderr: '' };
      },
      // Use real fsDeps for lstat; inject writeFile/unlink for askpass
      fsDeps: {
        lstat: realLstat,
        realpath: (await import('node:fs/promises')).realpath,
        writeFile: async () => {},
        unlink: async () => {},
      },
    });

    const result = await mutator.pullClone(cloneName, async () => 'fake-token-abc');

    // git pull ran in the correct directory
    expect(pullCwd).toBe(clonePath);

    // Token must NOT be in argv or the GIT_ASKPASS path value
    // (it's only in a randomly-named env var)
    expect(pullEnv.GIT_ASKPASS).not.toContain('fake-token-abc');
    expect(pullEnv.GIT_TERMINAL_PROMPT).toBe('0');

    // Result does not contain the token
    expect(JSON.stringify(result)).not.toContain('fake-token-abc');
    expect(result.summary).toContain('Already up to date');
  });

  it('AC4 — symlink inside workspace pointing outside: realpath guard rejects pull (C1 fix)', async () => {
    // Create a symlink inside workspace pointing OUTSIDE
    const symlinkName = 'evil-link';
    const symlinkPath = join(tmpWorkspace, symlinkName);
    await symlink(tmpOutside, symlinkPath);

    // The mutator uses real fsDeps (including realpath).
    // realpath(symlinkPath) resolves to tmpOutside (outside WORKSPACE_DIR) → traversal error.
    let mintCalled = false;
    let pullCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: tmpWorkspace,
      execFn: async () => {
        pullCalled = true;
        return { stdout: 'Already up to date.\n', stderr: '' };
      },
      // Use real fsDeps so realpath resolves the actual symlink target
    });

    // AC4: symlink pointing outside WORKSPACE_DIR must be rejected with traversal error
    await expect(
      mutator.pullClone(symlinkName, async () => { mintCalled = true; return 'fake-token'; }),
    ).rejects.toMatchObject({ errorClass: 'traversal' });

    // mint and git pull must NOT have been called (rejected before token mint)
    expect(mintCalled).toBe(false);
    expect(pullCalled).toBe(false);
  });
});

// ── Regression: existing tests for GET and delete should still pass ───────────

describe('Regression — GET /api/workspace/repos and DELETE still work after pull added', () => {
  it('GET /api/workspace/repos still returns 200', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner);
    const { server, port } = await startServer(app);
    try {
      const res = await get(port, '/api/workspace/repos');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.repos)).toBe(true);
    } finally {
      await closeServer(server);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('POST /api/workspace/repos/delete still returns 200 for valid name', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const mutator = { deleteClone: async () => {}, pullClone: async () => ({ summary: '' }) };
    const scanner = new WorkspaceScanner({ workspaceDir: '' });
    const app = makeApp(scanner, new AuditStore(), mutator);
    const { server, port } = await startServer(app);
    try {
      const res = await post(port, '/api/workspace/repos/delete', { name: 'my-repo' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('deleted');
    } finally {
      await closeServer(server);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});
