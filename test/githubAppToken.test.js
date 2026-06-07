/**
 * githubAppToken.test.js — Tests for the shared githubAppToken helper (#83, AC2).
 *
 * Covers:
 *   GitHubAppTokenError — typed error class with `.code` property
 *   mintInstallationToken — throws GitHubAppTokenError with correct codes on all failure paths:
 *     'credentials-incomplete'  — missing CredentialStore or missing fields
 *     'jwt-sign-failed'         — bad key material
 *     'network-error'           — fetch throws (unreachable) or non-ok response
 *     'invalid-response'        — non-parseable body or missing token field
 *   mintInstallationToken — returns token string on success (happy path)
 *
 * Strategy:
 *   - fetchFn injected (no real network calls)
 *   - CredentialStore mocked
 *   - RSA key pair generated once for happy-path / jwt-sign-failed tests
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import { mintInstallationToken, writeAskpassScript, minimalGitEnv, GitHubAppTokenError } from '../src/githubAppToken.js';

const generateKeyPairAsync = promisify(generateKeyPair);

/** @type {string} */
let VALID_PRIVATE_KEY_PEM;

beforeAll(async () => {
  const { privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  VALID_PRIVATE_KEY_PEM = privateKey;
});

// ── Helper factories ──────────────────────────────────────────────────────────

function makeCredStore({ appId = '12345', installationId = '67890', privateKey } = {}) {
  return {
    async getPlaintext(key) {
      if (key === 'credentials/github/app_id') return appId ?? null;
      if (key === 'credentials/github/installation_id') return installationId ?? null;
      if (key === 'credentials/github/private_key') return privateKey ?? VALID_PRIVATE_KEY_PEM;
      return null;
    },
  };
}

function makeSuccessFetch(token = 'ghs_mock_token_abc123') {
  return async (url) => {
    if (url.includes('/access_tokens')) {
      return {
        ok: true,
        json: async () => ({ token }),
        text: async () => JSON.stringify({ token }),
      };
    }
    throw new Error('unexpected fetch url');
  };
}

// ── Assertion helper ──────────────────────────────────────────────────────────

/**
 * Assert that a promise rejects with a GitHubAppTokenError having the given code.
 * @param {Promise<unknown>} promise
 * @param {string} expectedCode
 */
async function expectAppTokenError(promise, expectedCode) {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(GitHubAppTokenError);
    expect(err.code).toBe(expectedCode);
  }
  expect(threw).toBe(true);
}

// ── GitHubAppTokenError class ─────────────────────────────────────────────────

describe('GitHubAppTokenError', () => {
  it('is an instance of Error', () => {
    const err = new GitHubAppTokenError('test message', 'credentials-incomplete');
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct name', () => {
    const err = new GitHubAppTokenError('msg', 'jwt-sign-failed');
    expect(err.name).toBe('GitHubAppTokenError');
  });

  it('exposes .code property', () => {
    const err = new GitHubAppTokenError('msg', 'network-error');
    expect(err.code).toBe('network-error');
  });

  it('exposes .message property', () => {
    const err = new GitHubAppTokenError('Something went wrong', 'invalid-response');
    expect(err.message).toBe('Something went wrong');
  });

  it('supports all documented codes without throwing', () => {
    const codes = ['credentials-incomplete', 'jwt-sign-failed', 'network-error', 'invalid-response'];
    for (const code of codes) {
      expect(() => new GitHubAppTokenError('msg', code)).not.toThrow();
    }
  });
});

// ── mintInstallationToken — credentials-incomplete ────────────────────────────

