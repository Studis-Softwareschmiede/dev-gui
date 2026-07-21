/**
 * RedTeamScanPanel.jsx — Live-Fortschritts-Panel für den Pro-Container Red-Team-Scan
 * (docs/specs/red-team-scan-per-container.md, AC11/AC12/AC13; Auslöser-Knopf ist AC10 in
 * `VpsView.jsx` `ContainerRow`).
 *
 * A11y-/Poll-Muster 1:1 aus `ObsidianIngestOverlay.jsx` übernommen (Backdrop, Fokus beim
 * Öffnen, `Esc` schließt IMMER, `mountedRef`-Guard gegen State-Updates nach Unmount,
 * expliziter Nicht-200-Fehlerzweig im Poll-Loop statt stiller Endlos-"running"-Behandlung
 * — s. .claude/lessons/coder.md 2026-07-01) sowie das Degradations-Muster (Timeout +
 * Fail-Streak) aus `RedTeamView.jsx` (`maybeDegrade`, docs/specs/red-team-tile.md) — beide
 * bereits im Projekt etabliert (Simplicity-Leiter Stufe 2, `coder/R09`).
 *
 * ── Eigenständige, selbst-startende Komponente (Implementierungswahl) ──────────────
 * Diese Komponente startet den Scan-Job SELBST (POST beim Mount) und pollt ihn bis zu
 * einem Terminalzustand — analog zu `ObsidianIngestOverlay`, das seinen Lauf ebenfalls
 * selbst bootet. `ContainerRow` (Aufrufer) rendert dieses Panel bedingungslos, sobald der
 * Scan-Knopf geklickt wurde, und hält NUR den Mount-Zustand (kein zweiter, unabhängig
 * gepflegter Job-/Poll-State im Aufrufer) — die Client-Sperre gegen Doppelklick (AC10)
 * ergibt sich daraus, dass der Knopf deaktiviert ist, solange dieses Panel gemountet ist.
 *
 * Covers (red-team-scan-per-container):
 *   AC10 — (Aufrufer-seitig in VpsView.jsx ContainerRow) Klick sperrt den Knopf sofort und
 *          mountet dieses Panel; ein zweiter Klick ist wirkungslos, solange das Panel
 *          gemountet ist (Client-Sperre; Server-409 bleibt als zweite Verteidigungslinie).
 *   AC11 — Live-Fortschritts-Panel: POSTet `.../scan` beim Mount, pollt danach
 *          `GET .../scan/:jobId` bis `done`/`failed`/`auth-expired`/Timeout. Phasen-Anzeige
 *          ist BEWUSST defensiv (Feature-Handoff S-401: der wiederverwendete
 *          `HeadlessRedTeamRunner` liefert nur `phase ∈ {direkt, fertig}`, coarse, kein
 *          Zwischen-Fortschritts-Signal) — der Stepper (Direkt-Scan → Cloudflare-Scan →
 *          Befunde → Fertig) wird NUR während `running` gezeigt (Review-Fix Iteration 2:
 *          während `starting` ist noch kein Schritt aktiv — kein Vortäuschen, dass
 *          Direkt+Cloudflare bereits laufen, bevor der Job überhaupt gestartet ist).
 *   AC12 — Ergebnis-Anzeige bei `done`: NUR wenn der Status-Endpunkt echte `ampel`-Daten
 *          liefert (Store-Treffer — die Findings-Extraktion aus dem Runner-Output ist eine
 *          bewusst offene Folge-Naht, s. `vpsContainerScanRouter.js`-Moduldoku) zeigt das
 *          Panel Ampel (grün/gelb/rot, Text-Badge — nicht nur Farbe, A11y) + Befund-
 *          Kurzliste (max. `MAX_FINDINGS_SHOWN`, Rest als "N weitere"). OHNE `ampel`-Daten
 *          zeigt das Panel eine ehrliche, neutrale Meldung ("Befund-Erfassung noch nicht
 *          verfügbar") statt einer irreführenden grünen "keine Befunde"-Aussage (Review-Fund
 *          Iteration 2, Critical — ein hartkodiertes "gruen" für jeden Lauf wäre eine aktiv
 *          falsche "alles sicher"-Behauptung für ein Sicherheitswerkzeug). Der Link zum
 *          vollen Bericht (`reportRef`) erscheint in BEIDEN Fällen, sofern vorhanden (der
 *          Backend-Endpunkt liefert `reportRef` bei `done` auch ohne Store-Treffer aus
 *          `job.prHint`) — sonst ein klarer "kein Bericht"-Hinweis statt totem Link. Liefert
 *          der Endpunkt künftig echte `ampel`/`findings` (sobald die Folge-Naht geschlossen
 *          ist), greift der bestehende Ampel-Pfad unverändert — kein neuer Code nötig.
 *   AC13 — Fehler/Abbruch klar: `failed`/`auth-expired`/Netzwerk-Start-Fehler/Timeout
 *          (Safety-Window + Fail-Streak, Muster RedTeamView) zeigen einen `role="alert"`-
 *          Text — NIE ein stiller/hängender Zustand. Ein Nicht-200-Poll-Ergebnis wird
 *          explizit als Fehler behandelt (lessons 2026-07-01), NICHT als "noch running".
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — Fehler-/Befundtexte werden als reiner React-Text
 *     gerendert.
 *   - Keine Ziel-URL/Host-Pfad-Eingabe — der Job wird ausschließlich über
 *     `provider`/`serverId`/`containerId` gestartet (Server leitet Ziele server-seitig ab,
 *     AC4 — kein Freitext-URL-Feld in diesem Panel).
 *   - `reportRef` wird 1:1 vom bereits secret-freien Backend-Contract übernommen (kein
 *     Secret/Token/absoluter Host-Pfad in Response, s. `vpsContainerScanRouter.js` AC22).
 *
 * @param {{
 *   provider: string,
 *   serverId: string,
 *   containerId: string,
 *   containerLabel: string,
 *   onClose: () => void,
 *   onEnded?: () => void,
 *   fetchFn?: Function,
 *   pollMs?: number,
 * }} props
 *   provider/serverId/containerId — identifizieren den Ziel-Container (URL-Bausteine,
 *     identisch zur Konvention der übrigen Container-Aktionen in `VpsView.jsx`).
 *   containerLabel — Anzeige-Name/Hostname für die Panel-Überschrift.
 *   onClose — schließt das Panel (X/`Esc`/Backdrop) — reagiert IMMER sofort, JEDER
 *     Zustand; bricht den (fire-and-forget) Backend-Lauf NICHT ab.
 *   onEnded — genau einmal aufgerufen, sobald ein Terminalzustand erreicht ist (`done`/
 *     `failed`/`auth-expired`/Timeout/Start-Fehler) — Aufrufer nutzt dies, um den Scan-
 *     Knopf-Spinner zu stoppen (Panel bleibt bis zum expliziten Schließen sichtbar).
 *   fetchFn — injectable `fetch` für Tests (default: `globalThis.fetch`).
 *   pollMs — Poll-Intervall (default 3000; in Tests überschreibbar).
 */

