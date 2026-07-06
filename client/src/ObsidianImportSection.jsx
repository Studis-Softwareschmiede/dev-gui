/**
 * ObsidianImportSection.jsx — dritte "Neues Projekt"-Option "Aus Obsidian-Notizen"
 * (obsidian-project-intake, S-249 + obsidian-question-catalog, S-251).
 *
 * Diese Komponente wurde aus GitHubView.jsx extrahiert (S-300 Refactoring).
 * Verhalten, Guards und beide Pfade (strukturiertes Fragenkatalog-Overlay +
 * PTY-„Auslösen"-Fallback) bleiben unverändert.
 *
 * @param {{ fetchFn?: typeof fetch, onNavigate: (view: string) => void }} props
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { collapseToLine } from './costMode.js';
import { ObsidianIngestOverlay } from './ObsidianIngestOverlay.jsx';

// ── obsidian-project-intake constants (S-249) ────────────────────────────────

/** The from-notes trigger command prefix (obsidian-project-intake AC3). */
const FROM_NOTES_CMD = '/agent-flow:from-notes';

/** Busy-guard poll interval for the Obsidian-Import section (AC5). */
const OBSIDIAN_SESSION_POLL_MS = 3_000;

// ── Obsidian-Import API-Helfer (obsidian-project-intake, S-249) ──────────────

/**
 * GET /api/settings/obsidian-vault/projects
 * AC2: lädt die auswählbare Projekt-Unterordner-Liste.
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Array<{ name: string, path: string }>>}
 * @throws {Error} bei nicht-ok Response oder Netzwerkfehler (Aufrufer zeigt Fehlerzustand)
 */
async function fetchObsidianProjects(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-vault/projects');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.projects) ? data.projects : [];
}

/**
 * GET /api/session — Busy-Guard-Poll (AC5).
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean|null>} true=busy, false=ready, null=unbekannt (Zustand halten)
 */
async function fetchObsidianSessionBusy(fetchImpl) {
  try {
    const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
    const res = await fn('/api/session');
    if (!res.ok) return null;
    const data = await res.json();
    return data?.state === 'busy';
  } catch {
    return null;
  }
}

// ── ObsidianImportSection ─────────────────────────────────────────────────────

/**
 * ObsidianImportSection — dritte "Neues Projekt"-Option: Ordner-Auswahl aus dem
 * konfigurierten Obsidian-Vault + Auslösen von /agent-flow:from-notes
 * (obsidian-project-intake AC2, AC3, AC5, AC6, AC7).
 *
 * State machine (submitState): 'idle' | 'starting' | 'error'.
 * Busy-Guard (AC5) wird unabhängig per Poll auf GET /api/session gehalten.
 *
 * @param {{ fetchFn?: typeof fetch, onNavigate: (view: string) => void }} props
 */
