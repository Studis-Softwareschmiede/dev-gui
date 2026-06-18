/**
 * GitHubPackagesReader — reads GitHub Container Registry (ghcr) packages + tags.
 *
 * Architecture boundary: the ONLY place that touches the GitHub Packages API.
 *
 * Design:
 *   - Token is injectable: `tokenProvider` is a function () => string|Promise<string>.
 *     In production server.js ALWAYS injects the App-Token-Provider (S-146 AC5).
 *   - NO process.env.GH_TOKEN fallback (consistent with S-149 AC9).
 *   - Every external fetch has a timeout (js/R03).
 *   - Token is NEVER included in responses, logs, or errors (security/R01).
 *   - Org is fixed = 'Studis-Softwareschmiede' (no user input → no SSRF, security/R05).
 *   - Paginates via Link header up to MAX_PAGES limit (DoS protection).
 *
 * List-path strategy (S-165, live-verified 2026-06-18):
 *   The GitHub REST org-packages-list endpoint (GET /orgs/{org}/packages?package_type=container)
 *   returns "400 Invalid argument" with an App-Installation-Token, even though the single-package
 *   endpoints (GET /orgs/{org}/packages/container/{name}) return 200 with the same token.
 *   GraphQL organization.packages(packageType:CONTAINER) is also unavailable with the App-Token
 *   (CONTAINER is not a valid GraphQL PackageType; DOCKER returns empty).
 *   Solution (Variante c): retrieve installation repos via GET /installation/repositories,
 *   then probe each repo name via the working single-package endpoint. Packages that exist
 *   return 200; those that don't return 404 (silently skipped). Partial failures produce
 *   errors entries + partial results (AC3).
 *
 * Setup precondition (AC6, live-verified):
 *   The GitHub App does NOT need a special "Packages: Read" org-level permission for the
 *   single-package endpoints — they already work. The 400 from the list endpoint is a
 *   known GitHub API limitation for App-Installation-Tokens regardless of permissions.
 *   No permission change fixes the list endpoint; the workaround (Variante c) is permanent.
 *
 * @module GitHubPackagesReader
 */

/** Org to list packages from. */
const ORG = 'Studis-Softwareschmiede';

/** Default fetch timeout in ms. */
const FETCH_TIMEOUT_MS = 8000;

/** Maximum pages fetched per paginated call (DoS guard). */
const MAX_PAGES = 10;

/** Per-page size for GitHub API calls. */
const PER_PAGE = 100;

/** Package name validation regex — Paketnamen-Zeichensatz (AC5). */
const PACKAGE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Maximum number of installation repos fetched for the list-via-probe strategy (DoS guard).
 * GitHub returns up to 100 per page; we cap at 1 page (100 repos).
 */
const MAX_INSTALLATION_REPOS = 100;

/**
 * Validate a package name parameter.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidPackageName(name) {
  return typeof name === 'string' && name.length > 0 && PACKAGE_NAME_RE.test(name);
}

/**
 * Fetch with a timeout. Rejects on timeout or network error.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the `Link` header for the `next` URL, if present.
 *
 * @param {string|null} linkHeader
 * @returns {string|null} URL of the next page, or null
 */
