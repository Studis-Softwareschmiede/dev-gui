/**
 * GitHubWriter.test.js — Unit tests for the GitHubWriter boundary (AC2–AC7).
 *
 * Covers:
 *   AC2 — GitHubWriter is a separate write boundary (no POST/PATCH/PUT/DELETE in GitHubReader)
 *   AC3 — Token never appears in any response/error message
 *   AC6 — validateRepoName / validateVisibility reject invalid inputs before any GitHub call
 *   AC7 — Error classification: name-conflict → 409, permission-denied → 502, network-error → 502
 *
 * Strategy:
 *   - fetchFn is injected (no real network calls)
 *   - CredentialStore is mocked (returns fixed app_id / installation_id / private_key)
 *   - RSA key pair generated from pem stubs (test-only — not production keys)
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import { GitHubWriter, GitHubWriterError, validateRepoName, validateVisibility } from '../src/GitHubWriter.js';

const generateKeyPairAsync = promisify(generateKeyPair);

// ── Test RSA key pair ──────────────────────────────────────────────────────────

/** @type {string} */
let TEST_PRIVATE_KEY_PEM;

beforeAll(async () => {
  const { privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  TEST_PRIVATE_KEY_PEM = privateKey;
});

// ── Mock CredentialStore ───────────────────────────────────────────────────────

function makeMockCredentialStore({ appId = '12345', installationId = '67890', privateKey } = {}) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/github/app_id') return appId;
      if (key === 'credentials/github/installation_id') return installationId;
      if (key === 'credentials/github/private_key') return privateKey ?? TEST_PRIVATE_KEY_PEM;
      return null;
    },
  };
}

/** Returns a mock installation token (never a real token format). */
const MOCK_INSTALLATION_TOKEN = 'mock-installation-token-for-tests-only';

/**
 * Creates a fetchFn mock that:
 *   1. Handles POST /app/installations/.../access_tokens → returns mock token
 *   2. Handles POST /orgs/.../repos → configurable response
 *
 * @param {object} repoResponse - { status, body } for the repo creation call
 */
function makeFetchFn(repoResponse = { status: 201, body: {} }) {
  return async (url, _init) => {
    // Token minting call
    if (url.includes('/app/installations/') && url.includes('/access_tokens')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: MOCK_INSTALLATION_TOKEN }),
        text: async () => JSON.stringify({ token: MOCK_INSTALLATION_TOKEN }),
      };
    }

    // Repo creation call
    if (url.includes('/orgs/') && url.includes('/repos')) {
      const { status, body } = repoResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };
}

// ── AC2: GitHubWriter is a separate write boundary ─────────────────────────────

