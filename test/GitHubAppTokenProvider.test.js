/**
 * GitHubAppTokenProvider.test.js — Unit tests for the cached App-Token provider.
 *
 * Covers (github-app-token-unification):
 *   AC1 — new boundary getToken() mints on first call (cold cache)
 *   AC2 — cache HIT: second call within TTL returns same token without re-minting
 *   AC3 — cache REFRESH: call after TTL expires triggers a new mint
 *   AC4 — concurrency / Single-Flight: N parallel calls on cold cache mint exactly once;
 *          on failure the in-flight is cleared so the next call can retry
 *   AC5 — GitHubReader wired via injected tokenProvider (not process.env.GH_TOKEN);
 *          see describe "GitHubAppTokenProvider + GitHubReader — AC5" below + server.js
 *   AC6 — GH_TOKEN no longer a read-path: verified by inspection of
 *          docker-compose.yml (GH_TOKEN:-), .env.example comment, and
 *          docker-entrypoint.sh (unset GH_TOKEN GITHUB_TOKEN — unchanged);
 *          infra-level config, no unit test possible.
 *   AC7 — graceful degradation: GitHubAppTokenError from getToken() propagates
 *          correctly so callers (GitHubReader) can catch and degrade
 *   AC8 — Token-Floor: error messages contain NO token value
 *
 * Strategy:
 *   - `mintFn` is injected (call counter + configurable return value / throw).
 *   - `now` is injected (controlled clock — no real time waiting).
 *   - No real network I/O.
 */

import { describe, it, expect } from '@jest/globals';
import { GitHubAppTokenProvider } from '../src/GitHubAppTokenProvider.js';
import { GitHubAppTokenError } from '../src/githubAppToken.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a controlled clock that starts at `start` and can be advanced via
 * the returned `advance(ms)` function.
 *
 * @param {number} [start=0]
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

/**
 * Build an injectable mintFn that:
 *   - counts how many times it was called.
 *   - returns successive tokens from `tokens[]` (cycles on exhaustion).
 *   - throws `failWith` (if set) instead of returning.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.tokens]  Token strings to return in order.
 * @param {Error|null} [opts.failWith]  If set, throw this on every call.
 * @returns {{ mintFn: Function, callCount: () => number }}
 */
function makeMintFn({ tokens = ['token-a', 'token-b', 'token-c'], failWith = null } = {}) {
  let count = 0;
  const mintFn = async () => {
    count++;
    if (failWith) throw failWith;
    return tokens[(count - 1) % tokens.length];
  };
  return { mintFn, callCount: () => count };
}

/** Stub credentialStore — not used when mintFn is injected, but required by constructor. */
const stubStore = {};

// ── AC1: Cold-cache mint ───────────────────────────────────────────────────────

describe('GitHubAppTokenProvider — AC1: cold-cache mint', () => {
  it('calls mintFn once and returns the token on first getToken()', async () => {
    const { mintFn, callCount } = makeMintFn({ tokens: ['first-token'] });
    const clock = makeClock();
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    const token = await provider.getToken();

    expect(token).toBe('first-token');
    expect(callCount()).toBe(1);
  });
});

// ── AC2: Cache HIT ────────────────────────────────────────────────────────────

describe('GitHubAppTokenProvider — AC2: cache HIT', () => {
  it('returns the cached token without minting again on second call within TTL', async () => {
    const { mintFn, callCount } = makeMintFn({ tokens: ['cached-token'] });
    const clock = makeClock(1000);
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    const first = await provider.getToken();
    // Advance clock but stay well within 50-minute window (advance by 5 min)
    clock.advance(5 * 60 * 1000);
    const second = await provider.getToken();

    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    // mintFn must have been called exactly once (not twice)
    expect(callCount()).toBe(1);
  });

  it('returns the same token string on both calls', async () => {
    const { mintFn } = makeMintFn({ tokens: ['same-token'] });
    const clock = makeClock();
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    const a = await provider.getToken();
    const b = await provider.getToken();
    expect(a).toBe(b);
  });
});

// ── AC3: Refresh before expiry (clock-controlled) ─────────────────────────────

