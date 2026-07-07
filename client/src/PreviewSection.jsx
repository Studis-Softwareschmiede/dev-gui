/**
 * PreviewSection.jsx — neues Zuhause für `/agent-flow:preview` auf der
 * Fabrik-Übersicht (cockpit-declutter AC7, S-305).
 *
 * `/agent-flow:preview` verlor durch die Entfernung von `TriggerPanel`
 * (cockpit-declutter AC1, S-303) sein bisheriges UI-Zuhause. Owner-Entscheidung
 * (2026-07-06, Offene Annahme A1): kein ersatzloser Wegfall — ein eigener,
 * kleiner Button auf der Fabrik-Übersicht (RepoOverview.jsx), analog der
 * bereits dort etablierten eigenständigen Sektionen (AdoptSection.jsx).
 *
 * Covers (cockpit-declutter):
 *   AC7 — Eigener „Vorschau"-Button/Bereich neben den Projekt-Aktionen der
 *         Fabrik-Übersicht. Argument-Auswahl analog dem bisherigen
 *         TriggerPanel-Dropdown, minimal: Modus (up/down/list/available) +
 *         Projekt (nur für up/down Pflicht). Klick löst GENAU EINMAL
 *         POST /api/command mit `{ command: '/agent-flow:preview <mode> [repo]' }`
 *         aus — denselben bestehenden Pfad + die unveränderte Backend-Allowlist
 *         (AC4, kein neuer Endpunkt). Ergebnis/Fehler erscheinen inline.
 *
 * Projekt-Liste (Modus up/down, Pflichtfeld): aus GET /api/status
 * (`json.projects[].name`) — dieselbe, bereits bestehende Quelle, die zuvor
 * TriggerPanel nutzte. Degradiert defensiv auf ein Freitextfeld, wenn die
 * Liste nicht verfügbar ist (kein Blockieren).
 *
 * Busy-Guard + Kill (analog AdoptSection.jsx AC7): GET /api/session
 * state:"busy" ODER 409 → „Auslösen" disabled (disabled-Attribut + Text-
 * Hinweis, nie nur Farbe); Kill-Knopf aktiv während des Laufs, POSTet
 * /api/command/cancel.
 *
 * NFR A11y (WCAG 2.1 AA):
 *   - Selects/Inputs/Buttons beschriftet, Tastatur bedienbar, Touch-Targets ≥ 44 px.
 *   - Disabled-Zustände: disabled-Attribut UND Text-Label (nie nur Farbe).
 *   - Validierungs-/Status-/Fehlermeldungen: role="alert" bzw. role="status", aria-live.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Kein neuer Backend-Endpunkt, keine neue Trust-Boundary (AC7, AC4 aus
 *     cockpit-declutter) — nutzt POST /api/command unverändert; Server bleibt
 *     autoritativ über Allowlist + Sanitisierung ([[flow-trigger]] AC2).
 *   - Repo-Argument wird vor dem Senden kollabiert (collapseToLine) — keine
 *     Steuerzeichen/Mehrzeiligkeit im Command-Argument (defense in depth).
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { collapseToLine } from './costMode.js';

// ── Konstanten ────────────────────────────────────────────────────────────────

/** Der Preview-Trigger-Befehlspräfix (bereits Allowlist-gelistet, [[flow-trigger]] AC2). */
const PREVIEW_CMD = '/agent-flow:preview';

/** Sub-Modi für preview — Argument-Auswahl analog dem bisherigen TriggerPanel-Dropdown. */
const PREVIEW_MODES = ['up', 'down', 'list', 'available'];
/** Modi, die zwingend ein Repo-Argument benötigen. */
const PREVIEW_REPO_MODES = ['up', 'down'];

/** Busy-Guard-Poll-Intervall (analog AdoptSection.jsx, AC7). */
const PREVIEW_SESSION_POLL_MS = 3_000;

// ── API-Helfer ────────────────────────────────────────────────────────────────

/**
 * GET /api/status — Projektliste für das Repo-Select (Modus up/down).
 * Degradiert defensiv: bei Fehler/leerer Liste bleibt `null` (Freitext-Fallback).
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string[]|null>}
 */
async function fetchProjectNames(fetchImpl) {
  try {
    const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
    const res = await fn('/api/status');
    if (!res.ok) return null;
    const data = await res.json();
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    if (projects.length === 0) return null;
    return projects.map((p) => p?.name).filter((n) => typeof n === 'string' && n);
  } catch {
    return null;
  }
}

/**
 * GET /api/session — Busy-Guard-Poll (AC7, spiegelt AdoptSection.jsx).
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean|null>} true=busy, false=ready, null=unbekannt (Zustand halten)
 */