import { useState, useRef, useEffect, useCallback } from 'react';

/** Poll-Intervall (ms) für den Job-Status (überschreibbar via Prop `pollMs`). */
const SCAN_POLL_MS = 3000;

/** Sicherheitsfenster gegen einen hängenden Poll (Runner-Timeout 15 min + Puffer, Muster RedTeamView). */
const SCAN_SAFETY_WINDOW_MS = 20 * 60 * 1000;

/** Nach so vielen aufeinanderfolgenden Poll-Fehlern gilt der Lauf als "Status unklar". */
const SCAN_MAX_CONSECUTIVE_FAILURES = 5;

/** Max. Anzahl Befunde in der Kurzliste (AC12) — Rest wird als "N weitere" zusammengefasst. */
const MAX_FINDINGS_SHOWN = 5;

const PHASE_STEPS = [
  { key: 'direkt', label: 'Direkt-Scan' },
  { key: 'cloudflare', label: 'Cloudflare-Scan' },
  { key: 'befunde', label: 'Befunde' },
  { key: 'fertig', label: 'Fertig' },
];

const AMPEL_LABEL = {
  gruen: 'Grün — keine Befunde',
  gelb: 'Gelb — geringe/mittlere Befunde',
  rot: 'Rot — kritische Befunde',
};

