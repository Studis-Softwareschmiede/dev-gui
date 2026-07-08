/**
 * RegressionResultView.jsx — Regressions-Ergebnis-Ansicht je Projekt
 * (docs/specs/regression-result-view.md AC3–AC6).
 *
 * Struktur/A11y-Muster 1:1 aus `RegressionRunDialog.jsx`/
 * `RegressionDefineDialog.jsx` übernommen (Backdrop, `role="dialog"` +
 * `aria-modal`, Fokus beim Öffnen, `Esc` schließt IMMER, Fokus-Rückgabe an
 * `triggerRef`, `mountedRef`-Guard gegen State-Updates nach Unmount —
 * .claude/lessons/coder.md 2026-07-01/2026-07-03).
 *
 * Read-only: konsumiert ausschließlich die bereits gelandete Read-API aus
 * S-313 (`docs/specs/regression-result-view.md` AC1/AC2, `src/routers/
 * regressionRuns.js`) — keine Mutations-Endpunkte, kein neuer Backend-Code.
 *
 * Covers (regression-result-view):
 *   AC3 — Lauf-Liste je Projekt (Datum, Suite, grün/rot, Dauer,
 *          Testfall-Zähler `passed/total`), jüngste zuerst (Store liefert
 *          bereits absteigend nach `startedAt`, s. regressionRuns.js).
 *          grün/rot immer mit Icon (✓/✗) + Text + Farbe (nie Farbe allein,
 *          WCAG 2.1 AA) — Konvention aus regression-panel D9.
 *   AC4 — Einfacher grün/rot-Trend je Suite: aus der bereits geladenen Liste
 *          nach `suite` gruppiert, je Suite die Abfolge der letzten Läufe
 *          (jüngste zuerst, wie die Liste selbst) als Icon-Kette — KEINE
 *          eigene Statistik/Diagramm-Bibliothek (Nicht-Ziel der Spec).
 *   AC5 — Drilldown: Klick auf einen Lauf lädt `GET .../regression-runs/:runId`
 *          und zeigt die Testfälle aus `ctrf.results.tests[]` (Name +
 *          grün/rot + Fehlermeldung bei Rot). Ist `ctrf`/`results`/`tests`
 *          nicht das erwartete Format (unlesbar/teilweise), zeigt der
 *          Drilldown eine degradierte Meldung statt zu crashen (Edge-Case).
 *   AC6 — Debug-Artefakt-Zugriff (Link auf
 *          `GET .../regression-runs/:runId/artifacts/`) NUR wenn
 *          `run.status === 'failed'` — grüne Läufe zeigen keinen Link (kein
 *          toter Link, Edge-Case „Artefakt-Zugriff auf einen grünen ... Lauf
 *          → 404, kein Leak" wird so vermieden, statt erst serverseitig
 *          sichtbar zu werden).
 *
 * Edge-Cases (Spec):
 *   - Keine Läufe → Hinweistext „Noch kein Regressionstest gelaufen."
 *     (kein Fehler, s. Liste selbst).
 *   - CTRF-Details eines Laufs unlesbar/teilweise → Lauf bleibt in der
 *     Liste, Drilldown zeigt degradierte Meldung statt Crash.
 *   - Suite mit nur einem Lauf → Trend zeigt genau diesen einen Zustand
 *     (kein Sonderfall nötig — die Gruppierung produziert ohnehin ein
 *     1-elementiges Array).
 *
 * ── Component-Props-Vertrag ─────────────────────────────────────────────────
 * @param {{
 *   projectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 *
 * - `projectSlug` — das aktive Projekt (Cockpit-Kontext).
 * - `onClose` — schließt die Ansicht (X/`Esc`/Backdrop).
 * - `triggerRef` — optional; erhält beim Schließen den Fokus zurück (A11y).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML`.
 *   - Kein Secret/Token im UI — Lauf-/Testfall-Texte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`regressionRuns.js`, s. dortige
 *     Modul-Doku „Security (Floor)").
 *   - Artefakt-Link zeigt ausschließlich auf den bereits pfad-confined
 *     Backend-Endpunkt (`.../artifacts/`) — kein Client-seitiger Pfadbau
 *     über Nutzereingabe.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Gruppiert die (bereits jüngste-zuerst sortierte) Lauf-Liste nach `suite`
 * und behält je Suite die Reihenfolge der Gesamtliste bei (AC4: Trend =
 * Abfolge der letzten Läufe DIESER Suite, jüngste zuerst).
 *
 * @param {Array<{suite: string, status: string}>} runs
 * @returns {Array<{ suite: string, runs: Array }>}
 */
