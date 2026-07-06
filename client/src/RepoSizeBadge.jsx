/**
 * RepoSizeBadge.jsx — Repo-Größen-Badge je Projekt-Karte (docs/specs/repo-size-badge.md
 * AC9, AC10, AC11).
 *
 * Eigenständige, additive Komponente für die Fabrik-Übersicht (`RepoOverview.jsx` —
 * `RepoItem`), analog zum bestehenden Badge-Muster (`NightWatchStatusBadge.jsx`,
 * `ClaudeAuthBadge.jsx`): eigenes Laden über einen injizierbaren `fetchFn`, kein
 * Umbau der bestehenden Karten-Struktur. Sitzt als GESCHWISTER des Auswahl-Buttons
 * (siehe `RepoItem` in `RepoOverview.jsx`) — nicht darin verschachtelt, weil das
 * Badge eine eigene interaktive „Aktualisieren"-Aktion trägt.
 *
 * AC9 — menschenlesbares Gesamt-Größen-Badge (MB/GB) mit letztem bekanntem Wert +
 *   Alter (relativ im Text, absoluter Zeitstempel im `title`-Tooltip). Nie
 *   vermessen → neutraler Platzhalter „noch nicht vermessen". Ladefehler blockieren
 *   das Karten-Rendern NIE (graceful degradation — analog `ClaudeAuthBadge`, aber
 *   hier bleibt bei Fehler der Platzhalter sichtbar statt die Badge zu verbergen,
 *   weil AC9 explizit "blockiert das Rendern nie" fordert, nicht "verschwindet").
 *
 * AC10 — Aufschlüsselung (Arbeitsstand | .git | Abhängigkeiten/Artefakte, Summe =
 *   Gesamt) als <details>/<summary> (nativ tastaturbedienbar, kein eigenes
 *   Tooltip-Widget nötig). Eigene „Aktualisieren"-Aktion ruft
 *   `POST /api/workspace/repo-sizes/refresh` (Body `{ repo }`) und spiegelt
 *   „läuft…"/„aktualisiert"-Zustand. Nach erfolgreichem Trigger pollt die
 *   Komponente den Read-Endpunkt kurz nach, um den frischen Wert zu übernehmen
 *   (best-effort — der Read-Endpunkt liefert ohnehin immer den letzten bekannten
 *   Wert, AC4/AC6 sind Backend-Garantien).
 *
 * AC11 — bei `gitWarning: true` zusätzlicher dezenter, TEXTLICHER Warnhinweis
 *   (`role="note"`, eigener Text — nie nur Farbe), ohne eigene Aktion/Push.
 *
 * Datenquelle: `GET /api/workspace/repo-sizes?repo=<slug>` (S-297/S-298, Backend
 * bereits fertig). Alle Größen kommen in Bytes — Formatierung menschenlesbar hier
 * im Frontend (AC9/AC10: "Zahlen textlich, nicht nur farblich").
 *
 * Graceful degradation: Netzwerkfehler/unerwartete Antwortform beim initialen
 * Laden → Badge zeigt den neutralen "noch nicht vermessen"-Platzhalter (kein
 * Crash, kein Blockieren des Karten-Renderns — AC9).
 *
 * Security (Floor): keine Secrets/Host-Pfade — nur Byte-Zähler + ISO-Zeitstempel
 * + Slug, die der Read-Endpunkt selbst schon secret-frei liefert.
 *
 * A11y (WCAG 2.1 AA): Badge-Text trägt die volle Bedeutung (Farbe nie einzige
 * Quelle); `title` liefert den absoluten Zeitstempel als natives Tooltip;
 * <details>/<summary> nativ tastaturbedienbar; Aktualisieren-Button beschriftet
 * (`aria-label`) und meldet den "läuft"/"aktualisiert"-Zustand über sichtbaren Text.
 *
 * @param {{ repo: string, fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Formatiert eine Byte-Zahl menschenlesbar (AC9/AC10 — "Zahlen textlich").
 * @param {unknown} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (n <= 0) return '0 B';
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const value = n / Math.pow(1024, exp);
  const decimals = exp === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[exp]}`;
}

/**
 * Relatives Alter in groben, menschenlesbaren Schritten (AC9 — "Alter, relativ").
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatRelativeAge(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'gerade eben';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} h`;
  const days = Math.floor(hours / 24);
  return `vor ${days} d`;
}

/**
 * Absoluter, lokal formatierter Zeitstempel für das `title`-Tooltip (AC9).
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatAbsolute(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

async function fetchRepoSize(fetchFn, repo) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn(`/api/workspace/repo-sizes?repo=${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postRefresh(fetchFn, repo) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/workspace/repo-sizes/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function RepoSizeBadge({ repo, fetchFn }) {
  // null = noch nicht geladen/nie vermessen → neutraler Platzhalter (AC9)
  const [size, setSize] = useState(null);
  const [refreshState, setRefreshState] = useState('idle'); // 'idle'|'running'|'done'
  const doneTimerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchRepoSize(fetchFn, repo);
      const entry = Array.isArray(data?.sizes) ? data.sizes[0] : null;
      setSize(entry ?? null);
    } catch {
      // Graceful degradation (AC9): Ladefehler blockiert das Rendern nie —
      // Platzhalter bleibt sichtbar (kein Crash, keine leere Karte).
      setSize(null);
    }
  }, [fetchFn, repo]);

  useEffect(() => {
    load();
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, [load]);

  const handleRefresh = useCallback(async (e) => {
    e.stopPropagation(); // nie den Karten-Auswahl-Klick der <li> auslösen
    if (refreshState === 'running') return;
    setRefreshState('running');
    try {
      await postRefresh(fetchFn, repo);
      // Best-effort Nachpoll: der Backend-Scan läuft asynchron im Hintergrund;
      // ein einzelner Nachlade-Versuch übernimmt den Wert, falls er inzwischen
      // fertig ist (AC10 "spiegelt ... aktualisiert-Zustand"). Der Read-Endpunkt
      // selbst bleibt jederzeit sofort verfügbar (AC4/AC6, Backend-Garantie).
      await load();
    } catch {
      // Fehler beim Anstoßen: kein Crash, letzter bekannter Wert bleibt sichtbar.
    } finally {
      setRefreshState('done');
      doneTimerRef.current = setTimeout(() => setRefreshState('idle'), 2000);
    }
  }, [fetchFn, repo, refreshState, load]);

  const hasMeasurement = size && typeof size.total === 'number' && size.measuredAt;

  if (!hasMeasurement) {
    return (
      <div style={styles.wrapper}>
        <span style={styles.placeholder}>Größe: noch nicht vermessen</span>
        <RefreshButton state={refreshState} onRefresh={handleRefresh} />
      </div>
    );
  }

  const totalText = formatBytes(size.total);
  const relAge = formatRelativeAge(size.measuredAt);
  const absAge = formatAbsolute(size.measuredAt);
  const label = relAge ? `Größe: ${totalText} (${relAge})` : `Größe: ${totalText}`;

  return (
    <div style={styles.wrapper}>
      <details style={styles.details}>
        <summary style={styles.summary} title={absAge}>
          {label}
        </summary>
        <div style={styles.breakdown} role="group" aria-label="Größen-Aufschlüsselung">
          <div>Arbeitsstand: {formatBytes(size.workspace)}</div>
          <div>.git: {formatBytes(size.git)}</div>
          <div>Abhängigkeiten/Artefakte: {formatBytes(size.artifacts)}</div>
          <div style={styles.sum}>Summe = Gesamt: {formatBytes(size.total)}</div>
        </div>
      </details>

      <RefreshButton state={refreshState} onRefresh={handleRefresh} />

      {/* AC11: dezenter, textlicher Warnhinweis bei gitWarning — keine Aktion/Push */}
      {size.gitWarning && (
        <span role="note" style={styles.warning}>
          Hinweis: .git-Verzeichnis ungewöhnlich groß
        </span>
      )}
    </div>
  );
}

