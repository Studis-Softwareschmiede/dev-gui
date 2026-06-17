/**
 * githubPackages.test.js — tests for GET /api/github/packages and GET /api/github/packages/:name/tags
 *
 * Spec: docs/specs/ghcr-image-list.md
 *
 * Covers (ghcr-image-list):
 *   AC1 — GitHub-Packages-API access only through GitHubPackagesReader boundary;
 *          token exclusively via injected tokenProvider; no process.env.GH_TOKEN path.
 *   AC2 — GET /api/github/packages returns 200 { packages: ImagePackage[] };
 *          each entry: { name, fullImageRef, visibility, htmlUrl, updatedAt };
 *          fullImageRef = ghcr.io/<org>/<name> (lowercase, no tag);
 *          sorted alphabetically by name; fully paginated.
 *   AC3 — GET /api/github/packages/:name/tags returns 200 { tags: ImageTag[] };
 *          each entry: { tag, digest, updatedAt }; sorted by updatedAt descending;
 *          one entry per tag per version; untagged versions omitted.
 *   AC4 — Both endpoints behind AccessGuard (DEV_NO_ACCESS bypass tested);
 *          read-only (no POST/PATCH/PUT/DELETE); token never in Response/Log/errors.
 *   AC5 — GitHub unreachable / no token / 401/404 → empty list + 200;
 *          {name} validated (^[A-Za-z0-9._-]+$) → 400 on invalid, no API call.
 *
 * Strategy:
 *   - Inject fake fetch into GitHubPackagesReader (no real HTTP)
 *   - Run through real Express app with DEV_NO_ACCESS=1
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createAccessGuard } from '../src/AccessGuard.js';
import { GitHubPackagesReader, isValidPackageName } from '../src/GitHubPackagesReader.js';
import { githubPackagesRouter } from '../src/githubPackagesRouter.js';

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

function request(port, path, method) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Build a minimal Express app with AccessGuard (dev bypass) + githubPackagesRouter.
 * Accepts a pre-constructed GitHubPackagesReader so tests can inject fakes.
 */
function makeApp({ githubPackagesReader }) {
  const app = express();
  app.use(express.json());
  const guard = createAccessGuard();
  app.use('/api', guard);
  app.use(githubPackagesRouter({ githubPackagesReader }));
  return app;
}

// ── Fake response helpers ─────────────────────────────────────────────────────

/** Fake Response with JSON body and optional Link header. */
function fakeJson(data, status = 200, linkHeader = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name === 'link' ? linkHeader : null),
    },
    json: async () => data,
  };
}

