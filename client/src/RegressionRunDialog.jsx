/**
 * RegressionRunDialog.jsx — Ausführen-Dialog für den deterministischen
 * Regressionstest-Runner (docs/specs/regression-run.md AC4, AC6; Main
 * Success Scenario Schritte 1-3).
 *
 * Struktur/A11y-Muster 1:1 aus `RegressionDefineDialog.jsx` übernommen
 * (Backdrop, `role="dialog"` + `aria-modal`, Fokus beim Öffnen, `Esc`
 * schließt IMMER, Fokus-Rückgabe an `triggerRef`, `mountedRef`-Guard gegen
 * State-Updates nach Unmount — .claude/lessons/coder.md 2026-07-01/2026-07-03).
 * Anders als der Definier-Dialog gibt es HIER keinen Poll-Loop bis zu einem
 * Endzustand — der Dialog schließt sich nach erfolgreichem Start sofort
 * (Main Success Scenario Schritt 4: der laufende Lauf selbst wird über die
 * bestehende Inline-Statuszeile der Regressionstests-Karte angezeigt,
 * regression-panel AC4/AC6 — kein zweiter Status-Anzeige-Ort, Nicht-Ziel
 * dieser Story).
 *
 * Covers (regression-run):
 *   AC4 — Suite-Wahl (Bereich/Verbund/Gesamt) als Radiogruppe, geladen über
 *         `GET /api/projects/:slug/regression-suites`; jede Suite zeigt ihr
 *         deklariertes `target` (`local | ephemeral-infra | url`, gelesen aus
 *         der Begleitbeschreibung, s. `RegressionSuiteReader.js`). Leere
 *         Liste (kein Regressions-Grundgerüst) → Hinweistext, Start
 *         gesperrt (kein Lauf ohne Suite).
 *   AC6 — Bei Auswahl einer `ephemeral-infra`-Suite zeigt der Dialog VOR dem
 *         Start den Kosten-/Ressourcen-Hinweis (`kosten`-Feld der Suite).
 *
 * Kontext (Main Success Scenario Schritt 3, S-310 bereits Done — hier nur
 * Anbindung, kein neuer Zustand): bei mindestens einer `local`-Suite in der
 * Auswahl zeigt der Dialog die Checkbox „Neustes Image vor dem Lauf
 * ausrollen" (Default AN, Body-Feld `freshRollout`, S-310 Backend-Vertrag
 * bereits fertig — `regressionRunRouter.js` reicht `freshRollout` 1:1
 * durch). Ist das Testobjekt-Projekt dev-gui selbst (Selbsttest, AC8, Server
 * erzwingt den Skip ohnehin hart), ist die Checkbox deaktiviert mit
 * Selbsttest-Hinweistext (AC8 UI-Anforderung zusätzlich zur Server-Sperre).
 *
 * ── Component-Props-Vertrag ─────────────────────────────────────────────────
 * @param {{
 *   projectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 *   onRunStarted?: (runId: string) => void,
 * }} props
 *
 * - `projectSlug` — das aktive Projekt (Cockpit-Kontext).
 * - `onClose` — schließt den Dialog (X/`Esc`/Backdrop/nach erfolgreichem Start).
 * - `triggerRef` — optional; erhält beim Schließen den Fokus zurück (A11y).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 * - `onRunStarted(runId)` — nach erfolgreichem `202`-Start (Aufrufer kann die
 *   Inline-Statuszeile sofort auf "running" schalten, best-effort).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML`.
 *   - Kein Secret/Token im UI — Suite-/Fehlertexte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`regressionSuitesRouter.js`/
 *     `regressionRunRouter.js`).
 *   - `scope`/`scope.id` stammen ausschließlich aus der geladenen
 *     Suite-Liste (kein Freitext-Eingabefeld).
 */

import { useState, useRef, useEffect, useCallback } from 'react';

/** Selbsttest-Erkennung (AC8, Annahme A2 der Spec) — identisch zum Backend `RegressionRunner.SELF_PROJECT_SLUG`. */
const SELF_PROJECT_SLUG = 'dev-gui';

const TARGET_LABELS = {
  local: 'lokal (Docker-Container)',
  'ephemeral-infra': 'flüchtige Infrastruktur',
  url: 'externe URL',
};

/**
 * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
 * @returns {string} stabiler React-key/Radio-value.
 */
function scopeKey(scope) {
  // Nur `bereich` trägt in der Suite-Liste eine `id` (agent-flow
  // `regression-playwright-conventions` AC2: alle Verbund-Suiten teilen
  // sich EIN gemeinsames Verzeichnis, kein eigener Namens-Unterordner je
  // Verbund — s. RegressionRunner.js scopeToTestPath()-Kommentar). `verbund`
  // hat daher hier keine `id` — ein `id`-Anhängen würde `verbund:undefined`
  // erzeugen.
  return scope.typ === 'bereich' ? `bereich:${scope.id}` : scope.typ;
}

