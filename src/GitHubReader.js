/**
 * GitHubReader — reads Org repos + per-repo open-issue count + last CI run.
 *
 * Architecture boundary: the ONLY place that touches the GitHub API.
 *
 * Design:
 *   - Token is injectable: `tokenProvider` is a function () => string|Promise<string>.
 *     In production server.js ALWAYS injects the App-Token-Provider (AC5), so the
 *     App identity covers reads too.
 *   - The env-GH_TOKEN default has been REMOVED (S-149, AC9): the constructor no
 *     longer falls back to `process.env.GH_TOKEN`. Without an injected `tokenProvider`,
 *     the reader resolves no token and degrades gracefully to "unknown"/empty list
 *     (AC10). The env-GH_TOKEN minted by `ensure-gh-auth.sh` for the gh-CLI remains
 *     unaffected — the reader simply no longer reads it (AC6/§8).
 *   - Every external fetch has a timeout (js/R03).
 *   - Token is NEVER included in responses, logs, or errors (security/R01).
 *   - Repo names come from the GitHub API list (not user input) — no SSRF (security/R05).
 *
 * @module GitHubReader
 */

/** Org to list repos from. */
const ORG = 'Studis-Softwareschmiede';

/** Repos to exclude from the status list. */
const EXCLUDED_REPOS = new Set(['agent-flow', 'dev-gui']);

/** Default fetch timeout in ms. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Map GitHub Actions workflow conclusion/status → canonical value.
 *
 * @param {string|null|undefined} conclusion
 * @param {string|null|undefined} status
 * @returns {'success'|'failure'|'in_progress'|'none'}
 */
