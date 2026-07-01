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
 * AC5 — 202 → onNavigate('factory'); kein stehengebliebenes Element im Reiter.
 * AC6 — 409 → sichtbare Fehleranzeige, kein onNavigate, kein Crash.
 * AC7 — Netzwerkfehler/500 → sichtbare Fehleranzeige mit Reset, kein onNavigate.
 * Gespiegelt vom „Board abarbeiten"-Muster (CockpitView.jsx FactoryWorkspace).
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
 *
 * A11y (WCAG 2.1 AA):
 *   - Navigation als <nav> mit aria-label.
 *   - Aktives Dokument mit aria-current="page".
 *   - Ladezustand aria-busy auf dem Inhalts-Container.
 *   - Fokusring nie unterdrückt.
 *   - Touch-Targets ≥ 44 px für Nav-Buttons, den Reconcile-Button und den
 *     Audit-Spec-Button.
 *
 * Covers (reconcile-trigger): AC1, AC2, AC3, AC4, AC5, AC6, AC7
 * Covers (spec-audit-view): AC1, AC2, AC3, AC4
 *
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 *   onNavigate?: (view: string) => void,
 *   fetchFn?: Function,
 * }} props
 *   projectSlug   — Slug des aktiven Projekts (aus CockpitView/BoardAggregator)
 *   initialPath   — optional: direkt zu öffnende Datei (AC5, z.B. via Story-Klick)
 *   onNavigate    — (reconcile-trigger AC5) navigiert nach erfolgreichem Auslösen
 *                    in den Terminal-/Arbeiten-Bereich ('factory').
 *   fetchFn       — injectable für Tests (default: globalThis.fetch); vom
 *                    Reconcile-Trigger UND vom Audit-Spec-Button genutzt
 *                    (Doku-Laden im Nav-Baum bleibt unverändert).
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
 * }} props
 */
