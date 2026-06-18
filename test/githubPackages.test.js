/**
 * githubPackages.test.js — tests for GET /api/github/packages and GET /api/github/packages/:name/tags
 *
 * Spec: docs/specs/ghcr-image-list.md
 * Spec: docs/specs/ghcr-image-list-app-token.md (S-165 — Auflist-Pfad repariert)
 *
 * Covers (ghcr-image-list):
 *   AC1 — GitHub-Packages-API access only through GitHubPackagesReader boundary;
 *          token exclusively via injected tokenProvider; no process.env.GH_TOKEN path.
 *   AC2 — GET /api/github/packages returns 200 { packages: ImagePackage[] };
 *          each entry: { name, fullImageRef, visibility, htmlUrl, updatedAt };
 *          fullImageRef = ghcr.io/<org>/<name> (lowercase, no tag);
 *          sorted alphabetically by name; fully paginated (installation-repos page).
 *   AC3 — GET /api/github/packages/:name/tags returns 200 { tags: ImageTag[] };
 *          each entry: { tag, digest, updatedAt }; sorted by updatedAt descending;
 *          one entry per tag per version; untagged versions omitted.
 *   AC4 — Both endpoints behind AccessGuard (DEV_NO_ACCESS bypass tested);
 *          read-only (no POST/PATCH/PUT/DELETE); token never in Response/Log/errors.
 *   AC5 — GitHub unreachable / no token / 401/404 → empty list + 200;
 *          {name} validated (^[A-Za-z0-9._-]+$) → 400 on invalid, no API call.
 *
 * Covers (ghcr-image-list-app-token / S-165):
 *   AC1 — org-list-400 scenario: fetch via installation/repos + single-package probes → non-empty
 *   AC2 — App-Token exclusively via injected provider; no GH_TOKEN path; Boundary grep-verifiable
 *   AC3 — Partial probe failures: successful packages returned + errors[] per failed probe
 *   AC4 — Token-less / full-error → packages:[], 200, no crash
 *   AC5 — Token never in response/errors; errors entries contain only {scope, errorClass}
 *   AC6 — Setup-precondition: single-package endpoint 200 with App-Token confirmed (live); documented in spec
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
 * Build a fake fetch for the new S-165 list strategy (installation/repos + single-package probes).
 *
 * Emulates the live behavior:
 *   - GET /installation/repositories → returns { repositories: [{name}, ...] }
 *   - GET /orgs/{org}/packages/container/{name} → returns package object or 404
 *   - GET /orgs/{org}/packages/container/{name}/versions → returns versions array
 *   - GET /orgs/{org}/packages?package_type=container → returns 400 (live bug, NOT used)
 *
 * @param {object} opts
 * @param {string[]} [opts.repoNames]            installation repos (default: all package names)
 * @param {Array<object>} [opts.packages]        raw GitHub package objects (indexed by name)
 * @param {Record<string, Array<object>>} [opts.versions]  packageName → raw version objects
 * @param {boolean} [opts.failInstallationRepos] throw on /installation/repositories call
 * @param {number} [opts.installationReposStatus] HTTP status for installation/repos (default 200)
 * @param {number} [opts.versionsStatus]         HTTP status for versions calls (default 200)
 * @param {Record<string, number>} [opts.probeStatus] packageName → HTTP status for probe (default 200)
 */