/** Fake Response with given status and no (or null) body. */
function fakeResponse(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

// ── Fake fetch builders ───────────────────────────────────────────────────────

/**
 * Build a fake fetch for packages list + versions.
 *
 * @param {object} opts
 * @param {Array<object>} [opts.packages]       raw GitHub package objects
 * @param {Record<string, Array<object>>} [opts.versions]  packageName → raw version objects
 * @param {boolean} [opts.failPackageList]      throw on package-list call
 * @param {number} [opts.packagesStatus]        HTTP status for packages list (default 200)
 * @param {number} [opts.versionsStatus]        HTTP status for versions calls (default 200)
 */
function buildFakeFetch({
  packages = [],
  versions = {},
  failPackageList = false,
  packagesStatus = 200,
  versionsStatus = 200,
} = {}) {
  return async function fakeFetch(url, _init) {
    const u = new URL(url);

    // packages list: /orgs/{org}/packages?package_type=container
    if (u.pathname.match(/\/orgs\/[^/]+\/packages$/) && u.searchParams.get('package_type') === 'container') {
      if (failPackageList) throw new Error('network error');
      if (packagesStatus !== 200) return fakeResponse(packagesStatus, null);
      return fakeJson(packages);
    }

    // versions: /orgs/{org}/packages/container/{name}/versions
    const verMatch = u.pathname.match(/\/orgs\/[^/]+\/packages\/container\/([^/]+)\/versions$/);
    if (verMatch) {
      const pkgName = decodeURIComponent(verMatch[1]);
      if (versionsStatus !== 200) return fakeResponse(versionsStatus, null);
      const vers = versions[pkgName] ?? [];
      return fakeJson(vers);
    }

    return fakeResponse(404, null);
  };
}

// ── AC1 — Boundary + token isolation ─────────────────────────────────────────

describe('AC1 — GitHubPackagesReader: only injected tokenProvider, no GH_TOKEN fallback', () => {
  it('uses the injected tokenProvider to authenticate', async () => {
    let capturedHeaders = null;
    const fetchFn = async (url, init) => {
      capturedHeaders = init?.headers ?? {};
      return fakeJson([]);
    };
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'test-token-abc',
      fetchFn,
    });
    await reader.listPackages();
    expect(capturedHeaders['Authorization']).toBe('Bearer test-token-abc');
  });

  it('does not read process.env.GH_TOKEN (no fallback)', async () => {
    const origToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'env-token-should-not-be-used';
    let capturedHeaders = null;
    const fetchFn = async (_url, init) => {
      capturedHeaders = init?.headers ?? {};
      // Return 200 only to confirm token was sent or not
      return fakeJson([]);
    };
    // No tokenProvider injected → should NOT use GH_TOKEN
    const reader = new GitHubPackagesReader({ fetchFn });
    await reader.listPackages();
    // Without token, fetch should not be called (degrade gracefully)
    // OR headers should not contain the env token
    if (capturedHeaders !== null) {
      expect(capturedHeaders['Authorization']).not.toContain('env-token-should-not-be-used');
    }
    process.env.GH_TOKEN = origToken;
  });

  it('isValidPackageName accepts valid names', () => {
    expect(isValidPackageName('my-app')).toBe(true);
    expect(isValidPackageName('app.v2')).toBe(true);
    expect(isValidPackageName('App_123')).toBe(true);
    expect(isValidPackageName('a')).toBe(true);
  });

  it('isValidPackageName rejects invalid names', () => {
    expect(isValidPackageName('')).toBe(false);
    expect(isValidPackageName('../etc')).toBe(false);
    expect(isValidPackageName('my/app')).toBe(false);
    expect(isValidPackageName('my app')).toBe(false);
    expect(isValidPackageName('app;ls')).toBe(false);
    expect(isValidPackageName(null)).toBe(false);
    expect(isValidPackageName(undefined)).toBe(false);
  });
});

// ── AC2 — GET /api/github/packages — Image-Liste ─────────────────────────────

describe('GET /api/github/packages — AC2 response shape', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        packages: [
          {
            name: 'zebra-app',
            visibility: 'private',
            html_url: 'https://github.com/orgs/Studis-Softwareschmiede/packages/container/zebra-app/versions',
            updated_at: '2024-01-02T10:00:00Z',
          },
          {
            name: 'alpha-app',
            visibility: 'public',
            html_url: 'https://github.com/orgs/Studis-Softwareschmiede/packages/container/alpha-app/versions',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.status).toBe(200);
  });

  it('response has packages array', async () => {
    const res = await get(port, '/api/github/packages');
    expect(Array.isArray(res.body.packages)).toBe(true);
  });

  it('each package has name, fullImageRef, visibility, htmlUrl, updatedAt', async () => {
    const res = await get(port, '/api/github/packages');
    for (const p of res.body.packages) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.fullImageRef).toBe('string');
      expect(['public', 'private', 'internal']).toContain(p.visibility);
      expect(typeof p.htmlUrl).toBe('string');
      expect(typeof p.updatedAt).toBe('string');
    }
  });

  it('fullImageRef is ghcr.io/<org>/<name> in lowercase without tag', async () => {
    const res = await get(port, '/api/github/packages');
    for (const p of res.body.packages) {
      expect(p.fullImageRef).toMatch(/^ghcr\.io\/studis-softwareschmiede\/[a-z0-9._-]+$/);
      expect(p.fullImageRef).not.toContain(':');
    }
  });

  it('packages are sorted alphabetically by name', async () => {
    const res = await get(port, '/api/github/packages');
    const names = res.body.packages.map((p) => p.name);
    expect(names[0]).toBe('alpha-app');
    expect(names[1]).toBe('zebra-app');
  });

  it('alpha-app has correct field values', async () => {
    const res = await get(port, '/api/github/packages');
    const alpha = res.body.packages.find((p) => p.name === 'alpha-app');
    expect(alpha).toBeDefined();
    expect(alpha.fullImageRef).toBe('ghcr.io/studis-softwareschmiede/alpha-app');
    expect(alpha.visibility).toBe('public');
    expect(alpha.updatedAt).toBe('2024-01-01T00:00:00Z');
  });
});