function parseNextUrl(linkHeader) {
  if (!linkHeader) return null;
  // Link header format: <url>; rel="next", <url>; rel="last"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * GitHubPackagesReader reads Container-Registry package metadata from the GitHub REST API.
 *
 * @param {object} [options]
 * @param {() => string|Promise<string>} [options.tokenProvider]
 *   Async or sync function that returns a GitHub token.
 *   In production, `server.js` always injects the App-Token-Provider (S-146 AC5).
 *   Without an injected provider, the reader resolves no token and degrades gracefully.
 *   Does NOT fall back to process.env.GH_TOKEN (S-149 AC9).
 * @param {typeof fetch} [options.fetchFn]
 *   Injectable fetch implementation (default: global fetch with timeout).
 */
export class GitHubPackagesReader {
  #tokenProvider;
  #fetch;

  constructor({ tokenProvider, fetchFn } = {}) {
    // NO process.env.GH_TOKEN fallback (consistent with S-149 AC9 / GitHubReader pattern).
    this.#tokenProvider = tokenProvider ?? (() => undefined);
    this.#fetch = fetchFn ?? ((...args) => fetchWithTimeout(...args));
  }

  /**
   * Resolve the GitHub token. Returns undefined if absent.
   * Token is intentionally not logged.
   *
   * @returns {Promise<string|undefined>}
   */
  async #resolveToken() {
    try {
      const t = await this.#tokenProvider();
      return t || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Build common request headers.
   * Token goes in Authorization header only — never in URL, never logged.
   *
   * @param {string|undefined} token
   * @returns {Record<string,string>}
   */
  #headers(token) {
    const h = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) {
      h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  /**
   * Fetch all pages of a paginated GitHub API endpoint.
   * Collects items from all pages, up to MAX_PAGES (DoS guard).
   * Returns empty array on any error (graceful degradation).
   *
   * @param {string} firstUrl
   * @param {string|undefined} token
   * @returns {Promise<Array<object>>}
   */
  async #fetchAllPages(firstUrl, token) {
    const items = [];
    let url = firstUrl;
    let page = 0;

    while (url && page < MAX_PAGES) {
      let res;
      try {
        res = await this.#fetch(url, { headers: this.#headers(token) });
      } catch {
        // Network error — return what we have so far (graceful degradation, AC5)
        break;
      }
      if (!res.ok) break;

      let data;
      try {
        data = await res.json();
      } catch {
        break;
      }
      if (!Array.isArray(data)) break;

      items.push(...data);
      page++;

      // Parse Link header for next page URL
      const linkHeader = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('link')
        : null;
      url = parseNextUrl(linkHeader);
    }

    return items;
  }

  /**
   * Fetch the list of repos accessible to the App installation.
   * Returns repo name strings (up to MAX_INSTALLATION_REPOS, DoS guard).
   * Throws on network error (for callers that want to catch and produce an errors entry).
   * Returns empty array on non-200 HTTP response or malformed data.
   *
   * Note: Annahme: Container-Package-Name == Repository-Name. Packages unter abweichendem
   * Namen oder mehrere Packages pro Repo werden von dieser Strategie nicht entdeckt.
   *
   * @param {string} token
   * @returns {Promise<string[]>}
   */
  async #fetchInstallationRepoNames(token) {
    const url = `https://api.github.com/installation/repositories?per_page=${MAX_INSTALLATION_REPOS}`;
    // Note: network errors propagate to caller (not caught here) — allows listPackagesWithErrors
    // to record an errors entry. listPackages() wraps in its own try/catch.
    const res = await this.#fetch(url, { headers: this.#headers(token) });
    if (!res.ok) return [];

    let data;
    try {
      data = await res.json();
    } catch {
      return [];
    }

    if (!data || !Array.isArray(data.repositories)) return [];

    return data.repositories
      .filter((r) => r && typeof r.name === 'string' && PACKAGE_NAME_RE.test(r.name))
      .map((r) => r.name);
  }

  /**
   * Probe whether a repo name corresponds to a container package in the org.
   * Returns the raw package object on HTTP 200, or null on HTTP 404 (silent skip —
   * the repo simply has no same-named container image, which is the expected normal case).
   * All other outcomes (5xx, 403, network throw/timeout) are propagated as a rejected
   * promise so that `listPackagesWithErrors` can record an `errors` entry for this probe
   * while still returning results from all other successful probes (graceful, via allSettled).
   *
   * Note: Annahme: Container-Package-Name == Repository-Name. Packages unter abweichendem
   * Namen oder mehrere Packages pro Repo werden von dieser Strategie nicht entdeckt.
   *
   * Uses GET /orgs/{org}/packages/container/{name} — live-verified 200 with App-Token.
   *
   * @param {string} repoName  — already validated against PACKAGE_NAME_RE
   * @param {string} token
   * @returns {Promise<object|null>}  resolves to package object or null (404); rejects on error
   */
  async #probePackage(repoName, token) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(ORG)}/packages/container/${encodeURIComponent(repoName)}`;
    // Network errors / timeouts propagate as rejection (caller uses allSettled + records errors entry)
    const res = await this.#fetch(url, { headers: this.#headers(token) });

    if (res.status === 404) {
      // 404 = no container package with this name in the org — expected, silent skip
      return null;
    }
    if (!res.ok) {
      // 5xx, 403, or any other non-200/non-404 → treat as a probe failure (errors entry)
      throw new Error(`ProbeHTTPError:${res.status}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('ProbeParseError');
    }
    return data && typeof data.name === 'string' ? data : null;
  }

  /**
   * List all container packages of the org.
   *
   * Uses Variante (c): GET /installation/repositories to enumerate candidate names,
   * then probes each via GET /orgs/{org}/packages/container/{name} (live-verified 200).
   * The direct org-list endpoint (GET /orgs/{org}/packages?package_type=container) returns
   * "400 Invalid argument" with App-Installation-Tokens and is NOT used (S-165, live 2026-06-18).
   *
   * Returns { packages: ImagePackage[], errors?: ErrorEntry[] } internally as
   * { packages, errors } — callers (router) merge into the HTTP response.
   * For the simple return-only callers, returns ImagePackage[] sorted alphabetically.
   *
   * Degrades to empty array on error (AC4/AC5).
   *
   * @returns {Promise<Array<{
   *   name: string,
   *   fullImageRef: string,
   *   visibility: 'public'|'private'|'internal',
   *   htmlUrl: string,
   *   updatedAt: string
   * }>>}
   */
  async listPackages() {
    const token = await this.#resolveToken();
    if (!token) {
      // No token → cannot authenticate → degrade to empty list (AC4)
      return [];
    }

    // Step 1: get installation repo names (DoS-capped at MAX_INSTALLATION_REPOS)
    // Wrap in try/catch: #fetchInstallationRepoNames propagates network errors
    let repoNames;
    try {
      repoNames = await this.#fetchInstallationRepoNames(token);
    } catch {
      // Network error on installation/repos → degrade to empty list
      return [];
    }
    if (!repoNames.length) return [];

    // Step 2: probe each name via the working single-package endpoint (parallel, bounded)
    const org = ORG.toLowerCase();
    const results = await Promise.allSettled(
      repoNames.map((name) => this.#probePackage(name, token)),
    );

    const packages = [];
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const p = result.value;
      packages.push({
        name: p.name,
        fullImageRef: `ghcr.io/${org}/${p.name.toLowerCase()}`,
        visibility: ['public', 'private', 'internal'].includes(p.visibility)
          ? p.visibility
          : 'private',
        htmlUrl: typeof p.html_url === 'string'
          ? p.html_url
          : `https://github.com/orgs/${ORG}/packages/container/${encodeURIComponent(p.name)}/versions`,
        updatedAt: typeof p.updated_at === 'string' ? p.updated_at : '',
      });
    }

    // Sort alphabetically by name (AC1 / Spec)
    packages.sort((a, b) => a.name.localeCompare(b.name));

    return packages;
  }

  /**
   * List all container packages with partial-error details (AC3).
   *
   * Same as listPackages() but also returns errors for failed individual probes.
   * Used by the router to expose errors[] in the HTTP response.
   *
   * @returns {Promise<{
   *   packages: Array<{name, fullImageRef, visibility, htmlUrl, updatedAt}>,
   *   errors: Array<{scope: string, errorClass: string}>
   * }>}
   */
  async listPackagesWithErrors() {
    const token = await this.#resolveToken();
    if (!token) {
      return { packages: [], errors: [] };
    }

    let repoNames;
    try {
      repoNames = await this.#fetchInstallationRepoNames(token);
    } catch {
      return { packages: [], errors: [{ scope: 'installation/repositories', errorClass: 'FetchError' }] };
    }
    if (!repoNames.length) return { packages: [], errors: [] };

    const org = ORG.toLowerCase();
    const probeResults = await Promise.allSettled(
      repoNames.map((name) => this.#probePackage(name, token).then((pkg) => ({ name, pkg }))),
    );

    const packages = [];
    const errors = [];

    for (let i = 0; i < probeResults.length; i++) {
      const result = probeResults[i];
      if (result.status === 'rejected') {
        // 5xx / 403 / network error / parse error from #probePackage → errors entry (AC3)
        const errorClass = result.reason?.message?.startsWith('ProbeHTTPError:')
          ? `HTTPError${result.reason.message.slice('ProbeHTTPError:'.length)}`
          : result.reason?.message === 'ProbeParseError'
            ? 'ParseError'
            : 'FetchError';
        errors.push({ scope: repoNames[i] ?? 'unknown', errorClass });
        continue;
      }
      const { pkg } = result.value;
      if (!pkg) continue; // 404 = no container package for this repo name — silent skip, not an error
      packages.push({
        name: pkg.name,
        fullImageRef: `ghcr.io/${org}/${pkg.name.toLowerCase()}`,
        visibility: ['public', 'private', 'internal'].includes(pkg.visibility)
          ? pkg.visibility
          : 'private',
        htmlUrl: typeof pkg.html_url === 'string'
          ? pkg.html_url
          : `https://github.com/orgs/${ORG}/packages/container/${encodeURIComponent(pkg.name)}/versions`,
        updatedAt: typeof pkg.updated_at === 'string' ? pkg.updated_at : '',
      });
    }

    packages.sort((a, b) => a.name.localeCompare(b.name));

    return { packages, errors };
  }

  /**
   * List all tags for a named container package.
   *
   * Returns ImageTag[] sorted by updatedAt descending (newest first).
   * Versions without any tag are omitted (untagged versions are useless for a deploy dropdown).
   * Degrades to empty array on error / 404 (AC5).
   *
   * @param {string} packageName - validated package name (caller must validate via isValidPackageName)
   * @returns {Promise<Array<{ tag: string, digest: string, updatedAt: string }>>}
   */
  async listTags(packageName) {
    const token = await this.#resolveToken();
    if (!token) {
      // No token → degrade to empty list (AC5)
      return [];
    }

    const firstUrl = `https://api.github.com/orgs/${encodeURIComponent(ORG)}/packages/container/${encodeURIComponent(packageName)}/versions?per_page=${PER_PAGE}`;

    let raw;
    try {
      raw = await this.#fetchAllPages(firstUrl, token);
    } catch {
      return [];
    }

    // Each version may have multiple tags — produce one ImageTag entry per tag.
    // Versions without tags (only digest) are omitted (spec edge-case: untagged → ausgelassen).
    const tags = [];
    for (const version of raw) {
      if (!version || typeof version !== 'object') continue;

      const digest = typeof version.name === 'string' ? version.name : '';
      const updatedAt = typeof version.updated_at === 'string' ? version.updated_at : '';
      const versionTags = version.metadata?.container?.tags;

      if (!Array.isArray(versionTags) || versionTags.length === 0) {
        // No tags → skip (untagged versions are not useful for the deploy dropdown)
        continue;
      }

      for (const tag of versionTags) {
        if (typeof tag === 'string' && tag.length > 0) {
          tags.push({ tag, digest, updatedAt });
        }
      }
    }

    // Sort by updatedAt descending (newest first, AC3 / Spec §6)
    tags.sort((a, b) => {
      if (a.updatedAt > b.updatedAt) return -1;
      if (a.updatedAt < b.updatedAt) return 1;
      return a.tag.localeCompare(b.tag);
    });

    return tags;
  }
}
