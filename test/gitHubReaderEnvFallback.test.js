/**
 * gitHubReaderEnvFallback.test.js — Tests für S-149: GH_TOKEN-Env-Fallback entfernen.
 *
 * Covers (github-app-token-unification S-149 — AC9, AC10):
 *   AC9  — Kein process.env.GH_TOKEN-Default im GitHubReader-Konstruktor: Reader OHNE
 *           tokenProvider, aber MIT gesetztem process.env.GH_TOKEN, ruft getProjects()
 *           und listRepos() auf → liefert leere Liste/[] und nutzt das Env-Token NICHT
 *           (injizierter fetchFn sieht keinen Authorization-Header aus dem Env-Token).
 *   AC10 — Graceful degradation bei leerem/fehlendem Provider-Token: tokenProvider liefert
 *           undefined oder wirft → Reader liefert leere Liste/[] und crasht nicht, obwohl
 *           process.env.GH_TOKEN gesetzt ist.
 *
 * Nicht per Unit-Test prüfbar (dokumentiert):
 *   AC5 (server.js-Verdrahtung) — Strukturtest: GitHubReader in server.js mit
 *       { tokenProvider: () => provider.getToken() } verdrahtet. Nicht ohne echtes
 *       Hochfahren des Servers testbar; geprüft über Quelltext-Inspektion (server.js).
 *   AC6 (docker-compose.yml/env.example) — Konfigurationsdatei-Konvention, kein
 *       Unit-Test; geprüft über Quelltext-Inspektion.
 *
 * Strategie:
 *   - GitHubReader direkt instanziieren (kein HTTP-Server)
 *   - Injizierter fetchFn (fake) — kein echtes GitHub API
 *   - process.env.GH_TOKEN wird für die Testdauer gesetzt und danach wiederhergestellt
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { GitHubReader } from '../src/GitHubReader.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fake-Response mit JSON-Body. */
function fakeJson(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

/**
 * Baut einen fetchFn-Spy der Authorization-Header aufzeichnet und eine
 * Repos-Antwort zurückgibt.
 *
 * @param {Array} repos - Repos die zurückgegeben werden
 * @returns {{ fetchFn: Function, capturedHeaders: Array }}
 */
function makeFetchSpy(repos = []) {
  const capturedHeaders = [];
  const fetchFn = jest.fn(async (url, init) => {
    capturedHeaders.push(init?.headers ?? {});
    const u = new URL(url);
    if (u.pathname.includes('/orgs/') && u.pathname.endsWith('/repos')) {
      return fakeJson(repos.map((r) => ({
        name: r,
        full_name: `Studis-Softwareschmiede/${r}`,
        visibility: 'private',
        html_url: `https://github.com/Studis-Softwareschmiede/${r}`,
      })));
    }
    if (u.pathname === '/search/issues') {
      return fakeJson({ total_count: 0, items: [] });
    }
    const ciMatch = u.pathname.match(/\/repos\/[^/]+\/([^/]+)\/actions\/runs$/);
    if (ciMatch) {
      return fakeJson({ workflow_runs: [] });
    }
    return fakeJson(null, 404);
  });
  return { fetchFn, capturedHeaders };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('S-149 AC9 — GitHubReader ohne tokenProvider nutzt process.env.GH_TOKEN NICHT', () => {
  let originalGhToken;

  beforeEach(() => {
    originalGhToken = process.env.GH_TOKEN;
    // Setze GH_TOKEN auf einen gefälschten Wert, der sichtbar wäre wenn der Reader ihn nutzt
    process.env.GH_TOKEN = 'ghs_FAKE_ENV_TOKEN_SHOULD_NOT_BE_USED';
  });

  afterEach(() => {
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
  });

  it('AC9: getProjects() ohne tokenProvider liefert leere Liste — nutzt Env-Token nicht', async () => {
    // Leere Repo-Antwort: ohne tokenProvider darf der Reader das Env-GH_TOKEN NICHT
    // als Fallback nutzen → kein Auth-Header mit Env-Token UND leeres Ergebnis.
    const { fetchFn, capturedHeaders } = makeFetchSpy([]);

    // Reader OHNE tokenProvider (AC9: kein Env-Token-Fallback)
    const reader = new GitHubReader({ fetchFn });

    const result = await reader.getProjects();

    // (1) Ergebnis ist leer (kein Token → keine Repos)
    expect(result).toEqual([]);
    // (2) kein Authorization-Header mit dem Env-Token (Env-Fallback nicht genutzt)
    for (const headers of capturedHeaders) {
      const authHeader = headers['Authorization'] ?? headers['authorization'] ?? '';
      expect(authHeader).not.toContain('ghs_FAKE_ENV_TOKEN_SHOULD_NOT_BE_USED');
    }
  });

  it('AC9: listRepos() ohne tokenProvider liefert leere Liste — nutzt Env-Token nicht', async () => {
    const { fetchFn, capturedHeaders } = makeFetchSpy([]);

    const reader = new GitHubReader({ fetchFn });
    const result = await reader.listRepos();

    expect(result).toEqual([]);
    for (const headers of capturedHeaders) {
      const authHeader = headers['Authorization'] ?? headers['authorization'] ?? '';
      expect(authHeader).not.toContain('ghs_FAKE_ENV_TOKEN_SHOULD_NOT_BE_USED');
    }
  });

  it('AC9: Reader ohne tokenProvider aber mit gesetztem GH_TOKEN → kein Auth-Header an GitHub', async () => {
    // Direktere Prüfung: der Reader OHNE tokenProvider sendet keinen Authorization-Header.
    // Mit tokenProvider=undefined degeneriert er — kein Token, kein Authorization-Header.
    const authHeaders = [];
    const fetchFn = jest.fn(async (url, init) => {
      const auth = init?.headers?.['Authorization'] ?? init?.headers?.['authorization'];
      if (auth) authHeaders.push(auth);
      return fakeJson([]); // Leere Repo-Liste → getProjects() liefert []
    });

    const reader = new GitHubReader({ fetchFn });
    const result = await reader.getProjects();

    // Kein Authorization-Header mit dem Env-Token
    expect(authHeaders.length).toBe(0);
    // getProjects() liefert leere Liste (kein Token → keine Repos von fake-fetchFn)
    expect(result).toEqual([]);
  });
});

describe('S-149 AC10 — Graceful degradation: werfender/leerer tokenProvider → kein Crash', () => {
  let originalGhToken;

  beforeEach(() => {
    originalGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghs_FAKE_ENV_TOKEN_SHOULD_NOT_BE_USED';
  });

  afterEach(() => {
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
  });

  it('AC10: tokenProvider wirft → getProjects() crasht nicht und liefert leere Liste', async () => {
    const fetchFn = jest.fn(async () => fakeJson([]));

    const reader = new GitHubReader({
      tokenProvider: async () => { throw new Error('CredentialStore leer / DR-Zustand'); },
      fetchFn,
    });

    // Darf NICHT werfen — direkt awaiten (kein expect().not.toThrow() für async)
    const result = await reader.getProjects();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('AC10: tokenProvider liefert undefined → listRepos() crasht nicht und liefert leere Liste', async () => {
    const fetchFn = jest.fn(async () => fakeJson([]));

    const reader = new GitHubReader({
      tokenProvider: async () => undefined,
      fetchFn,
    });

    // Darf NICHT werfen — direkt awaiten
    const result = await reader.listRepos();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('AC10: tokenProvider liefert leeren String → kein Env-Token-Fallback, kein Auth-Header', async () => {
    const authHeaders = [];
    const fetchFn = jest.fn(async (url, init) => {
      const auth = init?.headers?.['Authorization'] ?? init?.headers?.['authorization'];
      if (auth) authHeaders.push(auth);
      return fakeJson([]);
    });

    const reader = new GitHubReader({
      tokenProvider: async () => '',
      fetchFn,
    });

    await reader.getProjects();

    // Leerer String → kein Token → kein Authorization-Header
    expect(authHeaders.length).toBe(0);
    // Kein Env-Token-Fallback
    for (const h of authHeaders) {
      expect(h).not.toContain('ghs_FAKE_ENV_TOKEN_SHOULD_NOT_BE_USED');
    }
  });

  it('AC10: Server-Start unberührt — Reader-Konstruktion ohne tokenProvider crasht nicht', () => {
    // Sicherstellen dass der Konstruktor selbst nicht wirft (kein Crash beim Server-Start)
    expect(() => new GitHubReader()).not.toThrow();
    expect(() => new GitHubReader({})).not.toThrow();
    expect(() => new GitHubReader({ tokenProvider: undefined })).not.toThrow();
  });
});

describe('S-149 AC9 — Quelltext-Inspektion: kein process.env.GH_TOKEN im Konstruktor-Default', () => {
  it('AC9: GitHubReader.js Konstruktor-Default ist NICHT () => process.env.GH_TOKEN', async () => {
    // Quelltext-Inspektion: sicherstellen dass der GH_TOKEN-Env-Fallback aus dem
    // Konstruktor-Default entfernt wurde. Prüft das konrete Muster, nicht alle Erwähnungen
    // (Kommentare zur historischen Erklärung sind erlaubt).
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcPath = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'GitHubReader.js');
    const src = await readFile(srcPath, 'utf8');

    // Der konkrete Default-Ausdruck darf nicht mehr vorhanden sein (AC9):
    // Die alte Form war: tokenProvider ?? (() => process.env.GH_TOKEN)
    expect(src).not.toMatch(/tokenProvider\s*\?\?.*process\.env\.GH_TOKEN/);

    // Das neue Muster muss vorhanden sein: Default liefert undefined (kein Env-Lookup)
    expect(src).toContain('tokenProvider ?? (() => undefined)');
  });
});
