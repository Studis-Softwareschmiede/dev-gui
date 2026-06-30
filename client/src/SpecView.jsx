/**
 * SpecView.jsx — Reiter „Spezifikation" im Cockpit (AC4, AC5, AC6 — projekt-spezifikation-anzeige).
 *
 * AC4 — Reiter „Spezifikation" im geöffneten Projekt:
 *        Links Navigation (Schicht-Gruppen: Konzept / Architektur / Specs / README),
 *        rechts gerendertes Markdown (markdownLite.jsx).
 *        Ladezustand (aria-busy) beim Nachladen einer Datei.
 *
 * AC5 — Über die openSpec-Prop (vom CockpitView übergeben) kann ein externer Aufrufer
 *        (z.B. BoardView beim Klick auf einen Spec-Bezug) eine Datei direkt öffnen.
 *        SpecView stellt das über den useImperativeHandle-ähnlichen Mechanismus bereit:
 *        CockpitView setzt activeSpecPath als State und übergibt es als Prop.
 *
 * AC6 — Filter nach Doku-Typ (Konzept/Architektur/Spec/README) + Spec-Status
 *        (draft/active/superseded). Mehrfachauswahl konsistent zum Board-Filter-Muster:
 *        Checkboxen in einem kleinen FilterBar-Element.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/board/projects/:slug/docs Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *   - Markdown via vorhandenen markdownLite-Renderer (kein fremder Parser).
 *
 * A11y (WCAG 2.1 AA):
 *   - Navigation als <nav> mit aria-label.
 *   - Aktives Dokument mit aria-current="page".
 *   - Ladezustand aria-busy auf dem Inhalts-Container.
 *   - Fokusring nie unterdrückt.
 *   - Touch-Targets ≥ 44 px für Nav-Buttons.
 *
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 * }} props
 *   projectSlug   — Slug des aktiven Projekts (aus CockpitView/BoardAggregator)
 *   initialPath   — optional: direkt zu öffnende Datei (AC5, z.B. via Story-Klick)
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { MarkdownLite } from './markdownLite.jsx';

// ── Typ-Konstanten ─────────────────────────────────────────────────────────────

/** Alle Doku-Typen (AC6 Filter). */
const ALL_DOC_TYPES = ['readme', 'konzept', 'architektur', 'spec'];

/** Lesbare Label je Typ. */
const TYPE_LABELS = {
  readme:      'README',
  konzept:     'Konzept',
  architektur: 'Architektur',
  spec:        'Spec',
};

/** Alle Spec-Status-Werte (AC6 Filter). */
const ALL_SPEC_STATUSES = ['draft', 'active', 'superseded'];

// ── SpecView ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 * }} props
 */
