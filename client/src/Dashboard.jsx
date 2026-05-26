/**
 * Dashboard.jsx — Status-Dashboard component.
 *
 * Fetches GET /api/status periodically and renders one card per project
 * (name, openItems, lastCi with label+icon, previews with clickable URLs).
 *
 * Design constraints (docs/design.md):
 *   - Dark-first; UI-Sans for panels/dashboard
 *   - Status conveyed by label + icon — never color alone (WCAG 2.1 AA)
 *   - Clickable preview URL is a real focusable <a> link
 *   - 8-pt spacing scale
 *
 * Security:
 *   - No secrets in client code (security/R01)
 *   - Preview URLs go only into href (no eval / dangerouslySetInnerHTML) (security/R02)
 *   - React escapes all string renders by default
 */

import { useState, useEffect, useRef } from 'react';

/** Polling interval in ms (10 s) */
const POLL_INTERVAL_MS = 10_000;

/**
 * CI status metadata: label + icon (a11y) + color hint (supplemental only).
 * Color is never the sole indicator — label+icon carry the primary meaning.
 */
const CI_META = {
  success:     { label: 'Erfolg',      icon: '✓', color: '#4ade80' },
  failure:     { label: 'Fehlgeschlagen', icon: '✕', color: '#f87171' },
  in_progress: { label: 'Läuft',       icon: '↻', color: '#fbbf24' },
  none:        { label: 'Kein CI',     icon: '—', color: '#9ca3af' },
  unknown:     { label: 'Unbekannt',   icon: '?', color: '#9ca3af' },
};

/**
 * Preview container status metadata.
 */
const PREVIEW_META = {
  running:  { label: 'läuft',     icon: '●', color: '#4ade80' },
  stopped:  { label: 'gestoppt',  icon: '○', color: '#9ca3af' },
  unknown:  { label: 'unbekannt', icon: '?', color: '#9ca3af' },
};

/**
 * Render a CI status badge: icon + label (+ supplemental color).
 *
 * @param {{ status: string }} props
 */
function CiBadge({ status }) {
  const meta = CI_META[status] ?? CI_META.unknown;
  return (
    <span
      style={{ ...styles.badge, color: meta.color }}
      aria-label={`CI-Status: ${meta.label}`}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {' '}
      {meta.label}
    </span>
  );
}

/**
 * Render a preview container row with a clickable URL.
 *
 * @param {{ preview: { name: string, url: string, status: string } }} props
 */
function PreviewRow({ preview }) {
  const meta = PREVIEW_META[preview.status] ?? PREVIEW_META.unknown;
  // Guard: only render an <a href> for http(s) URLs (security/R02 — blocks javascript: etc.)
  const safeUrl = /^https?:\/\//i.test(preview.url ?? '') ? preview.url : null;
  return (
    <div style={styles.previewRow}>
      <span
        style={{ color: meta.color, marginRight: 6 }}
        aria-label={`Preview-Status: ${meta.label}`}
      >
        <span aria-hidden="true">{meta.icon}</span>
        {' '}
        <span>{meta.label}</span>
      </span>
      <span style={styles.previewName}>{preview.name}</span>
      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.previewLink}
        >
          {safeUrl}
        </a>
      ) : preview.url ? (
        <span style={styles.previewLink}>{preview.url}</span>
      ) : null}
    </div>
  );
}

/**
 * Single project card: name, openItems, lastCi, and previews for this project.
 *
 * @param {{ project: object, previews: Array }} props
 */
function ProjectCard({ project, previews }) {
  const { name, openItems, lastCi } = project;
  const itemsDisplay =
    openItems === 'unknown' ? 'unbekannt' : String(openItems);

  // Filter previews whose name starts with the project name (best-effort matching)
  const projectPreviews = (previews ?? []).filter(
    (p) => p.name.startsWith(name)
  );

  return (
    <article style={styles.card} aria-label={`Projekt: ${name}`}>
      <h3 style={styles.cardTitle}>{name}</h3>

      <dl style={styles.dl}>
        <dt style={styles.dt}>Offene Items</dt>
        <dd style={styles.dd}>{itemsDisplay}</dd>

        <dt style={styles.dt}>Letzter CI-Lauf</dt>
        <dd style={styles.dd}>
          <CiBadge status={lastCi} />
        </dd>
      </dl>

      {projectPreviews.length > 0 && (
        <section aria-label="Preview-Container">
          <div style={styles.previewHeader}>Preview-Container</div>
          {projectPreviews.map((p) => (
            <PreviewRow key={p.name} preview={p} />
          ))}
        </section>
      )}
    </article>
  );
}

