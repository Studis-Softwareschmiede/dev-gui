/**
 * BoardView.jsx — Board-Aggregator Übersichts-View: Projekt → Feature → Story.
 *
 * dev-gui-board-aggregator:
 *   AC4  — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten
 *           (To Do / In Progress / Blocked / In Review / Done), aggregiert über
 *           alle gescannten Projekte. Lädt GET /api/board/projects beim Mount.
 *           Ladezustand (aria-busy/aria-live); Fehlerzustand; Leerzustand.
 *   AC5  — Rollup-Anzeige je Feature: vorhandenes progress-Feld nutzen; fehlt/stale
 *           → read-only aus Kind-Story-Status berechnet (done = 'done'-Stories).
 *   AC6  — Filter nach Projekt, Story-Status und Label (alle unabhängig kombinierbar).
 *          Status-Filter: Mehrfachauswahl per Checkbox-Gruppe (leere Auswahl = alle sichtbar).
 *
 * Story-Status-Lebenszyklus (board-subsystem §9.3):
 *   To Do | In Progress | Blocked | In Review | Done
 *
 * A11y (WCAG 2.1 AA):
 *   - <main> mit aria-label.
 *   - aria-busy / aria-live für Ladezustand.
 *   - Sichtbarer Fokusring — KEIN outline:none (coder lesson 2026-05-27).
 *   - Touch-Targets ≥ 44 px für interaktive Elemente.
 *   - Bedeutung nicht allein über Farbe (Status-Badges mit Text).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/board/* Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useMemo, useCallback } from 'react';

// ── Status-Lebensyklus (board-subsystem §9.3) ─────────────────────────────────

/** Canonical story-status lifecycle values. */
const STATUS_LIFECYCLE = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done'];

/**
 * "Done" story-statuses for rollup calculation (AC5).
 * 'done' is a defensive fallback for non-canonical backend values.
 */
const DONE_STATUSES = new Set(['Done', 'done']);

// ── Rollup helper ─────────────────────────────────────────────────────────────

/**
 * Compute display-rollup for a feature (AC5).
 *
 * If `feature.progress` is a non-null object with numeric `done` and `total`,
 * use it directly. Otherwise compute read-only from child story statuses.
 *
 * @param {{ progress?: unknown, stories: Array<{status: string}> }} feature
 * @returns {{ done: number, total: number }}
 */
function computeRollup(feature) {
  const p = feature.progress;
  if (
    p != null &&
    typeof p === 'object' &&
    typeof p.done === 'number' &&
    typeof p.total === 'number'
  ) {
    return { done: p.done, total: p.total };
  }
  // Fallback: compute from child stories (read-only, no file writes — AC7)
  const stories = Array.isArray(feature.stories) ? feature.stories : [];
  const total = stories.length;
  const done = stories.filter((s) => DONE_STATUSES.has(s.status)).length;
  return { done, total };
}