export function SpecView({ projectSlug, initialPath }) {
  // ── Doku-Struktur (Navigation) ─────────────────────────────────────────────
  const [docsState, setDocsState] = useState('idle');  // 'idle'|'loading'|'ok'|'error'
  const [docsError, setDocsError] = useState('');
  /** @type {[import('./SpecView.jsx').DocEntry[], Function]} */
  const [docs, setDocs] = useState([]);

  // ── Aktives Dokument ───────────────────────────────────────────────────────
  const [activePath, setActivePath] = useState(initialPath ?? null);
  const [contentState, setContentState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [contentError, setContentError] = useState('');
  const [content, setContent] = useState('');

  // ── Filter-State (AC6) ────────────────────────────────────────────────────
  /** @type {[Set<string>, Function]} */
  const [filterTypes, setFilterTypes]     = useState(() => new Set(ALL_DOC_TYPES));
  /** @type {[Set<string>, Function]} */
  const [filterStatuses, setFilterStatuses] = useState(() => new Set(ALL_SPEC_STATUSES));

  // ── Doku-Struktur laden (beim Mount + wenn Slug wechselt) ─────────────────
  useEffect(() => {
    if (!projectSlug) return;

    let cancelled = false;
    setDocsState('loading');
    setDocsError('');
    setDocs([]);

    fetch(`/api/board/projects/${encodeURIComponent(projectSlug)}/docs`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setDocs(data.docs ?? []);
        setDocsState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setDocsError(err.message || 'Netzwerkfehler');
        setDocsState('error');
      });

    return () => { cancelled = true; };
  }, [projectSlug]);

  // ── initialPath-Prop-Änderung → aktivieren (AC5) ──────────────────────────
  useEffect(() => {
    if (initialPath) {
      setActivePath(initialPath);
    }
  }, [initialPath]);

  // ── Dateiinhalt laden wenn activePath wechselt ────────────────────────────
  useEffect(() => {
    if (!activePath || !projectSlug) return;

    let cancelled = false;
    setContentState('loading');
    setContentError('');
    setContent('');

    const url = `/api/board/projects/${encodeURIComponent(projectSlug)}/docs/raw?path=${encodeURIComponent(activePath)}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setContentState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setContentError(err.message || 'Netzwerkfehler');
        setContentState('error');
      });

    return () => { cancelled = true; };
  }, [activePath, projectSlug]);

  // ── Filter-Logik (AC6) ────────────────────────────────────────────────────
  const filteredDocs = useMemo(() => {
    return docs.filter((d) => {
      // Typ-Filter
      if (!filterTypes.has(d.type)) return false;
      // Status-Filter: nur bei Specs; andere Typen werden nicht nach Status gefiltert
      if (d.type === 'spec' && d.status) {
        if (!filterStatuses.has(d.status)) return false;
      }
      return true;
    });
  }, [docs, filterTypes, filterStatuses]);

  // Gruppierung nach Typ (für Navigation)
  const groupedDocs = useMemo(() => {
    /** @type {Record<string, typeof filteredDocs>} */
    const groups = { readme: [], konzept: [], architektur: [], spec: [] };
    for (const d of filteredDocs) {
      if (groups[d.type]) groups[d.type].push(d);
    }
    return groups;
  }, [filteredDocs]);

  // ── Callback: Dokument öffnen ─────────────────────────────────────────────
  const handleSelect = useCallback((path) => {
    setActivePath(path);
  }, []);

  // ── Filter-Toggle-Callbacks ────────────────────────────────────────────────
  const toggleType = useCallback((type) => {
    setFilterTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) { next.delete(type); } else { next.add(type); }
      return next;
    });
  }, []);

  const toggleStatus = useCallback((status) => {
    setFilterStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) { next.delete(status); } else { next.add(status); }
      return next;
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Linke Spalte: Filter + Navigation */}
      <div style={styles.sidebar}>
        {/* Filter (AC6) */}
        <SpecFilterBar
          filterTypes={filterTypes}
          filterStatuses={filterStatuses}
          onToggleType={toggleType}
          onToggleStatus={toggleStatus}
        />

        {/* Navigations-Baum */}
        <nav style={styles.nav} aria-label="Dokument-Navigation">
          {docsState === 'loading' && (
            <div style={styles.navHint} aria-busy="true" aria-live="polite">
              Lade Dokument-Liste…
            </div>
          )}
          {docsState === 'error' && (
            <div style={styles.navError} role="alert">
              Fehler: {docsError}
            </div>
          )}
          {docsState === 'ok' && filteredDocs.length === 0 && (
            <div style={styles.navHint} role="status">
              Keine Dokumente gefunden.
            </div>
          )}
          {docsState === 'ok' && filteredDocs.length > 0 && (
            <>
              {ALL_DOC_TYPES.filter((t) => filterTypes.has(t) && groupedDocs[t]?.length > 0).map((type) => (
                <NavGroup
                  key={type}
                  label={TYPE_LABELS[type]}
                  entries={groupedDocs[type]}
                  activePath={activePath}
                  onSelect={handleSelect}
                />
              ))}
            </>
          )}
        </nav>
      </div>

      {/* Rechte Spalte: Markdown-Inhalt */}
      <div
        style={styles.content}
        aria-busy={contentState === 'loading'}
        aria-live="polite"
      >
        {!activePath && (
          <div style={styles.contentHint} role="status">
            Dokument aus der Navigation auswählen.
          </div>
        )}
        {activePath && contentState === 'loading' && (
          <div style={styles.contentHint} aria-busy="true">
            Lade Dokument…
          </div>
        )}
        {activePath && contentState === 'error' && (
          <div style={styles.contentError} role="alert">
            Fehler beim Laden: {contentError}
          </div>
        )}
        {activePath && contentState === 'ok' && (
          <div style={styles.markdownWrapper}>
            <MarkdownLite markdown={content} style={styles.markdown} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── NavGroup ──────────────────────────────────────────────────────────────────

/**
 * Eine Gruppe von Navigations-Einträgen einer Schicht.
 *
 * @param {{
 *   label: string,
 *   entries: Array<{ path: string, title: string, type: string, status: string|null }>,
 *   activePath: string|null,
 *   onSelect: (path: string) => void,
 * }} props
 */
function NavGroup({ label, entries, activePath, onSelect }) {
  return (
    <div style={styles.navGroup}>
      <div style={styles.navGroupLabel} aria-hidden="true">{label}</div>
      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          style={{
            ...styles.navBtn,
            ...(activePath === entry.path ? styles.navBtnActive : {}),
          }}
          aria-current={activePath === entry.path ? 'page' : undefined}
          onClick={() => onSelect(entry.path)}
          title={entry.path}
        >
          <span style={styles.navBtnTitle}>{entry.title}</span>
          {entry.type === 'spec' && entry.status && (
            <span
              style={{
                ...styles.statusChip,
                ...(STATUS_CHIP_STYLES[entry.status] ?? STATUS_CHIP_STYLES._default),
              }}
              aria-label={`Status: ${entry.status}`}
            >
              {entry.status}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── SpecFilterBar (AC6) ───────────────────────────────────────────────────────

/**
 * Filter-Leiste: Doku-Typ (Mehrfachauswahl) + Spec-Status (Mehrfachauswahl).
 * Konsistent zum Board-Filter-Muster (Checkbox-Gruppen, kein Dropdown).
 *
 * @param {{
 *   filterTypes: Set<string>,
 *   filterStatuses: Set<string>,
 *   onToggleType: (type: string) => void,
 *   onToggleStatus: (status: string) => void,
 * }} props
 */
function SpecFilterBar({ filterTypes, filterStatuses, onToggleType, onToggleStatus }) {
  return (
    <div style={styles.filterBar} role="search" aria-label="Doku-Filter">
      {/* Typ-Filter */}
      <fieldset style={styles.filterFieldset}>
        <legend style={styles.filterLegend}>Typ</legend>
        <div style={styles.filterCheckboxRow}>
          {ALL_DOC_TYPES.map((type) => {
            const checked = filterTypes.has(type);
            const id = `spec-filter-type-${type}`;
            return (
              <label key={type} style={styles.filterCheckboxLabel} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleType(type)}
                  aria-label={`Typ ${TYPE_LABELS[type]} ${checked ? 'aktiv' : 'inaktiv'}`}
                  style={styles.filterCheckbox}
                />
                {TYPE_LABELS[type]}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Status-Filter (nur relevant für Specs) */}
      <fieldset style={styles.filterFieldset}>
        <legend style={styles.filterLegend}>Spec-Status</legend>
        <div style={styles.filterCheckboxRow}>
          {ALL_SPEC_STATUSES.map((status) => {
            const checked = filterStatuses.has(status);
            const id = `spec-filter-status-${status}`;
            return (
              <label key={status} style={styles.filterCheckboxLabel} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleStatus(status)}
                  aria-label={`Spec-Status ${status} ${checked ? 'aktiv' : 'inaktiv'}`}
                  style={styles.filterCheckbox}
                />
                {status}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

// ── Status-Chip-Styles ─────────────────────────────────────────────────────────

const STATUS_CHIP_STYLES = {
  draft:      { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
  active:     { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  superseded: { background: '#2a2a2a', color: '#6b7280', borderColor: '#374151' },
  _default:   { background: '#2a2a2a', color: '#9ca3af', borderColor: '#4b5563' },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  container: {
    display: 'grid',
    gridTemplateColumns: '260px minmax(0, 1fr)',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },

  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #2a2a2a',
    background: '#111',
    overflowY: 'auto',
    minHeight: 0,
  },

  nav: {
    flex: 1,
    padding: '8px 0',
  },

  navGroup: {
    marginBottom: 4,
  },

  navGroupLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#4b5563',
    padding: '8px 14px 4px',
    textTransform: 'uppercase',
  },

  navBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: '#9ca3af',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 14px',
    textAlign: 'left',
    minHeight: 44,
    borderRadius: 0,
    // Focus ring preserved (no outline:none)
  },

  navBtnActive: {
    background: '#1a2a3a',
    color: '#93c5fd',
  },

  navBtnTitle: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },

  navHint: {
    fontSize: 12,
    color: '#4b5563',
    padding: '16px 14px',
    fontStyle: 'italic',
  },

  navError: {
    fontSize: 12,
    color: '#f87171',
    padding: '12px 14px',
  },

  // ── Status-Chip in Navleiste ──
  statusChip: {
    fontSize: 9,
    padding: '1px 5px',
    borderRadius: 8,
    border: '1px solid',
    flexShrink: 0,
    fontWeight: 600,
    letterSpacing: '0.02em',
  },

  // ── Inhalt-Spalte ──
  content: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  contentHint: {
    fontSize: 14,
    color: '#4b5563',
    padding: '32px 24px',
    fontStyle: 'italic',
  },

  contentError: {
    fontSize: 13,
    color: '#f87171',
    padding: '16px 24px',
    background: '#2a1a1a',
    border: '1px solid #7f1d1d',
    margin: '16px 24px',
    borderRadius: 6,
  },

  markdownWrapper: {
    padding: '24px 32px',
    maxWidth: 860,
  },

  markdown: {
    fontSize: 14,
    lineHeight: 1.7,
    color: '#e5e7eb',
  },

  // ── Filter-Leiste (AC6) ──
  filterBar: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  filterFieldset: {
    border: 'none',
    margin: 0,
    padding: 0,
  },

  filterLegend: {
    fontSize: 10,
    fontWeight: 700,
    color: '#4b5563',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  filterCheckboxRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
  },

  filterCheckboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#9ca3af',
    cursor: 'pointer',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA / design.md)
  },

  filterCheckbox: {
    accentColor: '#93c5fd',
    cursor: 'pointer',
  },
};