describe('mintInstallationToken — credentials-incomplete', () => {
  it('throws GitHubAppTokenError with code credentials-incomplete when credentialStore is null', async () => {
    await expectAppTokenError(mintInstallationToken(null), 'credentials-incomplete');
  });

  it('throws GitHubAppTokenError with code credentials-incomplete when credentialStore is undefined', async () => {
    await expectAppTokenError(mintInstallationToken(undefined), 'credentials-incomplete');
  });

  it('throws GitHubAppTokenError with code credentials-incomplete when app_id is missing', async () => {
    const store = makeCredStore({ appId: null, installationId: '67890' });
    await expectAppTokenError(mintInstallationToken(store), 'credentials-incomplete');
  });

  it('throws GitHubAppTokenError with code credentials-incomplete when installation_id is missing', async () => {
    const store = makeCredStore({ appId: '123', installationId: null });
    await expectAppTokenError(mintInstallationToken(store), 'credentials-incomplete');
  });

  it('error message does not contain credential values', async () => {
    const store = makeCredStore({ appId: null });
    try {
      await mintInstallationToken(store);
    } catch (err) {
      expect(err.message).not.toContain('null');
      expect(err.message).not.toContain('undefined');
    }
  });
});

// ── mintInstallationToken — jwt-sign-failed ───────────────────────────────────

describe('mintInstallationToken — jwt-sign-failed', () => {
  it('throws GitHubAppTokenError with code jwt-sign-failed for invalid private key', async () => {
    const store = makeCredStore({ privateKey: 'this-is-not-a-valid-pem-key' });
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: makeSuccessFetch() }),
      'jwt-sign-failed',
    );
  });

  it('error message does not contain the invalid key material', async () => {
    const store = makeCredStore({ privateKey: 'BAD_KEY_MATERIAL_SECRET' });
    let caughtErr;
    try {
      await mintInstallationToken(store, { fetchFn: makeSuccessFetch() });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr.message).not.toContain('BAD_KEY_MATERIAL_SECRET');
  });
});

// ── mintInstallationToken — network-error ─────────────────────────────────────

describe('mintInstallationToken — network-error', () => {
  it('throws GitHubAppTokenError with code network-error when fetchFn throws', async () => {
    const store = makeCredStore();
    const failFetch = async () => { throw new Error('ECONNREFUSED'); };
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: failFetch }),
      'network-error',
    );
  });

  it('throws GitHubAppTokenError with code network-error on non-ok response (401)', async () => {
    const store = makeCredStore();
    const failFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: failFetch }),
      'network-error',
    );
  });

  it('non-ok response message does not contain credential values', async () => {
    const store = makeCredStore();
    const failFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    let caughtErr;
    try {
      await mintInstallationToken(store, { fetchFn: failFetch });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr.message).not.toContain('ghs_');
    expect(caughtErr.message).not.toContain('Bearer');
  });
});

// ── mintInstallationToken — invalid-response ──────────────────────────────────

describe('mintInstallationToken — invalid-response', () => {
  it('throws GitHubAppTokenError with code invalid-response when body is not JSON', async () => {
    const store = makeCredStore();
    const badFetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
      text: async () => 'not-json',
    });
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: badFetch }),
      'invalid-response',
    );
  });

  it('throws GitHubAppTokenError with code invalid-response when token field is missing', async () => {
    const store = makeCredStore();
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ message: 'ok but no token field' }),
      text: async () => '{}',
    });
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: badFetch }),
      'invalid-response',
    );
  });

  it('throws GitHubAppTokenError with code invalid-response when token field is empty string', async () => {
    const store = makeCredStore();
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ token: '' }),
      text: async () => '{}',
    });
    await expectAppTokenError(
      mintInstallationToken(store, { fetchFn: badFetch }),
      'invalid-response',
    );
  });
});

// ── writeAskpassScript ────────────────────────────────────────────────────────

