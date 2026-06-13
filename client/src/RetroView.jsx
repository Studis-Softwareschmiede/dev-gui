/**
 * RetroView.jsx — Retro-Ansicht: Self-Improvement-Historie der Fabrik (retro/train/teamLeader).
 *
 * retro-view-frontend:
 *   AC1  — Einstieg über markanten „Retro"-Link im TeamView-Kopfbereich (dort implementiert).
 *   AC2  — Route `retro` (in useHashRouter + AppShell registriert); Deep-Link #/retro.
 *   AC3  — Browser-Back/Forward via Hash-Router (geerbt aus app-shell-navigation).
 *   AC4  — Lädt GET /api/retro/runs genau einmal beim Mount; aria-busy/aria-live Ladezustand;
 *           Lauf-Liste absteigend nach Datum; je Eintrag: Datum, Lauf-Name (Slug), Quelle-Badge,
 *           Zähler aus counts. Tastatur-navigierbar; aktiver Eintrag trägt aria-current.
 *   AC5  — Auswahl (Maus oder Tastatur) → GET /api/retro/runs/:slug → Detail-Pane mit
 *           drei Sektionen Agenten/Skills/Knowledge; je Eintrag Regel, Status-Badge, Provenance;
 *           Lauf-Ebene: statusMix. Sektionen ohne Einträge werden weggelassen.
 *   AC6  — metric != null → rate_per_100ep, baseline → neu, Status;
 *           metric == null → erkennbarer Platzhalter „— noch keine Messdaten", kein Crash.
 *   AC7  — Leere runs-Liste → erkennbarer Hinweis; kein leerer Bildschirm; kein Crash.
 *   AC8  — Fetch-Fehler → erkennbare Fehlermeldung; Shell bleibt bedienbar.
 *   AC9  — A11y WCAG 2.1 AA: semantische Liste/Landmark, sichtbare Fokusringe (kein outline:none),
 *           Touch-Targets ≥ 44 px, aria-current, Tastatur Enter/Space, Badges mit Text (Bedeutung
 *           nicht allein über Farbe).
 *   AC10 — Zwei Spalten Desktop / gestapelt schmal; Dark-Theme konsistent zu TeamView.
 *   AC11 — Keine Secrets im Bundle; nur /api/retro/* aufgerufen; kein dangerouslySetInnerHTML/
 *           innerHTML; keine externe Bibliothek; Regel-Text als React-Elemente.
 *
 * A11y (WCAG 2.1 AA):
 *   - Semantische Navigationsliste mit aria-label.
 *   - Sichtbarer Fokusring — KEIN outline:none (Coder-Lesson 2026-05-27).
 *   - Touch-Targets ≥ 44 px für Listeneinträge.
 *   - aria-busy / aria-live Ladezustand.
 *   - aria-current auf aktivem Eintrag.
 *   - Quelle-Badges + Status-Badges mit Text (Bedeutung nicht allein über Farbe).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/retro/* Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *   - Keine neue externe Bibliothek.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ── RetroView ─────────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function RetroView({ onNavigate: _onNavigate }) {
  // reserved: Rückkehr/Navigation läuft aktuell über die NavBar — onNavigate ist für
  // zukünftige programmatische Navigation reserviert, wird hier noch nicht aktiv genutzt.

  // ── State: runs overview
  const [runsState, setRunsState]   = useState('idle');   // 'idle'|'loading'|'ok'|'error'
  const [runsError, setRunsError]   = useState('');
  const [runs, setRuns]             = useState([]);

  // ── State: selected run and its report
  const [selectedSlug, setSelectedSlug]   = useState(null);
  const [reportState, setReportState]     = useState('idle');  // 'idle'|'loading'|'ok'|'error'
  const [reportError, setReportError]     = useState('');
  const [report, setReport]               = useState(null);

  // ── Load overview on mount exactly once — AC4
  useEffect(() => {
    let cancelled = false;
    setRunsState('loading');
    setRunsError('');

    fetch('/api/retro/runs')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs ?? []);
        setRunsState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setRunsError(err.message || 'Netzwerkfehler');
        setRunsState('error');
      });

    return () => { cancelled = true; };
  }, []); // empty deps = mount once

  // ── Stale-response guard for loadReport — generation counter prevents an older,
  // slower fetch from overwriting the result of a newer selection (race condition).
  // Each call to loadReport increments the counter; only the matching generation
  // is allowed to write state.
  const reportGenRef = useRef(0);

  // ── Load report on selection — AC5
  // Stale-response guard: if the user selects a second run before the first fetch
  // resolves, the earlier response is silently dropped — only the most-recently-
  // selected run's data is written to state.
  const loadReport = useCallback((slug) => {
    const myGen = ++reportGenRef.current;

    setSelectedSlug(slug);
    setReportState('loading');
    setReportError('');
    setReport(null);

    fetch(`/api/retro/runs/${slug}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        // Drop stale responses from superseded selections
        if (myGen !== reportGenRef.current) return;
        setReport(data);
        setReportState('ok');
      })
      .catch((err) => {
        if (myGen !== reportGenRef.current) return;
        setReportError(err.message || 'Netzwerkfehler');
        setReportState('error');
      });
  }, []);

  // ── Derived: empty state (AC7)
  const isEmpty = runsState === 'ok' && runs.length === 0;

  // ── Render
  return (
    <main style={styles.main} aria-label="Retro-Ansicht">
      <h1 style={styles.h1}>Retro</h1>

      {/* Loading state — accessible (AC4) */}
      {runsState === 'loading' && (
        <div
          aria-busy="true"
          aria-live="polite"
          style={styles.statusMsg}
        >
          Lade Retro-Läufe…
        </div>
      )}

      {/* Error state for overview load (AC8) */}
      {runsState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden der Retro-Läufe: {runsError}
        </div>
      )}

      {/* Empty state (AC7) */}
      {isEmpty && (
        <div style={styles.statusMsg} role="status">
          Noch keine Self-Improvement-Läufe vorhanden.
        </div>
      )}

      {/* Master-Detail layout (AC4–AC5, AC10) */}
      {runsState === 'ok' && !isEmpty && (
        <div style={styles.layout}>
          {/* ── Master: runs list ── */}
          <nav style={styles.nav} aria-label="Retro-Läufe">
            <ul style={styles.list} role="list">
              {runs.map((run) => (
                <RunItem
                  key={run.slug}
                  run={run}
                  isActive={selectedSlug === run.slug}
                  onSelect={loadReport}
                />
              ))}
            </ul>
          </nav>

          {/* ── Detail pane ── */}
          <div style={styles.detail} aria-label="Report-Pane">
            {/* No selection yet */}
            {selectedSlug === null && (
              <p style={styles.hintMsg}>
                Wähle einen Lauf aus der Liste aus.
              </p>
            )}

            {/* Report loading */}
            {reportState === 'loading' && (
              <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
                Lade Report…
              </div>
            )}

            {/* Report error (AC8) */}
            {reportState === 'error' && (
              <div role="alert" style={styles.errorMsg}>
                Fehler beim Laden des Reports: {reportError}
              </div>
            )}

            {/* Report content (AC5, AC6) */}
            {reportState === 'ok' && report && (
              <ReportPane report={report} />
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ── RunItem ───────────────────────────────────────────────────────────────────

/**
 * Single run list item in the master navigation list.
 * Shows date, slug (name), source badge, and counts.
 * Activatable by click and keyboard (Enter/Space) — AC4, AC9.
 *
 * @param {{
 *   run: { slug: string, date: string, source: string, counts: object, statusMix: object },
 *   isActive: boolean,
 *   onSelect: (slug: string) => void
 * }} props
 */
function RunItem({ run, isActive, onSelect }) {
  function activate() {
    onSelect(run.slug);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }

  const counts = run.counts ?? {};
  const countParts = [];
  if (counts.agents)    countParts.push(`${counts.agents} Agent${counts.agents !== 1 ? 'en' : ''}`);
  if (counts.skills)    countParts.push(`${counts.skills} Skill${counts.skills !== 1 ? 's' : ''}`);
  if (counts.knowledge) countParts.push(`${counts.knowledge} Knowledge`);

  return (
    <li style={styles.listItem} role="listitem">
      <button
        type="button"
        style={{
          ...styles.runButton,
          ...(isActive ? styles.runButtonActive : {}),
        }}
        aria-current={isActive ? 'page' : undefined}
        onClick={activate}
        onKeyDown={handleKeyDown}
        data-slug={run.slug}
      >
        {/* Date */}
        <span style={styles.runDate}>{run.date || '—'}</span>

        {/* Slug / name */}
        <span style={styles.runSlug}>{run.slug}</span>

        {/* Source badge — text label (Bedeutung nicht allein über Farbe, AC9) */}
        <SourceBadge source={run.source} />

        {/* Counts */}
        {countParts.length > 0 && (
          <span style={styles.runCounts} aria-label="Einträge">
            {countParts.join(' · ')}
          </span>
        )}
      </button>
    </li>
  );
}

// ── SourceBadge ───────────────────────────────────────────────────────────────

/**
 * Badge for the run source (retro / train / teamLeader / other).
 * Always shows a text label (Bedeutung nicht allein über Farbe — AC9).
 *
 * @param {{ source: string }} props
 */
function SourceBadge({ source }) {
  const label = source || 'other';
  const badgeStyle = SOURCE_BADGE_STYLES[label] ?? SOURCE_BADGE_STYLES.other;
  return (
    <span style={{ ...styles.sourceBadge, ...badgeStyle }} aria-label={`Quelle: ${label}`}>
      {label}
    </span>
  );
}

const SOURCE_BADGE_STYLES = {
  retro:      { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
  train:      { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  teamLeader: { background: '#2a1a2a', color: '#d8b4fe', borderColor: '#581c87' },
  other:      { background: '#2a2a1a', color: '#fde68a', borderColor: '#78350f' },
};

// ── StatusBadge ───────────────────────────────────────────────────────────────

/**
 * Badge for an entry's status.
 * Always shows a text label (Bedeutung nicht allein über Farbe — AC9).
 *
 * @param {{ status: string }} props
 */
function StatusBadge({ status }) {
  const label = status || '—';
  const badgeStyle = STATUS_BADGE_STYLES[label] ?? STATUS_BADGE_STYLES._default;
  return (
    <span style={{ ...styles.statusBadge, ...badgeStyle }} aria-label={`Status: ${label}`}>
      {label}
    </span>
  );
}

const STATUS_BADGE_STYLES = {
  Applied:   { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  Pending:   { background: '#2a2a1a', color: '#fde68a', borderColor: '#78350f' },
  Skipped:   { background: '#2a2a2a', color: '#9ca3af', borderColor: '#4b5563' },
  Rejected:  { background: '#2a1a1a', color: '#f87171', borderColor: '#7f1d1d' },
  _default:  { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
};

// ── ReportPane ────────────────────────────────────────────────────────────────

/**
 * Detail pane: shows the full retro report for one run.
 * Sections: Agenten / Skills / Knowledge — empty sections omitted (AC5).
 * Each entry: Regel, Status-Badge, Provenance, Metrik (or placeholder) (AC5, AC6).
 * StatusMix on run level (AC5).
 *
 * @param {{ report: object }} props
 */
function ReportPane({ report }) {
  const { slug, date, source, statusMix, agents, skills, knowledge } = report;

  const sections = [
    { key: 'agents',    label: 'Agenten',   entries: agents    ?? [] },
    { key: 'skills',    label: 'Skills',    entries: skills    ?? [] },
    { key: 'knowledge', label: 'Knowledge', entries: knowledge ?? [] },
  ].filter((s) => s.entries.length > 0); // AC5: omit empty sections

  return (
    <article style={styles.article}>
      {/* Run header */}
      <h2 style={styles.reportTitle}>Retro-Report</h2>

      {/* Run metadata */}
      <div style={styles.metaRow} aria-label="Lauf-Metadaten">
        <span style={styles.metaItem}>{date || '—'}</span>
        <SourceBadge source={source} />
        <span style={styles.metaItem} aria-label="Slug">{slug}</span>
      </div>

      {/* StatusMix on run level (AC5) */}
      {statusMix && Object.keys(statusMix).length > 0 && (
        <div style={styles.statusMixRow} aria-label="Status-Mix">
          {Object.entries(statusMix).map(([st, count]) => (
            <span key={st} style={styles.statusMixItem}>
              <StatusBadge status={st} />
              <span style={styles.statusMixCount} aria-label={`${count} mal`}>×{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Three sections: Agenten / Skills / Knowledge (AC5) */}
      {sections.map((sec) => (
        <section key={sec.key} aria-label={sec.label} style={styles.reportSection}>
          <h3 style={styles.sectionHeading}>{sec.label.toUpperCase()}</h3>
          <ul style={styles.entryList} role="list">
            {sec.entries.map((entry, idx) => (
              <EntryItem key={`${sec.key}-${entry.id ?? idx}`} entry={entry} />
            ))}
          </ul>
        </section>
      ))}

      {/* No sections at all — shouldn't happen due to filter, but guard anyway */}
      {sections.length === 0 && (
        <p style={styles.hintMsg}>Keine Einträge in diesem Lauf.</p>
      )}
    </article>
  );
}

// ── EntryItem ─────────────────────────────────────────────────────────────────

/**
 * Single entry in a report section.
 * Shows: Regel (rule), Status-Badge, Provenance, Metrik or placeholder (AC5, AC6).
 *
 * @param {{ entry: { id, rule, status, provenance, metric } }} props
 */
function EntryItem({ entry }) {
  const { rule, status, provenance, metric } = entry;

  return (
    <li style={styles.entryItem} role="listitem">
      {/* Rule text — as text node, no dangerouslySetInnerHTML (AC11) */}
      <p style={styles.ruleText}>{rule || '—'}</p>

      {/* Badges row */}
      <div style={styles.entryBadgeRow}>
        <StatusBadge status={status} />
        {provenance && (
          <span style={styles.provenanceBadge} aria-label={`Quelle: ${provenance}`}>
            {provenance}
          </span>
        )}
      </div>

      {/* Metric (AC6) */}
      {metric !== null && metric !== undefined ? (
        <div style={styles.metricRow} aria-label="Metrik">
          <span style={styles.metricItem}>
            <span style={styles.metricLabel}>Rate: </span>
            {metric.rate_per_100ep != null ? `${metric.rate_per_100ep}/100ep` : '—'}
          </span>
          <span style={styles.metricItem}>
            <span style={styles.metricLabel}>Baseline → neu: </span>
            {metric.baseline != null ? String(metric.baseline) : '—'}
            {' → '}
            {metric.neu != null ? String(metric.neu) : '—'}
          </span>
          {metric.status && (
            <StatusBadge status={metric.status} />
          )}
        </div>
      ) : (
        /* Phase 0 placeholder (AC6) — erkennbarer Platzhalter, kein leeres Feld */
        <p style={styles.metricPlaceholder} aria-label="Keine Messdaten">
          — noch keine Messdaten
        </p>
      )}
    </li>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Main landmark
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  h1: {
    margin: '0 0 16px',
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
    flexShrink: 0,
  },

  // ── Status / hint messages
  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
  },
  hintMsg: {
    color: '#9ca3af',
    fontSize: 14,
    margin: 0,
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

  // ── Master-Detail layout — CSS grid (same pattern as TeamView, AC10)
  // CSS grid: each column track is bounded by the container; minHeight:0 + overflowY:'auto'
  // on each column lets them scroll independently without blowing out the container.
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, 280px) minmax(0, 1fr)',
    gap: 16,
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },

  // ── Navigation (master / left column)
  nav: {
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    padding: '12px 8px',
    border: '1px solid #2a2a2a',
  },

  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },

  listItem: {
    margin: '2px 0',
  },

  // Run button — Touch-Target ≥ 44px (AC9); focus ring preserved (no outline:none)
  runButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    width: '100%',
    minHeight: 44,
    padding: '10px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
    // Focus ring visible — no outline:none (coder lesson 2026-05-27)
  },
  runButtonActive: {
    background: '#1e293b',
    color: '#f0f9ff',
  },

  runDate: {
    fontSize: 11,
    color: '#9ca3af',
    fontFamily: 'monospace',
  },

  runSlug: {
    fontSize: 12,
    color: '#e5e7eb',
    wordBreak: 'break-all',
  },

  runCounts: {
    fontSize: 11,
    color: '#6b7280',
  },

  // ── Source badge (AC9 — text label, not just colour)
  sourceBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 10,
    border: '1px solid',
  },

  // ── Status badge (AC9 — text label)
  statusBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    borderRadius: 10,
    border: '1px solid',
  },

  // ── Detail pane (right column)
  detail: {
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    padding: '16px 20px',
    border: '1px solid #2a2a2a',
  },

  article: {
    color: '#e5e7eb',
  },

  reportTitle: {
    margin: '0 0 12px',
    fontSize: 20,
    fontWeight: 700,
    color: '#e5e7eb',
  },

  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },

  metaItem: {
    fontSize: 13,
    color: '#9ca3af',
    fontFamily: 'monospace',
  },

  // StatusMix row (AC5)
  statusMixRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: '1px solid #2a2a2a',
  },

  statusMixItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },

  statusMixCount: {
    fontSize: 12,
    color: '#9ca3af',
  },

  // ── Report sections
  reportSection: {
    marginBottom: 20,
  },

  sectionHeading: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#9ca3af',
    margin: '0 0 8px',
    textTransform: 'uppercase',
  },

  entryList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },

  entryItem: {
    padding: '10px 0',
    borderBottom: '1px solid #2a2a2a',
  },

  // Rule text — plain text node (AC11: no dangerouslySetInnerHTML)
  ruleText: {
    margin: '0 0 6px',
    fontSize: 13,
    color: '#e5e7eb',
    lineHeight: 1.5,
  },

  entryBadgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },

  provenanceBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    borderRadius: 10,
    background: '#1e293b',
    color: '#9ca3af',
    border: '1px solid #334155',
  },

  // Metric display (AC6)
  metricRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    marginTop: 4,
  },

  metricItem: {
    fontSize: 12,
    color: '#9ca3af',
  },

  metricLabel: {
    color: '#6b7280',
    fontSize: 11,
  },

  // Phase-0 placeholder (AC6 — erkennbarer Platzhalter, kein leeres Feld)
  metricPlaceholder: {
    margin: '4px 0 0',
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
  },
};