describe('GitHubAppTokenProvider — AC3: cache REFRESH after TTL', () => {
  const SAFE_TTL_MS = 50 * 60 * 1000; // must match implementation

  it('mints a second token after the TTL has elapsed', async () => {
    const { mintFn, callCount } = makeMintFn({ tokens: ['old-token', 'new-token'] });
    const clock = makeClock(0);
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    const first = await provider.getToken();
    expect(first).toBe('old-token');
    expect(callCount()).toBe(1);

    // Advance past Safety-Margin TTL (50 min + 1 ms)
    clock.advance(SAFE_TTL_MS + 1);

    const second = await provider.getToken();
    expect(second).toBe('new-token');
    expect(callCount()).toBe(2);
  });

  it('does NOT refresh when exactly at the boundary (1 ms before expiry)', async () => {
    const { mintFn, callCount } = makeMintFn({ tokens: ['boundary-token'] });
    const clock = makeClock(0);
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    await provider.getToken();
    // Advance to 1 ms before the TTL boundary — token should still be valid
    clock.advance(SAFE_TTL_MS - 1);
    await provider.getToken();

    expect(callCount()).toBe(1); // no second mint
  });
});

// ── AC4: Single-Flight / Concurrency ─────────────────────────────────────────

describe('GitHubAppTokenProvider — AC4: Single-Flight concurrency', () => {
  it('N parallel getToken() calls on cold cache mint exactly once', async () => {
    const { mintFn, callCount } = makeMintFn({ tokens: ['concurrent-token'] });
    const clock = makeClock();
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    // Fire 5 concurrent calls before any resolves
    const results = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    // All 5 must receive the same token
    for (const r of results) {
      expect(r).toBe('concurrent-token');
    }
    // mintFn called exactly once (Single-Flight)
    expect(callCount()).toBe(1);
  });

  it('after a failed concurrent mint, the next caller can retry (no poisoned cache)', async () => {
    const mintError = new GitHubAppTokenError(
      'Netz nicht erreichbar (Token-Minting)',
      'network-error',
    );
    let failFirst = true;
    let callCount = 0;
    const mintFn = async () => {
      callCount++;
      if (failFirst) {
        failFirst = false;
        throw mintError;
      }
      return 'retry-token';
    };

    const clock = makeClock();
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    // First call fails
    await expect(provider.getToken()).rejects.toThrow('Netz nicht erreichbar');
    expect(callCount).toBe(1);

    // Second call (after failure) must retry — not re-use the poisoned in-flight
    const token = await provider.getToken();
    expect(token).toBe('retry-token');
    expect(callCount).toBe(2);
  });

  it('parallel callers all fail when the shared mint fails', async () => {
    const mintError = new GitHubAppTokenError(
      'Credentials nicht verfügbar',
      'credentials-incomplete',
    );
    const { mintFn, callCount } = makeMintFn({ failWith: mintError });
    const clock = makeClock();
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    // Fire 3 concurrent calls — all should fail
    const calls = [provider.getToken(), provider.getToken(), provider.getToken()];
    const results = await Promise.allSettled(calls);

    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(r.reason).toBeInstanceOf(GitHubAppTokenError);
      expect(r.reason.code).toBe('credentials-incomplete');
    }
    // mintFn called exactly once (Single-Flight — all share the single failed promise)
    expect(callCount()).toBe(1);
  });
});

// ── AC7: Error propagation (graceful degradation precondition) ────────────────

describe('GitHubAppTokenProvider — AC7: error propagation', () => {
  it('propagates GitHubAppTokenError with correct code when credentials-incomplete', async () => {
    const error = new GitHubAppTokenError(
      'GitHub-App-Credentials unvollständig: github/app_id fehlt im CredentialStore',
      'credentials-incomplete',
    );
    const { mintFn } = makeMintFn({ failWith: error });
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: Date.now,
    });

    await expect(provider.getToken()).rejects.toMatchObject({
      name: 'GitHubAppTokenError',
      code: 'credentials-incomplete',
    });
  });

  it('propagates GitHubAppTokenError with network-error code', async () => {
    const error = new GitHubAppTokenError(
      'GitHub-API nicht erreichbar (Token-Minting)',
      'network-error',
    );
    const { mintFn } = makeMintFn({ failWith: error });
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: Date.now,
    });

    await expect(provider.getToken()).rejects.toMatchObject({
      name: 'GitHubAppTokenError',
      code: 'network-error',
    });
  });
});

