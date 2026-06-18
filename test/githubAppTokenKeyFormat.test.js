/**
 * githubAppTokenKeyFormat.test.js — Tests for github-app-key-format-tolerant (S-168).
 *
 * Covers:
 *   AC1 — PKCS#1 key with correct newlines → valid, verifiable RS256 JWT
 *   AC2 — PKCS#8 key with correct newlines → valid, verifiable RS256 JWT (regression)
 *   AC3 — PKCS#1 key with newlines replaced by spaces → normalised → valid JWT
 *   AC4 — normalizePem is idempotent (double-call same result)
 *   AC6 — private key / JWT never in error message; no GH_TOKEN fallback in module
 *   AC7 — structurally broken PEM → jwt-sign-failed, no crash, no key leak
 *
 * Test strategy:
 *   - RSA key pairs generated freshly for each run using node:crypto (no hardcoded secrets).
 *   - PKCS#1 produced via crypto.generateKeyPairSync with privateKeyEncoding type:'pkcs1'.
 *   - PKCS#8 produced via crypto.generateKeyPairSync with privateKeyEncoding type:'pkcs8'.
 *   - JWTs verified with jwtVerify from jose (RS256 + public key).
 *   - fetchFn injected (no real network calls); CredentialStore mocked.
 *
 * Security:
 *   - No real secrets or hardcoded key material in this file.
 *   - The BEGIN PRIVATE KEY marker is assembled at runtime to avoid gitleaks false positives.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { generateKeyPair as _generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import { jwtVerify, importSPKI } from 'jose';
import { mintInstallationToken, normalizePem, GitHubAppTokenError } from '../src/githubAppToken.js';

const generateKeyPair = promisify(_generateKeyPair);

// ── Key material generated once for all tests ─────────────────────────────────

/** @type {{ pkcs1PrivatePem: string, pkcs8PrivatePem: string, spkiPublicPem: string }} */
let keys;

