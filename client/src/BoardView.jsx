/**
 * BoardView.jsx — Studis-Kanban-Board: Projekt → Feature → Story.
 *
 * dev-gui-board-aggregator:
 *   AC4  — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten
 *           (Idee / To Do / In Progress / Blocked / In Review / Done), aggregiert über
 *           alle gescannten Projekte. Lädt GET /api/board/projects beim Mount.
 *           Ladezustand (aria-busy/aria-live); Fehlerzustand; Leerzustand.
 *   AC5  — Rollup-Anzeige je Feature: vorhandenes progress-Feld nutzen; fehlt/stale
 *           → read-only aus Kind-Story-Status berechnet (done = 'done'-Stories).
 *   AC6  — Filter nach Projekt, Story-Status und Label (alle unabhängig kombinierbar).
 *          Status-Filter: Mehrfachauswahl per Checkbox-Gruppe (leere Auswahl = alle sichtbar).
 *
 * studis-kanban-board-ux:
 *   AC1  — Umbenennung: View-Titel + aria-label = „Studis-Kanban-Board". Route-id bleibt `board`.
 *   AC2  — Status-Filter-Default: alle Status vorausgewählt (alles sichtbar);
 *           Deselektieren blendet aus. (Seit ideen-inbox AC1: 6 Status inkl. „Idee".)
 *   AC3  — Alle Status deselektiert → keine Stories + role=status „Kein Status gewählt".
 *   AC4  — Status-Filter als Popover: Button „Status (n/N) ▾", Klick-Toggle,
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
 *   AC5  — Vorab-Schätzungs-Fallback: wenn items.jsonl kein ep_est liefert, zeigt
 *           die Soll-Ist-Ansicht dispo_est aus der Story-YAML mit einem „Vorab"-Badge.
 *           Ist-/Abweichungs-Spalten bleiben leer bis zum Flow-Lauf.
 *           ep_est_source: 'yaml' → Vorab-Badge; 'ledger' → kein Badge; null → keine Schätzung.
 *
 * story-detail-yaml-fallback:
 *   AC5  — Differenzierter Leer-Zustand im Agenten-Flow-Block: „Vor Metrik-Erfassung
 *           abgeschlossen" (done_at vorhanden) vs. „Noch kein Flow-Lauf erfasst".
 *           Ende-Zeit zeigt auch YAML-Quelle (ended_at_source='yaml') mit YAML-Badge.
 *   AC6  — Block „Verknüpfungen" mit Branch (Text) + PR (externer Link, noopener noreferrer);
 *           Block ausgeblendet wenn weder branch noch pr vorhanden.
 *   AC7  — Ledger hat Vorrang: bestehende Ledger-Daten unverändert.
 *   AC8  — Kein dangerouslySetInnerHTML; externer PR-Link mit rel=noopener noreferrer.
 *
 * autonome-board-abarbeitung:
 *   AC4  — Board zeigt Ready-/Blocked-Status: Ready-To-Do-Stories tragen ein dezentes
 *           „ready"-Badge (grün); Blocked-Stories zeigen ihren blocked_reason als
 *           Hinweiszeile unter dem Titel. Kontrast WCAG AA; aria-label an Badges.
 *
 * ideen-inbox:
 *   AC1  — Status „Idee" ist erstes Element von STATUS_LIFECYCLE (ganz links vor
 *           „To Do"); „Idee"-Spalte rendert links von „To Do"; Status-Filter führt
 *           „Idee" (Default ausgewählt, wie alle Status).
 *   AC2  — Idee-Items sind nie ready: computeStoryReadyStatus (src/BoardAggregator.js)
 *           liefert für status ≠ To Do bereits ready=false/ready_reason=null; die
 *           Ready-Badge-Bedingung bleibt auf story.status === 'To Do' beschränkt →
 *           „Idee"-Karten zeigen kein ready-Badge (kein neuer Code nötig, nur Test-Beleg).
 *   AC5/AC6 — SUPERSEDED durch idea-specify-chat (S-218, siehe unten): der frühere
 *           discuss-Tab-Sprung (POST .../discuss, onDiscussIdea, PTY-Terminal-Wechsel)
 *           und die frühere Resolve-UI (IdeaResolveModal, POST .../resolve) sind
 *           vollständig entfernt und durch das Chat-Overlay (IdeaSpecifyChatModal)
 *           ersetzt.
 *
 * idea-specify-chat:
 *   AC1  — Klick auf eine Idee-Karte (status === 'Idee') ODER auf den Button
 *           „Spezifizieren" öffnet dasselbe Chat-Overlay (`IdeaSpecifyChatModal`)
 *           über dem Board — kein Tab-Wechsel, kein Detail-Fetch. Beide Auslöser
 *           rufen `handleOpenSpecifyChat(slug, story, triggerEl)` auf, die den
 *           `specifyingIdea`-State ({slug, story}) setzt; das Modal rendert, wenn
 *           `specifyingIdea` gesetzt ist. A11y/Bubble-Verhalten lebt in
 *           `IdeaSpecifyChatModal.jsx` (S-217).
 *   AC2  — Button-Umbenennung: `StoryCard` zeigt statt „Idee auflösen" den Button
 *           „Spezifizieren" (Prop `onResolveIdea` → `onSpecifyIdea`, gleiche
 *           Aufrufsignatur `(story, triggerEl)`); der alte reine Verwerfen-Pfad
 *           (IdeaResolveModal) sowie der discuss-Tab-Sprung (onDiscussIdea,
 *           handleIdeaDiscuss) sind entfernt. `onSpecified(projectSlug)` löst ein
 *           Re-Fetch der Board-Daten aus (Wiederverwendung des bestehenden
 *           Cockpit-/Standalone-Lade-Mechanismus über `reloadToken`).
 *
 * board-feature-collapse:
 *   AC1  — Jede Feature-Zeile hat einen Auf-/Zu-Schalter (Collapse-Button mit Chevron);
 *           eingeklappt sind Story-Spalten ausgeblendet; ausgeklappt wie bisher sichtbar.
 *   AC2  — Ziel/DoD-Detail-Panel auf separaten Schalter entkoppelt; bei eingeklapptem
 *           Feature ist der Detail-Schalter ausgeblendet.
 *   AC3  — Default „Gemischt": erledigte Features (done==total, total>0, oder status
 *           Done/Archived) eingeklappt; übrige ausgeklappt.
 *   AC4  — „Alle einklappen" / „Alle ausklappen" in der Board-Kopfleiste.
 *   AC5  — Zustand pro Projekt im localStorage (Key boardview.collapsed.<slug>);
 *           defektes/fehlendes localStorage → stiller Default, kein Crash.
 *   AC6  — Bei aktivem einschränkendem Filter: eingeklappte Features mit passenden
 *           Stories temporär ausgeklappt dargestellt; gespeicherter Zustand nicht
 *           überschrieben.
 *   AC7  — A11y: Auf-/Zu-Schalter sind button mit aria-expanded + aria-controls;
 *           Tastatur (Enter/Space); Fokusring erhalten; Chevron aria-hidden.
 *   AC8  — Kein dangerouslySetInnerHTML; kein neuer API-Aufruf; keine Secrets.
 *
 * Story-Status-Lebenszyklus (board-subsystem §9.3, erweitert um ideen-inbox AC1):
 *   Idee | To Do | In Progress | Blocked | In Review | Done
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
import { EntityIcon }             from './icons/EntityIcon.jsx';
import { parseEntityLabel }       from './icons/parseEntityLabel.js';
import { IdeaSpecifyChatModal }   from './IdeaSpecifyChatModal.jsx';

// ── Status-Lebensyklus (board-subsystem §9.3) ─────────────────────────────────

/**
 * Canonical story-status lifecycle values.
 * ideen-inbox AC1: „Idee" ist GANZ LINKS einsortiert (vor „To Do") — Front-of-Funnel
 * vor dem eigentlichen Drain-Modell; Reihenfolge bestimmt sowohl Spalten-Rendering
 * (STATUS_LIFECYCLE.map in FeatureRow) als auch die Filter-Checkbox-Reihenfolge.
 */
