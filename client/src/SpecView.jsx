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
 * reconcile-trigger (S-201) — Button „Konzept/Spec nachziehen" oben in der Sidebar:
 * AC1 — Button + Hinweistext nennt den ausgelösten Befehl `/agent-flow:reconcile`;
 *        Touch-Target ≥ 44 px.
 * AC2 — Klick (bei freier Session) öffnet Bestätigungsdialog (role="dialog");
 *        noch kein POST.
 * AC3 — „Starten" POSTet genau einmal {command:'/agent-flow:reconcile', projectPath}
 *        an /api/command; „Abbrechen" schließt ohne POST.
 * AC4 — Bei `GET /api/session` state:"busy" ist der Button deaktiviert
 *        (disabled-Attribut + Text-Label, nie Farbe allein); kein Dialog/POST bei Klick.
 * AC5 — **überschrieben durch reconcile-inline-feedback (S-205) AC1** — kein
 *        `onNavigate` mehr nach 202; siehe unten.
 * AC6 — 409 → sichtbare Fehleranzeige, kein onNavigate, kein Crash.
 * AC7 — Netzwerkfehler/500 → sichtbare Fehleranzeige mit Reset, kein onNavigate.
 * Gespiegelt vom „Board abarbeiten"-Muster (CockpitView.jsx FactoryWorkspace).
 *
 * reconcile-inline-feedback (S-205) — bleibt auf dem Spezifikation-Reiter, hält
 * den Lauf, meldet Fortschritt inline, refresht die Audit-Anzeige automatisch:
 * AC1 — Nach 202 wird `onNavigate` NICHT mehr aufgerufen (überschreibt
 *        reconcile-trigger AC5); stattdessen inline „Reconcile läuft…"
 *        (role="status"), Button deaktiviert (disabled + Text-Label).
 * AC2 — Solange `GET /api/session` `state:"busy"` liefert, bleibt „Reconcile
 *        läuft…" sichtbar, Button deaktiviert (bestehendes Poll-Muster,
 *        kein zusätzliches Dauer-Polling).
 * AC3 — Erstmaliges nicht-`busy` nach `busy` (bzw. sofort bei sehr kurzem Lauf,
 *        Edge-Case) → „Fertig" (role="status"), Button wieder auslösbar.
 * AC4 — Beim Übergang auf „Fertig" wird `AuditSpecView` automatisch genau
 *        einmal neu geladen (Reload-Signal-Zähler, kein manueller Klick nötig).
 * AC5 — Erkennbarer PR-Bezug (URL oder `#<nummer>`) im Audit-Inhalt → dezenter
 *        Link/Hinweis; sonst kein Element (graceful absence, best-effort).
 * AC6 — Backend: `GET /api/session` meldet `busy` solange ein Reconcile-Job
 *        in Flight ist (CommandService/JobLock-Zustand sichtbar gemacht).
 * AC7 — Backend: `PtySessionRegistry` verwirft eine Session mit aktivem Job
 *        nicht idle — auch ohne WebSocket-Zuschauer.
 * AC8 — Bestätigt der Poll den Abschluss nicht innerhalb eines beschränkten
 *        Sicherheitsfensters (Session flippt nie zurück / Poll schlägt
 *        wiederholt fehl) → neutraler Text-Hinweis statt Endlos-Spinner;
 *        „Audit-Spec anzeigen" bleibt manuell bedienbar.
 * AC9 — 409/500/Netzwerkfehler weiterhin inline Fehleranzeige mit Reset, ohne
 *        `onNavigate`, ohne Crash (Regression zu reconcile-trigger AC6/AC7).
 *
 * spec-audit-view (S-203) — Sekundär-Button „Audit-Spec anzeigen" direkt
 * unterhalb des ReconcileTrigger-Buttons:
 * AC1 — Sekundär-Button „Audit-Spec anzeigen" direkt unterhalb des
 *        ReconcileTrigger-Buttons; Touch-Target ≥ 44 px, Zustand per Text
 *        erkennbar (nicht nur Farbe).
 * AC2 — Klick löst genau einen GET .../docs/raw?path=docs/spec-audit.md aus;
 *        Markdown wird über MarkdownLite gerendert und ist sichtbar.
 * AC3 — 404 (Datei fehlt) → freundlicher Hinweis „noch kein Reconcile-Lauf"
 *        (role="status"), keine rohe Fehlermeldung, kein Crash.
 * AC4 — Zugänglicher Lade-Zustand während des Ladens; Netzwerkfehler/500/
 *        unerwarteter Status → sichtbare, neutrale Fehleranzeige (role="alert"),
 *        kein Crash, übriger Reiter bleibt bedienbar.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/board/projects/:slug/docs Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *   - Markdown via vorhandenen markdownLite-Renderer (kein fremder Parser).
 *   - reconcile-trigger: kein neuer Endpunkt — bestehender allowlisted/sanitisierter
 *     /api/command-Kanal; Bestätigungsdialog verhindert versehentliches Auslösen.
 *   - spec-audit-view: kein neuer Endpunkt — wiederverwendet den bestehenden
 *     docs/raw-Endpunkt mit festem, nicht nutzergesteuertem Pfad
 *     (docs/spec-audit.md — kein Traversal-Vektor).
 *   - reconcile-inline-feedback: PR-Link nur aus dem gerenderten Audit-Inhalt
 *     (fester https?://-Präfix), `target="_blank"` stets mit
 *     `rel="noopener noreferrer"` (kein offener Redirect).
 *
 * A11y (WCAG 2.1 AA):
 *   - Navigation als <nav> mit aria-label.
 *   - Aktives Dokument mit aria-current="page".
 *   - Ladezustand aria-busy auf dem Inhalts-Container.
 *   - Fokusring nie unterdrückt.
 *   - Touch-Targets ≥ 44 px für Nav-Buttons, den Reconcile-Button und den
 *     Audit-Spec-Button.
 *   - Lauf-/Fertig-/Degraded-Zustände (S-205) als Text (role="status",
 *     aria-live="polite"), nicht nur Farbe.
 *
 * Covers (reconcile-trigger): AC1, AC2, AC3, AC4, AC6, AC7 (AC5 überschrieben — siehe reconcile-inline-feedback AC1)
 * Covers (spec-audit-view): AC1, AC2, AC3, AC4
 * Covers (reconcile-inline-feedback): AC1, AC2, AC3, AC4, AC5, AC8, AC9 (AC6/AC7 sind Backend — siehe src/routers/session.js, src/PtySessionRegistry.js)
 *
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 *   onNavigate?: (view: string) => void,
 *   fetchFn?: Function,
 *   reconcilePollInterval?: number,
 *   reconcileSafetyWindowMs?: number,
 *   reconcileMaxConsecutiveFailures?: number,
 * }} props
 *   projectSlug   — Slug des aktiven Projekts (aus CockpitView/BoardAggregator)
 *   initialPath   — optional: direkt zu öffnende Datei (AC5, z.B. via Story-Klick)
 *   onNavigate    — nicht mehr genutzt vom Reconcile-Trigger (S-205 AC1 überschreibt
 *                    reconcile-trigger AC5); Prop bleibt für Signatur-Kompatibilität
 *                    mit CockpitView erhalten, aber ungenutzt.
 *   fetchFn       — injectable für Tests (default: globalThis.fetch); vom
 *                    Reconcile-Trigger UND vom Audit-Spec-Button genutzt
 *                    (Doku-Laden im Nav-Baum bleibt unverändert).
 *   reconcilePollInterval, reconcileSafetyWindowMs, reconcileMaxConsecutiveFailures —
 *                    injectable Test-Overrides für den Reconcile-Session-Poll
 *                    (S-205 AC2/AC8; Defaults siehe ReconcileTrigger unten).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
 *   onNavigate?: (view: string) => void,
 *   fetchFn?: Function,
 *   reconcilePollInterval?: number,
 *   reconcileSafetyWindowMs?: number,
 *   reconcileMaxConsecutiveFailures?: number,
 * }} props
 */