// Kontrastpaare analog BoardView/ObsidianIngestOverlay-Konvention (WCAG AA).
const AMPEL_STYLE = {
  gruen: { color: '#6ee7b7', background: '#0f2417', border: '1px solid #14532d' },
  gelb: { color: '#fcd34d', background: '#2a1f00', border: '1px solid #b45309' },
  rot: { color: '#fca5a5', background: '#2a1a1a', border: '1px solid #7f1d1d' },
};

export function RedTeamScanPanel({
  provider,
  serverId,
  containerId,
  containerLabel,
  onClose,
  onEnded,
  fetchFn,
  pollMs = SCAN_POLL_MS,
}) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  // 'starting' | 'running' | 'done' | 'failed' | 'auth-expired' | 'timeout' | 'start-error'
  const [phase, setPhase] = useState('starting');
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState(null); // { ampel, findings, reportRef }

  const jobIdRef = useRef(null);
  const dialogRef = useRef(null);
  const startedAtRef = useRef(null);
  const failStreakRef = useRef(0);
  const endedRef = useRef(false); // onEnded genau einmal
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const signalEnded = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    onEnded?.();
  }, [onEnded]);

  // Fokus beim Öffnen; Esc schließt IMMER (Muster ObsidianIngestOverlay, AC13: nie still).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('button:not([disabled]), a[href]');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // ── Start (POST .../scan) — genau einmal beim Mount (AC11) ─────────────────────
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}/scan`;
      let res;
      try {
        res = await fetch_(url, { method: 'POST' });
      } catch {
        if (cancelled || !mountedRef.current) return;
        setPhase('start-error');
        setErrorMsg('Netzwerkfehler beim Starten des Scans — bitte schließen und erneut versuchen.');
        signalEnded();
        return;
      }
      if (cancelled || !mountedRef.current) return;

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (cancelled || !mountedRef.current) return;

      if (res.status === 202) {
        const jid = typeof data.jobId === 'string' && data.jobId.trim() !== '' ? data.jobId : null;
        if (!jid) {
          setPhase('start-error');
          setErrorMsg('Scan gestartet, aber keine gültige Job-ID erhalten — bitte schließen und erneut versuchen.');
          signalEnded();
          return;
        }
        jobIdRef.current = jid;
        startedAtRef.current = Date.now();
        setPhase('running');
        return;
      }
      if (res.status === 409) {
        setPhase('start-error');
        setErrorMsg('Für diesen Container läuft bereits ein Scan — bitte warten.');
        signalEnded();
        return;
      }
      if (res.status === 422) {
        setPhase('start-error');
        setErrorMsg('Container ist nicht scanbar (nicht managed/nicht laufend oder Ziel nicht auflösbar).');
        signalEnded();
        return;
      }
      setPhase('start-error');
      setErrorMsg(data.error ?? `Scan konnte nicht gestartet werden (HTTP ${res.status}).`);
      signalEnded();
    }

    boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Poll-Loop (AC11/AC13): running → done | failed | auth-expired | timeout ────
  useEffect(() => {
    if (phase !== 'running') return undefined;
    let stopped = false;
    let timer;

    function stop() {
      stopped = true;
      clearInterval(timer);
    }

    function maybeDegrade() {
      const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
      const timedOut = elapsed >= SCAN_SAFETY_WINDOW_MS;
      const tooManyFailures = failStreakRef.current >= SCAN_MAX_CONSECUTIVE_FAILURES;
      if (timedOut || tooManyFailures) {
        stop();
        if (!mountedRef.current) return;
        setPhase('timeout');
        setErrorMsg('Status unklar (Zeitüberschreitung) — der Scan läuft evtl. im Hintergrund weiter.');
        signalEnded();
      }
    }

    async function pollOnce() {
      if (stopped || !jobIdRef.current) return;
      let res;
      try {
        res = await fetch_(
          `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}/scan/${encodeURIComponent(jobIdRef.current)}`,
        );
      } catch {
        failStreakRef.current += 1;
        maybeDegrade();
        return;
      }
      if (stopped || !mountedRef.current) return;

      // lessons 2026-07-01: Nicht-200 NICHT wie "noch running" behandeln.
      if (res.status !== 200) {
        failStreakRef.current += 1;
        maybeDegrade();
        return;
      }

      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (stopped || !mountedRef.current) return;
      failStreakRef.current = 0;

      if (data.status === 'done') {
        stop();
        setResult({
          ampel: data.ampel,
          findings: Array.isArray(data.findings) ? data.findings : [],
          reportRef: typeof data.reportRef === 'string' && data.reportRef ? data.reportRef : null,
        });
        setPhase('done');
        signalEnded();
        return;
      }
      if (data.status === 'failed' || data.status === 'auth-expired') {
        stop();
        setPhase(data.status);
        setErrorMsg(
          data.status === 'auth-expired'
            ? 'Anmeldung abgelaufen — Scan konnte nicht abgeschlossen werden.'
            : 'Scan fehlgeschlagen.',
        );
        signalEnded();
        return;
      }
      // 'running' → weiterpollen.
    }

    pollOnce();
    timer = setInterval(pollOnce, pollMs);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pollMs]);

  const isError = phase === 'failed' || phase === 'auth-expired' || phase === 'timeout' || phase === 'start-error';
  // Defensiver Stepper (AC11): Backend liefert nur phase∈{direkt,fertig} (coarse) — kein
  // Vortäuschen einzelner Zwischenstände. Der Stepper wird NUR während `running` gezeigt
  // (s.u.) — `activeStepIndex` gilt daher ausschliesslich für running/done: running →
  // "Direkt+Cloudflare" aktiv; done → alles fertig. Review-Fix (Iteration 2, Suggestion):
  // während `starting` wird der Stepper gar nicht gerendert (statt Direkt+Cloudflare
  // fälschlich als "erledigt" zu zeigen, bevor der Job überhaupt gestartet ist).
  const activeStepIndex = phase === 'done' ? PHASE_STEPS.length - 1 : 1;

  const titleId = 'redteam-scan-panel-title';
  const findings = result?.findings ?? [];
  const shownFindings = findings.slice(0, MAX_FINDINGS_SHOWN);
  const hiddenCount = findings.length - shownFindings.length;
  // Review-Fix (Iteration 2, Critical): der Status-Endpunkt liefert `ampel` NUR, wenn ein
  // Store-Treffer existiert (die Findings-Extraktion ist eine bewusst offene Folge-Naht,
  // s. `vpsContainerScanRouter.js`) — OHNE `ampel` darf das Panel NIE eine grüne
  // "keine Befunde"-Aussage vortäuschen (aktiv irreführend für ein Sicherheitswerkzeug).
  const hasAmpelData = phase === 'done' && result != null && result.ampel !== undefined && result.ampel !== null;

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="redteam-scan-panel"
      >
        <h3 id={titleId} style={styles.heading}>Red-Team-Scan: {containerLabel}</h3>

        {!isError && phase !== 'done' && (
          <>
            <p role="status" aria-live="polite" style={styles.hint} data-testid="redteam-scan-running">
              {phase === 'starting' ? 'Scan wird gestartet…' : 'Scan läuft (direkt + über Cloudflare)…'}
            </p>
            {/* Review-Fix (Iteration 2, Suggestion): Stepper NUR während `running` — während
                `starting` ist noch kein einziger Schritt aktiv, ein Rendern mit
                `activeStepIndex:1` würde Direkt+Cloudflare fälschlich als "in Arbeit" zeigen,
                bevor der Job überhaupt existiert. */}
            {phase === 'running' && (
              <ol style={styles.stepper} aria-label="Scan-Fortschritt">
                {PHASE_STEPS.map((step, idx) => (
                  <li
                    key={step.key}
                    style={idx <= activeStepIndex ? styles.stepDone : styles.stepPending}
                    aria-current={idx === activeStepIndex ? 'step' : undefined}
                  >
                    {step.label}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        {isError && (
          <div role="alert" style={styles.error} data-testid="redteam-scan-error">
            {errorMsg}
          </div>
        )}

        {phase === 'done' && result && (
          <div data-testid="redteam-scan-result">
            {/* Review-Fix (Iteration 2, Critical): OHNE echte ampel-Daten (kein Store-Treffer
                — die Findings-Extraktion ist eine bewusst offene Folge-Naht, s.
                `vpsContainerScanRouter.js`) darf hier NIE eine grüne "keine Befunde"-Aussage
                erscheinen — das wäre eine aktiv irreführende "alles sicher"-Behauptung für ein
                Sicherheitswerkzeug. Stattdessen eine ehrliche, neutrale Meldung; sobald der
                Endpunkt künftig echte ampel/findings liefert, greift der bestehende Ampel-Pfad
                unverändert (kein neuer Code nötig). */}
            {hasAmpelData ? (
              <>
                <span
                  style={{ ...styles.ampelBadge, ...(AMPEL_STYLE[result.ampel] ?? AMPEL_STYLE.gruen) }}
                  data-testid="redteam-scan-ampel"
                >
                  {AMPEL_LABEL[result.ampel] ?? 'Unbekannter Status'}
                </span>

                {findings.length === 0 && (
                  <p style={styles.hint} data-testid="redteam-scan-no-findings">Keine Befunde erkannt.</p>
                )}

                {findings.length > 0 && (
                  <ul style={styles.findingsList} data-testid="redteam-scan-findings">
                    {shownFindings.map((f) => (
                      <li key={f.id ?? `${f.titel}-${f.testort}`} style={styles.findingItem}>
                        <strong>{f.severity ?? '—'}</strong> · {f.titel ?? '(ohne Titel)'} · {f.testort ?? '—'}
                      </li>
                    ))}
                    {hiddenCount > 0 && <li style={styles.findingMore}>… {hiddenCount} weitere</li>}
                  </ul>
                )}
              </>
            ) : (
              <p role="status" style={styles.hint} data-testid="redteam-scan-no-ampel-data">
                Scan abgeschlossen — die automatische Befund-Erfassung ist für diesen Lauf noch
                nicht verfügbar. Details im vollen Bericht.
              </p>
            )}

            <p style={styles.hint}>
              {result.reportRef ? (
                <a
                  href={result.reportRef}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.reportLink}
                  data-testid="redteam-scan-report-link"
                >
                  Vollen Bericht öffnen
                </a>
              ) : (
                <span data-testid="redteam-scan-no-report">Kein Bericht verfügbar.</span>
              )}
            </p>
          </div>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={onClose}
            data-testid="redteam-scan-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (Muster ObsidianIngestOverlay/RedTeamView) ─────────────────────────

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
    padding: '20px 24px',
    minWidth: 380,
    maxWidth: 520,
    maxHeight: '80vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
  },
  heading: {
    margin: '0 0 10px',
    fontSize: 16,
    fontWeight: 700,
    color: '#f0f9ff',
    wordBreak: 'break-all',
  },
  hint: {
    margin: '4px 0 8px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  stepper: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    listStyle: 'none',
    padding: 0,
    margin: '4px 0 8px',
  },
  stepDone: {
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 4,
    background: '#0f2022',
    color: '#56d364',
    border: '1px solid #1b4332',
  },
  stepPending: {
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 4,
    background: '#161b22',
    color: '#6b7280',
    border: '1px solid #30363d',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    margin: '4px 0 8px',
  },
  ampelBadge: {
    display: 'inline-block',
    fontSize: 12,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 6,
    marginBottom: 8,
  },
  findingsList: {
    listStyle: 'none',
    padding: 0,
    margin: '4px 0 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  findingItem: {
    fontSize: 12,
    color: '#d4d4d4',
    padding: '4px 6px',
    background: '#111',
    borderRadius: 4,
  },
  findingMore: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  reportLink: {
    color: '#60a5fa',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },
  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  btnSecondary: {
    minHeight: 44,
    padding: '8px 18px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