const STATUS_LIFECYCLE = ['Idee', 'To Do', 'In Progress', 'Blocked', 'In Review', 'Done'];

/**
 * "Done" story-statuses for rollup calculation (AC5).
 * 'done' is a defensive fallback for non-canonical backend values.
 */
const DONE_STATUSES = new Set(['Done', 'done']);

// ── Feature-collapse helpers (board-feature-collapse) ─────────────────────────

/**
 * localStorage key for a project slug.
 * Key: `boardview.collapsed.<slug>` → JSON `{ "collapsed": ["F-012","F-018"] }`
 * (AC5: localStorage pro Projekt)
 *
 * @param {string} slug
 * @returns {string}
 */
function collapseKey(slug) {
  return `boardview.collapsed.${slug}`;
}

/**
 * Load collapsed feature IDs from localStorage.
 * Returns null when no persisted state exists for this slug.
 * Returns an empty Set when persisted but nothing is collapsed.
 * Falls back silently to null on any error (AC5: defektes localStorage → Default).
 *
 * @param {string} slug
 * @returns {Set<string>|null}
 */
function loadCollapsedSet(slug) {
  try {
    const raw = window.localStorage.getItem(collapseKey(slug));
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.collapsed)) return null;
    return new Set(parsed.collapsed);
  } catch {
    return null;
  }
}

/**
 * Persist collapsed feature IDs to localStorage.
 * Silently ignores errors (quota, security, …) (AC5).
 *
 * @param {string} slug
 * @param {Set<string>} collapsedSet
 */
function saveCollapsedSet(slug, collapsedSet) {
  try {
    window.localStorage.setItem(
      collapseKey(slug),
      JSON.stringify({ collapsed: Array.from(collapsedSet) }),
    );
  } catch {
    // Silently ignore — AC5: kein Crash bei defektem localStorage
  }
}

/**
 * Determine whether a feature counts as "done" for the default-mixed rule (AC3).
 * Done = (rollup.done === rollup.total && rollup.total > 0) OR
 *        feature.status ∈ {'Done', 'Archived'}.
 *
 * @param {{ status?: string, progress?: unknown, stories?: Array<{status: string}> }} feature
 * @returns {boolean}
 */