async function fetchPreviewSessionBusy(fetchImpl) {
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

/**
 * Baut die vollständige Befehlszeile aus Modus + Repo-Auswahl. `null` bedeutet
 * „Pflichtfeld fehlt" — der Aufrufer darf dann nicht auslösen.
 *
 * @param {string} mode
 * @param {string} repoArg
 * @returns {string|null}
 */
function composePreviewCommand(mode, repoArg) {
  if (PREVIEW_REPO_MODES.includes(mode)) {
    const repo = collapseToLine(repoArg);
    if (!repo) return null; // Pflichtfeld
    return `${PREVIEW_CMD} ${mode} ${repo}`;
  }
  return `${PREVIEW_CMD} ${mode}`;
}

// ── PreviewSection ────────────────────────────────────────────────────────────

/**
 * PreviewSection — „Vorschau"-Button/Bereich für `/agent-flow:preview`
 * (up/down/list/available), neues Zuhause auf der Fabrik-Übersicht (AC7).
 *
 * State machine (submitState): 'idle' | 'starting' | 'running' | 'error'.
 * Busy-Guard (AC7-Muster) wird unabhängig per Poll auf GET /api/session gehalten.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */
export function PreviewSection({ fetchFn }) {
  const [mode, setMode] = useState(PREVIEW_MODES[0]);
  const [repoArg, setRepoArg] = useState('');
  const [projectNames, setProjectNames] = useState(null); // null = unbekannt/leer → Freitext
  /** 'idle' | 'starting' | 'running' | 'error' */
  const [submitState, setSubmitState] = useState('idle');
  const [errorMsg, setErrorMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // Projektliste einmalig laden (nicht-geheime Quelle GET /api/status).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const names = await fetchProjectNames(fetchFnRef.current);
      if (!cancelled) setProjectNames(names);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Busy-Guard-Poll (analog AdoptSection.jsx, AC7).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const isBusy = await fetchPreviewSessionBusy(fetchFnRef.current);
      if (!cancelled && isBusy !== null) setBusy(isBusy);
    }
    poll();
    const timer = setInterval(poll, PREVIEW_SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const needsRepo = PREVIEW_REPO_MODES.includes(mode);
  const composed = composePreviewCommand(mode, repoArg);

  const isStarting = submitState === 'starting';
  const isRunning = submitState === 'running';
  const canFire = composed !== null && !isStarting && !isRunning && !busy;

  const handleModeChange = useCallback((e) => {
    setMode(e.target.value);
    setRepoArg('');
  }, []);

  // Auslösung — POSTet GENAU EINMAL /api/command (AC7).
  const handleFire = useCallback(async () => {
    // Guard: Pflichtfeld fehlt, bereits starting/running oder busy → no-op
    // (kein zweiter POST — Doppelklick-/Race-Schutz).
    const command = composePreviewCommand(mode, repoArg);
    if (!command || isStarting || isRunning || busy) return;

    setSubmitState('starting');
    setErrorMsg(null);

    let res;
    try {
      res = await fetchFnRef.current('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch {
      setSubmitState('error');
      setErrorMsg('Netzwerkfehler beim Senden. Bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      setSubmitState('running');
      return;
    }

    if (res.status === 409) {
      setSubmitState('error');
      setErrorMsg('Ein Job läuft bereits.');
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
  }, [mode, repoArg, isStarting, isRunning, busy]);

  // Kill — POSTet /api/command/cancel, aktiv während des Laufs.
  const handleKill = useCallback(async () => {
    setErrorMsg(null);

    let res;
    try {
      res = await fetchFnRef.current('/api/command/cancel', { method: 'POST' });
    } catch {
      setSubmitState('error');
      setErrorMsg('Netzwerkfehler beim Abbrechen.');
      return;
    }

    if (res.ok) {
      setSubmitState('idle');
    } else {
      setSubmitState('error');
      setErrorMsg('Abbrechen fehlgeschlagen — bitte erneut versuchen.');
    }
  }, []);

  // Reset nach Fehler (kein Crash, neue Eingabe möglich).
  const handleReset = useCallback(() => {
    setSubmitState('idle');
    setErrorMsg(null);
  }, []);

  return (
    <section style={styles.section} aria-labelledby="preview-heading">
      <h2 id="preview-heading" style={styles.sectionHeading}>
        Vorschau
      </h2>
      <p style={styles.sectionDesc}>
        Startet <code style={styles.code}>/agent-flow:preview</code> — Deploy/Undeploy einer
        Preview-Umgebung oder Statusabfrage.
      </p>

      {/* AC7: Modus-Auswahl (analog dem bisherigen TriggerPanel-Dropdown) */}
      <div style={styles.fieldRow}>
        <label htmlFor="preview-mode-select" style={styles.label}>
          Modus
        </label>
        <select
          id="preview-mode-select"
          style={styles.select}
          value={mode}
          disabled={isStarting || isRunning}
          aria-disabled={isStarting || isRunning}
          onChange={handleModeChange}
          data-testid="preview-mode-select"
        >
          {PREVIEW_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Repo-Auswahl — nur für up/down (Pflicht) */}
      {needsRepo && (
        <div style={styles.fieldRow}>
          <label htmlFor="preview-repo-input" style={styles.label}>
            Projekt <span style={styles.required}>(Pflicht)</span>
          </label>
          {projectNames && projectNames.length > 0 ? (
            <select
              id="preview-repo-input"
              style={styles.select}
              value={repoArg}
              disabled={isStarting || isRunning}
              aria-disabled={isStarting || isRunning}
              onChange={(e) => setRepoArg(e.target.value)}
              data-testid="preview-repo-select"
            >
              <option value="">— wählen —</option>
              {projectNames.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          ) : (
            <input
              id="preview-repo-input"
              type="text"
              style={styles.input}
              placeholder="Repo-Name"
              value={repoArg}
              disabled={isStarting || isRunning}
              aria-disabled={isStarting || isRunning}
              onChange={(e) => setRepoArg(e.target.value)}
              data-testid="preview-repo-textinput"
            />
          )}
        </div>
      )}

      {/* Busy-Hinweis — Text-Label, nicht nur Farbe */}
      {busy && (
        <div role="status" aria-live="polite" style={styles.lockNotice} data-testid="preview-busy-notice">
          <span aria-hidden="true">⚙</span> Ein Job läuft bereits — Auslösen gesperrt.
        </div>
      )}

      {/* Inline Lauf-Status nach 202 */}
      {isRunning && (
        <div role="status" aria-live="polite" style={styles.runningNotice} data-testid="preview-running-notice">
          <span aria-hidden="true">⚙</span> Vorschau-Lauf läuft…
        </div>
      )}

      <div style={styles.actionRow}>
        <button
          type="button"
          style={canFire ? styles.btnPrimary : styles.btnPrimaryDisabled}
          disabled={!canFire}
          aria-disabled={!canFire}
          aria-busy={isStarting}
          aria-label={
            busy
              ? 'Auslösen — gesperrt (Job läuft bereits)'
              : isRunning
              ? 'Auslösen — Lauf bereits gestartet'
              : isStarting
              ? 'Auslösen — wird gesendet'
              : needsRepo && !repoArg.trim()
              ? 'Auslösen — Projekt fehlt'
              : `Auslösen: ${composed ?? PREVIEW_CMD}`
          }
          onClick={handleFire}
          data-testid="preview-fire-btn"
        >
          {isStarting ? 'Wird ausgelöst…' : 'Auslösen'}
        </button>

        {/* Kill — aktiv während des Laufs */}
        <button
          type="button"
          style={isRunning ? styles.btnKill : styles.btnKillDisabled}
          disabled={!isRunning}
          aria-disabled={!isRunning}
          aria-label={isRunning ? 'Laufenden Vorschau-Job abbrechen (Kill)' : 'Kill — kein Job läuft'}
          onClick={handleKill}
          data-testid="preview-kill-btn"
        >
          Kill
        </button>
      </div>

      {/* Fehleranzeige mit Reset */}
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
    </section>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
// (analog AdoptSection.jsx — konsistente Optik der Fabrik-Übersicht-Sektionen)

const styles = {
  section: {
    marginTop: 24,
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
  code: {
    background: '#1e293b',
    padding: '1px 4px',
    borderRadius: 3,
    fontFamily: 'monospace',
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
  },
  required: {
    fontSize: 11,
    color: '#f87171',
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
    minHeight: 44,
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 14,
    boxSizing: 'border-box',
    minHeight: 44,
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  btnPrimary: {
    padding: '10px 20px',
    background: '#1d4ed8',
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
  },
  btnKill: {
    padding: '8px 16px',
    background: '#92400e',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnKillDisabled: {
    padding: '8px 16px',
    background: '#1e1e1e',
    color: '#4b5563',
    border: '1px solid #333',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'not-allowed',
    minHeight: 44,
  },
  lockNotice: {
    padding: '8px 10px',
    background: '#1a1500',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',
    fontSize: 12,
    margin: '8px 0',
  },
  runningNotice: {
    padding: '8px 10px',
    background: '#0d1f14',
    border: '1px solid #14532d',
    borderRadius: 4,
    color: '#86efac',
    fontSize: 12,
    margin: '8px 0',
  },
  formError: {
    margin: '12px 0 0',
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 13,
    color: '#fca5a5',
  },
};
