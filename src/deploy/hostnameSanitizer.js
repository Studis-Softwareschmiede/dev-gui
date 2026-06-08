/**
 * hostnameSanitizer — shared hostname validation helper for the deploy boundary.
 *
 * Centralises the DNS-charset check that is used by both VpsDockerControl
 * (for the container label) and DeployOrchestrator (for the cloudflare route).
 *
 * @module deploy/hostnameSanitizer
 */

/**
 * Validates a hostname against the DNS character set.
 * Allows: a-z A-Z 0-9 . - _ (RFC 1123 + underscores for local names).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isValidHostname(hostname) {
  return typeof hostname === 'string' && hostname.length > 0 && /^[a-zA-Z0-9._-]+$/.test(hostname);
}