describe('AC2 — GitHubWriter separate boundary', () => {
  it('GitHubReader.js contains no POST/PATCH/PUT/DELETE GitHub API calls', async () => {
    // Testable as specified in AC2: grep GitHubReader source for mutating calls
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(__dirname, '../src/GitHubReader.js'), 'utf8');

    // Should contain no 'method: POST/PATCH/PUT/DELETE' against GitHub
    expect(source).not.toMatch(/method:\s*['"]POST['"]/i);
    expect(source).not.toMatch(/method:\s*['"]PATCH['"]/i);
    expect(source).not.toMatch(/method:\s*['"]PUT['"]/i);
    expect(source).not.toMatch(/method:\s*['"]DELETE['"]/i);
  });

  it('GitHubWriter exports createRepo (mutating boundary)', () => {
    const writer = new GitHubWriter();
    expect(typeof writer.createRepo).toBe('function');
  });
});

// ── AC6: Input validation ──────────────────────────────────────────────────────

describe('AC6 — validateRepoName', () => {
  it('rejects empty name', () => {
    expect(validateRepoName('').ok).toBe(false);
    expect(validateRepoName('   ').ok).toBe(false);
  });

  it('rejects non-string name', () => {
    expect(validateRepoName(null).ok).toBe(false);
    expect(validateRepoName(undefined).ok).toBe(false);
    expect(validateRepoName(42).ok).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    const longName = 'a'.repeat(101);
    const result = validateRepoName(longName);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/längenlimit|limit/i);
  });

  it('rejects name with spaces', () => {
    expect(validateRepoName('my repo').ok).toBe(false);
    expect(validateRepoName('my repo').error).toBeTruthy();
  });

  it('rejects name starting with dot', () => {
    expect(validateRepoName('.hidden-repo').ok).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    expect(validateRepoName('-bad-name').ok).toBe(false);
  });

  it('rejects name with ..' , () => {
    expect(validateRepoName('my..repo').ok).toBe(false);
  });

  it('accepts valid repo names', () => {
    expect(validateRepoName('my-repo').ok).toBe(true);
    expect(validateRepoName('my_repo').ok).toBe(true);
    expect(validateRepoName('MyRepo123').ok).toBe(true);
    expect(validateRepoName('a').ok).toBe(true);
    expect(validateRepoName('repo.name').ok).toBe(true);
    expect(validateRepoName('a'.repeat(100)).ok).toBe(true);
  });

  it('accepts 2-character name "ab" (shortest multi-char)', () => {
    expect(validateRepoName('ab').ok).toBe(true);
  });

  it('accepts name with dot between alphanumerics "a.2"', () => {
    expect(validateRepoName('a.2').ok).toBe(true);
  });
});

describe('AC6 — validateVisibility', () => {
  it('accepts private and public', () => {
    expect(validateVisibility('private').ok).toBe(true);
    expect(validateVisibility('public').ok).toBe(true);
  });

  it('accepts undefined (optional)', () => {
    expect(validateVisibility(undefined).ok).toBe(true);
    expect(validateVisibility(null).ok).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(validateVisibility('internal').ok).toBe(false);
    expect(validateVisibility('').ok).toBe(false);
    expect(validateVisibility('Public').ok).toBe(false);
  });
});

// ── AC3: Token never appears in responses/errors ───────────────────────────────

describe('AC3 — Token never in responses/errors', () => {
  it('createRepo response does not contain the installation token', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({
        status: 201,
        body: {
          name: 'test-repo',
          full_name: 'Studis-Softwareschmiede/test-repo',
          html_url: 'https://github.com/Studis-Softwareschmiede/test-repo',
          visibility: 'private',
          private: true,
        },
      }),
    });

    const result = await writer.createRepo({ name: 'test-repo' });
    const resultStr = JSON.stringify(result);

    expect(resultStr).not.toContain(MOCK_INSTALLATION_TOKEN);
    expect(resultStr).not.toContain('Bearer');
    expect(result.name).toBe('test-repo');
    expect(result.fullName).toBe('Studis-Softwareschmiede/test-repo');
    expect(result.htmlUrl).toBe('https://github.com/Studis-Softwareschmiede/test-repo');
    expect(result.visibility).toBe('private');
  });

  it('error thrown on name-conflict does not contain token', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({
        status: 422,
        body: { message: 'Repository creation failed. name already exists on this account' },
      }),
    });

    let thrownErr;
    try {
      await writer.createRepo({ name: 'existing-repo' });
    } catch (err) {
      thrownErr = err;
    }

    expect(thrownErr).toBeInstanceOf(GitHubWriterError);
    expect(thrownErr.message).not.toContain(MOCK_INSTALLATION_TOKEN);
    expect(thrownErr.message).not.toContain('Bearer');
    expect(thrownErr.errorClass).toBe('name-conflict');
  });

  it('error thrown on network failure does not contain token', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: async (url) => {
        if (url.includes('/access_tokens')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: MOCK_INSTALLATION_TOKEN }),
            text: async () => '',
          };
        }
        throw new Error('Network connection refused');
      },
    });

    let thrownErr;
    try {
      await writer.createRepo({ name: 'my-repo' });
    } catch (err) {
      thrownErr = err;
    }

    expect(thrownErr).toBeInstanceOf(GitHubWriterError);
    expect(thrownErr.message).not.toContain(MOCK_INSTALLATION_TOKEN);
    expect(thrownErr.errorClass).toBe('network-error');
  });
});

// ── AC7: Error classification ──────────────────────────────────────────────────