export function SpecView({
  projectSlug,
  initialPath,
  // Kept for CockpitView signature compat — no longer called (S-205 AC1 überschreibt reconcile-trigger AC5).
  onNavigate: _onNavigate,
  fetchFn,
  reconcilePollInterval,
  reconcileSafetyWindowMs,
  reconcileMaxConsecutiveFailures,
}) {
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

  // ── reconcile-inline-feedback (S-205) AC4: Audit-Reload-Signal ────────────
  // Zähler, der bei jedem Reconcile-Abschluss ("Fertig") hochgezählt wird.
  // AuditSpecView beobachtet die Änderung (reloadSignal-Prop) und lädt
  // daraufhin automatisch genau einmal neu (Edge-Case „Doppel-Reload").
  const [auditReloadSignal, setAuditReloadSignal] = useState(0);
  const handleReconcileDone = useCallback(() => {
    setAuditReloadSignal((n) => n + 1);
  }, []);

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
      {/* Linke Spalte: Reconcile-Trigger + Filter + Navigation */}
      <div style={styles.sidebar}>
        {/* reconcile-trigger (S-201) + reconcile-inline-feedback (S-205):
            „Konzept/Spec nachziehen"-Button, bleibt auf dem Reiter (kein
            onNavigate mehr), meldet Lauf/Fertig inline. */}
        <ReconcileTrigger
          projectSlug={projectSlug}
          fetchFn={fetchFn}
          onDone={handleReconcileDone}
          pollInterval={reconcilePollInterval}
          safetyWindowMs={reconcileSafetyWindowMs}
          maxConsecutiveFailures={reconcileMaxConsecutiveFailures}
        />

        {/* spec-audit-view (S-203): „Audit-Spec anzeigen"-Button, direkt unterhalb.
            reloadSignal (S-205 AC4): automatischer Reload nach Reconcile-Abschluss. */}
        <AuditSpecView
          projectSlug={projectSlug}
          fetchFn={fetchFn}
          reloadSignal={auditReloadSignal}
        />

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

// ── ReconcileTrigger (reconcile-trigger AC1–AC4/AC6/AC7 + reconcile-inline-feedback AC1–AC3/AC8/AC9) ──

/** Session poll interval in ms — matches CockpitView/FactoryWorkspace default. */
const RECONCILE_SESSION_POLL_MS = 3_000;

/**
 * reconcile-inline-feedback (S-205) AC8: bounded safety window against an
 * endless spinner — if the session never flips back to non-busy (or the poll
 * fails repeatedly) within this window, the UI degrades to a neutral hint.
 */
const RECONCILE_SAFETY_WINDOW_MS = 5 * 60 * 1000; // 5 min

/** AC8: max consecutive /api/session poll failures before degrading. */
const RECONCILE_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * ReconcileTrigger — „Konzept/Spec nachziehen"-Button
 * (reconcile-trigger AC1–AC4/AC6/AC7 + reconcile-inline-feedback AC1–AC3/AC8/AC9).
 *
 * Gespiegelt vom „Board abarbeiten"-Knopf (CockpitView.jsx FactoryWorkspace):
 * Bestätigungsdialog vor dem doku-ändernden Lauf, Busy-Guard via GET /api/session,
 * POST /api/command {command:'/agent-flow:reconcile', projectPath}.
 *
 * reconcile-inline-feedback (S-205): nach 202 bleibt die Ansicht auf dem Reiter
 * (kein onNavigate mehr, überschreibt reconcile-trigger AC5) — stattdessen
 * inline „Reconcile läuft…" (AC1), abgeleitet aus demselben Busy-Poll, der
 * bereits für AC4 läuft (kein zusätzliches Dauer-Polling, NFR Performance).
 * Kippt der Poll von busy → nicht-busy (oder ist der allererste Poll nach dem
 * Start bereits nicht-busy — Edge-Case „Race busy→ready sofort"), wechselt
 * die Anzeige auf „Fertig" (AC3) und `onDone()` wird genau einmal aufgerufen
 * (AuditSpecView-Reload-Signal, AC4). Ein `reconcileStateRef` hält den
 * aktuellen Phasen-Wert synchron zum State, damit der Poll-Handler (der aus
 * einem einmalig registrierten Effect heraus läuft) nie mit einem veralteten
 * Closure-Wert vergleicht — das verhindert sowohl den Doppel-Reload
 * (Edge-Case) als auch verpasste Übergänge.
 *
 * AC8 (robuste Degradierung): `runStartRef` verankert den Start-Zeitpunkt des
 * eigenen Laufs; `consecutiveFailRef` zählt aufeinanderfolgende Poll-Fehler
 * (Netzwerkfehler oder !res.ok). Überschreitet die verstrichene Zeit das
 * Sicherheitsfenster ODER die Fehlerzahl den Schwellwert, während der Lauf
 * noch als „running" geführt wird, degradiert die Anzeige neutral (kein
 * Endlos-Spinner, kein Crash) — der separate „Audit-Spec anzeigen"-Button
 * (AuditSpecView) bleibt unabhängig davon manuell bedienbar.
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   onDone?: () => void,
 *   pollInterval?: number,
 *   safetyWindowMs?: number,
 *   maxConsecutiveFailures?: number,
 * }} props
 *   fetchFn                — injectable for tests (default: globalThis.fetch)
 *   onDone                 — (AC4) aufgerufen genau einmal beim Übergang auf „Fertig"
 *   pollInterval           — session poll interval in ms (default: RECONCILE_SESSION_POLL_MS)
 *   safetyWindowMs         — (AC8) Sicherheitsfenster in ms (default: RECONCILE_SAFETY_WINDOW_MS)
 *   maxConsecutiveFailures — (AC8) max. aufeinanderfolgende Poll-Fehler (default: RECONCILE_MAX_CONSECUTIVE_FAILURES)
 */
