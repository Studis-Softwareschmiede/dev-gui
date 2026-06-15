/**
 * BoardView.jsx — Studis-Kanban-Board: Projekt → Feature → Story.
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
 * studis-kanban-board-ux:
 *   AC1  — Umbenennung: View-Titel + aria-label = „Studis-Kanban-Board". Route-id bleibt `board`.
 *   AC2  — Status-Filter-Default: alle 5 Status vorausgewählt (alles sichtbar);
 *           Deselektieren blendet aus.
 *   AC3  — Alle Status deselektiert → keine Stories + role=status „Kein Status gewählt".
 *   AC4  — Status-Filter als Popover: Button „Status (n/5) ▾", Klick-Toggle,
 *           schließt bei Außenklick + Esc; aria-expanded/-controls.
 *   AC5  — GET /api/board/projects/list (leicht) + GET /api/board/projects/:slug (voll).
 *   AC6  — Standalone: öffnet mit Projektliste, Klick lädt ein Projekt (lazy).
 *           Cockpit-Modus (lockedProject): direktes Anzeigen, keine Liste.
 *
 * team-entity-icons:
 *   AC12 — StoryCard zeigt ein <EntityIcon> (size=14) vor story.id wenn
 *           story.labels ein Label der Form „<kind>:<id>" enthält
 *           (kind ∈ agent|skill|knowledge). Label-Parsing via
 *           parseEntityLabel(); kein neues Datenfeld, kein neuer API-Aufruf.
 *
 * story-detail-ansicht:
 *   AC3  — Klick auf Story-Karte öffnet Detail-Ansicht mit drei Blöcken:
 *           (1) Zeiten (Start/Ende/Dauer), (2) Agenten-Flow (chronologisch,
 *           je Schritt Agent/Iteration/Gate/Dauer), (3) Soll-Ist
 *           (ep_est↔ep_act, tok geschätzt↔tatsächlich, Abweichung %).
 *           Rückweg zum Board. Touch-Targets ≥ 44 px.
 *   AC4  — Soll-Ist zeigt ep_est↔ep_act + tok_est↔tok_total mit Abweichung %;
 *           fehlende Schätzung sauber dargestellt als „keine Schätzung".
 *
 * Story-Status-Lebenszyklus (board-subsystem §9.3):
 *   To Do | In Progress | Blocked | In Review | Done
 *
 * A11y (WCAG 2.1 AA):
 *   - <main> mit aria-label „Studis-Kanban-Board".
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
 * @param {{
 *   onNavigate: (view: string) => void,
 *   lockedProject?: string,
 *   onOpenSpec?: (relPath: string) => void,
 * }} props
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { EntityIcon }       from './icons/EntityIcon.jsx';
import { parseEntityLabel } from './icons/parseEntityLabel.js';

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
 * @param {{
 *   onNavigate: (view: string) => void,
 *   lockedProject?: string,
 * }} props
 *   lockedProject — when set (Cockpit-Modus / F-005), shows that project directly
 *   without project list; project-filter dropdown is hidden (AC6/studis-kanban-board-ux).
 *   When absent (STANDALONE #/board), shows project list first — lazy-load mode (AC6).
 */