/**
 * Pro-Karte-„Aktualisieren"-Aktion (AC10) — eigene Komponente, damit
 * `handleRefresh` in `RepoSizeBadge` die Zustandslogik zentral hält.
 *
 * @param {{ state: 'idle'|'running'|'done', onRefresh: (e: Event) => void }} props
 */
function RefreshButton({ state, onRefresh }) {
  const text = state === 'running' ? 'Aktualisiert läuft…' : state === 'done' ? 'Aktualisiert' : 'Aktualisieren';
  return (
    <button
      type="button"
      style={styles.refreshBtn}
      onClick={onRefresh}
      disabled={state === 'running'}
      aria-label={`Größe von diesem Projekt neu messen — ${text}`}
    >
      {text}
    </button>
  );
}

const styles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    padding: '2px 20px 6px',
    fontSize: 12,
    color: '#9ca3af',
  },

  placeholder: {
    fontStyle: 'italic',
  },

  details: {
    display: 'inline-block',
  },

  summary: {
    cursor: 'pointer',
    color: '#93c5fd',
    fontFamily: 'monospace',
    listStyle: 'none',
  },

  breakdown: {
    marginTop: 4,
    marginLeft: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    color: '#d4d4d4',
  },

  sum: {
    marginTop: 2,
    fontWeight: 600,
    color: '#e5e7eb',
  },

  refreshBtn: {
    background: 'transparent',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 24,
  },

  warning: {
    color: '#fde68a',
    fontWeight: 600,
  },
};