function ReconcileTrigger({
  projectSlug,
  fetchFn,
  onDone,
  pollInterval = RECONCILE_SESSION_POLL_MS,
  safetyWindowMs = RECONCILE_SAFETY_WINDOW_MS,
  maxConsecutiveFailures = RECONCILE_MAX_CONSECUTIVE_FAILURES,
}) {
  // Stable ref so the poll effect doesn't re-register on every render.
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // ── Session busy state (AC4) ──────────────────────────────────────────────
  /** 'idle' | 'running' — derived from GET /api/session state */
  const [sessionRunState, setSessionRunState] = useState('idle');

  // ── Trigger state (AC2, AC3, AC6, AC7 + reconcile-inline-feedback AC1–AC3, AC8, AC9) ──
  /** 'idle' | 'confirm' | 'starting' | 'running' | 'done' | 'degraded' | 'error' */
  const [reconcileState, setReconcileState] = useState('idle');
  const [reconcileError, setReconcileError] = useState(null);

  // Kept in sync with reconcileState so the poll-effect closure (registered
  // once) always reads the CURRENT phase, not a stale one (avoids the
  // Doppel-Reload edge-case and missed running→done/degraded transitions).
  const reconcileStateRef = useRef('idle');
  const runStartRef = useRef(null);
  const consecutiveFailRef = useRef(0);

  /** Transition helper — keeps state + ref in lockstep. */
  const setPhase = useCallback((next) => {
    reconcileStateRef.current = next;
    setReconcileState(next);
  }, []);

  /** AC3/AC8: end this trigger's own run, transitioning to 'done' or 'degraded'. */
  const finishRun = useCallback((nextPhase) => {
    setPhase(nextPhase);
    runStartRef.current = null;
    consecutiveFailRef.current = 0;
    if (nextPhase === 'done') {
      onDoneRef.current?.(); // AC4 — exactly once per completion
    }
  }, [setPhase]);

  // ── Poll /api/session — single continuous poll (NFR: kein zusätzliches
  // Dauer-Polling über den bestehenden Busy-Poll hinaus) serves BOTH the
  // generic busy-guard (reconcile-trigger AC4) AND this trigger's own
  // running→done/degraded tracking (AC2/AC3/AC8). ────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      let ok = false;
      let busy = false;
      try {
        const res = await fetchFnRef.current('/api/session');
        if (res.ok) {
          const json = await res.json();
          ok = true;
          busy = json.state === 'busy';
        }
      } catch {
        ok = false; // network error — handled below (AC8)
      }

      if (cancelled) return;

      if (ok) {
        setSessionRunState(busy ? 'running' : 'idle');
      }

      // AC2/AC3/AC8: track this trigger's own run.
      if (reconcileStateRef.current === 'running') {
        if (ok) {
          consecutiveFailRef.current = 0;
          if (!busy) {
            // AC3 (+ Edge-Case „Race busy→ready sofort"): Übergang zu „Fertig".
            finishRun('done');
            return;
          }
        } else {
          consecutiveFailRef.current += 1;
        }

        const elapsed = Date.now() - (runStartRef.current ?? Date.now());
        const timedOut = elapsed >= safetyWindowMs;
        const tooManyFailures = consecutiveFailRef.current >= maxConsecutiveFailures;
        if (timedOut || tooManyFailures) {
          // AC8: robuste Degradierung — kein Endlos-Spinner, kein Crash.
          finishRun('degraded');
        }
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval, safetyWindowMs, maxConsecutiveFailures, finishRun]);

  const isSessionBusy = sessionRunState === 'running';
  const isOwnRunActive = reconcileState === 'running';

  // AC1/AC4: button disabled when session busy, a start is in flight, or this
  // trigger's own run is active.
  const isBtnDisabled = isSessionBusy || reconcileState === 'starting' || isOwnRunActive;

  // Button remains visible (and re-enables) across idle/running/done/degraded —
  // only hidden during the brief 'starting' POST-in-flight window and during
  // 'error' (replaced by the error alert + reset, unchanged AC6/AC7/AC9 behaviour).
  const showButton = ['idle', 'running', 'done', 'degraded'].includes(reconcileState);

  const handleClick = useCallback(() => {
    setPhase('confirm');
    setReconcileError(null);
  }, [setPhase]);

  const handleCancel = useCallback(() => {
    setPhase('idle');
    setReconcileError(null);
  }, [setPhase]);

  const handleConfirm = useCallback(async () => {
    setPhase('starting');
    setReconcileError(null);

    // AC3 (reconcile-trigger): include projectPath when an active project is set
    // (backwards-compat with the global session when absent, per Edge-Cases).
    const body = { command: '/agent-flow:reconcile' };
    if (projectSlug && typeof projectSlug === 'string' && projectSlug.trim()) {
      body.projectPath = projectSlug.trim();
    }

    let res;
    try {
      res = await fetchFnRef.current('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // AC9: network error → visible error, no onNavigate
      setPhase('error');
      setReconcileError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // reconcile-inline-feedback AC1: bleibt auf dem Reiter — kein onNavigate
      // mehr (überschreibt reconcile-trigger AC5). Inline „Reconcile läuft…".
      runStartRef.current = Date.now();
      consecutiveFailRef.current = 0;
      setPhase('running');
      setSessionRunState('running'); // optimistic update — poll will confirm
      return;
    }
    if (res.status === 409) {
      // AC6 (reconcile-trigger) / AC9 (reconcile-inline-feedback): job already
      // running → visible error, no onNavigate
      setSessionRunState('running');
      setPhase('error');
      setReconcileError('Ein Job läuft bereits — bitte warten.');
      return;
    }
    // AC7 (reconcile-trigger) / AC9 (reconcile-inline-feedback): 500/unexpected
    // status → visible error, no onNavigate
    setPhase('error');
    setReconcileError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [projectSlug, setPhase]);

  return (
    <div style={styles.reconcileBox} data-testid="reconcile-box">
      <div style={styles.reconcileHeader}>Konzept/Spec nachziehen</div>
      {/* AC1: Hinweistext nennt den ausgelösten Befehl */}
      <p style={styles.reconcileHint}>
        Startet <code style={styles.code}>/agent-flow:reconcile</code> — gleicht
        Konzept, Architektur und Specs wieder mit Vorlage und Code ab.
      </p>

      {showButton && (
        <button
          type="button"
          style={isBtnDisabled ? styles.btnReconcileDisabled : styles.btnReconcile}
          disabled={isBtnDisabled}
          aria-disabled={isBtnDisabled}
          onClick={isBtnDisabled ? undefined : handleClick}
          aria-label={
            isOwnRunActive
              ? 'Konzept/Spec nachziehen — läuft'
              : isSessionBusy
              ? 'Konzept/Spec nachziehen — gesperrt (Job läuft)'
              : 'Konzept/Spec nachziehen starten — öffnet Bestätigungsdialog'
          }
          data-testid="reconcile-btn"
        >
          {isOwnRunActive
            ? 'Konzept/Spec nachziehen — läuft'
            : isSessionBusy
            ? 'Konzept/Spec nachziehen — gesperrt'
            : 'Konzept/Spec nachziehen'}
        </button>
      )}

      {/* AC4 (reconcile-trigger): Lock-Hinweis für Fremd-Busy (Text, nicht nur Farbe) */}
      {isSessionBusy && !isOwnRunActive && reconcileState === 'idle' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileLockNotice}
          data-testid="reconcile-lock-notice"
        >
          Ein Job läuft — Trigger gesperrt.
        </div>
      )}

      {/* reconcile-inline-feedback AC1/AC2: eigener Lauf aktiv */}
      {reconcileState === 'running' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-running"
        >
          Reconcile läuft…
        </div>
      )}

      {/* reconcile-inline-feedback AC3: eigener Lauf abgeschlossen */}
      {reconcileState === 'done' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-done"
        >
          Fertig
        </div>
      )}

      {/* reconcile-inline-feedback AC8: robuste Degradierung — kein Endlos-Spinner */}
      {reconcileState === 'degraded' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileDegraded}
          data-testid="reconcile-degraded"
        >
          Status unklar — bitte „Audit-Spec anzeigen" manuell aktualisieren.
        </div>
      )}

      {/* AC2: Bestätigungsdialog — verhindert versehentlichen Start */}
      {reconcileState === 'confirm' && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Konzept/Spec nachziehen bestätigen"
          style={styles.reconcileConfirmBox}
          data-testid="reconcile-confirm-dialog"
        >
          <p style={styles.reconcileConfirmText}>
            Startet einen Fabrik-Lauf, der die Doku (Konzept, Architektur, Specs)
            automatisch ändert/abgleicht. Fortfahren?
          </p>
          <div style={styles.reconcileConfirmBtns}>
            <button
              type="button"
              style={styles.btnReconcileConfirm}
              onClick={handleConfirm}
              aria-label="Bestätigen — Konzept/Spec nachziehen starten"
              data-testid="reconcile-confirm-yes"
            >
              Starten
            </button>
            <button
              type="button"
              style={styles.btnReconcileCancel}
              onClick={handleCancel}
              aria-label="Abbrechen — kein Start"
              data-testid="reconcile-confirm-no"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {reconcileState === 'starting' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-starting"
        >
          Starte…
        </div>
      )}

      {/* AC6/AC7 (reconcile-trigger) / AC9 (reconcile-inline-feedback): Fehleranzeige mit Reset */}
      {reconcileState === 'error' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="reconcile-error">
          {reconcileError}
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => setPhase('idle')}
            aria-label="Fehlerstatus zurücksetzen"
            data-testid="reconcile-error-reset"
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </div>
  );
}