export function BoardView({ onNavigate: _onNavigate, lockedProject, onOpenSpec }) {
  // ─── Mode: standalone (lazy) vs cockpit (lockedProject set) ─────────────────
  const isStandalone = !lockedProject;

  // ─── Story Detail (AC3/AC4 story-detail-ansicht) ─────────────────────────────
  // selectedStory: { slug, storyId, storyTitle } | null
  const [selectedStory, setSelectedStory] = useState(null);
  // detailState: 'idle'|'loading'|'ok'|'error'
  const [detailState, setDetailState] = useState('idle');
  const [detailData, setDetailData]   = useState(null);
  const [detailError, setDetailError] = useState('');

  // ─── Standalone: project list state (AC6) ───────────────────────────────────
  // listState: 'idle'|'loading'|'ok'|'error'
  const [listState, setListState]   = useState('idle');
  const [listError, setListError]   = useState('');
  /** @type {[Array<{slug:string,feature_count?:number,story_count?:number,error?:string}>, Function]} */
  const [projectList, setProjectList] = useState([]);
  // selectedSlug: the project the user clicked on (null = showing project list)
  const [selectedSlug, setSelectedSlug] = useState(null);

  // ─── Data state: full project loaded on-demand (AC6 standalone) or on mount (cockpit) ─
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  // In cockpit mode: projects = [ lockedProject full data ]
  // In standalone mode: projects = [ selectedProject full data ]
  const [projects, setProjects] = useState([]);

  // ─── Filter state (AC2, AC3, AC4) ───────────────────────────────────────────
  // AC2: default = all 5 status selected (new Set(STATUS_LIFECYCLE))
  const [filterProject, setFilterProject] = useState(lockedProject ?? '');
  const [filterStatus, setFilterStatus]   = useState(() => new Set(STATUS_LIFECYCLE)); // AC2: alle vorausgewählt
  const [filterLabel, setFilterLabel]     = useState('');

  // ─── STANDALONE: load project list on mount (AC6) ───────────────────────────
  useEffect(() => {
    if (!isStandalone) return;

    let cancelled = false;
    setListState('loading');
    setListError('');

    fetch('/api/board/projects/list')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setProjectList(data.projects ?? []);
        setListState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(err.message || 'Netzwerkfehler');
        setListState('error');
      });

    return () => { cancelled = true; };
  }, [isStandalone]);

  // ─── COCKPIT: load the locked project on mount (AC6 cockpit mode) ────────────
  useEffect(() => {
    if (isStandalone) return;
    if (!lockedProject) return;

    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch(`/api/board/projects/${encodeURIComponent(lockedProject)}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const proj = data.project ?? null;
        setProjects(proj ? [proj] : []);
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        // Fallback: try the full list endpoint so Cockpit doesn't break
        // if the slug doesn't match (e.g. lockedProject = repo path not slug)
        fetch('/api/board/projects')
          .then((r) => {
            if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
            return r.json();
          })
          .then((data) => {
            if (cancelled) return;
            const all = data.projects ?? [];
            const filtered = all.filter((p) => {
              const slug = p.slug || p.project_slug || p.repo_path || '';
              return slug === lockedProject;
            });
            setProjects(filtered.length > 0 ? filtered : all);
            setLoadState('ok');
          })
          .catch((err2) => {
            if (cancelled) return;
            setLoadError(err2.message || err.message || 'Netzwerkfehler');
            setLoadState('error');
          });
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedProject]); // re-run if locked project changes

  // ─── STANDALONE: load single project when user clicks (AC6) ─────────────────
  const handleProjectSelect = useCallback((slug) => {
    setSelectedSlug(slug);
    setLoadState('loading');
    setLoadError('');
    setProjects([]);

    fetch(`/api/board/projects/${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        const proj = data.project ?? null;
        setProjects(proj ? [proj] : []);
        setLoadState('ok');
      })
      .catch((err) => {
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });
  }, []);

  // ─── STANDALONE: back to project list ────────────────────────────────────────
  const handleBackToList = useCallback(() => {
    setSelectedSlug(null);
    setProjects([]);
    setLoadState('idle');
    setLoadError('');
    // Reset filters when returning to list
    setFilterStatus(new Set(STATUS_LIFECYCLE));
    setFilterLabel('');
  }, []);

  // ─── Story click → Detail-Ansicht (AC3 story-detail-ansicht) ─────────────────
  // slug: the current project slug (from standalone selectedSlug or lockedProject)
  const handleStoryClick = useCallback((slug, story) => {
    setSelectedStory({ slug, storyId: story.id, storyTitle: story.title || story.id });
    setDetailState('loading');
    setDetailData(null);
    setDetailError('');

    fetch(`/api/board/projects/${encodeURIComponent(slug)}/stories/${encodeURIComponent(story.id)}/detail`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        setDetailData(data.detail ?? null);
        setDetailState('ok');
      })
      .catch((err) => {
        setDetailError(err.message || 'Netzwerkfehler');
        setDetailState('error');
      });
  }, []);

  // ─── Back from story detail → board ─────────────────────────────────────────
  const handleDetailBack = useCallback(() => {
    setSelectedStory(null);
    setDetailState('idle');
    setDetailData(null);
    setDetailError('');
  }, []);

  // ─── Current project slug (for story detail API calls) ───────────────────────
  // In standalone: selectedSlug; in cockpit: lockedProject
  const currentProjectSlug = isStandalone ? selectedSlug : (lockedProject ?? null);

  // ─── Derived: project options for filter dropdown (only in cockpit mode) ─────
  const projectOptions = useMemo(() => {
    return projects
      .filter((p) => !p.error)
      .map((p) => p.slug || p.project_slug || p.repo_path || '?')
      .filter(Boolean);
  }, [projects]);

  // ─── Derived: all label options for filter dropdown ──────────────────────────
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

  // ─── Derived: filtered view ───────────────────────────────────────────────────
  const filteredProjects = useMemo(() => {
    return projects
      .filter((p) => {
        if (!filterProject) return true;
        const slug = p.slug || p.project_slug || p.repo_path || '';
        return slug === filterProject;
      })
      .map((p) => {
        if (p.error) return p;
        const filteredFeatures = (p.features ?? []).map((f) => {
          const filteredStories = (f.stories ?? []).filter((s) => {
            // AC2/AC3: filterStatus is always a non-empty Set (all 5 by default);
            // empty Set = AC3 scenario → no stories shown
            if (!filterStatus.has(s.status)) return false;
            if (filterLabel && !(s.labels ?? []).includes(filterLabel)) return false;
            return true;
          });
          return { ...f, stories: filteredStories };
        });
        return { ...p, features: filteredFeatures };
      });
  }, [projects, filterProject, filterStatus, filterLabel]);

  // Total stories after filtering — used to detect "filter eliminates all" or AC3 empty-set
  const totalFilteredStories = useMemo(() => {
    return filteredProjects.reduce(
      (acc, p) =>
        acc + (p.features ?? []).reduce((a, f) => a + (f.stories ?? []).length, 0),
      0,
    );
  }, [filteredProjects]);

  // AC3: all statuses deselected
  const allStatusDeselected = filterStatus.size === 0;

  const isEmpty = loadState === 'ok' && projects.length === 0;
  const hasProjects = loadState === 'ok' && projects.length > 0;

  // ─── Render ───────────────────────────────────────────────────────────────────

  // ─── Story Detail View (AC3 story-detail-ansicht) — overlay ─────────────────
  if (selectedStory !== null) {
    return (
      <StoryDetailView
        story={selectedStory}
        detailState={detailState}
        detailData={detailData}
        detailError={detailError}
        onBack={handleDetailBack}
      />
    );
  }

  return (
    <main style={styles.main} aria-label="Studis-Kanban-Board">
      <h1 style={styles.h1}>Studis-Kanban-Board</h1>

      {/* ── STANDALONE: Project list (AC6) ─────────────────────────── */}
      {isStandalone && selectedSlug === null && (
        <>
          {listState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Projektliste…
            </div>
          )}
          {listState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Projektliste: {listError}
            </div>
          )}
          {listState === 'ok' && projectList.length === 0 && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}
          {listState === 'ok' && projectList.length > 0 && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {projectList.map((item) => (
                <ProjectListItem
                  key={item.slug}
                  item={item}
                  onSelect={handleProjectSelect}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── STANDALONE: Single project loaded (AC6) ────────────────── */}
      {isStandalone && selectedSlug !== null && (
        <>
          {/* Back to list */}
          <button
            type="button"
            style={styles.backBtn}
            onClick={handleBackToList}
            aria-label="Zurück zur Projektliste"
            data-testid="board-back-btn"
          >
            ← Projektliste
          </button>

          {/* Filter bar — shown when data is loaded (standalone project view) */}
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
              hideProjectFilter={true}
            />
          )}

          {/* Loading */}
          {loadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Projekt-Daten…
            </div>
          )}
          {/* Error */}
          {loadState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Board-Daten: {loadError}
            </div>
          )}
          {/* Empty */}
          {isEmpty && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}
          {/* AC3: all statuses deselected */}
          {hasProjects && allStatusDeselected && (
            <div role="status" style={styles.statusMsg} data-testid="no-status-hint">
              Kein Status gewählt — bitte mindestens einen wählen.
            </div>
          )}
          {/* Project content */}
          {hasProjects && !allStatusDeselected && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {filteredProjects.map((project) => (
                <ProjectSection
                  key={project.slug ?? project.repo_path ?? project.project_slug}
                  project={project}
                  onOpenSpec={onOpenSpec}
                  onStoryClick={currentProjectSlug
                    ? (story) => handleStoryClick(currentProjectSlug, story)
                    : null}
                />
              ))}
              {filteredProjects.length === 0 && (filterProject || filterStatus.size > 0 || filterLabel) && (
                <div role="status" style={styles.statusMsg}>
                  Keine Projekte / Stories passen zum aktuellen Filter.
                </div>
              )}
              {filteredProjects.length > 0 && totalFilteredStories === 0 && filterLabel && (
                <div role="status" style={styles.statusMsg}>
                  Keine Stories passen zum aktiven Filter.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── COCKPIT (lockedProject set — F-005): direct project view ── */}
      {!isStandalone && (
        <>
          {/* Filter bar — shown when data is loaded */}
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
              hideProjectFilter={true}
            />
          )}

          {/* Loading */}
          {loadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Board-Daten…
            </div>
          )}

          {/* Error */}
          {loadState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Board-Daten: {loadError}
            </div>
          )}

          {/* Empty */}
          {isEmpty && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}

          {/* AC3: all statuses deselected */}
          {hasProjects && allStatusDeselected && (
            <div role="status" style={styles.statusMsg} data-testid="no-status-hint">
              Kein Status gewählt — bitte mindestens einen wählen.
            </div>
          )}

          {/* Project list (AC4) */}
          {hasProjects && !allStatusDeselected && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {filteredProjects.map((project) => (
                <ProjectSection
                  key={project.slug ?? project.repo_path ?? project.project_slug}
                  project={project}
                  onOpenSpec={onOpenSpec}
                  onStoryClick={currentProjectSlug
                    ? (story) => handleStoryClick(currentProjectSlug, story)
                    : null}
                />
              ))}
              {filteredProjects.length === 0 && (filterProject || filterStatus.size > 0 || filterLabel) && (
                <div role="status" style={styles.statusMsg}>
                  Keine Projekte / Stories passen zum aktuellen Filter.
                </div>
              )}
              {filteredProjects.length > 0 && totalFilteredStories === 0 && filterLabel && (
                <div role="status" style={styles.statusMsg}>
                  Keine Stories passen zum aktiven Filter.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

/**
 * Filter controls for Projekt, Story-Status (popover, AC4) and Label.
 *
 * AC4 (studis-kanban-board-ux): Status-Filter as click-toggle popover.
 *   Button "Status (n/5) ▾" opens a floating panel with checkboxes.
 *   Closes on outside click and Esc. Button carries aria-expanded/aria-controls.
 *
 * AC2 (studis-kanban-board-ux): default = all 5 selected (passed in from parent).
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
 *   hideProjectFilter?: boolean,
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
  hideProjectFilter = false,
}) {
  // AC4: popover open/close state
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef(null);
  const triggerRef = useRef(null);
  const POPOVER_ID = 'board-status-popover';

  // Close on outside click (AC4)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleMouseDown(e) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [popoverOpen]);

  // Close on Esc (AC4)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        setPopoverOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [popoverOpen]);

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

  // AC4: button label "Status (n/5) ▾"
  const checkedCount = filterStatus.size;
  const totalCount   = statusOptions.length;
  const statusLabel  = `Status (${checkedCount}/${totalCount}) ▾`;

  // "Any filter active" determines whether reset button appears.
  // AC2: all 5 selected is NOT a "filter active" state; fewer than 5 OR label/project IS active.
  const allSelected = checkedCount === totalCount;
  const anyFilterActive =
    (!hideProjectFilter && filterProject) ||
    !allSelected ||
    filterLabel;

  return (
    <div style={styles.filterBar} role="search" aria-label="Board-Filter">
      {/* Projekt filter — hidden in Cockpit or standalone single-project view */}
      {!hideProjectFilter && (
        <>
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
        </>
      )}

      {/* AC4: Status popover trigger button */}
      <div style={styles.popoverContainer}>
        <button
          ref={triggerRef}
          type="button"
          id="board-status-filter-btn"
          style={styles.statusPopoverBtn}
          aria-expanded={popoverOpen}
          aria-controls={POPOVER_ID}
          aria-label={`Status-Filter öffnen: ${checkedCount} von ${totalCount} ausgewählt`}
          onClick={() => setPopoverOpen((prev) => !prev)}
          data-testid="status-filter-btn"
        >
          {statusLabel}
        </button>

        {/* AC4: Popover panel */}
        {popoverOpen && (
          <div
            ref={popoverRef}
            id={POPOVER_ID}
            role="dialog"
            aria-label="Status-Filter"
            style={styles.statusPopover}
            data-testid="status-popover"
          >
            <fieldset
              style={styles.filterFieldset}
              id="board-filter-status-group"
              aria-label="Nach Status filtern"
            >
              <legend style={{ ...styles.filterLabel, marginBottom: 6 }}>Status</legend>
              <div style={styles.statusCheckboxCol}>
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
          </div>
        )}
      </div>

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

      {/* Reset — shown when any filter deviates from default (AC2 default = all selected) */}
      {anyFilterActive && (
        <button
          type="button"
          style={styles.filterReset}
          onClick={() => {
            onProjectChange('');
            onStatusChange(new Set(STATUS_LIFECYCLE)); // AC2: reset to all selected
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

// ── ProjectListItem ───────────────────────────────────────────────────────────

/**
 * One row in the standalone project list (AC6).
 * Shows slug + coarse counters; click loads the project.
 *
 * @param {{
 *   item: { slug: string, feature_count?: number, story_count?: number, error?: string },
 *   onSelect: (slug: string) => void
 * }} props
 */
function ProjectListItem({ item, onSelect }) {
  return (
    <div
      role="listitem"
      style={styles.projectListItem}
      data-project-list-item={item.slug}
    >
      {item.error ? (
        <div style={styles.projectListItemContent}>
          <span style={styles.projectListSlug}>{item.slug}</span>
          <span style={styles.errorBadge} role="status" aria-label="Fehler">
            Fehler: {item.error}
          </span>
        </div>
      ) : (
        <div style={styles.projectListItemContent}>
          <button
            type="button"
            style={styles.projectListBtn}
            onClick={() => onSelect(item.slug)}
            aria-label={`Projekt ${item.slug} öffnen`}
            data-testid={`project-select-${item.slug}`}
          >
            {item.slug}
          </button>
          <span style={styles.projectListMeta} aria-label="Zähler">
            {item.feature_count ?? 0} Features · {item.story_count ?? 0} Stories
          </span>
        </div>
      )}
    </div>
  );
}

// ── ProjectSection ────────────────────────────────────────────────────────────

/**
 * One project block: header + list of features (AC4).
 * If the project has an error, renders an error badge (AC8).
 *
 * @param {{
 *   project: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 * }} props
 */
function ProjectSection({ project, onOpenSpec, onStoryClick }) {
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
          onOpenSpec={onOpenSpec}
          onStoryClick={onStoryClick}
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
 * @param {{
 *   feature: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 * }} props
 */
function FeatureRow({ feature, onOpenSpec, onStoryClick }) {
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
              onOpenSpec={onOpenSpec}
              onStoryClick={onStoryClick}
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
 * @param {{
 *   status: string,
 *   stories: object[],
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 * }} props
 */
function StatusColumn({ status, stories, onOpenSpec, onStoryClick }) {
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
        <StoryCard
          key={story.id}
          story={story}
          onOpenSpec={onOpenSpec}
          onStoryClick={onStoryClick}
        />
      ))}
    </div>
  );
}

// ── StoryCard ─────────────────────────────────────────────────────────────────

/**
 * Story card: id, title, priority, labels, spec link (AC3 model fields).
 * AC5 — Spec-Bezug ist klickbar (wenn onOpenSpec vorhanden): öffnet Spec im
 *        Spezifikation-Reiter. story.spec enthält den relativen Pfad (z.B. docs/specs/foo.md).
 * AC3 (story-detail-ansicht) — Karte als Button klickbar wenn onStoryClick vorhanden.
 *
 * @param {{
 *   story: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 * }} props
 */
function StoryCard({ story, onOpenSpec, onStoryClick }) {
  // AC12 — derive entity reference from story labels for icon display.
  const entityRef = parseEntityLabel(story.labels ?? []);

  const cardContent = (
    <>
      <div style={styles.storyHeader}>
        {entityRef && (
          <EntityIcon kind={entityRef.kind} id={entityRef.id} size={14} />
        )}
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

      {/* Spec reference (AC5 — klickbar wenn onOpenSpec vorhanden) */}
      {story.spec && (
        <div style={styles.specRef} aria-label="Spec">
          <span style={styles.specLabel}>Spec: </span>
          {onOpenSpec ? (
            <button
              type="button"
              style={styles.specLink}
              onClick={(e) => { e.stopPropagation(); onOpenSpec(story.spec); }}
              aria-label={`Spec öffnen: ${story.spec}`}
              data-testid={`spec-link-${story.id}`}
            >
              {story.spec}
            </button>
          ) : (
            <span style={styles.specValue}>{story.spec}</span>
          )}
        </div>
      )}
    </>
  );

  // AC3 (story-detail-ansicht): when onStoryClick is provided, wrap the card in a button
  if (onStoryClick) {
    return (
      <button
        type="button"
        style={{ ...styles.storyCard, ...styles.storyCardBtn }}
        aria-label={`Story: ${story.title || story.id}`}
        data-story={story.id}
        onClick={() => onStoryClick(story)}
        data-testid={`story-card-btn-${story.id}`}
      >
        {cardContent}
      </button>
    );
  }

  return (
    <article
      style={styles.storyCard}
      aria-label={`Story: ${story.title || story.id}`}
      data-story={story.id}
    >
      {cardContent}
    </article>
  );
}

// ── StoryDetailView ───────────────────────────────────────────────────────────

/**
 * Story-Detail-Ansicht (AC3/AC4 story-detail-ansicht).
 *
 * Drei Blöcke:
 *   (1) Zeiten       — Start / Ende / Dauer
 *   (2) Agenten-Flow — chronologisch: Agent / Iteration / Gate / Dauer
 *   (3) Soll-Ist     — ep_est↔ep_act, tok_est↔tok_total, Abweichung %;
 *                      fehlende Schätzung → „keine Schätzung"
 *
 * Rückweg zum Board per onBack (AC3 Rückweg vorhanden).
 * Touch-Targets ≥ 44 px (WCAG 2.1 AA).
 *
 * @param {{
 *   story: { slug: string, storyId: string, storyTitle: string },
 *   detailState: 'idle'|'loading'|'ok'|'error',
 *   detailData: object|null,
 *   detailError: string,
 *   onBack: () => void,
 * }} props
 */
function StoryDetailView({ story, detailState, detailData, detailError, onBack }) {
  /**
   * Format ISO timestamp to readable locale string (no dangerouslySetInnerHTML).
   * Returns '—' when ts is null/invalid.
   */
  function fmtTs(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  /**
   * Format duration (seconds) to readable string.
   */
  function fmtDuration(secs) {
    if (secs == null) return '—';
    const s = Math.round(secs);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m} min ${rem} s` : `${m} min`;
  }

  /**
   * Format a numeric value with a fallback.
   */
  function fmtNum(v, fallback = '—') {
    return v != null ? String(v) : fallback;
  }

  /**
   * Format deviation percentage with sign.
   */
  function fmtDevPct(pct) {
    if (pct == null) return '—';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct}%`;
  }

  return (
    <main style={styles.main} aria-label={`Story-Detail: ${story.storyTitle}`}>
      {/* ── Back button (AC3 — Rückweg vorhanden) ──────────────────────────── */}
      <button
        type="button"
        style={styles.backBtn}
        onClick={onBack}
        aria-label="Zurück zum Board"
        data-testid="detail-back-btn"
      >
        ← Board
      </button>

      <h1 style={styles.h1}>{story.storyId}: {story.storyTitle}</h1>

      {/* Loading */}
      {detailState === 'loading' && (
        <div aria-busy="true" aria-live="polite" style={styles.statusMsg}
          data-testid="detail-loading">
          Lade Story-Details…
        </div>
      )}

      {/* Error */}
      {detailState === 'error' && (
        <div role="alert" style={styles.errorMsg} data-testid="detail-error">
          Fehler beim Laden der Story-Details: {detailError}
        </div>
      )}

      {/* Detail blocks (AC3/AC4) */}
      {detailState === 'ok' && detailData != null && (
        <div style={styles.detailBlocks} data-testid="detail-blocks">

          {/* ── Block 1: Zeiten (AC3) ──────────────────────────────────────── */}
          <section style={styles.detailBlock} aria-label="Zeiten" data-testid="block-zeiten">
            <h2 style={styles.detailBlockTitle}>Zeiten</h2>
            <dl style={styles.detailDl}>
              <dt style={styles.detailTerm}>Start</dt>
              <dd style={styles.detailDesc} data-testid="detail-started-at">
                {fmtTs(detailData.started_at)}
              </dd>
              <dt style={styles.detailTerm}>Ende</dt>
              <dd style={styles.detailDesc} data-testid="detail-ended-at">
                {fmtTs(detailData.ended_at)}
              </dd>
              <dt style={styles.detailTerm}>Dauer</dt>
              <dd style={styles.detailDesc} data-testid="detail-duration">
                {fmtDuration(detailData.duration)}
              </dd>
            </dl>
          </section>

          {/* ── Block 2: Agenten-Flow (AC3) ────────────────────────────────── */}
          <section style={styles.detailBlock} aria-label="Agenten-Flow" data-testid="block-flow">
            <h2 style={styles.detailBlockTitle}>Agenten-Flow</h2>
            {(!detailData.flow || detailData.flow.length === 0) ? (
              <p style={styles.hintMsg} data-testid="flow-empty">Keine Flow-Daten vorhanden.</p>
            ) : (
              <table style={styles.flowTable} aria-label="Agenten-Flow-Schritte">
                <thead>
                  <tr>
                    <th style={styles.flowTh}>Seq</th>
                    <th style={styles.flowTh}>Agent</th>
                    <th style={styles.flowTh}>Iter.</th>
                    <th style={styles.flowTh}>Gate</th>
                    <th style={styles.flowTh}>Dauer</th>
                    <th style={styles.flowTh}>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {detailData.flow.map((step, idx) => (
                    <tr key={idx} data-testid={`flow-step-${idx}`}>
                      <td style={styles.flowTd}>{fmtNum(step.seq)}</td>
                      <td style={styles.flowTd}>{step.agent ?? '—'}</td>
                      <td style={styles.flowTd}>{fmtNum(step.iter)}</td>
                      <td style={styles.flowTd}>{step.gate ?? '—'}</td>
                      <td style={styles.flowTd}>
                        {step.secs != null ? fmtDuration(step.secs) : '—'}
                      </td>
                      <td style={styles.flowTd}>{fmtNum(step.tok)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Block 3: Soll-Ist (AC3/AC4) ────────────────────────────────── */}
          <section style={styles.detailBlock} aria-label="Soll-Ist" data-testid="block-soll-ist">
            <h2 style={styles.detailBlockTitle}>Soll-Ist</h2>
            <table style={styles.flowTable} aria-label="Soll-Ist-Vergleich">
              <thead>
                <tr>
                  <th style={styles.flowTh}>Metrik</th>
                  <th style={styles.flowTh}>Schätzung</th>
                  <th style={styles.flowTh}>Ist</th>
                  <th style={styles.flowTh}>Abweichung</th>
                </tr>
              </thead>
              <tbody>
                {/* Effort Points */}
                <tr data-testid="soll-ist-ep">
                  <td style={styles.flowTd}>Effort Points</td>
                  <td style={styles.flowTd} data-testid="ep-est">
                    {detailData.ep_est != null ? detailData.ep_est : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="ep-act">
                    {fmtNum(detailData.ep_act)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.ep_dev_pct),
                  }} data-testid="ep-dev">
                    {fmtDevPct(detailData.ep_dev_pct)}
                  </td>
                </tr>
                {/* Tokens */}
                <tr data-testid="soll-ist-tok">
                  <td style={styles.flowTd}>Tokens</td>
                  <td style={styles.flowTd} data-testid="tok-est">
                    {detailData.tok_est != null ? detailData.tok_est : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="tok-total">
                    {fmtNum(detailData.tok_total)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.tok_dev_pct),
                  }} data-testid="tok-dev">
                    {fmtDevPct(detailData.tok_dev_pct)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      )}

      {/* Loaded but no data (metrics missing) */}
      {detailState === 'ok' && detailData == null && (
        <div role="status" style={styles.statusMsg} data-testid="detail-no-data">
          Keine Metrik-Daten für diese Story vorhanden.
        </div>
      )}
    </main>
  );
}

/**
 * Color for deviation (positive = over-estimate → red, negative = under → green).
 * @param {number|null} pct
 * @returns {string}
 */
function devColor(pct) {
  if (pct == null) return '#9ca3af';
  if (pct > 0) return '#f87171'; // red: exceeded estimate
  if (pct < 0) return '#86efac'; // green: under estimate
  return '#9ca3af';
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

  // ── Back button (standalone project-detail view — AC6)
  backBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    marginBottom: 12,
    // Focus ring preserved
  },

  // ── Standalone project list (AC6)
  projectListItem: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '12px 16px',
    marginBottom: 8,
  },
  projectListItemContent: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  projectListBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved
  },
  projectListSlug: {
    fontSize: 14,
    fontWeight: 600,
    color: '#e5e7eb',
    fontFamily: 'monospace',
  },
  projectListMeta: {
    fontSize: 12,
    color: '#6b7280',
  },

  // ── Filter bar (AC4, studis-kanban-board-ux)
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
  // AC4: popover container (relative positioning anchor)
  popoverContainer: {
    position: 'relative',
    display: 'inline-block',
  },
  // AC4: button "Status (n/5) ▾"
  statusPopoverBtn: {
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved
  },
  // AC4: floating popover panel
  statusPopover: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 100,
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '12px 16px',
    minWidth: 160,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  statusCheckboxCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  statusCheckboxRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
  },
  statusCheckboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
    minHeight: 28,
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
  // AC5: klickbarer Spec-Link (Button-Reset-Stil, aber sichtbar klickbar)
  specLink: {
    fontSize: 10,
    color: '#93c5fd',
    fontFamily: 'monospace',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textDecoration: 'underline',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA / design.md)
    // Focus ring preserved (no outline:none)
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

  // ── Story card as clickable button (AC3 story-detail-ansicht)
  storyCardBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA)
    // Focus ring preserved (no outline:none)
  },

  // ── Story Detail View (AC3/AC4 story-detail-ansicht)
  detailBlocks: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },

  detailBlock: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '16px 20px',
  },

  detailBlockTitle: {
    margin: '0 0 12px',
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    borderBottom: '1px solid #2a2a2a',
    paddingBottom: 8,
  },

  // ── Flow / Soll-Ist table
  flowTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    color: '#d1d5db',
  },

  flowTh: {
    textAlign: 'left',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    borderBottom: '1px solid #2a2a2a',
    letterSpacing: '0.04em',
  },

  flowTd: {
    padding: '5px 8px',
    fontSize: 12,
    color: '#d1d5db',
    borderBottom: '1px solid #1e1e1e',
    fontFamily: 'monospace',
  },

  noEstimate: {
    color: '#6b7280',
    fontStyle: 'italic',
    fontFamily: 'inherit',
  },
};