export function ObsidianImportSection({ fetchFn, onNavigate }) {
  /** 'loading' | 'ok' | 'empty' | 'error' */
  const [projectsState, setProjectsState] = useState('loading');
  const [projects, setProjects]           = useState(/** @type {Array<{name:string,path:string}>} */([]));
  const [selectedPath, setSelectedPath]   = useState('');
  /** 'idle' | 'starting' | 'error' */
  const [submitState, setSubmitState]     = useState('idle');
  const [errorMsg, setErrorMsg]           = useState(null);
  const [busy, setBusy]                   = useState(false);

  // obsidian-question-catalog (S-251): headless Katalog-Overlay-Pfad — eigener
  // Zustand, unabhängig vom PTY-Busy-Guard oben (eigenes Lock/eigener Runner,
  // s. Modul-Kommentar in ObsidianIngestOverlay.jsx). `ingestJob` erlaubt den
  // Wiedereinstieg (AC7), solange diese Section selbst gemountet bleibt.
  //
  // Review-Fix (Iteration 2, Important reviewer/R06): `jobId` wird ZUSAMMEN
  // mit dem `projectFolderPath` gehalten, für den der Job gestartet wurde
  // (statt einer isolierten `ingestJobId`). Ohne diese Kopplung würde ein
  // Auswahlwechsel (Projekt A → Projekt B, während Job A noch detached
  // läuft) den „Fortsetzen"-Button weiter anzeigen und beim Öffnen den
  // FALSCHEN Job (A) für das NEU gewählte Projekt (B) resumen — lautlos,
  // ohne dass ein neuer `start()`-Call für B stattfindet. Zwei Sicherungen:
  // (1) der `<select>`-onChange setzt `ingestJob` zurück, sobald der neue
  // Pfad vom gemerkten Job-Pfad abweicht; (2) `handleOpenIngestOverlay`
  // prüft defensiv NOCHMAL vor dem Öffnen (defense in depth, falls „(1)"
  // je umgangen wird).
  const [showIngestOverlay, setShowIngestOverlay] = useState(false);
  const [ingestJob, setIngestJob]                  = useState(/** @type {{jobId:string, projectFolderPath:string}|null} */(null));
  const ingestTriggerRef = useRef(null);

  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // AC2: lädt die Projekt-Unterordner-Liste einmal beim Öffnen der Sektion.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setProjectsState('loading');
      try {
        const list = await fetchObsidianProjects(fetchFnRef.current);
        if (cancelled) return;
        setProjects(list);
        setProjectsState(list.length === 0 ? 'empty' : 'ok');
      } catch {
        if (!cancelled) setProjectsState('error');
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // AC5: Busy-Guard-Poll (GET /api/session).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const isBusy = await fetchObsidianSessionBusy(fetchFnRef.current);
      if (!cancelled && isBusy !== null) setBusy(isBusy);
    }
    poll();
    const timer = setInterval(poll, OBSIDIAN_SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const isStarting = submitState === 'starting';
  const canTrigger  = Boolean(selectedPath) && !isStarting && !busy;

  const handleTrigger = useCallback(async () => {
    // AC3/AC5 guard: keine Auswahl, bereits "starting" oder busy → no-op (kein zweiter POST).
    if (!selectedPath || isStarting || busy) return;

    // AC3: <path> ausschließlich aus der geladenen Liste — nie freien State vertrauen.
    const match   = projects.find((p) => p.path === selectedPath);
    const rawPath = match ? match.path : selectedPath;
    // Defensiv zu einer Zeile ohne Steuerzeichen kollabieren (defense in depth —
    // path ist server-confined, keine neue Trust-Boundary).
    const collapsedPath = collapseToLine(rawPath);
    if (!collapsedPath) return;

    setSubmitState('starting');
    setErrorMsg(null);

    const command = `${FROM_NOTES_CMD} ${collapsedPath}`;
    const body    = { command };

    let res;
    try {
      res = await fetchFnRef.current('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setSubmitState('error');
      setErrorMsg('Netzwerkfehler beim Senden. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      setSubmitState('idle');
      // AC6: kein stehengebliebenes "gestartet"-Element — direkt navigieren.
      onNavigate('factory');
      return;
    }

    if (res.status === 409) {
      // AC7: Job läuft bereits — sichtbare Fehleranzeige, kein Navigate.
      setSubmitState('error');
      setErrorMsg('Ein Job läuft bereits. Bitte warten bis der aktuelle Lauf abgeschlossen ist.');
      return;
    }

    if (res.status === 400) {
      let detail = 'Ungültiger Befehl.';
      try {
        const json = await res.json();
        if (json?.reason) detail = `Ungültiger Befehl: ${json.reason}`;
      } catch { /* ignore parse error */ }
      setSubmitState('error');
      setErrorMsg(detail);
      return;
    }

    // 500 / unerwartet
    setSubmitState('error');
    setErrorMsg('Serverfehler. Bitte erneut versuchen.');
  }, [selectedPath, isStarting, busy, projects, onNavigate]);

  // AC7: Reset-Möglichkeit nach Fehler (kein Navigate, kein Crash).
  const handleReset = useCallback(() => {
    setSubmitState('idle');
    setErrorMsg(null);
  }, []);

  // obsidian-question-catalog AC3/AC4/AC5/AC7 (S-251): öffnet das Fragenkatalog-
  // Overlay — primärer, „richerer" Einstieg für die dritte Option (strukturierte
  // Rückfragen statt reinem Terminal-Text). Ein Wiedereinstieg (kein erneuter
  // `start()`) findet NUR statt, wenn der gemerkte Job zum AKTUELL gewählten
  // Projekt-Pfad gehört (Review-Fix Iteration 2) — sonst wird eine Auswahl
  // verlangt wie beim PTY-Fallback-Button.
  const ingestJobMatchesSelection = Boolean(ingestJob) && ingestJob.projectFolderPath === selectedPath;
  const canStartIngest = Boolean(selectedPath) && !showIngestOverlay;
  const handleOpenIngestOverlay = useCallback(() => {
    if (!selectedPath) return;
    // Defense in depth (reviewer/R06): ein gemerkter Job für ein ANDERES
    // Projekt darf niemals stillschweigend resumed werden.
    if (ingestJob && ingestJob.projectFolderPath !== selectedPath) {
      setIngestJob(null);
    }
    setShowIngestOverlay(true);
  }, [selectedPath, ingestJob]);

  return (
    <section style={styles.section} aria-labelledby="obsidian-import-heading">
      <h2 id="obsidian-import-heading" style={styles.sectionHeading}>
        Aus Obsidian-Notizen
      </h2>
      <p style={styles.sectionDesc}>
        Wählt einen Projekt-Unterordner aus dem konfigurierten Vault. „Strukturiert
        starten" zeigt Rückfragen als Fragenkatalog-Overlay (empfohlen); „Auslösen"
        löst stattdessen direkt{' '}
        <code style={styles.obsidianInlineCode}>/agent-flow:from-notes</code> im
        Terminal aus (unstrukturiert, Fallback).
      </p>

      {/* AC2: Lade-Indikator */}
      {projectsState === 'loading' && (
        <div role="status" aria-live="polite" style={styles.notice}>
          Lade Projekt-Ordner…
        </div>
      )}

      {/* AC2: Ladefehler — sichtbare Fehleranzeige, kein Crash */}
      {projectsState === 'error' && (
        <div role="alert" style={styles.errorNotice}>
          Projekt-Ordner konnten nicht geladen werden.
        </div>
      )}

      {/* AC2: leere Liste — klarer Hinweis */}
      {projectsState === 'empty' && (
        <p style={styles.emptyHint}>
          Keine Projekte unter &lt;vault&gt;/Projekte gefunden.
        </p>
      )}

      {/* AC2: auswählbare Liste — name sichtbar, path als Wert */}
      {projectsState === 'ok' && (
        <div style={styles.fieldRow}>
          <label htmlFor="obsidian-project-select" style={styles.label}>
            Projekt-Ordner
          </label>
          <select
            id="obsidian-project-select"
            style={styles.select}
            value={selectedPath}
            disabled={isStarting}
            aria-disabled={isStarting}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedPath(next);
              // Review-Fix (Iteration 2, Important reviewer/R06): ein Auswahl-
              // wechsel verwirft einen gemerkten Ingest-Job für das ALTE
              // Projekt sofort — sonst zeigt der Button weiter "Fortsetzen"
              // und würde beim Öffnen lautlos den falschen Job resumen.
              setIngestJob((prev) => (prev && prev.projectFolderPath !== next ? null : prev));
            }}
          >
            <option value="">— wählen —</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* AC5: Busy-Hinweis — Text-Label, nicht nur Farbe */}
      {busy && (
        <div role="status" aria-live="polite" style={styles.obsidianLockNotice}>
          <span aria-hidden="true">⚙</span> Ein Job läuft bereits — Auslösen gesperrt.
        </div>
      )}

      {/* AC7: Fehleranzeige mit Reset */}
      {submitState === 'error' && errorMsg && (
        <div role="alert" style={styles.formError}>
          <p style={{ margin: '0 0 8px' }}>{errorMsg}</p>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleReset}
            aria-label="Fehler zurücksetzen und erneut versuchen"
          >
            Zurücksetzen
          </button>
        </div>
      )}

      <div style={styles.actionRow}>
        {/* obsidian-question-catalog AC3/AC4/AC5/AC7 (S-251): primärer,
            „richerer" Einstieg — öffnet das Fragenkatalog-Overlay statt direkt
            in den PTY-Terminal-Stream zu schreiben. Eigener aria-label-Text
            (kein „Auslösen"-Substring), damit Tests, die per Name „auslösen"
            matchen, weiterhin eindeutig den bestehenden PTY-Button treffen. */}
        <button
          ref={ingestTriggerRef}
          type="button"
          style={canStartIngest ? styles.btnPrimary : styles.btnPrimaryDisabled}
          disabled={!canStartIngest}
          aria-disabled={!canStartIngest}
          aria-label={
            !selectedPath
              ? 'Strukturiert starten — Projekt-Ordner fehlt'
              : ingestJobMatchesSelection
              ? 'Strukturiert starten — Fragenkatalog-Lauf fortsetzen'
              : 'Strukturiert starten — mit Fragenkatalog'
          }
          onClick={handleOpenIngestOverlay}
          data-testid="obsidian-ingest-open-btn"
        >
          {ingestJobMatchesSelection ? 'Fortsetzen' : 'Strukturiert starten'}
        </button>

        {/* obsidian-project-intake AC3 (S-249) — PTY-Fallback: Logik/Verhalten
            UNVERÄNDERT (derselbe POST /api/command-Pfad, dieselben Guards),
            nur visuell auf Sekundär-Button demotet (btnSecondary statt
            btnPrimary), seit der neue Strukturiert-starten-Button (oben) der
            primäre Einstieg ist. */}
        <button
          type="button"
          style={canTrigger ? styles.btnSecondary : styles.btnPrimaryDisabled}
          disabled={!canTrigger}
          aria-disabled={!canTrigger}
          aria-busy={isStarting}
          aria-label={
            busy
              ? 'Auslösen — gesperrt (Job läuft bereits)'
              : !selectedPath
              ? 'Auslösen — Projekt-Ordner fehlt'
              : isStarting
              ? 'Auslösen — wird gesendet'
              : 'Aus Obsidian-Notizen auslösen'
          }
          onClick={handleTrigger}
        >
          {isStarting ? 'Wird ausgelöst…' : 'Auslösen'}
        </button>
      </div>

      {/* obsidian-question-catalog AC3/AC4/AC5/AC7 (S-251): Fragenkatalog-
          Overlay — eigene Datei, eigene State-Machine (s. Modul-Kommentar
          dort). Schließen bricht den headless Lauf NICHT ab (AC7); jobId +
          projectFolderPath bleiben zusammen in dieser Section gemerkt
          (Wiedereinstieg NUR bei unverändertem selectedPath, s.o.). */}
      {showIngestOverlay && (
        <ObsidianIngestOverlay
          projectFolderPath={selectedPath}
          initialJobId={ingestJobMatchesSelection ? ingestJob.jobId : null}
          fetchFn={fetchFnRef.current}
          triggerRef={ingestTriggerRef}
          onClose={() => setShowIngestOverlay(false)}
          onJobStarted={(jobId) => setIngestJob({ jobId, projectFolderPath: selectedPath })}
          onJobEnded={() => setIngestJob(null)}
          onIngestComplete={() => onNavigate('factory')}
        />
      )}
    </section>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: {
    margin: '0 0 8px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  sectionDesc: {
    margin: '0 0 20px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
  },
  select: {
    width: '100%',
    padding: '8px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 14,
    boxSizing: 'border-box',
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '10px 20px',
    background: '#1d4ed8',    // Kontrast #fff/#1d4ed8 ≥ 4.5:1
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnPrimaryDisabled: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },
  btnSecondary: {
    padding: '8px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    marginTop: 12,
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  obsidianInlineCode: {
    fontFamily: 'monospace',
    fontSize: 12,
    background: '#1e1e1e',
    padding: '1px 4px',
    borderRadius: 3,
    color: '#93c5fd',
  },
  obsidianLockNotice: {
    padding: '8px 10px',
    background: '#1a1500',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',           // Kontrast auf #1a1500 ≥ 4.5:1
    fontSize: 12,
    marginBottom: 8,
  },
  notice: {
    padding: '12px 0',
    fontSize: 13,
    color: '#9ca3af',
  },
  errorNotice: {
    margin: '0 0 12px',
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 13,
    color: '#fca5a5',
  },
  emptyHint: {
    margin: 0,
    padding: '12px 0',
    fontSize: 13,
    color: '#9ca3af',
  },
  formError: {
    margin: '0 0 12px',
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 13,
    color: '#fca5a5',           // Kontrast auf #2d0f0f ≥ 4.5:1
  },
};