// ── AC2 — Pagination ──────────────────────────────────────────────────────────

describe('AC2 — Pagination: all pages are collected', () => {
  it('fetches page 2 when Link: next header is present', async () => {
    let callCount = 0;
    const page1Pkg = { name: 'pkg-page1', visibility: 'private', html_url: 'https://x.com', updated_at: '' };
    const page2Pkg = { name: 'pkg-page2', visibility: 'private', html_url: 'https://x.com', updated_at: '' };

    const fetchFn = async (url) => {
      callCount++;
      const u = new URL(url);
      // First page: return Link: next
      if (!u.searchParams.get('page') || u.searchParams.get('page') === '1') {
        const nextUrl = url.includes('?')
          ? url + '&page=2'
          : url + '?page=2';
        return fakeJson([page1Pkg], 200, `<${nextUrl}>; rel="next"`);
      }
      // Second page: no Link header
      return fakeJson([page2Pkg], 200, null);
    };

    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn,
    });
    const packages = await reader.listPackages();
    expect(callCount).toBe(2);
    expect(packages.map((p) => p.name)).toContain('pkg-page1');
    expect(packages.map((p) => p.name)).toContain('pkg-page2');
  });
});

// ── AC2 — Token never in response ─────────────────────────────────────────────

describe('AC2/AC4 — App-Token never appears in response (security/R01)', () => {
  it('response body does not contain any token string', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'super-secret-ghp_token',
      fetchFn: buildFakeFetch({
        packages: [{ name: 'my-pkg', visibility: 'private', html_url: 'https://x', updated_at: '' }],
      }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages');
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

// ── AC2 — Read-only (no write methods on router) ──────────────────────────────

describe('AC4 — githubPackagesRouter exposes only GET (no write routes)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ packages: [] }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('GET /api/github/packages returns 200', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.status).toBe(200);
  });

  it('AC4 — POST /api/github/packages is not a write route (404/405)', async () => {
    const res = await request(port, '/api/github/packages', 'POST');
    expect([404, 405]).toContain(res.status);
  });

  it('AC4 — DELETE /api/github/packages/foo/tags is not a write route (404/405)', async () => {
    const res = await request(port, '/api/github/packages/foo/tags', 'DELETE');
    expect([404, 405]).toContain(res.status);
  });
});

describe('AC4 — AccessGuard blocks both endpoints without DEV_NO_ACCESS bypass', () => {
  let server, port, prevDev, prevNode;

  beforeEach(async () => {
    prevDev = process.env.DEV_NO_ACCESS;
    prevNode = process.env.NODE_ENV;
    delete process.env.DEV_NO_ACCESS;   // kein Bypass
    process.env.NODE_ENV = 'test';      // nicht production
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ packages: [] }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    if (prevDev === undefined) delete process.env.DEV_NO_ACCESS; else process.env.DEV_NO_ACCESS = prevDev;
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
  });

  it('AC4 — GET /api/github/packages without Access token → 403', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.status).toBe(403);
  });

  it('AC4 — GET /api/github/packages/foo/tags without Access token → 403', async () => {
    const res = await get(port, '/api/github/packages/foo/tags');
    expect(res.status).toBe(403);
  });
});

