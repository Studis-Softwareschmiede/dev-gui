/**
 * GithubReposRouter.test.js — Integration tests for POST /api/github/repos.
 *
 * Covers:
 *   AC1  — 201 response with { name, fullName, htmlUrl, visibility }
 *   AC3  — Token never in response/audit
 *   AC4  — Audit-First: audit entry before GitHub call; audit fail blocks mutation
 *   AC5  — AccessGuard (403 without token); CRED_ADMIN_EMAILS allowlist
 *   AC6  — Validation: empty name, invalid format → 422 (no GitHub call)
 *   AC7  — Error mapping: name-conflict → 409, permission-denied → 502, network → 502
 *
 * Strategy:
 *   - GitHubWriter is injected as a mock (no real GitHub calls)
 *   - AuditStore is real (in-memory) — verifies audit entries
 *   - AccessGuard with DEV_NO_ACCESS=1 (dev bypass)
 *   - CRED_ADMIN_EMAILS tested via env var
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

import { githubReposRouter } from '../src/githubReposRouter.js';
import { AuditStore } from '../src/AuditStore.js';
import { GitHubWriterError } from '../src/GitHubWriter.js';
import { createAccessGuard } from '../src/AccessGuard.js';

// ── Mock GitHubWriter ──────────────────────────────────────────────────────────

const MOCK_TOKEN = 'ghs_mock_installation_token_never_in_response';

function makeMockWriter(response = null, shouldThrow = null) {
  return {
    async createRepo(params) {
      if (shouldThrow) throw shouldThrow;
      return response ?? {
        name: params.name,
        fullName: `Studis-Softwareschmiede/${params.name}`,
        htmlUrl: `https://github.com/Studis-Softwareschmiede/${params.name}`,
        visibility: params.visibility ?? 'private',
      };
    },
  };
}

// ── Test server factory ────────────────────────────────────────────────────────

async function makeTestServer({ writer, auditStore: audit } = {}) {
  const app = express();
  app.use(express.json());

  const guard = createAccessGuard();
  app.use('/api', guard);

  const auditInstance = audit ?? new AuditStore();
  app.use(githubReposRouter(auditInstance, writer ?? makeMockWriter()));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function req(method, path, body = null) {
    return new Promise((resolve) => {
      const headers = { 'Content-Type': 'application/json' };
      const bodyStr = body !== null ? JSON.stringify(body) : null;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const options = { hostname: '127.0.0.1', port, path, method, headers };
      const r = httpRequest(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  async function close() {
    await new Promise((r) => server.close(r));
  }

  return { req, close, audit: auditInstance, server };
}

// ── AC5: AccessGuard — 403 without Access token ───────────────────────────────

describe('GithubReposRouter — AC5: AccessGuard', () => {
  let testServer;

  beforeEach(async () => {
    // Do NOT set DEV_NO_ACCESS — AccessGuard must be active
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    testServer = await makeTestServer({ writer: makeMockWriter() });
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    await testServer.close();
  });

  it('AC5 — POST without CF-Access-Jwt-Assertion → 403', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(403);
  });
});

// ── AC5: CRED_ADMIN_EMAILS allowlist ──────────────────────────────────────────

describe('GithubReposRouter — AC5: CRED_ADMIN_EMAILS', () => {
  let testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    delete process.env.CRED_ADMIN_EMAILS;
    if (testServer) await testServer.close();
    testServer = null;
  });

  it('AC5 — CRED_ADMIN_EMAILS set, dev@local not in list → 403', async () => {
    process.env.CRED_ADMIN_EMAILS = 'admin@example.com,other@example.com';
    testServer = await makeTestServer({ writer: makeMockWriter() });

    // DEV_NO_ACCESS sets identity email to 'dev@local'
    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/berechtigung|berechtigt/i);
  });

  it('AC5 — CRED_ADMIN_EMAILS set, dev@local in list → allowed (201)', async () => {
    process.env.CRED_ADMIN_EMAILS = 'dev@local,admin@example.com';
    testServer = await makeTestServer({ writer: makeMockWriter() });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(201);
  });

  it('AC5 — CRED_ADMIN_EMAILS not set → any valid identity allowed', async () => {
    delete process.env.CRED_ADMIN_EMAILS;
    testServer = await makeTestServer({ writer: makeMockWriter() });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(201);
  });
});

// ── AC6: Input validation ──────────────────────────────────────────────────────

describe('GithubReposRouter — AC6: Validation (no GitHub call on invalid input)', () => {
  let testServer;
  let fetchCalled;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.CRED_ADMIN_EMAILS;
    fetchCalled = false;
    const writerSpy = {
      async createRepo(params) {
        fetchCalled = true;
        return { name: params.name, fullName: `Org/${params.name}`, htmlUrl: 'https://github.com/Org/repo', visibility: 'private' };
      },
    };
    testServer = await makeTestServer({ writer: writerSpy });
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
  });

  it('AC6 — empty name → 422, no GitHub call', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: '' });
    expect(res.status).toBe(422);
    expect(fetchCalled).toBe(false);
  });

  it('AC6 — missing name → 422, no GitHub call', async () => {
    const res = await testServer.req('POST', '/api/github/repos', {});
    expect(res.status).toBe(422);
    expect(fetchCalled).toBe(false);
  });

  it('AC6 — name with spaces → 422, no GitHub call', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: 'my repo' });
    expect(res.status).toBe(422);
    expect(fetchCalled).toBe(false);
  });

  it('AC6 — name too long (>100 chars) → 422, no GitHub call', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: 'a'.repeat(101) });
    expect(res.status).toBe(422);
    expect(fetchCalled).toBe(false);
  });

  it('AC6 — invalid visibility → 422, no GitHub call', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo', visibility: 'internal' });
    expect(res.status).toBe(422);
    expect(fetchCalled).toBe(false);
  });

  it('AC6 — valid name (hyphens, underscores) → not rejected by validation', async () => {
    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-valid_repo.name' });
    expect(res.status).toBe(201);
    expect(fetchCalled).toBe(true);
  });
});

// ── AC1: Successful response ───────────────────────────────────────────────────

describe('GithubReposRouter — AC1: 201 { name, fullName, htmlUrl, visibility }', () => {
  let testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.CRED_ADMIN_EMAILS;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
  });

  it('AC1 — POST returns 201 with correct shape', async () => {
    const writer = makeMockWriter({
      name: 'new-repo',
      fullName: 'Studis-Softwareschmiede/new-repo',
      htmlUrl: 'https://github.com/Studis-Softwareschmiede/new-repo',
      visibility: 'private',
    });
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'new-repo' });
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.name).toBe('new-repo');
    expect(data.fullName).toBe('Studis-Softwareschmiede/new-repo');
    expect(data.htmlUrl).toBe('https://github.com/Studis-Softwareschmiede/new-repo');
    expect(data.visibility).toBe('private');
  });

  it('AC1 — default visibility is private', async () => {
    let capturedParams;
    const writerSpy = {
      async createRepo(params) {
        capturedParams = params;
        return {
          name: params.name,
          fullName: `Studis-Softwareschmiede/${params.name}`,
          htmlUrl: 'https://github.com/Studis-Softwareschmiede/my-repo',
          visibility: params.visibility,
        };
      },
    };
    testServer = await makeTestServer({ writer: writerSpy });

    await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(capturedParams.visibility).toBe('private');
  });

  it('AC3 — response does not contain installation token', async () => {
    const writer = makeMockWriter({
      name: 'repo',
      fullName: 'Org/repo',
      htmlUrl: 'https://github.com/Org/repo',
      visibility: 'private',
    });
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'repo' });
    expect(res.body).not.toContain(MOCK_TOKEN);
    expect(res.body).not.toContain('Bearer');
    expect(res.body).not.toContain('ghs_');
  });
});

// ── AC4: Audit-First ───────────────────────────────────────────────────────────

describe('GithubReposRouter — AC4: Audit-First', () => {
  let testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.CRED_ADMIN_EMAILS;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
  });

  it('AC4 — successful create: pre-mutation intent entry recorded with repo name and identity', async () => {
    const audit = new AuditStore();
    testServer = await makeTestServer({ writer: makeMockWriter(), auditStore: audit });

    await testServer.req('POST', '/api/github/repos', { name: 'audited-repo' });

    const entries = audit.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.command.includes('audited-repo'));
    expect(entry).toBeTruthy();
    expect(entry.command).toMatch(/github:repo:create/);
    expect(entry.command).toContain('audited-repo');
    // AC3/AC4: Token must not be in audit entry
    expect(entry.command).not.toContain(MOCK_TOKEN);
    expect(entry.command).not.toContain('Bearer');
    expect(JSON.stringify(entry)).not.toContain(MOCK_TOKEN);
  });

  it('AC4 — successful create: outcome audit entry ends with ":success"', async () => {
    const audit = new AuditStore();
    testServer = await makeTestServer({ writer: makeMockWriter(), auditStore: audit });

    await testServer.req('POST', '/api/github/repos', { name: 'outcome-ok-repo' });

    const entries = audit.getAll();
    const outcomeEntry = entries.find(
      (e) => e.command === 'github:repo:create:outcome-ok-repo:success',
    );
    expect(outcomeEntry).toBeTruthy();
    expect(outcomeEntry.command).toBe('github:repo:create:outcome-ok-repo:success');
  });

  it('AC4 — audit entry recorded even when GitHub call fails (audit before mutation)', async () => {
    const audit = new AuditStore();
    const writer = makeMockWriter(
      null,
      new GitHubWriterError('Network error', 'network-error'),
    );
    testServer = await makeTestServer({ writer, auditStore: audit });

    await testServer.req('POST', '/api/github/repos', { name: 'failed-repo' });

    const entries = audit.getAll();
    const entry = entries.find((e) => e.command.includes('failed-repo'));
    expect(entry).toBeTruthy();
    expect(entry.command).toMatch(/github:repo:create/);
  });

  it('AC4 — failed create: outcome audit entry contains "failed:<errorClass>"', async () => {
    const audit = new AuditStore();
    const writer = makeMockWriter(
      null,
      new GitHubWriterError('Network error', 'network-error'),
    );
    testServer = await makeTestServer({ writer, auditStore: audit });

    await testServer.req('POST', '/api/github/repos', { name: 'fail-outcome-repo' });

    const entries = audit.getAll();
    const outcomeEntry = entries.find(
      (e) => e.command.includes('fail-outcome-repo') && e.command.includes('failed:'),
    );
    expect(outcomeEntry).toBeTruthy();
    expect(outcomeEntry.command).toBe('github:repo:create:fail-outcome-repo:failed:network-error');
  });

  it('AC4 — audit write failure → 500, GitHub call not made', async () => {
    const brokenAudit = {
      record() {
        throw new Error('Audit store unavailable');
      },
    };
    let githubCalled = false;
    const writerSpy = {
      async createRepo() {
        githubCalled = true;
        return { name: 'r', fullName: 'O/r', htmlUrl: 'h', visibility: 'private' };
      },
    };
    testServer = await makeTestServer({ writer: writerSpy, auditStore: brokenAudit });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toMatch(/audit/i);
    expect(githubCalled).toBe(false); // Mutation must NOT proceed after audit failure
  });

  it('AC4 — audit entry does not contain token', async () => {
    const audit = new AuditStore();
    testServer = await makeTestServer({ writer: makeMockWriter(), auditStore: audit });

    await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });

    const allEntries = JSON.stringify(audit.getAll());
    expect(allEntries).not.toContain(MOCK_TOKEN);
    expect(allEntries).not.toContain('ghs_');
  });
});

// ── AC7: Error status codes ────────────────────────────────────────────────────

describe('GithubReposRouter — AC7: Error status codes', () => {
  let testServer;

  beforeEach(async () => {
    process.env.DEV_NO_ACCESS = '1';
    delete process.env.CRED_ADMIN_EMAILS;
  });

  afterEach(async () => {
    delete process.env.DEV_NO_ACCESS;
    await testServer.close();
  });

  it('AC7 — name-conflict → 409', async () => {
    const writer = makeMockWriter(
      null,
      new GitHubWriterError("Repository-Name 'existing-repo' existiert bereits", 'name-conflict', 422),
    );
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'existing-repo' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/existiert bereits|already/i);
  });

  it('AC7 — permission-denied (no Administration permission) → 502', async () => {
    const writer = makeMockWriter(
      null,
      new GitHubWriterError(
        'GitHub-App hat keine Berechtigung. Administration: Read & Write benötigt.',
        'permission-denied',
        403,
      ),
    );
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it('AC7 — network-error → 502', async () => {
    const writer = makeMockWriter(
      null,
      new GitHubWriterError('GitHub-API nicht erreichbar: ECONNREFUSED', 'network-error'),
    );
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(502);
  });

  it('AC7 — credentials-incomplete → 500', async () => {
    const writer = makeMockWriter(
      null,
      new GitHubWriterError('Credentials unvollständig', 'credentials-incomplete'),
    );
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.status).toBe(500);
  });

  it('AC7 — response error body does not contain token', async () => {
    const writer = makeMockWriter(
      null,
      new GitHubWriterError('Network error', 'network-error'),
    );
    testServer = await makeTestServer({ writer });

    const res = await testServer.req('POST', '/api/github/repos', { name: 'my-repo' });
    expect(res.body).not.toContain(MOCK_TOKEN);
    expect(res.body).not.toContain('Bearer');
    expect(res.body).not.toContain('ghs_');
  });
});