export function RegressionRunDialog({
  projectSlug,
  onClose,
  triggerRef,
  fetchFn,
  onRunStarted,
}) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  const [suites, setSuites] = useState(null); // null = lädt, [] = leer/Fehler
  const [selectedKey, setSelectedKey] = useState(null);
  const [freshRollout, setFreshRollout] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');

  const dialogRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen; Esc schließt (Muster RegressionDefineDialog).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('input, textarea, button:not([disabled])');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // AC4: Suite-Liste laden (GET /api/projects/:slug/regression-suites).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch_(`/api/projects/${encodeURIComponent(projectSlug)}/regression-suites`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.suites) ? data.suites : [];
        if (cancelled || !mountedRef.current) return;
        setSuites(list);
        if (list.length > 0) setSelectedKey(scopeKey(list[0].scope));
      } catch {
        if (cancelled || !mountedRef.current) return;
        setSuites([]);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  const selectedSuite = Array.isArray(suites)
    ? suites.find((s) => scopeKey(s.scope) === selectedKey)
    : null;

  const isSelfProject = projectSlug === SELF_PROJECT_SLUG;
  // Main Success Scenario Schritt 3 (S-310 bereits Done): Checkbox nur
  // relevant/sichtbar bei mind. einer `local`-Suite in der Auswahl — hier:
  // die AKTUELL gewählte Suite ist `local` (Gesamt hat kein eigenes target,
  // zeigt die Option konservativ NICHT, da AC4/AC6 dieser Story nur die
  // Suite-Wahl + Kosten-Hinweis betreffen, kein neues Verhalten für Gesamt).
  const showFreshRolloutOption = selectedSuite?.target === 'local';

  const canStart = Boolean(selectedSuite);

  const handleStart = useCallback(async () => {
    if (!selectedSuite) return;
    setStarting(true);
    setStartError('');

    const body = { scope: selectedSuite.scope };
    if (showFreshRolloutOption) body.freshRollout = freshRollout;

    let res;
    try {
      res = await fetch_(`/api/projects/${encodeURIComponent(projectSlug)}/regression-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      if (!mountedRef.current) return;
      setStarting(false);
      setStartError('Netzwerkfehler beim Starten — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;

    if (res.status === 202) {
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      onRunStarted?.(data.runId);
      handleClose();
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setStarting(false);
    setStartError(data.error === 'busy'
      ? 'Ein Regressionslauf oder Drain für dieses Projekt läuft bereits.'
      : (data.error ?? `Regressionslauf konnte nicht gestartet werden (HTTP ${res.status}).`));
  }, [selectedSuite, showFreshRolloutOption, freshRollout, projectSlug, fetch_, onRunStarted, handleClose]);

  const titleId = 'regression-run-dialog-title';

  return (
    <>
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="regression-run-dialog"
      >
        <h2 id={titleId} style={styles.heading}>Regressionstest ausführen</h2>

        {suites === null && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-run-suites-loading">
            Suiten werden geladen…
          </p>
        )}

        {suites !== null && suites.length === 0 && (
          <p style={styles.hint} data-testid="regression-run-no-suites">
            Keine Regressionstest-Suiten gefunden — zuerst über „Regressionstest definieren" eine Suite anlegen.
          </p>
        )}

        {suites !== null && suites.length > 0 && (
          <>
            <p style={styles.hint}>Suite wählen (Bereich, Verbund oder Gesamt):</p>
            <div role="radiogroup" aria-label="Regressionstest-Suite" style={styles.optionsGroup}>
              {suites.map((suite) => {
                const key = scopeKey(suite.scope);
                return (
                  <label key={key} style={styles.optionLabel}>
                    <input
                      type="radio"
                      name="regression-run-suite"
                      value={key}
                      checked={selectedKey === key}
                      onChange={() => setSelectedKey(key)}
                      data-testid={`regression-run-suite-${key}`}
                    />
                    {' '}{suite.label}
                    {suite.target && (
                      <span style={styles.targetBadge} data-testid={`regression-run-target-${key}`}>
                        {TARGET_LABELS[suite.target] ?? suite.target}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            {/* AC6: Kosten-/Ressourcen-Hinweis bei ephemeral-infra-Suiten, VOR dem Start. */}
            {selectedSuite?.target === 'ephemeral-infra' && selectedSuite?.kosten && (
              <div style={styles.costNotice} role="note" data-testid="regression-run-cost-notice">
                Kosten-/Ressourcen-Hinweis: {selectedSuite.kosten}
              </div>
            )}

            {/* Main Success Scenario Schritt 3 (S-310, bereits Done): Frisch-Ausrollen-Option. */}
            {showFreshRolloutOption && (
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={isSelfProject ? false : freshRollout}
                  disabled={isSelfProject}
                  onChange={(e) => setFreshRollout(e.target.checked)}
                  data-testid="regression-run-fresh-rollout-checkbox"
                />
                {' '}Neustes Image vor dem Lauf ausrollen
              </label>
            )}
            {showFreshRolloutOption && isSelfProject && (
              <p style={styles.hint} data-testid="regression-run-selftest-hint">
                Selbsttest: dieses Projekt läuft im selben Container wie der Runner — Frisch-Ausrollen wird
                automatisch übersprungen.
              </p>
            )}

            {startError && (
              <div role="alert" style={styles.error} data-testid="regression-run-start-error">
                {startError}
              </div>
            )}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={canStart && !starting ? styles.btnPrimary : styles.btnDisabled}
                disabled={!canStart || starting}
                aria-disabled={!canStart || starting}
                onClick={handleStart}
                data-testid="regression-run-start-btn"
              >
                {starting ? 'Startet…' : 'Regressionstest starten'}
              </button>
            </div>
          </>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="regression-run-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog RegressionDefineDialog.jsx) ──────────────────────────────

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 999,
  },
  dialog: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    background: '#1a1a1a',
    border: '1px solid #374151',
    borderRadius: 10,
    padding: '24px 28px',
    minWidth: 460,
    maxWidth: 560,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
  },
  heading: {
    margin: '0 0 4px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },
  hint: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  optionsGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 14,
  },
  optionLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
  },
  targetBadge: {
    marginLeft: 8,
    fontSize: 11,
    color: '#9ca3af',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
    marginBottom: 8,
  },
  costNotice: {
    color: '#fbbf24',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a2410',
    borderRadius: 6,
    border: '1px solid #78350f',
    marginBottom: 12,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 12,
  },
  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  btnPrimary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnSecondary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDisabled: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#4b5563',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'not-allowed',
  },
};