function buildFakeFetch({
  repoNames,
  packages = [],
  versions = {},
  failInstallationRepos = false,
  installationReposStatus = 200,
  versionsStatus = 200,
  probeStatus = {},
} = {}) {
  // Build package lookup map by name
  const pkgMap = Object.fromEntries(packages.map((p) => [p.name, p]));
  // If repoNames not explicitly given, derive from packages
  const repos = repoNames ?? packages.map((p) => p.name);

  return async function fakeFetch(url, _init) {
    const u = new URL(url);

    // ── OLD org-list endpoint (400 in production — NOT called by new code) ──
    if (u.pathname.match(/\/orgs\/[^/]+\/packages$/) && u.searchParams.get('package_type') === 'container') {
      // Return 400 to prove old code path is gone
      return fakeResponse(400, { message: 'Invalid argument.' });
    }

    // ── Installation repositories (Variante c, step 1) ──
    if (u.pathname === '/installation/repositories') {
      if (failInstallationRepos) throw new Error('network error');
      if (installationReposStatus !== 200) return fakeResponse(installationReposStatus, null);
      return fakeJson({ repositories: repos.map((name) => ({ name })) });
    }

    // ── Single package probe (Variante c, step 2) ──
    const probeMatch = u.pathname.match(/\/orgs\/[^/]+\/packages\/container\/([^/]+)$/);
    if (probeMatch) {
      const pkgName = decodeURIComponent(probeMatch[1]);
      const status = probeStatus[pkgName] ?? 200;
      if (status !== 200) return fakeResponse(status, null);
      const pkg = pkgMap[pkgName];
      if (!pkg) return fakeResponse(404, null);
      return fakeJson(pkg);
    }

    // ── Versions (tag path — unchanged) ──
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

/**
 * Build a fake fetch for the packages-list that simulates the 400-list-then-probe scenario:
 * - /installation/repositories → repos
 * - /orgs/{org}/packages/container/{name} → 200 with package data
 * This is the ONLY working path for App-Token (S-165, live-verified).
 */
function buildFakeFetchWithOrgList400({
  repoNames = [],
  packages = [],
} = {}) {
  const pkgMap = Object.fromEntries(packages.map((p) => [p.name, p]));

  return async function fakeFetch(url, _init) {
    const u = new URL(url);

    // Org list → 400 (as in production)
    if (u.pathname.match(/\/orgs\/[^/]+\/packages$/) && u.searchParams.get('package_type') === 'container') {
      return fakeResponse(400, { message: 'Invalid argument.' });
    }

    // Installation repos
    if (u.pathname === '/installation/repositories') {
      return fakeJson({ repositories: repoNames.map((name) => ({ name })) });
    }

    // Single package probe
    const probeMatch = u.pathname.match(/\/orgs\/[^/]+\/packages\/container\/([^/]+)$/);
    if (probeMatch) {
      const pkgName = decodeURIComponent(probeMatch[1]);
      const pkg = pkgMap[pkgName];
      if (!pkg) return fakeResponse(404, null);
      return fakeJson(pkg);
    }

    return fakeResponse(404, null);
  };
}

// ── AC1 — Boundary + token isolation ─────────────────────────────────────────

describe('AC1 — GitHubPackagesReader: only injected tokenProvider, no GH_TOKEN fallback', () => {
  it('uses the injected tokenProvider to authenticate (Authorization header on every request)', async () => {
    const capturedHeaders = [];
    const fetchFn = async (url, init) => {
      capturedHeaders.push(init?.headers ?? {});
      const u = new URL(url);
      // installation/repositories → empty list (no probes follow)
      if (u.pathname === '/installation/repositories') {
        return fakeJson({ repositories: [] });
      }
      return fakeResponse(404, null);
    };
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'test-token-abc',
      fetchFn,
    });
    await reader.listPackages();
    // Every request must carry the injected token
    expect(capturedHeaders.length).toBeGreaterThan(0);
    for (const h of capturedHeaders) {
      expect(h['Authorization']).toBe('Bearer test-token-abc');
    }
  });

  it('does not read process.env.GH_TOKEN (no fallback)', async () => {
    const origToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'env-token-should-not-be-used';
    let capturedHeaders = null;
    const fetchFn = async (_url, init) => {
      capturedHeaders = init?.headers ?? {};
      return fakeJson({ repositories: [] });
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
        // repoNames drives installation/repos response; packages drives single probes
        repoNames: ['zebra-app', 'alpha-app'],
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

// ── AC2 — Probe strategy: all repos from installation are probed ──────────────

describe('AC2 — Installation-repos-to-probe strategy: multiple repos → multiple packages', () => {
  it('returns a package for each repo that has a container image', async () => {
    const pkg1 = { name: 'app-one', visibility: 'public', html_url: 'https://x.com', updated_at: '2024-01-01T00:00:00Z' };
    const pkg2 = { name: 'app-two', visibility: 'private', html_url: 'https://x.com', updated_at: '2024-01-02T00:00:00Z' };

    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetch({
        repoNames: ['app-one', 'app-two', 'no-image-repo'],
        packages: [pkg1, pkg2],
        // no-image-repo → probe returns 404 (not in packages list) → skipped
      }),
    });
    const packages = await reader.listPackages();
    expect(packages.map((p) => p.name)).toContain('app-one');
    expect(packages.map((p) => p.name)).toContain('app-two');
    // repo without container image is silently skipped (not an error)
    expect(packages.map((p) => p.name)).not.toContain('no-image-repo');
  });

  it('org-list 400 scenario (live bug): list returns empty but probe strategy finds packages', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetchWithOrgList400({
        repoNames: ['dev-gui', 'sandbox-3'],
        packages: [
          { name: 'dev-gui', visibility: 'public', html_url: 'https://x.com', updated_at: '2026-06-18T00:00:00Z' },
          { name: 'sandbox-3', visibility: 'public', html_url: 'https://x.com', updated_at: '2026-05-26T00:00:00Z' },
        ],
      }),
    });
    const packages = await reader.listPackages();
    // Must NOT be empty — the org-list 400 must not prevent results
    expect(packages.length).toBe(2);
    expect(packages.map((p) => p.name)).toContain('dev-gui');
    expect(packages.map((p) => p.name)).toContain('sandbox-3');
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

// ── AC4/AC5 — Graceful degradation: 401 from GitHub API ─────────────────────

describe('AC4 — GitHub 401 on installation/repos → packages:[], tags:[], 200', () => {
  it('listPackages degrades when installation/repos returns 401', async () => {
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'valid-looking-token',
      fetchFn: buildFakeFetch({ installationReposStatus: 401 }),
    });
    const packages = await reader.listPackages();
    expect(packages).toEqual([]);
  });

  it('listTags degrades on 401 (tags path unchanged)', async () => {
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

// ── S-165 AC3 — Partial-error robustness (Einzel-Endpunkt-Variante) ──────────

describe('S-165 AC3 — Partial probe failures: successful packages + errors[] per failed probe', () => {
  it('listPackagesWithErrors: 500 probe → errors[] entry for that package, other packages returned (AC3)', async () => {
    const goodPkg = { name: 'good-pkg', visibility: 'public', html_url: 'https://x.com', updated_at: '2024-01-01T00:00:00Z' };

    const fetchFn = async (url, _init) => {
      const u = new URL(url);

      if (u.pathname === '/installation/repositories') {
        return fakeJson({ repositories: [{ name: 'good-pkg' }, { name: 'bad-pkg' }] });
      }
      // single probe: good-pkg → 200, bad-pkg → 500 (server error → must produce errors entry)
      const probeMatch = u.pathname.match(/\/orgs\/[^/]+\/packages\/container\/([^/]+)$/);
      if (probeMatch) {
        const name = decodeURIComponent(probeMatch[1]);
        if (name === 'good-pkg') return fakeJson(goodPkg);
        // bad-pkg: 500 → #probePackage throws → rejected in allSettled → errors entry (AC3)
        return fakeResponse(500, null);
      }
      return fakeResponse(404, null);
    };

    const reader = new GitHubPackagesReader({ tokenProvider: () => 'tok', fetchFn });
    const { packages, errors } = await reader.listPackagesWithErrors();
    // good-pkg must be in results
    expect(packages.map((p) => p.name)).toContain('good-pkg');
    // bad-pkg (500 probe) must NOT appear as a package
    expect(packages.map((p) => p.name)).not.toContain('bad-pkg');
    expect(packages.length).toBe(1);
    // 500 probe must produce exactly one errors entry (AC3 contract)
    expect(errors.length).toBe(1);
    expect(errors[0]).toHaveProperty('scope', 'bad-pkg');
    expect(errors[0]).toHaveProperty('errorClass');
  });

  it('listPackagesWithErrors: 404 probe → silent skip, no errors entry (expected normal case)', async () => {
    const goodPkg = { name: 'good-pkg', visibility: 'public', html_url: 'https://x.com', updated_at: '2024-01-01T00:00:00Z' };

    const fetchFn = async (url, _init) => {
      const u = new URL(url);
      if (u.pathname === '/installation/repositories') {
        return fakeJson({ repositories: [{ name: 'good-pkg' }, { name: 'no-image-repo' }] });
      }
      const probeMatch = u.pathname.match(/\/orgs\/[^/]+\/packages\/container\/([^/]+)$/);
      if (probeMatch) {
        const name = decodeURIComponent(probeMatch[1]);
        if (name === 'good-pkg') return fakeJson(goodPkg);
        // no-image-repo: 404 → silent skip (repo exists but has no container image)
        return fakeResponse(404, null);
      }
      return fakeResponse(404, null);
    };

    const reader = new GitHubPackagesReader({ tokenProvider: () => 'tok', fetchFn });
    const { packages, errors } = await reader.listPackagesWithErrors();
    expect(packages.map((p) => p.name)).toContain('good-pkg');
    expect(packages.map((p) => p.name)).not.toContain('no-image-repo');
    expect(packages.length).toBe(1);
    // 404 = no container image for repo → NOT an error, errors array must be empty
    expect(errors).toEqual([]);
  });

  it('listPackagesWithErrors: installation/repos FetchError → errors entry with scope', async () => {
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/installation/repositories') throw new Error('network down');
      return fakeResponse(404, null);
    };
    const reader = new GitHubPackagesReader({ tokenProvider: () => 'tok', fetchFn });
    const { packages, errors } = await reader.listPackagesWithErrors();
    expect(packages).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toHaveProperty('scope');
    expect(errors[0]).toHaveProperty('errorClass');
    // errors entry must not contain token
    const errStr = JSON.stringify(errors);
    expect(errStr).not.toContain('tok');
  });

  it('HTTP /api/github/packages: errors[] contains only {scope, errorClass} — no token (AC5)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/installation/repositories') throw new Error('network super-secret-token');
      return fakeResponse(404, null);
    };
    const reader = new GitHubPackagesReader({ tokenProvider: () => 'super-secret-token', fetchFn });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages');
      expect(res.status).toBe(200);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super-secret-token');
      // errors entries if present: only scope + errorClass
      if (res.body.errors) {
        for (const e of res.body.errors) {
          expect(Object.keys(e).sort()).toEqual(['errorClass', 'scope'].sort());
        }
      }
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });

  it('HTTP /api/github/packages: non-empty list when packages exist (AC1 / S-165 core)', async () => {
    process.env.DEV_NO_ACCESS = '1';
    const reader = new GitHubPackagesReader({
      tokenProvider: () => 'tok',
      fetchFn: buildFakeFetchWithOrgList400({
        repoNames: ['my-app'],
        packages: [{ name: 'my-app', visibility: 'public', html_url: 'https://x.com', updated_at: '2024-01-01T00:00:00Z' }],
      }),
    });
    const app = makeApp({ githubPackagesReader: reader });
    const { server: srv, port: p } = await startServer(app);
    try {
      const res = await get(p, '/api/github/packages');
      expect(res.status).toBe(200);
      expect(res.body.packages.length).toBeGreaterThan(0);
      expect(res.body.packages[0].name).toBe('my-app');
    } finally {
      await closeServer(srv);
      delete process.env.DEV_NO_ACCESS;
    }
  });
});