// ── AC8: Token-Floor — no token in error messages ────────────────────────────

describe('GitHubAppTokenProvider — AC8: Token-Floor (no secret in error message)', () => {
  it('error messages do not contain the token string', async () => {
    const SECRET_TOKEN = 'ghs_super_secret_installation_token_value';
    // Mint succeeds once, then fails — but the error should not contain the token
    let call = 0;
    const mintFn = async () => {
      call++;
      if (call === 1) return SECRET_TOKEN;
      throw new GitHubAppTokenError(
        'GitHub-App-Authentication fehlgeschlagen (HTTP 401) beim Token-Minting',
        'network-error',
      );
    };

    const clock = makeClock(0);
    const SAFE_TTL_MS = 50 * 60 * 1000;
    const provider = new GitHubAppTokenProvider({
      credentialStore: stubStore,
      mintFn,
      now: clock.now,
    });

    // First call caches the token
    const t = await provider.getToken();
    expect(t).toBe(SECRET_TOKEN);

    // Advance past TTL so we need to re-mint
    clock.advance(SAFE_TTL_MS + 1);

    // Second call fails — the error must not expose the old or new token
    try {
      await provider.getToken();
      throw new Error('Expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppTokenError);
      expect(err.message).not.toContain(SECRET_TOKEN);
      // Error message must not include any token-like values
      expect(err.message).not.toMatch(/ghs_/);
    }
  });

  it('GitHubAppTokenError message contains only field names / codes, no secret values', () => {
    const err = new GitHubAppTokenError(
      'GitHub-App-Credentials unvollständig: github/app_id, github/private_key fehlen im CredentialStore',
      'credentials-incomplete',
    );
    // message contains field NAMES (safe), not values
    expect(err.message).toContain('github/app_id');
    expect(err.code).toBe('credentials-incomplete');
    // No mock token or secret value in the message
    expect(err.message).not.toMatch(/ghs_/);
    expect(err.message).not.toMatch(/ghp_/);
  });
});

// ── AC5 precondition: Reader uses tokenProvider, not process.env.GH_TOKEN ────

describe('GitHubAppTokenProvider + GitHubReader — AC5: reader uses provider', () => {
  it('GitHubReader calls the injected tokenProvider (not process.env.GH_TOKEN) to resolve the token', async () => {
    // We inject a controlled provider and a fetch stub.
    // If the reader called process.env.GH_TOKEN instead, tokenProviderCalled would be false.
    let tokenProviderCalled = false;
    const tokenProvider = async () => {
      tokenProviderCalled = true;
      return 'provider-supplied-token';
    };

    // Lazy import to avoid module-level side-effects
    const { GitHubReader } = await import('../src/GitHubReader.js');

    // Stub fetch: repos call returns empty list (we just want to see the header)
    let capturedAuthHeader = null;
    const fetchFn = async (url, init) => {
      capturedAuthHeader = init?.headers?.Authorization ?? null;
      return {
        ok: true,
        json: async () => [],
      };
    };

    const reader = new GitHubReader({ tokenProvider, fetchFn });
    await reader.getProjects();

    expect(tokenProviderCalled).toBe(true);
    // Token appears in Authorization header ONLY — not in URL or body
    expect(capturedAuthHeader).toBe('Bearer provider-supplied-token');
  });

  it('GitHubReader degrades gracefully when tokenProvider throws GitHubAppTokenError (AC7)', async () => {
    const { GitHubReader } = await import('../src/GitHubReader.js');
    const { GitHubAppTokenError } = await import('../src/githubAppToken.js');

    const tokenProvider = async () => {
      throw new GitHubAppTokenError(
        'GitHub-App-Credentials unvollständig: github/app_id fehlt',
        'credentials-incomplete',
      );
    };

    // Inject a fetchFn stub that returns empty lists for org repos
    // (tokenProvider throws, so #resolveToken() returns undefined, then
    //  #listRepos() returns [] because the unauthenticated org-repos call also returns []).
    // We stub fetch to return an empty array so no real network I/O occurs.
    const fetchFn = async () => ({
      ok: true,
      json: async () => [],
    });

    const reader = new GitHubReader({ tokenProvider, fetchFn });
    // Must NOT throw — must degrade to empty list
    const projects = await reader.getProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toHaveLength(0);
  });
});