function groupBySuite(runs) {
  const order = [];
  const bySuite = new Map();
  for (const run of runs) {
    const key = run.suite || '(ohne Suite)';
    if (!bySuite.has(key)) {
      bySuite.set(key, []);
      order.push(key);
    }
    bySuite.get(key).push(run);
  }
  return order.map((suite) => ({ suite, runs: bySuite.get(suite) }));
}

/**
 * @param {string|number|null|undefined} ts
 * @returns {string} formatiertes Datum (Muster CockpitView.jsx formatRegressionTimestamp).
 */
function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return `${s.toFixed(1)} s`;
}

/**
 * AC3/AC5: Icon+Text+Farbe-Baustein für grün/rot — nie Farbe allein
 * (WCAG 2.1 AA), Icon-Konvention ✓/✗ wie regression-panel D9.
 *
 * @param {{ status: string }} props
 */
function StatusBadge({ status }) {
  if (status === 'failed') {
    return (
      <span style={styles.statusFailed} data-testid="regression-result-status-badge" data-status="failed">
        ✗ Fehlgeschlagen
      </span>
    );
  }
  if (status === 'passed') {
    return (
      <span style={styles.statusPassed} data-testid="regression-result-status-badge" data-status="passed">
        ✓ Erfolgreich
      </span>
    );
  }
  return (
    <span style={styles.statusUnknown} data-testid="regression-result-status-badge" data-status={status ?? 'unknown'}>
      ? Unbekannt
    </span>
  );
}

/**
 * AC4: einfache Icon-Kette für den grün/rot-Trend einer Suite — keine
 * Statistik/Diagramm-Bibliothek, nur die Abfolge (jüngste zuerst, ganz
 * links).
 *
 * @param {{ runs: Array<{status: string}> }} props
 */
function SuiteTrend({ runs }) {
  return (
    <span style={styles.trendRow} data-testid="regression-result-trend">
      {runs.map((run, idx) => (
        <span
          key={run.runId ?? idx}
          style={run.status === 'failed' ? styles.trendDotFailed : styles.trendDotPassed}
          title={run.status === 'failed' ? 'Fehlgeschlagen' : 'Erfolgreich'}
          aria-hidden="true"
        >
          {run.status === 'failed' ? '✗' : '✓'}
        </span>
      ))}
      <span style={styles.trendSrOnly}>
        {runs.map((r) => (r.status === 'failed' ? 'Fehlgeschlagen' : 'Erfolgreich')).join(', ')}
      </span>
    </span>
  );
}