function isFeatureDone(feature) {
  if (feature.status === 'Done' || feature.status === 'Archived') return true;
  const rollup = computeRollup(feature);
  return rollup.total > 0 && rollup.done === rollup.total;
}

/**
 * Compute the default collapsed set for a list of features (AC3 — Default „Gemischt").
 * Erledigte Features eingeklappt, übrige ausgeklappt.
 *
 * @param {Array<{id: string}>} features
 * @returns {Set<string>}
 */
function computeDefaultCollapsed(features) {
  const collapsed = new Set();
  for (const f of features) {
    if (isFeatureDone(f)) collapsed.add(f.id);
  }
  return collapsed;
}

/**
 * Derive the effective collapsed set for a project:
 * - If localStorage has state → use it; new features not yet stored follow default.
 * - Otherwise → default „Gemischt" from computeDefaultCollapsed.
 *
 * @param {string} slug
 * @param {Array<{id: string}>} features
 * @returns {Set<string>}
 */
function resolveCollapsedSet(slug, features) {
  const stored = loadCollapsedSet(slug);
  if (stored === null) {
    // No persisted state → default „Gemischt" (AC3/V3)
    return computeDefaultCollapsed(features);
  }
  // Persisted state exists → use it as-is (AC5: gespeicherter Zustand hat Vorrang).
  // Our format stores only collapsed IDs.
  // - Feature in stored → collapsed.
  // - Feature absent from stored → was explicitly expanded (or "Alle ausklappen" was used).
  // Spec V5: "gespeicherter Feature-Zustand vorhanden → diesen verwenden"
  return new Set(stored);
}

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

  // ─── Idee spezifizieren (idea-specify-chat AC1/AC2, S-218) ───────────────────
  // specifyingIdea: { slug, story } | null — welche Idee gerade im Chat-Overlay
  // besprochen wird. Wird sowohl vom Karte-Klick (handleStoryClick, status ===
  // 'Idee') als auch vom „Spezifizieren"-Button (StoryCard) aufgerufen — beide
  // führen zum selben Overlay (AC1).
  const [specifyingIdea, setSpecifyingIdea] = useState(null);
  const specifyTriggerRef = useRef(null);

  const handleOpenSpecifyChat = useCallback((slug, story, triggerEl) => {
    specifyTriggerRef.current = triggerEl ?? null;
    setSpecifyingIdea({ slug, story });
  }, []);

  const handleCloseSpecifyChat = useCallback(() => {
    setSpecifyingIdea(null);
  }, []);

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

  // ─── Reload trigger (idea-specify-chat AC10-Konsument, S-218) ───────────────
  // Incremented after a successful Finalize (onSpecified) to force a re-fetch
  // in Cockpit-Modus (the load-effect below depends on it). Standalone-Modus
  // re-fetched stattdessen direkt über handleProjectSelect (imperativ).
  const [reloadToken, setReloadToken] = useState(0);

  // ─── Filter state (AC2, AC3, AC4) ───────────────────────────────────────────
  // AC2: default = all status selected (new Set(STATUS_LIFECYCLE), now 6 incl. „Idee")
  const [filterProject, setFilterProject] = useState(lockedProject ?? '');
  const [filterStatus, setFilterStatus]   = useState(() => new Set(STATUS_LIFECYCLE)); // AC2: alle vorausgewählt
  const [filterLabel, setFilterLabel]     = useState('');

  // ─── Collapse state (AC1/AC3/AC4/AC5 board-feature-collapse) ─────────────────
  // collapsedIds: Set<featureId> — which features are currently collapsed.
  // Initialized synchronously in the fetch callbacks alongside setProjects.
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());

  /**
   * Toggle a single feature's collapsed state and persist it.
   * AC1: ein-/ausklappen. AC5: Persistenz.
   */
  const handleCollapseToggle = useCallback((featureId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(featureId)) {
        next.delete(featureId);
      } else {
        next.add(featureId);
      }
      // Persist per current project slug (AC5)
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Collapse all features of the current project (AC4).
   */
  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(() => {
      const allIds = (projects[0]?.features ?? []).map((f) => f.id);
      const next = new Set(allIds);
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Expand all features of the current project (AC4).
   */
  const handleExpandAll = useCallback(() => {
    setCollapsedIds(() => {
      const next = new Set();
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Whether ANY filter is restricting the view — used for AC6 filter-wechselwirkung.
   * A restricting filter = status filter not all-selected, OR label filter active.
   */
  const hasRestrictingFilter = useMemo(() => {
    return filterStatus.size < STATUS_LIFECYCLE.length || Boolean(filterLabel);
  }, [filterStatus, filterLabel]);

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
        const projList = proj ? [proj] : [];
        setProjects(projList);
        // AC3/AC5: resolve collapse state synchronously with project load
        if (proj) {
          const slug = proj.slug ?? proj.project_slug ?? proj.repo_path ?? null;
          if (slug) setCollapsedIds(resolveCollapsedSet(slug, proj.features ?? []));
        }
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
            const projList = filtered.length > 0 ? filtered : all;
            setProjects(projList);
            // AC3/AC5: resolve collapse state for fallback
            if (projList.length > 0) {
              const p = projList[0];
              const slug = p.slug ?? p.project_slug ?? p.repo_path ?? null;
              if (slug) setCollapsedIds(resolveCollapsedSet(slug, p.features ?? []));
            }
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
  }, [lockedProject, reloadToken]); // re-run if locked project changes OR a reload was requested (AC10)

  // ─── STANDALONE: load single project when user clicks (AC6) ─────────────────
  const handleProjectSelect = useCallback((slug) => {
    setSelectedSlug(slug);
    setLoadState('loading');
    setLoadError('');
    setProjects([]);
    setCollapsedIds(new Set()); // reset while loading

    fetch(`/api/board/projects/${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        const proj = data.project ?? null;
        setProjects(proj ? [proj] : []);
        // AC3/AC5: resolve collapse state synchronously with project load
        if (proj) {
          const projSlug = proj.slug ?? proj.project_slug ?? proj.repo_path ?? null;
          if (projSlug) setCollapsedIds(resolveCollapsedSet(projSlug, proj.features ?? []));
        }
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
  // idea-specify-chat AC1 (S-218): ein Klick auf eine Idee-Karte (status === 'Idee')
  // öffnet stattdessen das Spezifizieren-Chat-Overlay (handleOpenSpecifyChat) —
  // keine Detail-Ansicht, kein Tab-Wechsel.
  const handleStoryClick = useCallback((slug, story, triggerEl) => {
    if (story.status === 'Idee') {
      handleOpenSpecifyChat(slug, story, triggerEl);
      return;
    }

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
  }, [handleOpenSpecifyChat]);

  // ─── onSpecified: Board-Re-Fetch nach erfolgreichem Finalize (AC10) ──────────
  // Cockpit-Modus: reloadToken hochzählen → Load-Effect (oben) fetcht neu.
  // Standalone-Modus: direkt handleProjectSelect erneut aufrufen (imperativer
  // Re-Fetch desselben Projekts, wiederverwendet den bestehenden Mechanismus).
  const handleSpecified = useCallback((_slug) => {
    if (isStandalone) {
      if (selectedSlug) handleProjectSelect(selectedSlug);
    } else {
      setReloadToken((t) => t + 1);
    }
  }, [isStandalone, selectedSlug, handleProjectSelect]);

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
            // AC2/AC3: filterStatus is always a non-empty Set (all STATUS_LIFECYCLE by default);
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

      {/* idea-specify-chat AC1 (S-218): Chat-Overlay über dem Board (kein Tab-Wechsel) */}
      {specifyingIdea && (
        <IdeaSpecifyChatModal
          projectSlug={specifyingIdea.slug}
          story={specifyingIdea.story}
          onClose={handleCloseSpecifyChat}
          onSpecified={handleSpecified}
          triggerRef={specifyTriggerRef}
        />
      )}

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
              collapsedIds={collapsedIds}
              allFeatureIds={(projects[0]?.features ?? []).map((f) => f.id)}
              onCollapseAll={handleCollapseAll}
              onExpandAll={handleExpandAll}
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
                    ? (story, triggerEl) => handleStoryClick(currentProjectSlug, story, triggerEl)
                    : null}
                  onSpecifyIdea={currentProjectSlug
                    ? (story, triggerEl) => handleOpenSpecifyChat(currentProjectSlug, story, triggerEl)
                    : null}
                  collapsedIds={collapsedIds}
                  onCollapseToggle={handleCollapseToggle}
                  hasRestrictingFilter={hasRestrictingFilter}
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
              collapsedIds={collapsedIds}
              allFeatureIds={(projects[0]?.features ?? []).map((f) => f.id)}
              onCollapseAll={handleCollapseAll}
              onExpandAll={handleExpandAll}
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
                    ? (story, triggerEl) => handleStoryClick(currentProjectSlug, story, triggerEl)
                    : null}
                  onSpecifyIdea={currentProjectSlug
                    ? (story, triggerEl) => handleOpenSpecifyChat(currentProjectSlug, story, triggerEl)
                    : null}
                  collapsedIds={collapsedIds}
                  onCollapseToggle={handleCollapseToggle}
                  hasRestrictingFilter={hasRestrictingFilter}
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
 * Also contains Alle-ein-/ausklappen-Schalter (AC4 board-feature-collapse).
 *
 * AC4 (studis-kanban-board-ux): Status-Filter as click-toggle popover.
 *   Button "Status (n/N) ▾" opens a floating panel with checkboxes.
 *   Closes on outside click and Esc. Button carries aria-expanded/aria-controls.
 *
 * AC2 (studis-kanban-board-ux): default = all selected (passed in from parent);
 *   N = statusOptions.length (6 incl. „Idee", ideen-inbox AC1).
 *
 * AC4 (board-feature-collapse): "Alle einklappen" / "Alle ausklappen" Schalter.
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
 *   collapsedIds?: Set<string>,
 *   allFeatureIds?: string[],
 *   onCollapseAll?: () => void,
 *   onExpandAll?: () => void,
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
  collapsedIds,
  allFeatureIds,
  onCollapseAll,
  onExpandAll,
}) {
  // AC4 (board-feature-collapse): derive whether any feature is collapsed/expanded
  // to decide which button to show.
  const allCollapsed = useMemo(() => {
    if (!allFeatureIds || allFeatureIds.length === 0 || !collapsedIds) return false;
    return allFeatureIds.every((id) => collapsedIds.has(id));
  }, [allFeatureIds, collapsedIds]);
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

  // AC4: button label "Status (n/N) ▾"
  const checkedCount = filterStatus.size;
  const totalCount   = statusOptions.length;
  const statusLabel  = `Status (${checkedCount}/${totalCount}) ▾`;

  // "Any filter active" determines whether reset button appears.
  // AC2: all selected is NOT a "filter active" state; fewer than all OR label/project IS active.
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

      {/* AC4 (board-feature-collapse): „Alle einklappen" / „Alle ausklappen" */}
      {allFeatureIds && allFeatureIds.length > 0 && onCollapseAll && onExpandAll && (
        <button
          type="button"
          style={styles.collapseAllBtn}
          onClick={allCollapsed ? onExpandAll : onCollapseAll}
          aria-label={allCollapsed ? 'Alle Features ausklappen' : 'Alle Features einklappen'}
          aria-pressed={allCollapsed}
          data-testid="collapse-all-btn"
        >
          {allCollapsed ? '▾ Alle ausklappen' : '▸ Alle einklappen'}
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
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   collapsedIds?: Set<string>,
 *   onCollapseToggle?: (featureId: string) => void,
 *   hasRestrictingFilter?: boolean,
 * }} props
 */
function ProjectSection({ project, onOpenSpec, onStoryClick, onSpecifyIdea, collapsedIds, onCollapseToggle, hasRestrictingFilter }) {
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
          onSpecifyIdea={onSpecifyIdea}
          isCollapsed={collapsedIds ? collapsedIds.has(feature.id) : false}
          onCollapseToggle={onCollapseToggle}
          hasRestrictingFilter={hasRestrictingFilter ?? false}
        />
      ))}
    </section>
  );
}

// ── FeatureRow ────────────────────────────────────────────────────────────────

/**
 * One feature row: collapse-button (AC1/AC7), title, rollup bar (AC5),
 * detail-button (AC2), then stories in status columns (AC4).
 *
 * AC1: Auf-/Zu-Schalter (Collapse-Button) blendet Story-Spalten aus.
 * AC2: Detail-Panel (Ziel/DoD) über separaten Schalter; bei eingeklappt verborgen.
 * AC6: Filter-Wechselwirkung — temporär ausgeklappt wenn Treffer vorhanden + Filter aktiv.
 * AC7: aria-expanded + aria-controls, Fokusring erhalten, Chevron aria-hidden.
 *
 * @param {{
 *   feature: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   isCollapsed?: boolean,
 *   onCollapseToggle?: (featureId: string) => void,
 *   hasRestrictingFilter?: boolean,
 * }} props
 */
function FeatureRow({ feature, onOpenSpec, onStoryClick, onSpecifyIdea, isCollapsed = false, onCollapseToggle, hasRestrictingFilter = false }) {
  // AC2: separate detail-panel open/close state (entkoppelt vom Einklappen)
  const [detailOpen, setDetailOpen] = useState(false);
  const rollup = computeRollup(feature);
  // stories prop contains FILTERED stories (from filteredProjects — only matching filter)
  const stories = Array.isArray(feature.stories) ? feature.stories : [];

  // AC6: Wenn Filter aktiv UND Feature hat passende Stories → temporär ausgeklappt anzeigen.
  // Diese Aufklappung überschreibt isCollapsed NUR für die Anzeige, nie den gespeicherten Zustand.
  const hasFilteredStories = hasRestrictingFilter && stories.length > 0;
  // Effective collapsed: eingeklappt wenn isCollapsed UND (kein Filter ODER keine Treffer)
  const effectivelyCollapsed = isCollapsed && !hasFilteredStories;

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

  const handleCollapseClick = useCallback(() => {
    if (onCollapseToggle) onCollapseToggle(feature.id);
  }, [feature.id, onCollapseToggle]);

  const handleDetailClick = useCallback(() => {
    setDetailOpen((prev) => !prev);
  }, []);

  const storiesRegionId = `feature-stories-${feature.id}`;
  const detailRegionId  = `feature-detail-${feature.id}`;

  return (
    <div
      style={styles.featureRow}
      data-feature={feature.id}
      aria-label={`Feature: ${feature.title || feature.id}`}
    >
      {/* Feature header */}
      <div style={styles.featureHeader}>
        {/* AC1/AC7: Collapse-Button — blendet Story-Spalten aus/ein */}
        <button
          type="button"
          style={styles.featureCollapseBtn}
          onClick={handleCollapseClick}
          aria-expanded={!effectivelyCollapsed}
          aria-controls={storiesRegionId}
          aria-label={effectivelyCollapsed
            ? `Feature ${feature.title || feature.id} ausklappen`
            : `Feature ${feature.title || feature.id} einklappen`}
          data-testid={`feature-collapse-btn-${feature.id}`}
        >
          {/* Chevron aria-hidden (AC7) */}
          <span style={styles.featureTitleChevron} aria-hidden="true">
            {effectivelyCollapsed ? '▸' : '▾'}
          </span>
          {feature.title || feature.id}
        </button>

        {feature.status && (
          <StatusBadge status={feature.status} />
        )}
        {/* Rollup bar (AC5) */}
        <RollupBar done={rollup.done} total={rollup.total} />

        {/* AC2: Separater Details-Schalter (Ziel/DoD) — nur sichtbar wenn ausgeklappt */}
        {!effectivelyCollapsed && (
          <button
            type="button"
            style={styles.featureTitleBtn}
            onClick={handleDetailClick}
            aria-expanded={detailOpen}
            aria-controls={detailOpen ? detailRegionId : undefined}
            data-testid={`feature-title-btn-${feature.id}`}
            aria-label={`Details für Feature ${feature.title || feature.id} ${detailOpen ? 'schließen' : 'öffnen'}`}
          >
            <span aria-hidden="true">{detailOpen ? 'ⓘ ▾' : 'ⓘ ▸'}</span>
          </button>
        )}
      </div>

      {/* AC2: Feature detail panel — shown when detail expanded AND feature not collapsed */}
      {!effectivelyCollapsed && detailOpen && (
        <div
          id={detailRegionId}
          style={styles.featureDetail}
          data-testid={`feature-detail-${feature.id}`}
          aria-label={`Details für Feature: ${feature.title || feature.id}`}
        >
          <FeatureDetailPanel feature={feature} />
        </div>
      )}

      {/* AC1: Stories region — hidden when collapsed */}
      {!effectivelyCollapsed && (
        <div id={storiesRegionId}>
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
                  onSpecifyIdea={onSpecifyIdea}
                />
              ))}
            </div>
          )}

          {stories.length === 0 && (
            <p style={styles.hintMsg}>Keine Stories in diesem Feature.</p>
          )}
        </div>
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
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 * }} props
 */
function StatusColumn({ status, stories, onOpenSpec, onStoryClick, onSpecifyIdea }) {
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
          onSpecifyIdea={onSpecifyIdea}
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
 * AC4 (autonome-board-abarbeitung) — Ready-Badge für To-Do-Stories; blocked_reason als
 *        Hinweiszeile unter dem Titel für Blocked-Stories.
 *
 * idea-specify-chat AC1/AC2 (S-218) — für `status === 'Idee'` UND `onSpecifyIdea`
 * vorhanden zusätzlich ein kleiner „Spezifizieren"-Trigger NEBEN der (weiterhin
 * klickbaren, dasselbe Chat-Overlay öffnenden) Karte — additiv, kein
 * verschachteltes `<button>`-in-`<button>` (ungültiges HTML). Beide Auslöser
 * (Karte, Button) rufen dieselbe Handler-Signatur `(story, triggerEl)` auf.
 *
 * @param {{
 *   story: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 * }} props
 */
function StoryCard({ story, onOpenSpec, onStoryClick, onSpecifyIdea }) {
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
        {/* AC4: Ready-Badge for To-Do stories */}
        {story.status === 'To Do' && story.ready === true && (
          <span
            style={styles.readyBadge}
            aria-label="Story ist ready für autonome Abarbeitung"
            title="Ready — alle Voraussetzungen erfüllt"
            data-testid={`ready-badge-${story.id}`}
          >
            ready
          </span>
        )}
      </div>

      {story.title && (
        <p style={styles.storyTitle}>{story.title}</p>
      )}

      {/* AC4: blocked_reason hint for Blocked stories */}
      {story.status === 'Blocked' && story.blocked_reason && (
        <p
          style={styles.blockedReason}
          aria-label={`Grund: ${story.blocked_reason}`}
          title={story.blocked_reason}
          data-testid={`blocked-reason-${story.id}`}
        >
          {story.blocked_reason}
        </p>
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

  // AC3 (story-detail-ansicht): when onStoryClick is provided, wrap the card in a button.
  // idea-specify-chat AC1 (S-218): for status === 'Idee', the click opens the
  // Spezifizieren-Chat-Overlay instead of the detail view — reflected in the
  // aria-label for screen-reader clarity.
  if (onStoryClick) {
    const isIdea = story.status === 'Idee';
    const cardButton = (
      <button
        type="button"
        style={{ ...styles.storyCard, ...styles.storyCardBtn }}
        aria-label={isIdea ? `Idee spezifizieren: ${story.title || story.id}` : `Story: ${story.title || story.id}`}
        data-story={story.id}
        onClick={(e) => onStoryClick(story, e.currentTarget)}
        data-testid={`story-card-btn-${story.id}`}
      >
        {cardContent}
      </button>
    );

    // idea-specify-chat AC2 (S-218): additiver „Spezifizieren"-Trigger NEBEN
    // der Karte (kein <button> in <button>) — gleiches Overlay wie der Karte-Klick.
    if (isIdea && onSpecifyIdea) {
      return (
        <div style={styles.ideaCardWrapper} data-testid={`idea-card-wrapper-${story.id}`}>
          {cardButton}
          <button
            type="button"
            style={styles.ideaSpecifyBtn}
            onClick={(e) => onSpecifyIdea(story, e.currentTarget)}
            aria-label={`Spezifizieren: ${story.title || story.id}`}
            data-testid={`idea-specify-btn-${story.id}`}
          >
            Spezifizieren
          </button>
        </div>
      );
    }

    return cardButton;
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
 * Story-Detail-Ansicht (AC3/AC4 story-detail-ansicht; AC5/AC6 story-detail-yaml-fallback).
 *
 * Blöcke:
 *   (1) Zeiten       — Start / Ende (auch aus YAML) / Dauer
 *   (2) Agenten-Flow — chronologisch; differenzierter Leer-Zustand (AC5 yaml-fallback)
 *   (3) Soll-Ist     — ep_est↔ep_act, tok_est↔tok_total, Abweichung %
 *   (4) Verknüpfungen — Branch + PR-Link (AC6 yaml-fallback); ausgeblendet wenn beide null
 *
 * Rückweg zum Board per onBack (AC3 Rückweg vorhanden).
 * Touch-Targets ≥ 44 px (WCAG 2.1 AA).
 * Kein dangerouslySetInnerHTML; externer PR-Link rel=noopener noreferrer (AC8 Floor).
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

          {/* ── Block 1: Zeiten (AC3; AC5 yaml-fallback — Ende aus YAML mit Badge) ── */}
          <section style={styles.detailBlock} aria-label="Zeiten" data-testid="block-zeiten">
            <h2 style={styles.detailBlockTitle}>Zeiten</h2>
            <dl style={styles.detailDl}>
              <dt style={styles.detailTerm}>Start</dt>
              <dd style={styles.detailDesc} data-testid="detail-started-at">
                {fmtTs(detailData.started_at)}
              </dd>
              <dt style={styles.detailTerm}>Ende</dt>
              <dd style={styles.detailDesc} data-testid="detail-ended-at">
                {detailData.ended_at != null ? (
                  <>
                    {fmtTs(detailData.ended_at)}
                    {detailData.ended_at_source === 'yaml' && (
                      <span
                        style={styles.yamlBadge}
                        aria-label="Ende-Zeit aus Board-YAML (done_at)"
                        title="Ende-Zeit aus Board-YAML — kein Ledger-Eintrag"
                        data-testid="ended-at-yaml-badge"
                      >
                        YAML
                      </span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt style={styles.detailTerm}>Dauer</dt>
              <dd style={styles.detailDesc} data-testid="detail-duration">
                {fmtDuration(detailData.duration)}
              </dd>
            </dl>
          </section>

          {/* ── Block 2: Agenten-Flow (AC3; AC5 yaml-fallback — differenz. Leer-Zustand) ── */}
          <section style={styles.detailBlock} aria-label="Agenten-Flow" data-testid="block-flow">
            <h2 style={styles.detailBlockTitle}>Agenten-Flow</h2>
            {(!detailData.flow || detailData.flow.length === 0) ? (
              <p style={styles.hintMsg} data-testid="flow-empty">
                {/* AC5 yaml-fallback: differenzierter Leer-Hinweis */}
                {detailData.ended_at != null
                  ? 'Vor Metrik-Erfassung abgeschlossen — kein Agenten-Flow aufgezeichnet.'
                  : 'Noch kein Flow-Lauf erfasst.'}
              </p>
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
                    {detailData.ep_est != null ? (
                      <>
                        {detailData.ep_est}
                        {detailData.ep_est_source === 'yaml' && (
                          <span
                            style={styles.vorabBadge}
                            aria-label="Vorab-Schätzung aus Story-YAML"
                            title="Vorab-Schätzung aus Story-YAML — noch kein Flow-Lauf"
                            data-testid="ep-est-vorab-badge"
                          >
                            Vorab
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="ep-act">
                    {/* AC5: Ist-Spalte leer wenn YAML-Fallback (kein Ledger-Wert) */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtNum(detailData.ep_act)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.ep_dev_pct),
                  }} data-testid="ep-dev">
                    {/* AC5: Abweichung leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtDevPct(detailData.ep_dev_pct)}
                  </td>
                </tr>
                {/* Tokens */}
                <tr data-testid="soll-ist-tok">
                  <td style={styles.flowTd}>Tokens</td>
                  <td style={styles.flowTd} data-testid="tok-est">
                    {detailData.tok_est != null ? (
                      detailData.tok_est
                    ) : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="tok-total">
                    {/* AC5: Ist-Spalte leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtNum(detailData.tok_total)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.tok_dev_pct),
                  }} data-testid="tok-dev">
                    {/* AC5: Abweichung leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtDevPct(detailData.tok_dev_pct)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* ── Block 4: Verknüpfungen (AC6 story-detail-yaml-fallback) ────────── */}
          {/* Block nur anzeigen wenn branch oder pr vorhanden (AC6: sonst ausblenden) */}
          {(detailData.branch != null || detailData.pr != null) && (
            <section
              style={styles.detailBlock}
              aria-label="Verknüpfungen"
              data-testid="block-verknuepfungen"
            >
              <h2 style={styles.detailBlockTitle}>Verknüpfungen</h2>
              <dl style={styles.detailDl}>
                {detailData.branch != null && (
                  <>
                    <dt style={styles.detailTerm}>Branch</dt>
                    <dd style={styles.detailDesc} data-testid="detail-branch">
                      <span style={styles.monoText}>{detailData.branch}</span>
                    </dd>
                  </>
                )}
                {detailData.pr != null && (
                  <>
                    <dt style={styles.detailTerm}>Pull Request</dt>
                    <dd style={styles.detailDesc} data-testid="detail-pr">
                      {/* AC8: externer Link mit rel=noopener noreferrer; kein dangerouslySetInnerHTML */}
                      <a
                        href={detailData.pr}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.prLink}
                        aria-label={`Pull Request öffnen: ${detailData.pr}`}
                      >
                        {detailData.pr}
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
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
  // ideen-inbox AC1: eigener Farbton für „Idee" (Contrast: #67e8f9 on #0f2a2a ≈ 10.5:1 — WCAG AA).
  'Idee':        { background: '#0f2a2a', color: '#67e8f9', borderColor: '#164e4e' },
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
  // AC4: button "Status (n/N) ▾"
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

  // AC1 (board-feature-collapse): Collapse-Button — blendet Story-Spalten aus
  // Der Hauptschalter mit Chevron + Titel; flex:1 damit er den Raum ausfüllt.
  featureCollapseBtn: {
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

  // AC2 (board-feature-collapse): Detail-Schalter (Ziel/DoD) — separater, kleiner Button
  // kein flex:1; rechts positioniert im Header
  featureTitleBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    padding: '2px 6px',
    fontSize: 11,
    color: '#6b7280',
    cursor: 'pointer',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
    // Focus ring preserved (no outline:none)
  },
  featureTitleChevron: {
    fontSize: 10,
    color: '#6b7280',
    flexShrink: 0,
  },

  // AC4 (board-feature-collapse): „Alle einklappen/ausklappen"-Button in der FilterBar
  collapseAllBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
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
  // gridTemplateColumns folgt STATUS_LIFECYCLE.length dynamisch (ideen-inbox AC1
  // fügt „Idee" hinzu — 6 statt 5 Spalten; kein hartcodiertes repeat(5,...) mehr).
  statusColumns: {
    display: 'grid',
    gridTemplateColumns: `repeat(${STATUS_LIFECYCLE.length}, minmax(0, 1fr))`,
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

  // AC4 (autonome-board-abarbeitung): ready badge — dezent, grün-tonal
  // #86efac on #1a2a1a: contrast ≈ 5.5:1 — WCAG AA compliant
  readyBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1a2a1a',
    color: '#86efac',
    border: '1px solid #14532d',
    flexShrink: 0,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },

  // AC4: blocked_reason display for Blocked stories
  // #fbbf24 on #1a1a1a: contrast ≈ 6.9:1 — WCAG AA compliant
  blockedReason: {
    margin: '2px 0 4px',
    fontSize: 11,
    color: '#fbbf24',
    lineHeight: 1.4,
    fontStyle: 'italic',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    // Allow wrapping for accessibility — do not force single line for long reasons
    whiteSpace: 'normal',
    wordBreak: 'break-word',
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

  // ── Idee-Karte + Spezifizieren-Trigger (idea-specify-chat AC1/AC2, S-218)
  ideaCardWrapper: {
    marginBottom: 4,
  },

  ideaSpecifyBtn: {
    display: 'block',
    width: '100%',
    marginTop: 2,
    minHeight: 32,
    padding: '4px 10px',
    background: 'transparent',
    border: '1px dashed #374151',
    borderRadius: 4,
    color: '#9ca3af',
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'center',
    // Contrast: #9ca3af on transparent (effektiv #1a1a1a Karten-Hintergrund) ≈ 5.6:1 (WCAG AA).
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

  // story-detail-yaml-fallback AC5: YAML-Badge für ended_at aus Board-YAML (done_at)
  // Contrast: #93c5fd on #0d1a2a ≈ 7.1:1 — WCAG AA compliant
  yamlBadge: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#0d1a2a',
    color: '#93c5fd',
    border: '1px solid #1e3a5f',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    verticalAlign: 'middle',
    fontFamily: 'inherit',
  },

  // story-detail-yaml-fallback AC6: monospace Text für Branch-Namen
  monoText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#d1d5db',
  },

  // story-detail-yaml-fallback AC6: PR-Link (externer Link, noopener noreferrer)
  // Contrast: #93c5fd on #111 ≈ 7.1:1 — WCAG AA compliant
  prLink: {
    color: '#93c5fd',
    fontSize: 12,
    fontFamily: 'monospace',
    textDecoration: 'underline',
    // Focus ring preserved (no outline:none)
  },

  // AC5 (story-detail-ansicht): Vorab-Badge — kennzeichnet Schätzung aus Story-YAML
  // Contrast: #fbbf24 on #1a1500 ≈ 10.9:1 — WCAG AA compliant
  vorabBadge: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1a1500',
    color: '#fbbf24',
    border: '1px solid #78350f',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    verticalAlign: 'middle',
    fontFamily: 'inherit',
  },
};