describe('AC7 — Error classification', () => {
  it('name-conflict: GitHub 422 "already exists" → errorClass=name-conflict', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({
        status: 422,
        body: { message: 'Repository creation failed. name already exists on this account' },
      }),
    });

    await expect(writer.createRepo({ name: 'existing-repo' })).rejects.toMatchObject({
      errorClass: 'name-conflict',
    });
  });

  it('permission-denied: GitHub 403 → errorClass=permission-denied, message mentions Permission', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({ status: 403, body: { message: 'Forbidden' } }),
    });

    let thrownErr;
    try {
      await writer.createRepo({ name: 'my-repo' });
    } catch (err) {
      thrownErr = err;
    }

    expect(thrownErr.errorClass).toBe('permission-denied');
    expect(thrownErr.message).toMatch(/Administration|Permission|permission/i);
  });

  it('network-error: fetch throws → errorClass=network-error', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: async (url) => {
        if (url.includes('/access_tokens')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: MOCK_INSTALLATION_TOKEN }),
            text: async () => '',
          };
        }
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(writer.createRepo({ name: 'my-repo' })).rejects.toMatchObject({
      errorClass: 'network-error',
    });
  });

  it('credentials-incomplete: missing app_id → errorClass=credentials-incomplete', async () => {
    const writer = new GitHubWriter({
      credentialStore: {
        async getPlaintext(key) {
          if (key === 'credentials/github/app_id') return null;
          if (key === 'credentials/github/installation_id') return '12345';
          if (key === 'credentials/github/private_key') return TEST_PRIVATE_KEY_PEM;
          return null;
        },
      },
      fetchFn: makeFetchFn({ status: 201, body: {} }),
    });

    await expect(writer.createRepo({ name: 'my-repo' })).rejects.toMatchObject({
      errorClass: 'credentials-incomplete',
    });
  });

  it('credential-store-missing: no CredentialStore → errorClass=credential-store-missing', async () => {
    const writer = new GitHubWriter({ fetchFn: makeFetchFn({ status: 201, body: {} }) });

    await expect(writer.createRepo({ name: 'my-repo' })).rejects.toMatchObject({
      errorClass: 'credential-store-missing',
    });
  });

  it('github 500 → errorClass=github-error', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({ status: 500, body: { message: 'Internal Server Error' } }),
    });

    await expect(writer.createRepo({ name: 'my-repo' })).rejects.toMatchObject({
      errorClass: 'github-error',
    });
  });

  it('validates name before minting token (no fetch called for invalid name)', async () => {
    const fetchCalls = [];
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: async (url, _init) => {
        fetchCalls.push(url);
        return makeFetchFn()();
      },
    });

    // Should throw validation error before any fetch
    await expect(writer.createRepo({ name: '' })).rejects.toMatchObject({
      errorClass: 'validation-error',
    });
    expect(fetchCalls.length).toBe(0);
  });
});

// ── AC1: Successful repo creation returns correct shape ────────────────────────

describe('AC1 — createRepo returns { name, fullName, htmlUrl, visibility }', () => {
  it('public repo', async () => {
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: makeFetchFn({
        status: 201,
        body: {
          name: 'public-repo',
          full_name: 'Studis-Softwareschmiede/public-repo',
          html_url: 'https://github.com/Studis-Softwareschmiede/public-repo',
          visibility: 'public',
          private: false,
        },
      }),
    });

    const result = await writer.createRepo({ name: 'public-repo', visibility: 'public' });
    expect(result).toEqual({
      name: 'public-repo',
      fullName: 'Studis-Softwareschmiede/public-repo',
      htmlUrl: 'https://github.com/Studis-Softwareschmiede/public-repo',
      visibility: 'public',
    });
  });

  it('passes autoInit and description to GitHub API', async () => {
    const capturedBodies = [];
    const writer = new GitHubWriter({
      credentialStore: makeMockCredentialStore(),
      fetchFn: async (url, init) => {
        if (url.includes('/repos')) {
          capturedBodies.push(JSON.parse(init.body));
          return {
            ok: true,
            status: 201,
            json: async () => ({
              name: 'my-repo',
              full_name: 'Studis-Softwareschmiede/my-repo',
              html_url: 'https://github.com/Studis-Softwareschmiede/my-repo',
              visibility: 'private',
              private: true,
            }),
          };
        }
        // Token minting
        return { ok: true, status: 200, json: async () => ({ token: MOCK_INSTALLATION_TOKEN }) };
      },
    });

    await writer.createRepo({
      name: 'my-repo',
      visibility: 'private',
      description: 'Test description',
      autoInit: true,
    });

    expect(capturedBodies.length).toBe(1);
    expect(capturedBodies[0].description).toBe('Test description');
    expect(capturedBodies[0].auto_init).toBe(true);
    expect(capturedBodies[0].name).toBe('my-repo');
    // Token MUST NOT appear in the repo creation request body
    expect(JSON.stringify(capturedBodies[0])).not.toContain(MOCK_INSTALLATION_TOKEN);
  });
});