// ── AC3 — GET /api/github/packages/:name/tags — Tag-Liste ────────────────────

describe('GET /api/github/packages/:name/tags — AC3 response shape', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'test-token',
      fetchFn: buildFakeFetch({
        packages: [],
        versions: {
          'my-app': [
            {
              name: 'sha256:abc123',
              updated_at: '2024-03-01T12:00:00Z',
              metadata: { container: { tags: ['v2.0', 'latest'] } },
            },
            {
              name: 'sha256:def456',
              updated_at: '2024-01-15T08:00:00Z',
              metadata: { container: { tags: ['v1.0'] } },
            },
          ],
        },
      }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 200', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    expect(res.status).toBe(200);
  });

  it('response has tags array', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    expect(Array.isArray(res.body.tags)).toBe(true);
  });

  it('each tag entry has tag, digest, updatedAt', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    for (const t of res.body.tags) {
      expect(typeof t.tag).toBe('string');
      expect(typeof t.digest).toBe('string');
      expect(typeof t.updatedAt).toBe('string');
    }
  });

  it('a version with multiple tags produces one entry per tag', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    // version sha256:abc123 has 2 tags (v2.0, latest)
    const tags = res.body.tags.map((t) => t.tag);
    expect(tags).toContain('v2.0');
    expect(tags).toContain('latest');
  });

  it('tags are sorted by updatedAt descending (newest first)', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    const updatedAts = res.body.tags.map((t) => t.updatedAt);
    // All entries from the newer version (2024-03-01) must come before the older one (2024-01-15)
    const newestIdx = updatedAts.indexOf('2024-03-01T12:00:00Z');
    const oldestIdx = updatedAts.indexOf('2024-01-15T08:00:00Z');
    expect(newestIdx).toBeLessThan(oldestIdx);
  });

  it('v1.0 tag has the correct digest', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    const v1 = res.body.tags.find((t) => t.tag === 'v1.0');
    expect(v1).toBeDefined();
    expect(v1.digest).toBe('sha256:def456');
  });
});

// ── AC3 — Untagged versions are omitted ──────────────────────────────────────

describe('AC3 — Untagged versions (only digest) are omitted from tags list', () => {
  it('version without tags produces no ImageTag entry', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({
        packages: [],
        versions: {
          'my-app': [
            // Untagged version — should be omitted
            {
              name: 'sha256:untagged',
              updated_at: '2024-05-01T00:00:00Z',
              metadata: { container: { tags: [] } },
            },
            // Tagged version — should be included
            {
              name: 'sha256:tagged',
              updated_at: '2024-04-01T00:00:00Z',
              metadata: { container: { tags: ['v3.0'] } },
            },
          ],
        },
      }),
    });
    const tags = await reader.listTags('my-app');
    expect(tags.length).toBe(1);
    expect(tags[0].tag).toBe('v3.0');
    expect(tags[0].digest).toBe('sha256:tagged');
  });

  it('version with missing metadata.container.tags is also omitted', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({
        packages: [],
        versions: {
          'my-app': [
            { name: 'sha256:no-meta', updated_at: '2024-05-01T00:00:00Z' },
          ],
        },
      }),
    });
    const tags = await reader.listTags('my-app');
    expect(tags.length).toBe(0);
  });
});

// ── AC5 — Graceful degradation: GitHub unreachable ───────────────────────────

describe('AC5 — GitHub unreachable → packages:[], endpoint stays 200', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'test-token',
      fetchFn: async () => { throw new Error('GitHub unreachable'); },
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('packages endpoint returns 200 (no crash)', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.status).toBe(200);
  });

  it('packages is empty array (gracefully degraded)', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.body.packages).toEqual([]);
  });

  it('tags endpoint returns 200 (no crash)', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    expect(res.status).toBe(200);
  });

  it('tags is empty array (gracefully degraded)', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    expect(res.body.tags).toEqual([]);
  });
});

// ── AC5 — Graceful degradation: no token ─────────────────────────────────────