// ── AuditSpecView (spec-audit-view AC1–AC4 + reconcile-inline-feedback AC4/AC5) ──

/**
 * PR-URL-Muster: `.../pull/<n>[...]` (GitHub-Pull-Request-Link).
 * Bare-Hash-Muster: `#<n>` (nicht gefolgt von einem weiteren Wortzeichen —
 * schließt z.B. `#123abc` als Nicht-Treffer aus).
 */
const PR_URL_RE = /https?:\/\/\S*\/pull\/(\d+)\S*/i;
const PR_HASH_RE = /#(\d+)(?!\w)/;

/**
 * Sucht im geladenen Audit-Markdown nach einem erkennbaren PR-Bezug
 * (reconcile-inline-feedback AC5, best-effort/SHOULD).
 *
 * @param {string} markdown
 * @returns {{ url: string|null, label: string }|null}
 */
function extractPrReference(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const urlMatch = markdown.match(PR_URL_RE);
  if (urlMatch) {
    return { url: urlMatch[0], label: `PR #${urlMatch[1]}` };
  }
  const hashMatch = markdown.match(PR_HASH_RE);
  if (hashMatch) {
    return { url: null, label: `PR #${hashMatch[1]}` };
  }
  return null;
}

/**
 * AuditSpecView — „Audit-Spec anzeigen"-Sekundär-Button, direkt unterhalb des
 * ReconcileTrigger-Buttons (spec-audit-view AC1–AC4).
 *
 * Klick lädt `docs/spec-audit.md` des aktiven Projekts über die bestehende
 * Doku-Lese-API und rendert den Inhalt über MarkdownLite. 404 (kein
 * Reconcile-Lauf) → freundlicher Hinweis statt Fehleranzeige. Netzwerkfehler
 * oder unerwarteter Status → sichtbare, neutrale Fehleranzeige. Ein
 * `requestId`-Zähler stellt sicher, dass bei überlappenden Anfragen nur die
 * zuletzt gestartete Antwort den State setzt („letzte Ladung gewinnt"); ein
 * synchroner `loadingRef`-Flag (statt eines State-Reads) verhindert, dass
 * mehrere synchron aufeinanderfolgende Klicks (Doppelklick, bevor React den
 * `disabled`-State neu gerendert hat) einen zweiten konkurrierenden Request
 * auslösen. Der Button ist zusätzlich während einer aktiven Ladung
 * deaktiviert (State-basiert, für den sichtbaren/zugänglichen Zustand).
 *
 * reconcile-inline-feedback (S-205):
 * AC4 — `reloadSignal` (ein monoton hochgezählter Zähler von SpecView, bei
 *        jedem Reconcile-Abschluss +1) triggert programmatisch genau EIN
 *        `load()` — derselbe Lade-Pfad wie der manuelle Klick, inkl.
 *        `hasProjectSlug`-Guard (Edge-Case „Kein projectSlug") und
 *        Doppelklick-/Doppel-Reload-Guard (`loadingRef`). Der `lastReloadSignalRef`
 *        vergleicht gegen den beim Mount erfassten Startwert, damit der
 *        Effect NICHT beim initialen Mount feuert (nur bei einer echten
 *        Änderung, d.h. einem tatsächlichen Reconcile-Abschluss).
 * AC5 — erkennbarer PR-Bezug im geladenen Inhalt (PR-URL oder `#<nummer>`)
 *        → dezenter Link (echte URL, `target="_blank" rel="noopener noreferrer"`)
 *        bzw. reiner Text-Hinweis (Bare-Hash ohne Domain); sonst kein Element
 *        (graceful absence, kein Platzhalter, kein Crash).
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   reloadSignal?: number,
 * }} props
 *   fetchFn      — injectable für Tests (default: globalThis.fetch), analog zum
 *                  ReconcileTrigger.
 *   reloadSignal — (S-205 AC4) monoton hochgezählter Zähler; jede Änderung ab
 *                  dem Mount-Wert löst genau einen automatischen Reload aus.
 */