// ── BoardView ─────────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function BoardView({ onNavigate: _onNavigate }) {
  // ── Data state
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  const [projects, setProjects] = useState([]);

  // ── Filter state (AC6)
  const [filterProject, setFilterProject] = useState('');    // '' = alle
  const [filterStatus, setFilterStatus]   = useState(new Set()); // empty Set = alle sichtbar
  const [filterLabel, setFilterLabel]     = useState('');    // '' = alle (free-text)

  // ── Load once on mount (AC4)
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch('/api/board/projects')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects ?? []);
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });

    return () => { cancelled = true; };
  }, []); // mount once

  // ── Derived: project options for filter dropdown (AC6)
  const projectOptions = useMemo(() => {
    return projects
      .filter((p) => !p.error)
      .map((p) => p.slug || p.project_slug || p.repo_path || '?')
      .filter(Boolean);
  }, [projects]);

  // ── Derived: all label options for filter dropdown (AC6)
  const labelOptions = useMemo(() => {
    const labels = new Set();
    for (const project of projects) {
      if (project.error) continue;
      for (const feature of project.features ?? []) {
        for (const story of feature.stories ?? []) {
          for (const lbl of story.labels ?? []) {
            if (lbl) labels.add(lbl);
          }
        }
      }
    }
    return Array.from(labels).sort();
  }, [projects]);

  // ── Derived: filtered view (AC6)
  const filteredProjects = useMemo(() => {
    return projects
      .filter((p) => {
        if (!filterProject) return true;
        const slug = p.slug || p.project_slug || p.repo_path || '';
        return slug === filterProject;
      })
      .map((p) => {
        if (p.error) return p;
        // Filter features whose stories pass the status/label filter
        const filteredFeatures = (p.features ?? []).map((f) => {
          const filteredStories = (f.stories ?? []).filter((s) => {
            // Multi-select status: empty Set = alle; non-empty = status must be in Set
            if (filterStatus.size > 0 && !filterStatus.has(s.status)) return false;
            if (filterLabel && !(s.labels ?? []).includes(filterLabel)) return false;
            return true;
          });
          return { ...f, stories: filteredStories };
        });
        return { ...p, features: filteredFeatures };
      });
  }, [projects, filterProject, filterStatus, filterLabel]);

  // Total stories after status/label filtering — used to detect "filter eliminates all stories"
  const totalFilteredStories = useMemo(() => {
    return filteredProjects.reduce(
      (acc, p) =>
        acc +
        (p.features ?? []).reduce((a, f) => a + (f.stories ?? []).length, 0),
      0,
    );
  }, [filteredProjects]);

  const isEmpty = loadState === 'ok' && projects.length === 0;
  const hasProjects = loadState === 'ok' && projects.length > 0;

  return (
    <main style={styles.main} aria-label="Board-Übersicht">
      <h1 style={styles.h1}>Board</h1>

      {/* ── Filter bar (AC6) — only shown when data is loaded */}
      {hasProjects && (
        <FilterBar
          projects={projectOptions}
          statusOptions={STATUS_LIFECYCLE}
          labelOptions={labelOptions}
          filterProject={filterProject}
          filterStatus={filterStatus}
          filterLabel={filterLabel}
          onProjectChange={setFilterProject}
          onStatusChange={setFilterStatus}
          onLabelChange={setFilterLabel}
        />
      )}


      {/* ── Loading */}
      {loadState === 'loading' && (
        <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
          Lade Board-Daten…
        </div>
      )}

      {/* ── Error */}
      {loadState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden der Board-Daten: {loadError}
        </div>
      )}

      {/* ── Empty */}
      {isEmpty && (
        <div role="status" style={styles.statusMsg}>
          Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
        </div>
      )}

      {/* ── Project list (AC4) */}
      {hasProjects && (
        <div style={styles.projectList} role="list" aria-label="Projekte">
          {filteredProjects.map((project) => (
            <ProjectSection
              key={project.slug ?? project.repo_path ?? project.project_slug}
              project={project}
            />
          ))}
          {filteredProjects.length === 0 && (filterProject || filterStatus.size > 0 || filterLabel) && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte / Stories passen zum aktuellen Filter.
            </div>
          )}
          {filteredProjects.length > 0 && totalFilteredStories === 0 && (filterStatus.size > 0 || filterLabel) && (
            <div role="status" style={styles.statusMsg}>
              Keine Stories passen zum aktiven Filter.
            </div>
          )}
        </div>
      )}
    </main>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

/**
 * Filter controls for Projekt, Story-Status (multi-select checkboxes) and Label (AC6).
 *
 * @param {{
 *   projects: string[],
 *   statusOptions: string[],
 *   labelOptions: string[],
 *   filterProject: string,
 *   filterStatus: Set<string>,
 *   filterLabel: string,
 *   onProjectChange: (v: string) => void,
 *   onStatusChange: (v: Set<string>) => void,
 *   onLabelChange: (v: string) => void,
 * }} props
 */