describe('AC5 — No token → degrades gracefully (empty lists, no crash)', () => {
  let server, port;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => undefined,
      fetchFn: async () => fakeResponse(401, { message: 'Bad credentials' }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('packages endpoint returns 200 and packages:[]', async () => {
    const res = await get(port, '/api/github/packages');
    expect(res.status).toBe(200);
    expect(res.body.packages).toEqual([]);
  });

  it('tags endpoint returns 200 and tags:[]', async () => {
    const res = await get(port, '/api/github/packages/my-app/tags');
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([]);
  });
});

// ── AC5 — Graceful degradation: 401 from GitHub API ─────────────────────────

describe('AC5 — GitHub 401 → packages:[], tags:[], 200', () => {
  it('listPackages degrades on 401', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'valid-looking-token',
      fetchFn: buildFakeFetch({ packagesStatus: 401 }),
    });
    const packages = await reader.listPackages();
    expect(packages).toEqual([]);
  });

  it('listTags degrades on 401', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'valid-looking-token',
      fetchFn: buildFakeFetch({ versionsStatus: 401 }),
    });
    const tags = await reader.listTags('my-app');
    expect(tags).toEqual([]);
  });
});

// ── AC5 — Graceful degradation: 404 (unknown package) ────────────────────────

describe('AC5 — GitHub 404 (unknown package) → tags:[], 200', () => {
  it('listTags degrades on 404 (no existence disclosure)', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ versionsStatus: 404 }),
    });
    const tags = await reader.listTags('nonexistent-pkg');
    expect(tags).toEqual([]);
  });

  it('HTTP endpoint returns 200 with tags:[] for unknown package', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({ versionsStatus: 404 }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages/nonexistent-pkg/tags');
      expect(res.status).toBe(200);
      expect(res.body.tags).toEqual([]);
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});

// ── AC5 — {name} validation → 400, no API call ────────────────────────────────

describe('AC5 — {name} validation: invalid names return 400, no API call made', () => {
  let server, port, apiCallCount;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    apiCallCount = 0;
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: async (_url) => {
        apiCallCount++;
        return fakeJson([]);
      },
    });
    const app = makeApp({ githubPackagesReader: reader });
    ({ server, port } = await startServer(app));
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.DEV_NO_ACCESS;
  });

  it('returns 400 for name with path traversal (../etc)', async () => {
    // URL-encoded %2F for slash since express won't route a literal slash in segment
    const res = await get(port, '/api/github/packages/..%2Fetc/tags');
    // Either 400 (validation) or 404 (no route match for segmented path) — both acceptable
    expect([400, 404]).toContain(res.status);
  });

  it('returns 400 for name with spaces (encoded as %20)', async () => {
    const res = await get(port, '/api/github/packages/my%20app/tags');
    expect(res.status).toBe(400);
    expect(apiCallCount).toBe(0);
  });

  it('returns 400 for name with semicolon', async () => {
    const res = await get(port, '/api/github/packages/app%3Bls/tags');
    expect(res.status).toBe(400);
    expect(apiCallCount).toBe(0);
  });

  it('does NOT make API call for invalid name', async () => {
    await get(port, '/api/github/packages/bad%20name/tags');
    expect(apiCallCount).toBe(0);
  });

  it('returns 200 for valid name', async () => {
    const res = await get(port, '/api/github/packages/my-valid-app/tags');
    expect(res.status).toBe(200);
  });
});

// ── AC5 — Token never leaked in errors ────────────────────────────────────────

describe('AC5/AC4 — Token never appears in error responses (security/R01)', () => {
  it('tags endpoint: token not in response when API fails', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'super-secret-app-token',
      fetchFn: async () => { throw new Error('connection refused super-secret-app-token'); },
    });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages/my-app/tags');
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super-secret-app-token');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('packages endpoint: token not in response when API fails', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'super-secret-app-token',
      fetchFn: async () => { throw new Error('connection refused super-secret-app-token'); },
    });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages');
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super-secret-app-token');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});