/**
 * Dashboard — polls /api/status every POLL_INTERVAL_MS and renders project cards.
 *
 * States:
 *   loading  — initial fetch in flight (spinner shown)
 *   ok       — data rendered; refreshing indicator shown during re-fetch
 *   error    — fetch failed; stale data (if any) rendered with error notice
 *
 * @param {{ pollInterval?: number, fetchFn?: Function }} props
 *   pollInterval — override for tests (default: POLL_INTERVAL_MS)
 *   fetchFn      — override for tests (default: global fetch)
 */
export function Dashboard({ pollInterval = POLL_INTERVAL_MS, fetchFn }) {
  const [data, setData]           = useState(null);   // { projects, previews }
  const [loadState, setLoadState] = useState('loading'); // 'loading'|'ok'|'error'
  const [refreshing, setRefreshing] = useState(false);

  // Use a ref so the effect closure always sees the current fetchFn without
  // re-registering the interval on every render.
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  useEffect(() => {
    let cancelled = false;

    async function doFetch() {
      if (!cancelled) setRefreshing(true);
      try {
        const res = await fetchFnRef.current('/api/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setLoadState('ok');
        }
      } catch {
        if (!cancelled) {
          // Keep stale data; switch to error state
          setLoadState('error');
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }

    // Initial fetch
    doFetch();

    // Periodic refresh
    const timer = setInterval(doFetch, pollInterval);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  return (
    <aside style={styles.panel} aria-label="Fabrik-Status">
      <header style={styles.panelHeader}>
        <span style={styles.panelTitle}>Status</span>
        {refreshing && (
          <span
            role="status"
            aria-live="polite"
            aria-label="Aktualisiert…"
            style={styles.refreshIndicator}
          >
            ↻
          </span>
        )}
      </header>

      {loadState === 'loading' && !data && (
        <div role="status" aria-live="polite" style={styles.notice}>
          Lade…
        </div>
      )}

      {loadState === 'error' && (
        <div role="alert" style={styles.errorNotice}>
          {data ? 'Aktualisierung fehlgeschlagen — veraltete Daten.' : 'Fehler beim Laden.'}
        </div>
      )}

      {data && (
        <div style={styles.cardList}>
          {(data.projects ?? []).map((project) => (
            <ProjectCard
              key={project.name}
              project={project}
              previews={data.previews}
            />
          ))}
          {(data.projects ?? []).length === 0 && (
            <div style={styles.notice}>Keine Projekte.</div>
          )}
        </div>
      )}
    </aside>
  );
}

// ── Styles (inline, dark-first, 8-pt scale) ──────────────────────────────────

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    background: '#111',
    borderLeft: '1px solid #2a2a2a',
    minWidth: 280,
    maxWidth: 340,
    overflowY: 'auto',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    color: '#d4d4d4',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    borderBottom: '1px solid #2a2a2a',
    background: '#0d0d0d',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  panelTitle: {
    fontWeight: 600,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#9ca3af',
  },
  refreshIndicator: {
    color: '#fbbf24',
    fontSize: 14,
    display: 'inline-block',
    animation: 'spin 1s linear infinite',
    // display:'inline-block' is required: transform (rotate) has no effect on
    // display:'inline' elements. @keyframes spin is defined in client/index.html.
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  card: {
    padding: '12px 16px',
    borderBottom: '1px solid #1e1e1e',
  },
  cardTitle: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 600,
    color: '#e5e7eb',
    wordBreak: 'break-all',
  },
  dl: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '4px 12px',
    margin: '0 0 8px',
  },
  dt: {
    color: '#9ca3af',
    whiteSpace: 'nowrap',
    fontSize: 12,
    alignSelf: 'center',
  },
  dd: {
    margin: 0,
    fontSize: 13,
  },
  badge: {
    fontWeight: 500,
  },
  previewHeader: {
    color: '#9ca3af',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 4,
  },
  previewRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '2px 8px',
    fontSize: 12,
    marginBottom: 4,
  },
  previewName: {
    color: '#9ca3af',
    fontFamily: 'monospace',
  },
  previewLink: {
    color: '#60a5fa',
    textDecoration: 'underline',
    wordBreak: 'break-all',
    // Ensure sufficient contrast (blue on dark bg ≥ 4.5:1)
  },
  notice: {
    padding: '16px',
    color: '#9ca3af',
    fontSize: 12,
  },
  errorNotice: {
    padding: '8px 16px',
    color: '#f87171',
    background: '#1f0f0f',
    borderBottom: '1px solid #3f1010',
    fontSize: 12,
  },
};
