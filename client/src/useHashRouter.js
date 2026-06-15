/**
 * useHashRouter.js — Lightweight client-side hash routing.
 *
 * Uses the URL hash (window.location.hash) as the routing mechanism.
 * Canonical routes:
 *   #/          → 'panel' (entry panel / home)
 *   #/github    → 'github'
 *   #/vps       → 'vps'
 *   #/cloudflare → 'cloudflare'
 *   #/factory   → 'factory' (Repo-Übersicht)
 *   #/factory/<repo> → 'factory' with activeRepo=<repo> (Projekt-Cockpit)
 *   #/settings     → 'settings'
 *   #/team         → 'team'
 *   #/deployments  → 'deployments'
 *   #/retro        → 'retro'
 *   #/retro-trend  → 'retro-trend'
 *   #/board        → 'board'
 *
 * Unknown hashes fall back to 'panel'.
 * Browser Back/Forward navigate the history (pushState-style via hash changes).
 *
 * projekt-cockpit-navigation:
 *   AC2 — #/factory/<repo> sets the active project context; reload/deep-link restores it.
 *          #/factory (no repo) shows the repo overview. useHashRouter parses both forms.
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
  'board',
]);

/**
 * Parse result from a hash string.
 *
 * @typedef {{ view: string, factoryRepo: string | null }} ParseResult
 */

/**
 * Parse a hash string into a view key and optional factory repo segment.
 *
 * Handles:
 *   '#/factory'         → { view: 'factory', factoryRepo: null }
 *   '#/factory/my-app'  → { view: 'factory', factoryRepo: 'my-app' }
 *   '#/github'          → { view: 'github',  factoryRepo: null }
 *   '' or '#/'          → { view: 'panel',   factoryRepo: null }
 *   unknown             → { view: 'panel',   factoryRepo: null }
 *
 * @param {string} hash  e.g. '#/factory/my-app' or ''
 * @returns {ParseResult}
 */
export function parseHashFull(hash) {
  if (!hash || hash === '#' || hash === '#/') {
    return { view: 'panel', factoryRepo: null };
  }
  // Strip leading '#' and optional leading '/'
  const raw = hash.replace(/^#\/?/, '');
  const lower = raw.toLowerCase();

  // Factory route with optional repo segment: factory/<repo>
  if (lower === 'factory' || lower.startsWith('factory/')) {
    const rest = raw.slice('factory'.length); // '' or '/my-app'
    const repo = rest.startsWith('/') && rest.length > 1 ? rest.slice(1) : null;
    return { view: 'factory', factoryRepo: repo };
  }

  // Standard routes
  if (VIEWS.includes(lower)) {
    return { view: lower, factoryRepo: null };
  }

  return { view: 'panel', factoryRepo: null };
}

/**
 * Parse a hash string into a view key.
 * Handles '#/factory', '#factory', and plain '' → 'panel'.
 *
 * @param {string} hash  e.g. '#/factory' or ''
 * @returns {string} one of VIEWS, defaulting to 'panel'
 */
export function parseHash(hash) {
  return parseHashFull(hash).view;
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
 * Build the canonical hash string for a factory route with an optional repo.
 *
 * @param {string | null} repo  repo name, or null for the overview
 * @returns {string} e.g. '#/factory/my-app' or '#/factory'
 */
export function factoryToHash(repo) {
  if (!repo) return '#/factory';
  return `#/factory/${repo}`;
}

/**
 * useHashRouter — returns the current view, optional factoryRepo, and navigate functions.
 *
 * @returns {{
 *   view: string,
 *   factoryRepo: string | null,
 *   navigate: (view: string) => void,
 *   navigateFactory: (repo: string | null) => void,
 * }}
 */
export function useHashRouter() {
  const [routeState, setRouteState] = useState(() => parseHashFull(window.location.hash));

  useEffect(() => {
    function handleHashChange() {
      setRouteState(parseHashFull(window.location.hash));
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  /**
   * Navigate to a standard view by pushing a new hash entry to the browser history.
   * This satisfies AC5 (deep-link) and AC6 (Browser Back/Forward).
   *
   * @param {string} target  One of VIEWS.
   */
  const navigate = useCallback((target) => {
    const hash = viewToHash(target);
    // Only push if it actually changes — avoid duplicate history entries
    if (window.location.hash !== hash) {
      window.location.hash = hash;
      // hashchange event fires automatically; setRouteState is called by the listener.
    } else {
      // Already on this hash — still sync state (e.g. programmatic same-route nav)
      setRouteState(parseHashFull(hash));
    }
  }, []);

  /**
   * Navigate to the factory view, optionally selecting a specific repo.
   * Passing null navigates back to the repo overview (#/factory).
   * Passing a repo name navigates to the project cockpit (#/factory/<repo>).
   *
   * @param {string | null} repo
   */
  const navigateFactory = useCallback((repo) => {
    const hash = factoryToHash(repo);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      setRouteState({ view: 'factory', factoryRepo: repo });
    }
  }, []);

  return {
    view: routeState.view,
    factoryRepo: routeState.factoryRepo,
    navigate,
    navigateFactory,
  };
}