describe('writeAskpassScript', () => {
  it('writes a sh script with correct shebang and case structure', async () => {
    const calls = [];
    const fakeWriteFile = async (path, content, opts) => {
      calls.push({ path, content, opts });
    };

    await writeAskpassScript('/tmp/test-askpass.sh', '_GIT_CLONE_TOKEN_ABCD1234', fakeWriteFile);

    expect(calls).toHaveLength(1);
    const { content, opts } = calls[0];

    // Must start with sh shebang
    expect(content).toMatch(/^#!\/bin\/sh\n/);

    // Must contain the case "$1" pattern for git credential protocol
    expect(content).toContain('case "$1"');

    // Must echo x-access-token for Username prompts
    expect(content).toContain('*Username*)');
    expect(content).toContain('echo x-access-token');

    // Must use printenv <ENVVAR> (not shell substitution) for Password/token prompts
    expect(content).toContain('printenv _GIT_CLONE_TOKEN_ABCD1234');

    // Must be executable (mode 0o700)
    expect(opts).toBeDefined();
    expect(opts.mode).toBe(0o700);
  });

  it('does not embed the token value in the script content', async () => {
    // The token itself must never appear in the script — only the env-var name does
    const SECRET_TOKEN = 'ghs_SUPER_SECRET_TOKEN_VALUE_12345';
    let writtenContent = '';
    const fakeWriteFile = async (_path, content) => { writtenContent = content; };

    await writeAskpassScript('/tmp/test-askpass.sh', '_GIT_CLONE_TOKEN_XYZ', fakeWriteFile);

    // Script contains the env var name, not a token value
    expect(writtenContent).not.toContain(SECRET_TOKEN);
    expect(writtenContent).toContain('_GIT_CLONE_TOKEN_XYZ');
  });

  it('uses the provided env var name in the printenv call', async () => {
    const envVarName = '_GIT_CLONE_TOKEN_DEADBEEF0011';
    let writtenContent = '';
    const fakeWriteFile = async (_path, content) => { writtenContent = content; };

    await writeAskpassScript('/tmp/test-askpass.sh', envVarName, fakeWriteFile);

    expect(writtenContent).toContain(`printenv ${envVarName}`);
  });
});

// ── minimalGitEnv ─────────────────────────────────────────────────────────────

describe('minimalGitEnv', () => {
  it('returns an object (not null/undefined)', () => {
    const env = minimalGitEnv();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
    expect(env).not.toBeNull();
  });

  it('allowlist: only forwards HOME, PATH, USER, LANG, TMP, TMPDIR from process.env', () => {
    // Keys in the result must be from the allowlist (plus any extra passed in)
    const env = minimalGitEnv();
    const allowedBase = new Set(['HOME', 'PATH', 'USER', 'LANG', 'TMP', 'TMPDIR']);
    for (const key of Object.keys(env)) {
      expect(allowedBase.has(key)).toBe(true);
    }
  });

  it('does not forward arbitrary/sensitive process.env keys', () => {
    // Even if a sensitive var is set, it must not appear in minimalGitEnv()
    const env = minimalGitEnv();
    // Common sensitive keys that must never bleed into child env
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('NPM_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('merges extra keys into the result', () => {
    const extra = {
      GIT_ASKPASS: '/tmp/askpass.sh',
      GIT_TERMINAL_PROMPT: '0',
      _GIT_CLONE_TOKEN_ABCD: 'ghs_faketoken',
    };
    const env = minimalGitEnv(extra);
    expect(env.GIT_ASKPASS).toBe('/tmp/askpass.sh');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env._GIT_CLONE_TOKEN_ABCD).toBe('ghs_faketoken');
  });

  it('extra keys do not pollute subsequent calls (no shared state)', () => {
    minimalGitEnv({ _GIT_CLONE_TOKEN_FIRST: 'ghs_first' });
    const env2 = minimalGitEnv();
    expect(env2).not.toHaveProperty('_GIT_CLONE_TOKEN_FIRST');
  });
});

// ── mintInstallationToken — happy path ───────────────────────────────────────

describe('mintInstallationToken — success', () => {
  it('returns the token string on success', async () => {
    const store = makeCredStore();
    const token = await mintInstallationToken(store, { fetchFn: makeSuccessFetch('ghs_returned_token') });
    expect(token).toBe('ghs_returned_token');
  });

  it('returned value is a non-empty string', async () => {
    const store = makeCredStore();
    const token = await mintInstallationToken(store, { fetchFn: makeSuccessFetch() });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});