export function SpecView({ projectSlug, initialPath, onNavigate, fetchFn }) {
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
      {/* Linke Spalte: Reconcile-Trigger + Filter + Navigation */}
      <div style={styles.sidebar}>
        {/* reconcile-trigger (S-201): „Konzept/Spec nachziehen"-Button */}
        <ReconcileTrigger
          projectSlug={projectSlug}
          fetchFn={fetchFn}
          onNavigate={onNavigate}
        />

        {/* spec-audit-view (S-203): „Audit-Spec anzeigen"-Button, direkt unterhalb */}
        <AuditSpecView
          projectSlug={projectSlug}
          fetchFn={fetchFn}
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

// ── ReconcileTrigger (reconcile-trigger AC1–AC7) ──────────────────────────────

/** Session poll interval in ms — matches CockpitView/FactoryWorkspace default. */
const RECONCILE_SESSION_POLL_MS = 3_000;

/**
 * ReconcileTrigger — „Konzept/Spec nachziehen"-Button (reconcile-trigger AC1–AC7).
 *
 * Gespiegelt vom „Board abarbeiten"-Knopf (CockpitView.jsx FactoryWorkspace):
 * Bestätigungsdialog vor dem doku-ändernden Lauf, Busy-Guard via GET /api/session,
 * POST /api/command {command:'/agent-flow:reconcile', projectPath}, 202→onNavigate,
 * 409/500/Netzfehler→sichtbare Fehleranzeige mit Reset.
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   onNavigate?: (view: string) => void,
 *   pollInterval?: number,
 * }} props
 *   fetchFn      — injectable for tests (default: globalThis.fetch)
 *   pollInterval — session poll interval in ms (default: RECONCILE_SESSION_POLL_MS)
 */
function ReconcileTrigger({ projectSlug, fetchFn, onNavigate, pollInterval = RECONCILE_SESSION_POLL_MS }) {
  // Stable ref so the poll effect doesn't re-register on every render.
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // ── Session busy state (AC4) ──────────────────────────────────────────────
  /** 'idle' | 'running' — derived from GET /api/session state */
  const [sessionRunState, setSessionRunState] = useState('idle');

  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      try {
        const res = await fetchFnRef.current('/api/session');
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) {
          setSessionRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // network error — keep current state
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  const isSessionBusy = sessionRunState === 'running';

  // ── Trigger state (AC2, AC3, AC6, AC7) ────────────────────────────────────
  /** 'idle' | 'confirm' | 'starting' | 'error' */
  const [reconcileState, setReconcileState] = useState('idle');
  const [reconcileError, setReconcileError] = useState(null);

  // AC4: button disabled when session busy or a start is already in flight.
  const isBtnDisabled = isSessionBusy || reconcileState === 'starting';

  const handleClick = useCallback(() => {
    setReconcileState('confirm');
    setReconcileError(null);
  }, []);

  const handleCancel = useCallback(() => {
    setReconcileState('idle');
    setReconcileError(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    setReconcileState('starting');
    setReconcileError(null);

    // AC3: include projectPath when an active project is set (backwards-compat
    // with the global session when absent, per Edge-Cases in the spec).
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
      // AC7: network error → visible error, no onNavigate
      setReconcileState('error');
      setReconcileError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // AC5: success → navigate to terminal pane, no stale element left behind
      setReconcileState('idle');
      setSessionRunState('running'); // optimistic update — poll will confirm
      if (onNavigate) onNavigate('factory');
      return;
    }
    if (res.status === 409) {
      // AC6: job already running → visible error, no onNavigate
      setSessionRunState('running');
      setReconcileState('error');
      setReconcileError('Ein Job läuft bereits — bitte warten.');
      return;
    }
    // AC7: 500/unexpected status → visible error, no onNavigate
    setReconcileState('error');
    setReconcileError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [projectSlug, onNavigate]);

  return (
    <div style={styles.reconcileBox} data-testid="reconcile-box">
      <div style={styles.reconcileHeader}>Konzept/Spec nachziehen</div>
      {/* AC1: Hinweistext nennt den ausgelösten Befehl */}
      <p style={styles.reconcileHint}>
        Startet <code style={styles.code}>/agent-flow:reconcile</code> — gleicht
        Konzept, Architektur und Specs wieder mit Vorlage und Code ab.
      </p>

      {reconcileState === 'idle' && (
        <button
          type="button"
          style={isBtnDisabled ? styles.btnReconcileDisabled : styles.btnReconcile}
          disabled={isBtnDisabled}
          aria-disabled={isBtnDisabled}
          onClick={isBtnDisabled ? undefined : handleClick}
          aria-label={
            isSessionBusy
              ? 'Konzept/Spec nachziehen — gesperrt (Job läuft)'
              : 'Konzept/Spec nachziehen starten — öffnet Bestätigungsdialog'
          }
          data-testid="reconcile-btn"
        >
          {isSessionBusy ? 'Konzept/Spec nachziehen — gesperrt' : 'Konzept/Spec nachziehen'}
        </button>
      )}

      {/* AC4: Lock-Hinweis (Text, nicht nur Farbe) */}
      {isSessionBusy && reconcileState === 'idle' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileLockNotice}
          data-testid="reconcile-lock-notice"
        >
          Ein Job läuft — Trigger gesperrt.
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

      {/* AC6/AC7: Fehleranzeige mit Reset-Möglichkeit */}
      {reconcileState === 'error' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="reconcile-error">
          {reconcileError}
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => setReconcileState('idle')}
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

// ── AuditSpecView (spec-audit-view AC1–AC4) ───────────────────────────────────

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
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 * }} props
 *   fetchFn — injectable für Tests (default: globalThis.fetch), analog zum
 *             ReconcileTrigger.
 */
function AuditSpecView({ projectSlug, fetchFn }) {
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

  const handleClick = useCallback(async () => {
    // Edge-case: fehlender projectSlug → kein Request mit leerem Slug.
    if (!hasProjectSlug) return;
    // Doppelklick-Guard: nur eine aktive Ladung (synchron geprüft).
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
};
