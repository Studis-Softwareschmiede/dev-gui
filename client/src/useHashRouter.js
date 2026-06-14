/**
 * useHashRouter.js — Lightweight client-side hash routing.
 *
 * Uses the URL hash (window.location.hash) as the routing mechanism.
 * Canonical routes:
 *   #/          → 'panel' (entry panel / home)
 *   #/github    → 'github'
 *   #/vps       → 'vps'
 *   #/cloudflare → 'cloudflare'
 *   #/factory   → 'factory'
 *   #/settings     → 'settings'
 *   #/team         → 'team'
 *   #/deployments  → 'deployments'
 *   #/retro        → 'retro'
 *   #/retro-trend  → 'retro-trend'
 *
 * Unknown hashes fall back to 'panel'.
 * Browser Back/Forward navigate the history (pushState-style via hash changes).
 *
 * @module useHashRouter
 */

import { useState, useEffect, useCallback } from 'react';

/** Known view keys. 'panel' is the root / home. */
export const VIEWS = /** @type {const} */ ([
  'panel',
  'github',
  'vps',
  'cloudflare',
  'factory',
  'settings',
  'team',
  'deployments',
  'retro',
  'retro-trend',
]);

/**
 * Parse a hash string into a view key.
 * Handles '#/factory', '#factory', and plain '' → 'panel'.
 *
 * @param {string} hash  e.g. '#/factory' or ''
 * @returns {string} one of VIEWS, defaulting to 'panel'
 */
export function parseHash(hash) {
  if (!hash || hash === '#' || hash === '#/') return 'panel';
  // Strip leading '#' and optional leading '/'
  const raw = hash.replace(/^#\/?/, '').toLowerCase();
  return VIEWS.includes(raw) ? raw : 'panel';
}

/**
 * Build the canonical hash string for a given view.
 *
 * @param {string} view
 * @returns {string} e.g. '#/factory'
 */
export function viewToHash(view) {
  if (view === 'panel') return '#/';
  return `#/${view}`;
}

/**
 * useHashRouter — returns the current view and a navigate function.
 *
 * @returns {{ view: string, navigate: (view: string) => void }}
 */
export function useHashRouter() {
  const [view, setView] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    function handleHashChange() {
      setView(parseHash(window.location.hash));
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  /**
   * Navigate to a view by pushing a new hash entry to the browser history.
   * This satisfies AC5 (deep-link) and AC6 (Browser Back/Forward).
   *
   * @param {string} target  One of VIEWS.
   */
  const navigate = useCallback((target) => {
    const hash = viewToHash(target);
    // Only push if it actually changes — avoid duplicate history entries
    if (window.location.hash !== hash) {
      window.location.hash = hash;
      // hashchange event fires automatically; setView is called by the listener.
    } else {
      // Already on this hash — still sync state (e.g. programmatic same-route nav)
      setView(target);
    }
  }, []);

  return { view, navigate };
}