export function RegressionResultView({ projectSlug, onClose, triggerRef, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  const [runs, setRuns] = useState(null); // null = lädt, [] = leer/Fehler
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [runDetail, setRunDetail] = useState(null); // null = kein Drilldown offen
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

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

  // Fokus beim Öffnen; Esc schließt (Muster RegressionRunDialog/RegressionDefineDialog).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('input, textarea, button:not([disabled]), a[href]');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // AC3: Lauf-Liste laden (GET /api/projects/:slug/regression-runs).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch_(`/api/projects/${encodeURIComponent(projectSlug)}/regression-runs`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data?.runs) ? data.runs : [];
        if (cancelled || !mountedRef.current) return;
        setRuns(list);
      } catch {
        if (cancelled || !mountedRef.current) return;
        setRuns([]);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  // AC5: Drilldown — Einzel-Lauf inkl. CTRF-Testfälle laden.
  const handleSelectRun = useCallback(async (runId) => {
    setSelectedRunId(runId);
    setRunDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const res = await fetch_(`/api/projects/${encodeURIComponent(projectSlug)}/regression-runs/${encodeURIComponent(runId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mountedRef.current) return;
      setRunDetail(data?.run ?? null);
    } catch {
      if (!mountedRef.current) return;
      setDetailError('Lauf-Details konnten nicht geladen werden.');
    } finally {
      if (mountedRef.current) setDetailLoading(false);
    }
  }, [projectSlug, fetch_]);

  const handleCloseDrilldown = useCallback(() => {
    setSelectedRunId(null);
    setRunDetail(null);
    setDetailError('');
  }, []);

  const suiteGroups = Array.isArray(runs) ? groupBySuite(runs) : [];

  // AC5 Edge-Case: CTRF-Details unlesbar/teilweise → degradierte Meldung
  // statt Crash (kein `ctrf`, kein `results`, kein `tests`-Array).
  const testCases = Array.isArray(runDetail?.ctrf?.results?.tests) ? runDetail.ctrf.results.tests : null;

  const titleId = 'regression-result-view-title';

  return (
    <>
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="regression-result-view"
      >
        <h2 id={titleId} style={styles.heading}>Regressions-Ergebnisse</h2>

        {runs === null && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-result-loading">
            Läufe werden geladen…
          </p>
        )}

        {runs !== null && runs.length === 0 && (
          <p style={styles.hint} data-testid="regression-result-empty">
            Noch kein Regressionstest gelaufen.
          </p>
        )}

        {runs !== null && runs.length > 0 && !selectedRunId && (
          <>
            {/* AC4: einfacher grün/rot-Trend je Suite. */}
            <div style={styles.trendSection} data-testid="regression-result-trends">
              {suiteGroups.map(({ suite, runs: suiteRuns }) => (
                <div key={suite} style={styles.trendItem} data-testid={`regression-result-trend-${suite}`}>
                  <span style={styles.trendLabel}>{suite}</span>
                  <SuiteTrend runs={suiteRuns} />
                </div>
              ))}
            </div>

            {/* AC3: Lauf-Liste, jüngste zuerst (Store liefert bereits absteigend). */}
            <ul style={styles.runList} data-testid="regression-result-list">
              {runs.map((run) => (
                <li key={run.runId} style={styles.runItem}>
                  <button
                    type="button"
                    style={styles.runButton}
                    onClick={() => handleSelectRun(run.runId)}
                    data-testid={`regression-result-run-${run.runId}`}
                    aria-label={`Lauf ${run.suite} vom ${formatTimestamp(run.startedAt)} — Testfälle anzeigen`}
                  >
                    <span style={styles.runRowTop}>
                      <StatusBadge status={run.status} />
                      <span style={styles.runSuite}>{run.suite}</span>
                    </span>
                    <span style={styles.runRowBottom}>
                      <span>{formatTimestamp(run.startedAt)}</span>
                      <span>{formatDuration(run.durationMs)}</span>
                      <span>{run.counts?.passed ?? 0}/{run.counts?.total ?? 0} bestanden</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* AC5: Drilldown — Testfälle des ausgewählten Laufs. */}
        {selectedRunId && (
          <div data-testid="regression-result-drilldown">
            <button
              type="button"
              style={styles.btnBack}
              onClick={handleCloseDrilldown}
              data-testid="regression-result-drilldown-back"
            >
              ← zurück zur Lauf-Liste
            </button>

            {detailLoading && (
              <p role="status" aria-live="polite" style={styles.hint} data-testid="regression-result-drilldown-loading">
                Testfälle werden geladen…
              </p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" style={styles.hint} data-testid="regression-result-drilldown-error">
                {detailError}
              </p>
            )}

            {!detailLoading && !detailError && runDetail && (
              <>
                <h3 style={styles.subHeading}>
                  {runDetail.suite} — {formatTimestamp(runDetail.startedAt)}
                </h3>

                {/* AC6: Debug-Artefakt-Zugriff NUR bei roten Läufen (kein toter Link bei Grün). */}
                {runDetail.status === 'failed' && (
                  <a
                    href={`/api/projects/${encodeURIComponent(projectSlug)}/regression-runs/${encodeURIComponent(runDetail.runId)}/artifacts/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.artifactLink}
                    data-testid="regression-result-artifact-link"
                  >
                    Debug-Artefakte (HTML-Report) öffnen ↗
                  </a>
                )}

                {testCases === null && (
                  <p style={styles.hint} data-testid="regression-result-ctrf-degraded">
                    Testfall-Details konnten nicht gelesen werden (unerwartetes Format).
                  </p>
                )}

                {testCases !== null && testCases.length === 0 && (
                  <p style={styles.hint} data-testid="regression-result-ctrf-empty">
                    Keine Testfälle im Ergebnis.
                  </p>
                )}

                {testCases !== null && testCases.length > 0 && (
                  <ul style={styles.testCaseList} data-testid="regression-result-testcases">
                    {testCases.map((tc, idx) => {
                      const isFailed = tc?.status === 'failed';
                      return (
                        <li key={`${tc?.name ?? 'test'}-${idx}`} style={styles.testCaseItem}>
                          <span style={styles.testCaseRow}>
                            <StatusBadge status={tc?.status} />
                            <span>{tc?.name ?? '(ohne Namen)'}</span>
                          </span>
                          {isFailed && tc?.message && (
                            <p role="alert" style={styles.testCaseMessage} data-testid="regression-result-testcase-message">
                              {tc.message}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="regression-result-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog RegressionRunDialog.jsx/RegressionDefineDialog.jsx) ─────────

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
    minWidth: 480,
    maxWidth: 640,
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
  subHeading: {
    margin: '0 0 8px',
    fontSize: 15,
    fontWeight: 600,
    color: '#f0f9ff',
  },
  hint: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  trendSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 14,
    padding: '8px 10px',
    background: '#111827',
    borderRadius: 6,
    border: '1px solid #1f2937',
  },
  trendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
  },
  trendLabel: {
    color: '#9ca3af',
    minWidth: 100,
  },
  trendRow: {
    display: 'inline-flex',
    gap: 2,
  },
  trendDotPassed: {
    color: '#4ade80',
    fontSize: 12,
  },
  trendDotFailed: {
    color: '#f87171',
    fontSize: 12,
  },
  trendSrOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
  runList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  runItem: {
    margin: 0,
  },
  runButton: {
    width: '100%',
    textAlign: 'left',
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 6,
    padding: '8px 10px',
    color: '#e5e7eb',
    cursor: 'pointer',
    minHeight: 44,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  runRowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    fontWeight: 600,
  },
  runSuite: {
    color: '#e5e7eb',
  },
  runRowBottom: {
    display: 'flex',
    gap: 12,
    fontSize: 12,
    color: '#9ca3af',
  },
  statusPassed: {
    color: '#4ade80',
    fontWeight: 600,
  },
  statusFailed: {
    color: '#f87171',
    fontWeight: 600,
  },
  statusUnknown: {
    color: '#9ca3af',
    fontWeight: 600,
  },
  btnBack: {
    background: 'none',
    border: 'none',
    color: '#93c5fd',
    cursor: 'pointer',
    fontSize: 13,
    padding: '4px 0',
    marginBottom: 10,
    textDecoration: 'underline',
    minHeight: 44,
  },
  artifactLink: {
    display: 'inline-block',
    color: '#93c5fd',
    fontSize: 13,
    marginBottom: 12,
  },
  testCaseList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  testCaseItem: {
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 6,
    padding: '8px 10px',
  },
  testCaseRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
  },
  testCaseMessage: {
    margin: '6px 0 0',
    fontSize: 12,
    color: '#f87171',
  },
  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 12,
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
};