function mapCiStatus(conclusion, status) {
  if (status === 'in_progress' || status === 'queued') return 'in_progress';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') return 'failure';
  return 'none';
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
 * GitHubReader reads project metadata live from the GitHub REST API.
 *
 * @param {object} [options]
 * @param {() => string|Promise<string>} [options.tokenProvider]
 *   Async or sync function that returns a GitHub token.
 *   In production, `server.js` always injects the App-Token-Provider (S-146 AC5).
 *   Without an injected provider, the reader resolves no token and degrades
 *   gracefully (S-149 AC9/AC10) — it does NOT fall back to process.env.GH_TOKEN.
 * @param {typeof fetch} [options.fetchFn]
 *   Injectable fetch implementation (default: global fetch).
 */
export class GitHubReader {
  #tokenProvider;
  #fetch;

  constructor({ tokenProvider, fetchFn } = {}) {
    // AC9 (S-149): NO process.env.GH_TOKEN fallback. Without an injected tokenProvider,
    // the reader resolves undefined and degrades gracefully (AC10). The env-GH_TOKEN
    // minted by ensure-gh-auth.sh for the gh-CLI is intentionally NOT read here.
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
      // Token goes in Authorization header only — never in URL, never logged
      h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  /**
   * Fetch the raw org repos list from GitHub API.
   * Returns an empty array on error (AC4 graceful degradation).
   *
   * @param {string|undefined} token
   * @returns {Promise<Array<{name:string, full_name:string, visibility:string, html_url:string}>>}
   */
  async #fetchOrgRepos(token) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(ORG)}/repos?per_page=100&sort=full_name`;
    let res;
    try {
      res = await this.#fetch(url, { headers: this.#headers(token) });
    } catch {
      return [];
    }
    if (!res.ok) return [];
    let data;
    try {
      data = await res.json();
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && typeof r.name === 'string');
  }

  /**
   * List all repos in the org, excluding agent-flow and dev-gui.
   * Returns an empty array on error (AC4 graceful degradation).
   *
   * @param {string|undefined} token
   * @returns {Promise<string[]>} repo names
   */
  async #listRepos(token) {
    const raw = await this.#fetchOrgRepos(token);
    return raw
      .map((r) => r.name)
      .filter((name) => !EXCLUDED_REPOS.has(name));
  }

  /**
   * Fetch open issue count for one repo (true issues only, PRs excluded).
   * Returns 'unknown' on error (AC4).
   *
   * Uses the Search API (`is:issue`) so pull requests are never counted.
   * The issues list endpoint (`/repos/{org}/{repo}/issues`) includes PRs
   * because GitHub models PRs as issues — the Search API does not.
   *
   * @param {string} repo
   * @param {string|undefined} token
   * @returns {Promise<number|'unknown'>}
   */
  async #openItems(repo, token) {
    // Search API: `is:issue` excludes PRs; `per_page=1` minimises data transfer.
    const q = encodeURIComponent(`repo:${ORG}/${repo} is:issue is:open`);
    const url = `https://api.github.com/search/issues?q=${q}&per_page=1`;
    let res;
    try {
      res = await this.#fetch(url, { headers: this.#headers(token) });
    } catch {
      return 'unknown';
    }
    if (!res.ok) return 'unknown';
    let data;
    try {
      data = await res.json();
    } catch {
      return 'unknown';
    }
    return typeof data?.total_count === 'number' ? data.total_count : 'unknown';
  }

  /**
   * Fetch the last CI run status for one repo.
   * Returns 'unknown' on error, 'none' if no runs exist (AC4).
   *
   * @param {string} repo
   * @param {string|undefined} token
   * @returns {Promise<'success'|'failure'|'in_progress'|'none'|'unknown'>}
   */
  async #lastCi(repo, token) {
    const url = `https://api.github.com/repos/${encodeURIComponent(ORG)}/${encodeURIComponent(repo)}/actions/runs?per_page=1`;
    let res;
    try {
      res = await this.#fetch(url, { headers: this.#headers(token) });
    } catch {
      return 'unknown';
    }
    if (res.status === 404) return 'none'; // Actions not enabled / no runs
    if (!res.ok) return 'unknown';
    let data;
    try {
      data = await res.json();
    } catch {
      return 'unknown';
    }
    const runs = data?.workflow_runs;
    if (!Array.isArray(runs) || runs.length === 0) return 'none';
    const run = runs[0];
    return mapCiStatus(run.conclusion, run.status);
  }

  /**
   * Aggregate all project data.
   *
   * Returns an array of `{ name, openItems, lastCi }`.
   * - If GitHub is unreachable / no token: returns projects with
   *   `openItems: 'unknown'` and `lastCi: 'unknown'` (AC4).
   * - If a single repo's fetch fails, only that repo is affected.
   *
   * @returns {Promise<Array<{name:string, openItems:number|'unknown', lastCi:string}>>}
   */
  async getProjects() {
    const token = await this.#resolveToken();

    // Without token, degrade: return empty list with unknown values for repos
    // (we can't list repos without auth for private orgs)
    const repos = await this.#listRepos(token);
    if (repos.length === 0) {
      // Could be auth issue or empty org — return empty array (AC4: no crash)
      return [];
    }

    // Fetch openItems + lastCi in parallel per repo (AC4: each independently degrades)
    const results = await Promise.all(
      repos.map(async (name) => {
        const [openItems, lastCi] = await Promise.all([
          this.#openItems(name, token),
          this.#lastCi(name, token),
        ]);
        return { name, openItems, lastCi };
      }),
    );
    return results;
  }

  /**
   * List all org repos for the GitHub-Repos overview (AC1, AC2 — github-repos-overview spec).
   *
   * Unlike `getProjects()`, this method:
   *   - Includes ALL repos (no exclusions — not agent-flow, not dev-gui).
   *   - Returns the full Repo-Overview shape: `{ name, fullName, visibility, openIssues, lastCi, htmlUrl }`.
   *
   * Graceful degradation (AC6):
   *   - If repo list is unreachable → returns `[]` (no crash).
   *   - Per-repo `openIssues` or `lastCi` failure → field degrades to `'unknown'`.
   *
   * Token is NEVER included in any returned field (security/R01).
   *
   * @returns {Promise<Array<{
   *   name: string,
   *   fullName: string,
   *   visibility: 'private'|'public',
   *   openIssues: number|'unknown',
   *   lastCi: 'success'|'failure'|'in_progress'|'none'|'unknown',
   *   htmlUrl: string
   * }>>}
   */
  async listRepos() {
    const token = await this.#resolveToken();

    // Fetch raw org repos (includes all repos — no exclusions for this endpoint)
    const rawRepos = await this.#fetchOrgRepos(token);
    if (rawRepos.length === 0) {
      // Auth issue or empty org — return empty array (AC6: no crash)
      return [];
    }

    // Fetch openIssues + lastCi in parallel per repo (AC6: each independently degrades)
    const results = await Promise.all(
      rawRepos.map(async (r) => {
        const name = r.name;
        const fullName = typeof r.full_name === 'string' ? r.full_name : `${ORG}/${name}`;
        // GitHub API returns 'public' or 'private' in visibility field
        const visibility = r.visibility === 'public' ? 'public' : 'private';
        const htmlUrl = typeof r.html_url === 'string' ? r.html_url : `https://github.com/${fullName}`;

        const [openIssues, lastCi] = await Promise.all([
          this.#openItems(name, token),
          this.#lastCi(name, token),
        ]);

        return { name, fullName, visibility, openIssues, lastCi, htmlUrl };
      }),
    );
    return results;
  }
}
