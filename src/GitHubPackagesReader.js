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
   * List all container packages of the org.
   *
   * Returns ImagePackage[] sorted alphabetically by name.
   * Degrades to empty array on error (AC5).
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
      // No token → cannot authenticate → degrade to empty list (AC5)
      return [];
    }

    const firstUrl = `https://api.github.com/orgs/${encodeURIComponent(ORG)}/packages?package_type=container&per_page=${PER_PAGE}`;

    let raw;
    try {
      raw = await this.#fetchAllPages(firstUrl, token);
    } catch {
      return [];
    }

    const org = ORG.toLowerCase();
    const packages = raw
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        name: p.name,
        fullImageRef: `ghcr.io/${org}/${p.name.toLowerCase()}`,
        visibility: ['public', 'private', 'internal'].includes(p.visibility)
          ? p.visibility
          : 'private',
        htmlUrl: typeof p.html_url === 'string' ? p.html_url : `https://github.com/orgs/${ORG}/packages/container/${encodeURIComponent(p.name)}/versions`,
        updatedAt: typeof p.updated_at === 'string' ? p.updated_at : '',
      }));

    // Sort alphabetically by name (AC2 / Spec §6)
    packages.sort((a, b) => a.name.localeCompare(b.name));

    return packages;
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
