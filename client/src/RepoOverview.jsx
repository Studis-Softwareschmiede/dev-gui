/**
 * RepoOverview.jsx — Repo-Übersicht der lokalen Klone (AC1).
 *
 * projekt-cockpit-navigation:
 *   AC1 — Zeigt die Liste der lokalen Klone aus GET /api/workspace/repos:
 *          je Repo Name, Branch, dirty-Status, letzter Commit. Read-only.
 *          Loading-, Error- und Empty-State vorhanden.
 *   AC2 — Klick auf einen Repo-Eintrag setzt den Projekt-Kontext via navigateFactory(name).
 *
 * A11y (WCAG 2.1 AA):
 *   - <main> mit aria-label.
 *   - aria-busy / aria-live für Ladezustand.
 *   - Sichtbarer Fokusring — KEIN outline:none.
 *   - Touch-Targets ≥ 44 px für den Auswahl-Button.
 *   - Status/Dirty-Badge: Text + Farbe (Bedeutung nicht allein über Farbe).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Nur /api/workspace/repos (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *
 * @param {{
 *   navigateFactory: (repo: string | null) => void,
 * }} props
 */

import { useState, useEffect } from 'react';

/**
 * @param {{ navigateFactory: (repo: string | null) => void }} props
 */
export function RepoOverview({ navigateFactory }) {
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  const [repos, setRepos] = useState([]);

  // Load once on mount (AC1)
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch('/api/workspace/repos')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        // API returns array directly or wrapped in { repos: [...] }
        const list = Array.isArray(data) ? data : (data.repos ?? []);
        setRepos(list);
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });

    return () => { cancelled = true; };
  }, []); // mount once

  const isEmpty = loadState === 'ok' && repos.length === 0;
  const hasRepos = loadState === 'ok' && repos.length > 0;

  return (
    <main style={styles.main} aria-label="Repo-Übersicht">
      <h1 style={styles.h1}>Fabrik — Projekt wählen</h1>

      {/* Loading */}
      {loadState === 'loading' && (
        <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
          Lade lokale Repos…
        </div>
      )}

      {/* Error */}
      {loadState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden der Repos: {loadError}
        </div>
      )}

      {/* Empty */}
      {isEmpty && (
        <div role="status" style={styles.statusMsg}>
          Keine lokalen Klone gefunden.
        </div>
      )}

      {/* Repo list (AC1) */}
      {hasRepos && (
        <ul style={styles.repoList} role="list" aria-label="Lokale Repos">
          {repos.map((repo) => (
            <RepoItem
              key={repo.name}
              repo={repo}
              onSelect={() => navigateFactory(repo.name)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

// ── RepoItem ─────────────────────────────────────────────────────────────────

/**
 * Single repo row — activatable via click and keyboard (AC1 + AC2).
 *
 * @param {{
 *   repo: { name: string, branch: string, dirty: boolean, lastCommit: string },
 *   onSelect: () => void,
 * }} props
 */
function RepoItem({ repo, onSelect }) {
  const { name, branch, dirty, lastCommit } = repo;

  return (
    <li role="listitem" style={styles.repoItem}>
      <button
        type="button"
        style={styles.repoBtn}
        onClick={onSelect}
        aria-label={`Projekt ${name} öffnen`}
        data-repo={name}
      >
        {/* Repo name */}
        <span style={styles.repoName}>{name}</span>

        {/* Branch */}
        <span style={styles.repoBranch} aria-label={`Branch: ${branch ?? '—'}`}>
          {branch ?? '—'}
        </span>

        {/* Dirty badge */}
        <span
          style={dirty ? styles.dirtyBadge : styles.cleanBadge}
          aria-label={dirty ? 'Uncommittete Änderungen vorhanden' : 'Sauber'}
        >
          {dirty ? 'dirty' : 'clean'}
        </span>

        {/* Last commit */}
        <span style={styles.lastCommit} aria-label={`Letzter Commit: ${lastCommit ?? '—'}`}>
          {lastCommit ?? '—'}
        </span>
      </button>
    </li>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  h1: {
    margin: '0 0 20px',
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
    flexShrink: 0,
  },

  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
  },

  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
  },

  repoList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  repoItem: {
    // semantic list-item wrapper
  },

  repoBtn: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 1fr) auto auto minmax(120px, 1fr)',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    minHeight: 56,
    padding: '12px 20px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#d4d4d4',
    // Focus ring preserved (no outline:none — WCAG 2.1 SC 2.4.7)
  },

  repoName: {
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  repoBranch: {
    fontSize: 12,
    color: '#93c5fd',
    fontFamily: 'monospace',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: '2px 8px',
    flexShrink: 0,
  },

  dirtyBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#2a1a1a',
    color: '#fde68a',
    border: '1px solid #78350f',
    flexShrink: 0,
  },

  cleanBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#1a2a1a',
    color: '#86efac',
    border: '1px solid #14532d',
    flexShrink: 0,
  },

  lastCommit: {
    fontSize: 12,
    color: '#9ca3af',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