function FilterBar({
  projects,
  statusOptions,
  labelOptions,
  filterProject,
  filterStatus,
  filterLabel,
  onProjectChange,
  onStatusChange,
  onLabelChange,
}) {
  /** Toggle a status value in the Set. */
  function handleStatusToggle(status) {
    const next = new Set(filterStatus);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }
    onStatusChange(next);
  }

  const anyFilterActive = filterProject || filterStatus.size > 0 || filterLabel;

  return (
    <div style={styles.filterBar} role="search" aria-label="Board-Filter">
      {/* Projekt filter */}
      <label style={styles.filterLabel} htmlFor="board-filter-project">
        Projekt
      </label>
      <select
        id="board-filter-project"
        style={styles.filterSelect}
        value={filterProject}
        onChange={(e) => onProjectChange(e.target.value)}
        aria-label="Nach Projekt filtern"
      >
        <option value="">Alle Projekte</option>
        {projects.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      {/* Status filter — Mehrfachauswahl per Checkbox-Gruppe (AC6) */}
      <fieldset style={styles.filterFieldset} id="board-filter-status-group" aria-label="Nach Status filtern">
        <legend style={styles.filterLabel}>Status</legend>
        <div style={styles.statusCheckboxRow}>
          {statusOptions.map((s) => {
            const checked = filterStatus.has(s);
            const inputId = `board-filter-status-${s.replace(/\s+/g, '-').toLowerCase()}`;
            return (
              <label key={s} style={styles.statusCheckboxLabel} htmlFor={inputId}>
                <input
                  id={inputId}
                  type="checkbox"
                  style={styles.statusCheckbox}
                  checked={checked}
                  onChange={() => handleStatusToggle(s)}
                  aria-label={`Status ${s} ${checked ? 'aktiv' : 'inaktiv'}`}
                />
                {s}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Label filter */}
      <label style={styles.filterLabel} htmlFor="board-filter-label">
        Label
      </label>
      <select
        id="board-filter-label"
        style={styles.filterSelect}
        value={filterLabel}
        onChange={(e) => onLabelChange(e.target.value)}
        aria-label="Nach Label filtern"
      >
        <option value="">Alle Labels</option>
        {labelOptions.map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      {/* Reset */}
      {anyFilterActive && (
        <button
          type="button"
          style={styles.filterReset}
          onClick={() => {
            onProjectChange('');
            onStatusChange(new Set());
            onLabelChange('');
          }}
          aria-label="Filter zurücksetzen"
        >
          Zurücksetzen
        </button>
      )}
    </div>
  );
}

// ── ProjectSection ────────────────────────────────────────────────────────────

/**
 * One project block: header + list of features (AC4).
 * If the project has an error, renders an error badge (AC8).
 *
 * @param {{ project: object }} props
 */
function ProjectSection({ project }) {
  const slug = project.slug || project.project_slug || project.repo_path || '?';

  return (
    <section
      role="listitem"
      style={styles.projectSection}
      aria-label={`Projekt: ${slug}`}
      data-project={slug}
    >
      {/* Project header */}
      <div style={styles.projectHeader}>
        <h2 style={styles.projectTitle}>{slug}</h2>
        {project.error && (
          <span style={styles.errorBadge} role="status" aria-label="Fehler">
            Fehler: {project.error}
          </span>
        )}
        {project.repo_path && (
          <span style={styles.repoBadge} aria-label="Repo-Pfad">
            {project.repo_path}
          </span>
        )}
      </div>

      {/* Features */}
      {!project.error && (project.features ?? []).length === 0 && (
        <p style={styles.hintMsg}>Keine Features in diesem Projekt.</p>
      )}

      {!project.error && (project.features ?? []).map((feature) => (
        <FeatureRow
          key={feature.id}
          feature={feature}
        />
      ))}
    </section>
  );
}

// ── FeatureRow ────────────────────────────────────────────────────────────────

/**
 * One feature row: title, rollup bar (AC5), then stories in status columns (AC4).
 * Klick auf den Feature-Titel öffnet/schliesst das Detail-Panel (goal, DoD, …).
 *
 * @param {{ feature: object }} props
 */
function FeatureRow({ feature }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const rollup = computeRollup(feature);
  const stories = Array.isArray(feature.stories) ? feature.stories : [];

  // Group stories by status column (AC4)
  const byStatus = {};
  for (const s of STATUS_LIFECYCLE) {
    byStatus[s] = [];
  }
  for (const story of stories) {
    const key = story.status && byStatus[story.status] !== undefined
      ? story.status
      : null;
    if (key) {
      byStatus[key].push(story);
    } else {
      // Stories with unknown status go to 'To Do' bucket
      byStatus['To Do'].push(story);
    }
  }

  const handleTitleClick = useCallback(() => {
    setDetailOpen((prev) => !prev);
  }, []);

  return (
    <div
      style={styles.featureRow}
      data-feature={feature.id}
      aria-label={`Feature: ${feature.title || feature.id}`}
    >
      {/* Feature header */}
      <div style={styles.featureHeader}>
        {/* Clickable title — toggles detail panel */}
        <button
          type="button"
          style={styles.featureTitleBtn}
          onClick={handleTitleClick}
          aria-expanded={detailOpen}
          aria-controls={detailOpen ? `feature-detail-${feature.id}` : undefined}
          data-testid={`feature-title-btn-${feature.id}`}
        >
          <span style={styles.featureTitleChevron} aria-hidden="true">
            {detailOpen ? '▾' : '▸'}
          </span>
          {feature.title || feature.id}
        </button>
        {feature.status && (
          <StatusBadge status={feature.status} />
        )}
        {/* Rollup bar (AC5) */}
        <RollupBar done={rollup.done} total={rollup.total} />
      </div>

      {/* Feature detail panel — shown when expanded */}
      {detailOpen && (
        <div
          id={`feature-detail-${feature.id}`}
          style={styles.featureDetail}
          data-testid={`feature-detail-${feature.id}`}
          aria-label={`Details für Feature: ${feature.title || feature.id}`}
        >
          <FeatureDetailPanel feature={feature} />
        </div>
      )}

      {/* Status columns (AC4) */}
      {stories.length > 0 && (
        <div style={styles.statusColumns} role="list" aria-label="Stories nach Status">
          {STATUS_LIFECYCLE.map((status) => (
            <StatusColumn
              key={status}
              status={status}
              stories={byStatus[status]}
            />
          ))}
        </div>
      )}

      {stories.length === 0 && (
        <p style={styles.hintMsg}>Keine Stories in diesem Feature.</p>
      )}
    </div>
  );
}

// ── FeatureDetailPanel ────────────────────────────────────────────────────────

/**
 * Detail panel for a feature — shows goal, definition_of_done, priority, depends, labels.
 * Fields that are null/empty are omitted (dezent ausgeblendet).
 *
 * @param {{ feature: object }} props
 */
function FeatureDetailPanel({ feature }) {
  const hasLabels = Array.isArray(feature.labels) && feature.labels.length > 0;
  const hasDepends = Array.isArray(feature.depends) && feature.depends.length > 0;

  return (
    <dl style={styles.detailDl}>
      {feature.goal && (
        <>
          <dt style={styles.detailTerm}>Ziel</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-goal">{feature.goal}</dd>
        </>
      )}
      {feature.definition_of_done && (
        <>
          <dt style={styles.detailTerm}>Definition of Done</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-dod">{feature.definition_of_done}</dd>
        </>
      )}
      {feature.priority && (
        <>
          <dt style={styles.detailTerm}>Priorität</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-priority">{feature.priority}</dd>
        </>
      )}
      {hasDepends && (
        <>
          <dt style={styles.detailTerm}>Abhängigkeiten</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-depends">
            <div style={styles.labelRow}>
              {feature.depends.map((dep) => (
                <span key={dep} style={styles.dependsChip}>{dep}</span>
              ))}
            </div>
          </dd>
        </>
      )}
      {hasLabels && (
        <>
          <dt style={styles.detailTerm}>Labels</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-labels">
            <div style={styles.labelRow}>
              {feature.labels.map((lbl) => (
                <span key={lbl} style={styles.labelChip} aria-label={`Label: ${lbl}`}>{lbl}</span>
              ))}
            </div>
          </dd>
        </>
      )}
    </dl>
  );
}

// ── RollupBar ─────────────────────────────────────────────────────────────────

/**
 * Progress/rollup bar for a feature (AC5).
 * Shows "done/total done" as text and a visual bar.
 *
 * @param {{ done: number, total: number }} props
 */
function RollupBar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const label = `${done}/${total} done`;

  return (
    <div
      style={styles.rollupContainer}
      aria-label={`Fortschritt: ${label}`}
      data-testid="rollup-bar"
    >
      <span style={styles.rollupText}>{label}</span>
      <div
        style={styles.rollupTrack}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}%`}
      >
        <div
          style={{
            ...styles.rollupFill,
            width: `${pct}%`,
          }}
        />
      </div>
    </div>
  );
}

// ── StatusColumn ──────────────────────────────────────────────────────────────

/**
 * One status column with a header label and list of StoryCards.
 * Always rendered (even when empty) so the grid is consistent (AC4).
 *
 * @param {{ status: string, stories: object[] }} props
 */
function StatusColumn({ status, stories }) {
  return (
    <div
      role="listitem"
      style={styles.statusColumn}
      aria-label={`Status: ${status}`}
      data-status={status}
    >
      <div style={styles.columnHeader}>
        <StatusBadge status={status} />
        {stories.length > 0 && (
          <span style={styles.columnCount} aria-label={`${stories.length} Stories`}>
            {stories.length}
          </span>
        )}
      </div>

      {stories.map((story) => (
        <StoryCard key={story.id} story={story} />
      ))}
    </div>
  );
}

// ── StoryCard ─────────────────────────────────────────────────────────────────

/**
 * Story card: id, title, priority, labels, spec link (AC3 model fields).
 *
 * @param {{ story: object }} props
 */
function StoryCard({ story }) {
  return (
    <article
      style={styles.storyCard}
      aria-label={`Story: ${story.title || story.id}`}
      data-story={story.id}
    >
      <div style={styles.storyHeader}>
        <span style={styles.storyId} aria-label="Story-ID">{story.id}</span>
        {story.priority && (
          <span style={styles.priorityBadge} aria-label={`Priorität: ${story.priority}`}>
            {story.priority}
          </span>
        )}
      </div>

      {story.title && (
        <p style={styles.storyTitle}>{story.title}</p>
      )}

      {/* Labels (AC6 — filter target) */}
      {(story.labels ?? []).length > 0 && (
        <div style={styles.labelRow} aria-label="Labels">
          {story.labels.map((lbl) => (
            <span key={lbl} style={styles.labelChip} aria-label={`Label: ${lbl}`}>
              {lbl}
            </span>
          ))}
        </div>
      )}

      {/* Spec reference */}
      {story.spec && (
        <div style={styles.specRef} aria-label="Spec">
          <span style={styles.specLabel}>Spec: </span>
          <span style={styles.specValue}>{story.spec}</span>
        </div>
      )}
    </article>
  );
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

/**
 * Badge with text label for a status value.
 * Meaning conveyed via text, not only colour (WCAG 2.1 AA, AC4/A11y).
 *
 * @param {{ status: string }} props
 */
function StatusBadge({ status }) {
  const label = status || '—';
  const badgeStyle = STATUS_BADGE_STYLES[label] ?? STATUS_BADGE_STYLES._default;
  return (
    <span
      style={{ ...styles.statusBadge, ...badgeStyle }}
      aria-label={`Status: ${label}`}
    >
      {label}
    </span>
  );
}

const STATUS_BADGE_STYLES = {
  'To Do':       { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
  'In Progress': { background: '#2a1a1a', color: '#fde68a', borderColor: '#78350f' },
  'Blocked':     { background: '#2a1a1a', color: '#f87171', borderColor: '#7f1d1d' },
  'In Review':   { background: '#2a1a2a', color: '#d8b4fe', borderColor: '#581c87' },
  'Done':        { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  _default:      { background: '#2a2a2a', color: '#9ca3af', borderColor: '#4b5563' },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Main landmark
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
  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
  },
  hintMsg: {
    color: '#6b7280',
    fontSize: 13,
    margin: '4px 0',
    fontStyle: 'italic',
  },

  // ── Filter bar (AC6)
  filterBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 12px',
    marginBottom: 20,
    padding: '12px 16px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#9ca3af',
    letterSpacing: '0.04em',
  },
  filterFieldset: {
    border: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  statusCheckboxRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
  },
  statusCheckboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: '#e5e7eb',
    cursor: 'pointer',
    minHeight: 24,
    // Focus ring on the checkbox input itself is preserved
  },
  statusCheckbox: {
    accentColor: '#93c5fd',
    cursor: 'pointer',
  },
  filterSelect: {
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 13,
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },
  filterReset: {
    background: 'transparent',
    border: '1px solid #444',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },

  // ── Project list
  projectList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },

  projectSection: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '16px 20px',
  },

  projectHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 12,
    paddingBottom: 12,
    borderBottom: '1px solid #2a2a2a',
  },

  projectTitle: {
    margin: 0,
    fontSize: 17,
    fontWeight: 700,
    color: '#e5e7eb',
  },

  repoBadge: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'monospace',
  },

  errorBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    borderRadius: 10,
    background: '#2a1a1a',
    color: '#f87171',
    border: '1px solid #7f1d1d',
  },

  // ── Feature row
  featureRow: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottom: '1px solid #1e1e1e',
  },

  featureHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },

  featureTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#d1d5db',
    flex: 1,
    minWidth: 0,
  },

  // Feature title as a button (expand/collapse detail)
  featureTitleBtn: {
    background: 'transparent',
    border: 'none',
    padding: '2px 0',
    fontSize: 14,
    fontWeight: 600,
    color: '#d1d5db',
    cursor: 'pointer',
    textAlign: 'left',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    // Focus ring preserved (no outline:none)
  },
  featureTitleChevron: {
    fontSize: 10,
    color: '#6b7280',
    flexShrink: 0,
  },

  // Feature detail panel (goal, DoD, priority, depends, labels)
  featureDetail: {
    marginBottom: 10,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #1e2a3a',
    borderRadius: 6,
  },
  detailDl: {
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '4px 12px',
    alignItems: 'baseline',
  },
  detailTerm: {
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    margin: 0,
  },
  detailDesc: {
    fontSize: 12,
    color: '#9ca3af',
    margin: 0,
    lineHeight: 1.5,
  },

  dependsChip: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 10,
    background: '#1e2a1e',
    color: '#86efac',
    border: '1px solid #14532d',
  },

  // ── Rollup bar (AC5)
  rollupContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  rollupText: {
    fontSize: 11,
    color: '#9ca3af',
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  rollupTrack: {
    width: 80,
    height: 6,
    background: '#2a2a2a',
    borderRadius: 3,
    overflow: 'hidden',
  },
  rollupFill: {
    height: '100%',
    background: '#86efac',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },

  // ── Status columns (AC4 — Kanban-style)
  statusColumns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
    gap: 8,
  },

  statusColumn: {
    minWidth: 0,
    background: '#0d0d0d',
    borderRadius: 6,
    padding: '8px 8px',
    border: '1px solid #222',
  },

  columnHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },

  columnCount: {
    fontSize: 11,
    color: '#6b7280',
    background: '#1e1e1e',
    borderRadius: 10,
    padding: '1px 6px',
  },

  // ── Story card
  storyCard: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '8px 10px',
    marginBottom: 4,
  },

  storyHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },

  storyId: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'monospace',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  storyTitle: {
    margin: '0 0 4px',
    fontSize: 12,
    color: '#d1d5db',
    lineHeight: 1.4,
  },

  priorityBadge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    flexShrink: 0,
  },

  labelRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 4,
  },

  labelChip: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 10,
    background: '#1e293b',
    color: '#a5b4fc',
    border: '1px solid #312e81',
  },

  specRef: {
    display: 'flex',
    gap: 4,
    marginTop: 4,
  },
  specLabel: {
    fontSize: 10,
    color: '#4b5563',
  },
  specValue: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  // ── Status badge (text label — not only colour)
  statusBadge: {
    display: 'inline-block',
    padding: '2px 6px',
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 10,
    border: '1px solid',
    flexShrink: 0,
  },
};