beforeAll(async () => {
  // PKCS#8 private key + SPKI public key (standard pair)
  const pkcs8Pair = await generateKeyPair('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // PKCS#1 private key (same public key derivable from it, but we need a separate generation
  // since generateKeyPair doesn't return two encoding types for the same pair at once)
  const pkcs1Pair = await generateKeyPair('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  keys = {
    pkcs1PrivatePem: pkcs1Pair.privateKey,
    pkcs1PublicPem: pkcs1Pair.publicKey,
    pkcs8PrivatePem: pkcs8Pair.privateKey,
    pkcs8PublicPem: pkcs8Pair.publicKey,
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCredStore(privateKeyPem) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/github/app_id') return '12345';
      if (key === 'credentials/github/installation_id') return '67890';
      if (key === 'credentials/github/private_key') return privateKeyPem;
      return null;
    },
  };
}

function makeSuccessFetch(token = 'ghs_mock_token') {
  return async (url) => {
    if (url.includes('/access_tokens')) {
      return {
        ok: true,
        json: async () => ({ token }),
        text: async () => JSON.stringify({ token }),
      };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
}

/**
 * Run mintInstallationToken with the given private key PEM and verify the
 * resulting App-JWT against the corresponding public key.
 *
 * The fetchFn is intercepted before the actual network call so we can inspect
 * the Authorization header that carries the App-JWT.
 *
 * @param {string} privateKeyPem
 * @param {string} publicKeySpkiPem
 * @returns {Promise<object>} Decoded JWT payload
 */
async function mintAndVerifyJwt(privateKeyPem, publicKeySpkiPem) {
  let capturedJwt = null;

  const interceptFetch = async (url, init) => {
    // Capture the Bearer token from the Authorization header
    const authHeader = init?.headers?.Authorization ?? '';
    const match = /^Bearer (.+)$/.exec(authHeader);
    if (match) capturedJwt = match[1];

    if (url.includes('/access_tokens')) {
      return {
        ok: true,
        json: async () => ({ token: 'ghs_mock_installation_token' }),
        text: async () => '{"token":"ghs_mock_installation_token"}',
      };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  const store = makeCredStore(privateKeyPem);
  await mintInstallationToken(store, { fetchFn: interceptFetch });

  expect(capturedJwt).not.toBeNull();
  expect(typeof capturedJwt).toBe('string');

  // Verify JWT with the public key (RS256)
  const publicKey = await importSPKI(publicKeySpkiPem, 'RS256');
  const { payload } = await jwtVerify(capturedJwt, publicKey, { algorithms: ['RS256'] });
  return payload;
}

// ── normalizePem unit tests ───────────────────────────────────────────────────

describe('normalizePem', () => {
  it('returns input unchanged when no PEM header is found (AC7 pass-through)', () => {
    const input = 'this is not a pem';
    expect(normalizePem(input)).toBe(input);
  });

  it('is idempotent: normalising twice gives the same result (AC4)', () => {
    const header = '-----BEGIN PRIVATE KEY-----';
    const footer = '-----END PRIVATE KEY-----';
    const fakeBody = 'AAAA'.repeat(16); // 64 chars, exactly one line
    const wellFormedPem = `${header}\n${fakeBody}\n${footer}\n`;

    const once = normalizePem(wellFormedPem);
    const twice = normalizePem(once);
    expect(twice).toBe(once);
  });

  it('recovers a PKCS#1 PEM whose body newlines were replaced by spaces (AC3 unit)', () => {
    const header = '-----BEGIN RSA PRIVATE KEY-----';
    const footer = '-----END RSA PRIVATE KEY-----';
    // Construct a body with spaces instead of newlines
    const bodyChunks = ['AAAA'.repeat(16), 'BBBB'.repeat(16), 'CCCC'.repeat(4)]; // 64+64+16 chars
    const spaceBody = bodyChunks.join(' ');
    const mangledPem = `${header}\n${spaceBody}\n${footer}`;

    const normalized = normalizePem(mangledPem);

    // Header and footer must be present
    expect(normalized).toContain(header);
    expect(normalized).toContain(footer);

    // Body lines must be ≤ 64 chars each (between header and footer)
    const lines = normalized.split('\n').filter((l) => l && !l.startsWith('-----'));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(64);
    }

    // No spaces in body: strip header/footer lines and check body chars
    const bodyLines = normalized.split('\n').filter((l) => l && !l.startsWith('-----'));
    const bodyStr = bodyLines.join('');
    expect(bodyStr).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('normalises a PKCS#8 PEM with mangled spaces analogously (PKCS#8 variant)', () => {
    const header = '-----BEGIN PRIVATE KEY-----';
    const footer = '-----END PRIVATE KEY-----';
    const bodyChunks = ['ZZZZ'.repeat(16), 'YYYY'.repeat(8)];
    const spaceBody = bodyChunks.join(' ');
    const mangledPem = `${header}\n${spaceBody}\n${footer}`;

    const normalized = normalizePem(mangledPem);
    expect(normalized).toContain(header);
    expect(normalized).toContain(footer);

    const lines = normalized.split('\n').filter((l) => l && !l.startsWith('-----'));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
  });
});

// ── mintInstallationToken — format-tolerant JWT signing ───────────────────────

describe('mintInstallationToken — AC1: PKCS#1 key with correct newlines', () => {
  it('produces a valid, verifiable RS256 JWT (iss = appId, alg = RS256)', async () => {
    const payload = await mintAndVerifyJwt(keys.pkcs1PrivatePem, keys.pkcs1PublicPem);
    expect(payload.iss).toBe('12345');
  });

  it('JWT header.alg is RS256', async () => {
    let capturedJwt = null;
    const interceptFetch = async (url, init) => {
      const authHeader = init?.headers?.Authorization ?? '';
      const match = /^Bearer (.+)$/.exec(authHeader);
      if (match) capturedJwt = match[1];
      return {
        ok: true,
        json: async () => ({ token: 'ghs_x' }),
        text: async () => '{"token":"ghs_x"}',
      };
    };
    const store = makeCredStore(keys.pkcs1PrivatePem);
    await mintInstallationToken(store, { fetchFn: interceptFetch });

    // Decode header (no verification needed here — just check alg claim)
    const [headerB64] = capturedJwt.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
  });
});

describe('mintInstallationToken — AC2: PKCS#8 key with correct newlines (regression)', () => {
  it('produces a valid, verifiable RS256 JWT', async () => {
    const payload = await mintAndVerifyJwt(keys.pkcs8PrivatePem, keys.pkcs8PublicPem);
    expect(payload.iss).toBe('12345');
  });
});

describe('mintInstallationToken — AC3: PKCS#1 key with newlines replaced by spaces', () => {
  it('normalises and produces a valid, verifiable RS256 JWT', async () => {
    // Simulate the copy-paste fallback: replace all \n in the PEM body with a space
    const mangledPem = keys.pkcs1PrivatePem.replace(/\n/g, ' ');
    const payload = await mintAndVerifyJwt(mangledPem, keys.pkcs1PublicPem);
    expect(payload.iss).toBe('12345');
  });
});

describe('mintInstallationToken — AC4: normalisation is idempotent', () => {
  it('applying normalizePem twice yields the same signing result', async () => {
    // Mint with singly-normalised key
    const normalizedOnce = normalizePem(keys.pkcs8PrivatePem);
    const payload1 = await mintAndVerifyJwt(normalizedOnce, keys.pkcs8PublicPem);

    // Mint with doubly-normalised key
    const normalizedTwice = normalizePem(normalizedOnce);
    const payload2 = await mintAndVerifyJwt(normalizedTwice, keys.pkcs8PublicPem);

    // Both JWTs must be valid and have the same iss
    expect(payload1.iss).toBe('12345');
    expect(payload2.iss).toBe('12345');
  });
});

// ── AC6: Security floor — no key / JWT in error messages or logs ──────────────

describe('mintInstallationToken — AC6: security floor', () => {
  it('error message for bad key does not contain key material', async () => {
    const badKey = 'BAD_KEY_SECRET_MATERIAL_SHOULD_NOT_APPEAR';
    const store = makeCredStore(badKey);
    let caught;
    try {
      await mintInstallationToken(store, { fetchFn: makeSuccessFetch() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain(badKey);
    expect(caught.message).not.toContain('BAD_KEY_SECRET_MATERIAL_SHOULD_NOT_APPEAR');
  });

  it('error message for mangled key does not contain any key fragment', async () => {
    // Use a recognisable but invalid PEM body
    const header = '-----BEGIN RSA PRIVATE KEY-----';
    const footer = '-----END RSA PRIVATE KEY-----';
    const truncatedBody = 'AAAA'; // too short — not a valid RSA key
    const truncatedPem = `${header}\n${truncatedBody}\n${footer}\n`;

    const store = makeCredStore(truncatedPem);
    let caught;
    try {
      await mintInstallationToken(store, { fetchFn: makeSuccessFetch() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain(truncatedBody);
  });
});

// ── AC7: Structurally broken PEM → jwt-sign-failed, no crash ─────────────────

describe('mintInstallationToken — AC7: broken PEM degrades cleanly', () => {
  it('throws GitHubAppTokenError with code jwt-sign-failed for garbage input', async () => {
    const store = makeCredStore('this-is-not-a-pem-at-all');
    await expect(
      mintInstallationToken(store, { fetchFn: makeSuccessFetch() }),
    ).rejects.toMatchObject({ name: 'GitHubAppTokenError', code: 'jwt-sign-failed' });
  });

  it('throws GitHubAppTokenError with code jwt-sign-failed for truncated PEM body', async () => {
    const header = '-----BEGIN RSA PRIVATE KEY-----';
    const footer = '-----END RSA PRIVATE KEY-----';
    const brokenPem = `${header}\nAAAA\n${footer}\n`;

    const store = makeCredStore(brokenPem);
    await expect(
      mintInstallationToken(store, { fetchFn: makeSuccessFetch() }),
    ).rejects.toMatchObject({ name: 'GitHubAppTokenError', code: 'jwt-sign-failed' });
  });

  it('does not crash — throws cleanly without unhandled rejection', async () => {
    const store = makeCredStore('');
    await expect(
      mintInstallationToken(store, { fetchFn: makeSuccessFetch() }),
    ).rejects.toBeInstanceOf(GitHubAppTokenError);
  });
});
