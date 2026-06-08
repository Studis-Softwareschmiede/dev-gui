/**
 * LockoutGuard — Self-Lockout-Hard-Block (ADR-011).
 *
 * Architecture boundary: the ONLY place that defines "protected" for Cloudflare
 * mutations. Every mutating Cloudflare path calls isProtected(target) BEFORE
 * any API call, audit, or confirm check.
 *
 * Protected targets:
 *   (a) The devgui hostname itself — from env DEVGUI_HOSTNAME (O2 DECIDED).
 *   (b) Any Cloudflare Access wall hostname — configurable allowlist of
 *       protected hostnames/suffixes.
 *
 * Fail-closed: if config is missing or target is ambiguous → protected = true.
 * This deliberately prefers false-negative (blocking a legitimate deletion)
 * over false-positive (self-lockout).
 *
 * No network/IO — pure function/class (ADR-011).
 *
 * @module LockoutGuard
 */

/**
 * Default Cloudflare Access wall hostname patterns.
 *
 * These hostnames are used by Cloudflare Access to authenticate users.
 * They must never be deleted or mutated (would break Access authentication).
 *
 * Additional patterns can be injected via the constructor.
 */
const DEFAULT_ACCESS_WALL_PATTERNS = [
  // Cloudflare Access authentication endpoints
  /\.cloudflareaccess\.com$/i,
];

// ── LockoutGuard ──────────────────────────────────────────────────────────────

export class LockoutGuard {
  /** @type {string|null} Own devgui hostname (from DEVGUI_HOSTNAME env) */
  #devguiHostname;

  /** @type {Array<string|RegExp>} Additional protected hostnames or suffix patterns */
  #protectedPatterns;

  /**
   * @param {object} [options]
   * @param {string} [options.devguiHostname]
   *   The devgui hostname (e.g. "devgui.example.com").
   *   Defaults to process.env.DEVGUI_HOSTNAME.
   *   If absent → fail-closed for any target that cannot be definitively
   *   classified as non-devgui.
   * @param {Array<string|RegExp>} [options.protectedPatterns]
   *   Additional hostname strings (exact match) or RegExp patterns (suffix/pattern)
   *   that should always be treated as protected.
   *   Defaults to DEFAULT_ACCESS_WALL_PATTERNS.
   */
  constructor({ devguiHostname, protectedPatterns } = {}) {
    // Resolve devgui hostname from options or env
    const raw = devguiHostname ?? process.env.DEVGUI_HOSTNAME ?? '';
    this.#devguiHostname = raw.trim() || null;

    // Merge default Access wall patterns with any injected extras
    this.#protectedPatterns = [
      ...DEFAULT_ACCESS_WALL_PATTERNS,
      ...(protectedPatterns ?? []),
    ];
  }

  /**
   * Returns true if the target hostname/route should be treated as protected
   * (i.e. no mutation allowed).
   *
   * Protected = (a) matches own devgui hostname, OR
   *             (b) matches a Cloudflare Access wall pattern.
   *
   * Fail-closed: returns true (protected) when:
   *   - DEVGUI_HOSTNAME is not configured (cannot exclude "could be own hostname")
   *   - target is null/undefined/empty
   *
   * @param {string|null|undefined} target - Hostname to check (e.g. "app.example.com")
   * @returns {boolean} true if protected, false if safe to mutate
   */
  isProtected(target) {
    // Fail-closed: empty/missing target → treat as protected
    if (!target || typeof target !== 'string') {
      return true;
    }

    const normalised = target.trim().toLowerCase();

    // Fail-closed: empty after trim → protected
    if (!normalised) {
      return true;
    }

    // (a) Check against own devgui hostname
    if (this.#devguiHostname === null) {
      // DEVGUI_HOSTNAME not configured → fail-closed: any target might be
      // the devgui route, so treat everything as potentially protected.
      // We still check Access wall patterns below to be precise when that is
      // the reason (the caller only needs to know: protected or not).
      return true;
    }

    const devguiNormalised = this.#devguiHostname.toLowerCase();
    if (normalised === devguiNormalised) {
      return true;
    }

    // (b) Check against Cloudflare Access wall patterns
    for (const pattern of this.#protectedPatterns) {
      if (typeof pattern === 'string') {
        if (normalised === pattern.toLowerCase()) {
          return true;
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(normalised)) {
          return true;
        }
      }
    }

    return false;
  }
}