function AuditSpecView({ projectSlug, fetchFn, reloadSignal }) {
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  /** 'idle' | 'loading' | 'ok' | 'notfound' | 'error' */
  const [auditState, setAuditState] = useState('idle');
  const [auditContent, setAuditContent] = useState('');
  const [auditError, setAuditError] = useState('');

  // Monotonic request id — guards against overlapping loads (double-click,
  // repeat click while a previous request is still in flight).
  const requestIdRef = useRef(0);
  // Synchronous in-flight flag — checked BEFORE any `await`, so two
  // `fireEvent.click()` calls fired back-to-back in the same synchronous
  // event-handler batch (before React re-renders the `disabled` attribute)
  // still only start one request.
  const loadingRef = useRef(false);

  const hasProjectSlug = typeof projectSlug === 'string' && projectSlug.trim().length > 0;
  const isBtnDisabled = !hasProjectSlug || auditState === 'loading';

  const load = useCallback(async () => {
    // Edge-case: fehlender projectSlug → kein Request mit leerem Slug
    // (gilt für Klick UND automatischen Reload, S-205 Edge-Cases).
    if (!hasProjectSlug) return;
    // Doppelklick-/Doppel-Reload-Guard: nur eine aktive Ladung (synchron geprüft).
    if (loadingRef.current) return;
    loadingRef.current = true;

    const myRequestId = ++requestIdRef.current;
    setAuditState('loading');
    setAuditError('');

    const url = `/api/board/projects/${encodeURIComponent(projectSlug)}/docs/raw?path=${encodeURIComponent('docs/spec-audit.md')}`;

    let res;
    try {
      res = await fetchFnRef.current(url);
    } catch {
      loadingRef.current = false;
      if (requestIdRef.current !== myRequestId) return; // stale — a newer load already won
      setAuditState('error');
      setAuditError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    loadingRef.current = false;
    if (requestIdRef.current !== myRequestId) return; // stale

    if (res.status === 404) {
      // AC3: freundlicher Hinweis statt roher Fehlermeldung.
      setAuditState('notfound');
      return;
    }
    if (!res.ok) {
      // AC4: 500/unerwarteter Status → sichtbare, neutrale Fehleranzeige.
      setAuditState('error');
      setAuditError(`Fehler beim Laden (HTTP ${res.status}).`);
      return;
    }

    const text = await res.text();
    if (requestIdRef.current !== myRequestId) return; // stale
    setAuditContent(text);
    setAuditState('ok');
  }, [projectSlug, hasProjectSlug]);

  const handleClick = useCallback(() => {
    load();
  }, [load]);

  // reconcile-inline-feedback (S-205) AC4: automatischer Reload nach Reconcile-
  // Abschluss. Der Ref erfasst den Startwert beim Mount, damit der Effect NICHT
  // beim initialen Mount feuert — nur bei einer echten Änderung (= Abschluss).
  const lastReloadSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === undefined || reloadSignal === null) return;
    if (reloadSignal === lastReloadSignalRef.current) return; // kein neuer Abschluss
    lastReloadSignalRef.current = reloadSignal;
    load();
  }, [reloadSignal, load]);

  // AC5: PR-Bezug aus dem geladenen Inhalt (best-effort, nur wenn geladen).
  const prReference = useMemo(() => {
    if (auditState !== 'ok') return null;
    return extractPrReference(auditContent);
  }, [auditState, auditContent]);

  return (
    <div style={styles.auditBox} data-testid="audit-spec-box">
      <button
        type="button"
        style={isBtnDisabled ? styles.btnAuditSpecDisabled : styles.btnAuditSpec}
        disabled={isBtnDisabled}
        aria-disabled={isBtnDisabled}
        onClick={isBtnDisabled ? undefined : handleClick}
        aria-label="Audit-Spec anzeigen — zeigt die letzten Reconcile-Aktionen"
        data-testid="audit-spec-btn"
      >
        Audit-Spec anzeigen
      </button>

      {/* AC4: zugänglicher Lade-Zustand (Text, nicht nur Farbe) */}
      {auditState === 'loading' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.auditHint}
          data-testid="audit-spec-loading"
        >
          Lade Audit-Spec…
        </div>
      )}

      {/* AC3: 404 → freundlicher Hinweis, kein Fehler-Look */}
      {auditState === 'notfound' && (
        <div role="status" style={styles.auditHint} data-testid="audit-spec-notfound">
          Noch kein Reconcile-Lauf.
        </div>
      )}

      {/* AC4: Netzwerkfehler/500/unerwarteter Status → sichtbare Fehleranzeige */}
      {auditState === 'error' && (
        <div role="alert" style={styles.auditError} data-testid="audit-spec-error">
          {auditError}
        </div>
      )}

      {/* AC2: geladener Markdown-Inhalt über MarkdownLite */}
      {auditState === 'ok' && (
        <div style={styles.auditContentWrapper} data-testid="audit-spec-content">
          <MarkdownLite markdown={auditContent} style={styles.auditMarkdown} />
          {/* reconcile-inline-feedback AC5: dezenter PR-Bezug (graceful absence) */}
          {prReference && (
            prReference.url ? (
              <a
                href={prReference.url}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.auditPrLink}
                data-testid="audit-spec-pr-link"
              >
                {prReference.label}
              </a>
            ) : (
              <span style={styles.auditPrHint} data-testid="audit-spec-pr-hint">
                {prReference.label}
              </span>
            )
          )}
        </div>
      )}
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

  // ── Reconcile-Trigger (reconcile-trigger AC1–AC7) ──
  reconcileBox: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  reconcileHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  reconcileHint: {
    fontSize: 11,
    color: '#6b7280',
    margin: 0,
    lineHeight: 1.5,
  },

  code: {
    fontFamily: 'monospace',
    background: '#1a1a1a',
    padding: '0 3px',
    borderRadius: 2,
    fontSize: 10,
    color: '#93c5fd',
  },

  btnReconcile: {
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  // AC4: disabled state when session busy
  btnReconcileDisabled: {
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },

  // AC4: lock notice text when session busy (supplements disabled button — not color alone)
  reconcileLockNotice: {
    fontSize: 11,
    color: '#fbbf24',
    fontStyle: 'italic',
  },

  reconcileConfirmBox: {
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  reconcileConfirmText: {
    fontSize: 12,
    color: '#d1d5db',
    margin: 0,
    lineHeight: 1.5,
  },

  reconcileConfirmBtns: {
    display: 'flex',
    gap: 8,
  },

  btnReconcileConfirm: {
    flex: 1,
    background: '#15803d',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },

  btnReconcileCancel: {
    flex: 1,
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },

  reconcileStatus: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  // reconcile-inline-feedback (S-205) AC8: neutrale Degradierung — kein Fehler-Look
  reconcileDegraded: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  reconcileStatusError: {
    fontSize: 12,
    color: '#f87171',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    alignItems: 'flex-start',
  },

  btnReconcileReset: {
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 32,
  },

  // ── Audit-Spec-Button (spec-audit-view AC1–AC4) ──
  auditBox: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  btnAuditSpec: {
    alignSelf: 'flex-start',
    background: 'transparent',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  btnAuditSpecDisabled: {
    alignSelf: 'flex-start',
    background: 'transparent',
    color: '#4b5563',
    border: '1px solid #262626',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },

  auditHint: {
    fontSize: 11,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  auditError: {
    fontSize: 11,
    color: '#f87171',
  },

  auditContentWrapper: {
    maxHeight: 300,
    overflowY: 'auto',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
    padding: '8px 10px',
    background: '#0d0d0d',
  },

  auditMarkdown: {
    fontSize: 12,
    lineHeight: 1.6,
    color: '#d1d5db',
  },

  // reconcile-inline-feedback (S-205) AC5: dezenter PR-Bezug
  auditPrLink: {
    display: 'inline-block',
    marginTop: 8,
    fontSize: 11,
    color: '#93c5fd',
    textDecoration: 'underline',
  },

  auditPrHint: {
    display: 'inline-block',
    marginTop: 8,
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },
};
