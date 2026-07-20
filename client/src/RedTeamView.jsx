/**
 * RedTeamView.jsx — Red-Team-Kachel (Spec docs/specs/red-team-tile.md, AC7/AC8/AC9).
 *
 * Dünner Auslöser für die Fabrik-Fähigkeit /agent-flow:red-team — gesamte Logik
 * in der Fabrik. Die Kachel wählt ein Ziel aus einer konstruktiv erzwungenen
 * Allowlist (VPS-laufend ∩ eigenes Repo), verlangt eine explizite Feuer-Freigabe
 * und startet dann den Headless-Runner (POST → 202 {jobId} → Poll).
 *
 * AC7 — Ziel-Auswahl NUR aus GET /api/red-team/targets (Dropdown, kein Freitext),
 *        modus-Auswahl, explizite Feuer-Freigabe-Bestätigung (Sicherheits-Grenze
 *        sichtbar: Trockenlauf/Gerüst, kein Live-Angriff, keine Cloudflare-
 *        Umkonfiguration), POST-Start + Status-Polling (Muster ReconcileTrigger),
 *        Ergebnis-Anzeige inkl. Protokoll-Hinweis (docs/red-team-audit.md) + PR-Link.
 * AC8 — Leere Allowlist → klarer Hinweis, Start deaktiviert (nichts feuerbar).
 * AC9 — abgedeckt in client/src/__tests__/RedTeamView.test.jsx.
 *
 * Sicherheits-Grenze (agent-flow-Rahmen §6): Die Kachel triggert die Fabrik-
 * Fähigkeit, die in dieser Iteration TROCKEN läuft — sie feuert nicht selbst und
 * konfiguriert Cloudflare nicht um. Die Feuer-Freigabe ist eine explizite
 * menschliche Bestätigung. Board-Items/Protokoll landen als PR zur Freigabe.
 *
 * @param {{
 *   onNavigate: (view: string) => void,
 *   fetchFn?: Function,
 *   pollInterval?: number,
 * }} props
 *   fetchFn      — injizierbar für Tests (default: globalThis.fetch)
 *   pollInterval — Poll-Intervall in ms für den Job-Status (default: 3000)
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// Robuste Degradierung (Endlos-Spinner-Schutz, wie ReconcileTrigger maybeDegrade).
const SAFETY_WINDOW_MS = 20 * 60 * 1000; // 20 min — Runner-Default 15 min + Puffer
const MAX_CONSECUTIVE_FAILURES = 5;

const MODUS_OPTIONS = [
  { value: 'beide', label: 'beide (durch Cloudflare + direkt)' },
  { value: 'durch-cloudflare', label: 'nur durch Cloudflare' },
  { value: 'direkt', label: 'nur direkt' },
];

export default function RedTeamView({ onNavigate, fetchFn = fetch, pollInterval = 3000 }) {
  // Stabile Ref, damit der Poll-Effekt nicht bei jedem Render neu registriert.
  // Der globale `fetch` muss an `globalThis` gebunden werden (sonst „Illegal
  // invocation" im Browser); injizierte Mocks werden unverändert übernommen.
  const bind = (fn) => (fn === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fn);
  const fetchFnRef = useRef(bind(fetchFn));
  useEffect(() => {
    fetchFnRef.current = bind(fetchFn);
  }, [fetchFn]);

  // ── Allowlist-Ziele (GET /api/red-team/targets) ────────────────────────────
  /** 'loading' | 'ready' | 'error' */
  const [targetsState, setTargetsState] = useState('loading');
  const [targets, setTargets] = useState([]);
  const [targetsError, setTargetsError] = useState(null);

  // ── Auswahl ────────────────────────────────────────────────────────────────
  const [selectedSlug, setSelectedSlug] = useState('');
  const [modus, setModus] = useState('beide');
  const [fireConfirmed, setFireConfirmed] = useState(false);

  // ── Lauf-Zustand (Muster ReconcileTrigger) ─────────────────────────────────
  /** 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'degraded' | 'error' */
  const [runState, setRunState] = useState('idle');
  const [runError, setRunError] = useState(null);
  const [result, setResult] = useState(null); // { result?, prHint? }

  const jobIdRef = useRef(null);
  const runStartRef = useRef(null);
  const consecutiveFailRef = useRef(0);

  // ── Ziele laden (beim Mount) ────────────────────────────────────────────────
  const loadTargets = useCallback(async () => {
    setTargetsState('loading');
    setTargetsError(null);
    let res;
    try {
      res = await fetchFnRef.current('/api/red-team/targets');
    } catch {
      setTargetsState('error');
      setTargetsError('Ziele konnten nicht geladen werden (Netzwerkfehler).');
      return;
    }
    if (!res.ok) {
      setTargetsState('error');
      setTargetsError(`Ziele konnten nicht geladen werden (HTTP ${res.status}).`);
      return;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      setTargetsState('error');
      setTargetsError('Ziele konnten nicht geladen werden (ungültige Antwort).');
      return;
    }
    const list = Array.isArray(json?.targets) ? json.targets : [];
    setTargets(list);
    setTargetsState('ready');
  }, []);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  const finishRun = useCallback((nextPhase) => {
    setRunState(nextPhase);
    runStartRef.current = null;
    consecutiveFailRef.current = 0;
    jobIdRef.current = null;
  }, []);

  // ── Job-Status pollen (GET /api/red-team/:jobId) ────────────────────────────
  useEffect(() => {
    if (runState !== 'running') return undefined;
    let cancelled = false;

    function maybeDegrade() {
      const elapsed = Date.now() - (runStartRef.current ?? Date.now());
      const timedOut = elapsed >= SAFETY_WINDOW_MS;
      const tooManyFailures = consecutiveFailRef.current >= MAX_CONSECUTIVE_FAILURES;
      if (timedOut || tooManyFailures) {
        // Kein Endlos-Spinner, kein Crash.
        finishRun('degraded');
      }
    }

    async function pollJob() {
      const jobId = jobIdRef.current;
      if (!jobId) return;

      let res;
      try {
        res = await fetchFnRef.current(`/api/red-team/${encodeURIComponent(jobId)}`);
      } catch {
        if (cancelled) return;
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }
      if (cancelled) return;

      // 404 (unbekannte jobId, z.B. Server-Neustart) zählt als Poll-Fehler.
      if (!res.ok) {
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }

      let json;
      try {
        json = await res.json();
      } catch {
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }
      if (cancelled) return;

      consecutiveFailRef.current = 0;

      if (json.status === 'done') {
        setResult({ result: json.result, prHint: json.prHint });
        finishRun('done');
        return;
      }
      if (json.status === 'failed') {
        setRunError(
          typeof json.error === 'string' && json.error.trim()
            ? json.error
            : 'Red-Team-Lauf fehlgeschlagen.',
        );
        finishRun('failed');
        return;
      }
      if (json.status === 'auth-expired') {
        setRunError('Anmeldung abgelaufen — bitte Fabrik-Login erneuern und erneut starten.');
        finishRun('failed');
        return;
      }
      if (json.status === 'running') {
        maybeDegrade();
        return;
      }
      // Unbekannter Status — defensiv wie ein Poll-Fehler behandeln.
      consecutiveFailRef.current += 1;
      maybeDegrade();
    }

    pollJob();
    const timer = setInterval(pollJob, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runState, pollInterval, finishRun]);

  const hasTargets = targetsState === 'ready' && targets.length > 0;
  const emptyAllowlist = targetsState === 'ready' && targets.length === 0;
  const isRunActive = runState === 'starting' || runState === 'running';

  // AC7/AC8: Start erst nach Feuer-Freigabe, gültiger Auswahl, nicht-leerer Allowlist.
  const canStart = hasTargets && !!selectedSlug && fireConfirmed && !isRunActive;

  const selectedTarget = targets.find((t) => t.slug === selectedSlug) ?? null;

  // ── Start (POST /api/red-team) ──────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!selectedSlug || !fireConfirmed) return;
    setRunState('starting');
    setRunError(null);
    setResult(null);

    let res;
    try {
      res = await fetchFnRef.current('/api/red-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectSlug: selectedSlug, modus }),
      });
    } catch {
      setRunState('error');
      setRunError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      let json;
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      // Ohne verwertbare jobId NICHT nach 'running' — sonst bricht der Poll-Effekt
      // bei `if (!jobId) return` vor dem Degrade-Timer ab und der Spinner läuft endlos.
      const jid = typeof json.jobId === 'string' && json.jobId.trim() !== '' ? json.jobId : null;
      if (!jid) {
        setRunState('error');
        setRunError('Lauf gestartet, aber keine gültige Job-ID erhalten — bitte erneut versuchen.');
        return;
      }
      jobIdRef.current = jid;
      runStartRef.current = Date.now();
      consecutiveFailRef.current = 0;
      setRunState('running');
      return;
    }
    if (res.status === 403) {
      setRunState('error');
      setRunError('Nicht autorisiert: Ziel liegt nicht in der Allowlist (nur eigene, auf dem VPS laufende Apps).');
      return;
    }
    if (res.status === 409) {
      setRunState('error');
      setRunError('Für dieses Ziel läuft bereits ein Red-Team-Lauf — bitte warten.');
      return;
    }
    if (res.status === 400) {
      setRunState('error');
      setRunError('Lauf konnte nicht gestartet werden (ungültiges Ziel).');
      return;
    }
    setRunState('error');
    setRunError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [selectedSlug, modus, fireConfirmed]);

  const handleReset = useCallback(() => {
    setRunState('idle');
    setRunError(null);
    setResult(null);
  }, []);

  return (
    <main style={styles.view} aria-label="Red-Team-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Red-Team</h1>

        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          ← Zurück zum Panel
        </button>

        <p style={styles.intro}>
          Autorisiertes Testen einer <strong>eigenen</strong> App. Löst die Fabrik-Fähigkeit{' '}
          <code style={styles.code}>/agent-flow:red-team</code> aus — die gesamte Logik läuft in der
          Fabrik.
        </p>

        {/* Sicherheits-Grenze dauerhaft sichtbar (AC7) */}
        <div style={styles.safetyBox} role="note" data-testid="red-team-safety-note">
          Diese Iteration läuft als <strong>Trockenlauf/Gerüst</strong> — kein realer Live-Angriff,
          keine Cloudflare-Umkonfiguration. Koordination statt Tarnung. Funde landen als PR zur
          Freigabe.
        </div>

        {/* Ziele laden */}
        {targetsState === 'loading' && (
          <p style={styles.loading} aria-live="polite" aria-busy="true">
            Lade autorisierte Ziele…
          </p>
        )}

        {targetsState === 'error' && (
          <div>
            <p style={styles.error} role="alert" data-testid="red-team-targets-error">
              {targetsError}
            </p>
            <button type="button" style={styles.secondaryBtn} onClick={loadTargets}>
              Erneut laden
            </button>
          </div>
        )}

        {/* AC8 — leere Allowlist */}
        {emptyAllowlist && (
          <div style={styles.emptyBox} role="status" data-testid="red-team-empty">
            Kein autorisiertes Ziel verfügbar (nur Apps, die auf dem VPS laufen UND ein eigenes Repo
            sind). Nichts feuerbar.
          </div>
        )}

        {/* Auswahl + Start */}
        {hasTargets && (
          <section aria-labelledby="red-team-config-heading" style={styles.section}>
            <h2 id="red-team-config-heading" style={styles.sectionHeading}>
              Lauf konfigurieren
            </h2>

            {/* Ziel-Auswahl — Dropdown, kein Freitext (AC7) */}
            <label htmlFor="red-team-target" style={styles.fieldLabel}>
              Ziel (nur autorisierte Apps)
            </label>
            <select
              id="red-team-target"
              style={styles.select}
              value={selectedSlug}
              onChange={(e) => setSelectedSlug(e.target.value)}
              disabled={isRunActive}
              data-testid="red-team-targets-select"
            >
              <option value="">— Ziel wählen —</option>
              {targets.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.slug}
                  {t.image ? ` · ${t.image}` : ''}
                  {t.state ? ` · ${t.state}` : ''}
                </option>
              ))}
            </select>

            {selectedTarget && (
              <p style={styles.targetMeta} data-testid="red-team-target-meta">
                <span style={styles.metaMono}>{selectedTarget.slug}</span>
                {selectedTarget.image && <span style={styles.metaDim}> · {selectedTarget.image}</span>}
                {selectedTarget.state && <span style={styles.metaDim}> · {selectedTarget.state}</span>}
                {selectedTarget.repo && <span style={styles.metaDim}> · {selectedTarget.repo}</span>}
              </p>
            )}

            {/* Modus-Auswahl */}
            <label htmlFor="red-team-modus" style={styles.fieldLabel}>
              Modus
            </label>
            <select
              id="red-team-modus"
              style={styles.select}
              value={modus}
              onChange={(e) => setModus(e.target.value)}
              disabled={isRunActive}
              data-testid="red-team-modus-select"
            >
              {MODUS_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            {/* Feuer-Freigabe-Bestätigung (AC7) */}
            <label style={styles.confirmRow}>
              <input
                type="checkbox"
                checked={fireConfirmed}
                onChange={(e) => setFireConfirmed(e.target.checked)}
                disabled={isRunActive}
                style={styles.checkbox}
                data-testid="red-team-fire-confirm"
              />
              <span style={styles.confirmText}>
                <strong>Feuer-Freigabe.</strong> Autorisiertes Testen der EIGENEN App. Diese Iteration
                läuft als <strong>Trockenlauf/Gerüst</strong> — kein realer Live-Angriff, keine
                Cloudflare-Umkonfiguration. Koordination statt Tarnung.
              </span>
            </label>

            {/* Start */}
            {runState !== 'error' && runState !== 'failed' && (
              <button
                type="button"
                style={canStart ? styles.startBtn : styles.startBtnDisabled}
                disabled={!canStart}
                aria-disabled={!canStart}
                onClick={canStart ? handleStart : undefined}
                aria-label={
                  isRunActive
                    ? 'Red-Team-Lauf läuft'
                    : !fireConfirmed
                    ? 'Red-Team-Lauf starten — erst nach Feuer-Freigabe möglich'
                    : 'Red-Team-Lauf starten'
                }
                data-testid="red-team-start-btn"
              >
                {isRunActive ? 'Red-Team-Lauf läuft…' : 'Red-Team-Lauf starten'}
              </button>
            )}

            {/* Laufender Zustand */}
            {runState === 'running' && (
              <div
                role="status"
                aria-live="polite"
                style={styles.runningBox}
                data-testid="red-team-running"
              >
                Red-Team-Lauf läuft… (Trockenlauf)
              </div>
            )}

            {/* Degradiert (Timeout/zu viele Poll-Fehler) */}
            {runState === 'degraded' && (
              <div role="status" style={styles.degradedBox} data-testid="red-team-degraded">
                Status unklar (Zeitüberschreitung). Der Lauf könnte noch laufen — bitte später das
                Protokoll <code style={styles.code}>docs/red-team-audit.md</code> prüfen.
                <div>
                  <button type="button" style={styles.secondaryBtn} onClick={handleReset}>
                    Zurücksetzen
                  </button>
                </div>
              </div>
            )}

            {/* Fehler beim Start / Lauf */}
            {(runState === 'error' || runState === 'failed') && (
              <div style={styles.errorBox} role="alert" data-testid="red-team-error">
                {runError}
                <div>
                  <button
                    type="button"
                    style={styles.secondaryBtn}
                    onClick={handleReset}
                    data-testid="red-team-error-reset"
                  >
                    Zurücksetzen
                  </button>
                </div>
              </div>
            )}

            {/* Ergebnis (AC7) */}
            {runState === 'done' && (
              <div style={styles.resultBox} role="status" data-testid="red-team-result">
                <h3 style={styles.resultHeading}>Red-Team-Lauf abgeschlossen (Trockenlauf)</h3>
                {result?.result && (
                  <p style={styles.resultText}>
                    {typeof result.result === 'string'
                      ? result.result
                      : JSON.stringify(result.result)}
                  </p>
                )}
                <p style={styles.resultMeta}>
                  Protokoll: <code style={styles.code}>docs/red-team-audit.md</code>
                </p>
                {result?.prHint && (
                  <p style={styles.resultMeta}>
                    Board-Items/Protokoll zur Freigabe:{' '}
                    <a
                      href={result.prHint}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.prLink}
                      data-testid="red-team-pr-link"
                    >
                      PR öffnen
                    </a>
                  </p>
                )}
                <p style={styles.resultBoundary}>
                  Sicherheits-Grenze: kein Live-Angriff / keine Cloudflare-Umkonfiguration in dieser
                  Iteration — die Funde landen als PR zur menschlichen Freigabe.
                </p>
                <button type="button" style={styles.secondaryBtn} onClick={handleReset}>
                  Neuer Lauf
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#d4d4d4',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px 24px',
  },
  inner: {
    width: '100%',
    maxWidth: 860,
  },
  title: {
    margin: '0 0 24px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  homeBtn: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    marginBottom: 24,
  },
  intro: {
    margin: '0 0 16px',
    fontSize: 14,
    lineHeight: 1.6,
    color: '#d4d4d4',
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 13,
    background: '#111',
    padding: '1px 6px',
    borderRadius: 4,
    border: '1px solid #2a2a2a',
    color: '#e5e7eb',
  },
  safetyBox: {
    padding: '12px 16px',
    background: '#2a1f00',
    border: '1px solid #b45309',
    borderRadius: 6,
    color: '#fcd34d',
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 24,
  },
  loading: {
    color: '#9ca3af',
    fontSize: 14,
  },
  error: {
    color: '#f87171',
    fontSize: 14,
    padding: '8px 12px',
    background: '#3b0f0f',
    borderRadius: 4,
    margin: '8px 0',
  },
  emptyBox: {
    padding: '16px 20px',
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 8,
    color: '#9ca3af',
    fontSize: 14,
    lineHeight: 1.6,
  },
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: {
    margin: '0 0 16px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  fieldLabel: {
    display: 'block',
    fontSize: 13,
    color: '#9ca3af',
    fontWeight: 600,
    margin: '12px 0 6px',
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    background: '#0d1117',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    minHeight: 44,
    boxSizing: 'border-box',
  },
  targetMeta: {
    margin: '8px 0 0',
    fontSize: 12,
  },
  metaMono: {
    fontFamily: 'monospace',
    color: '#e5e7eb',
  },
  metaDim: {
    fontFamily: 'monospace',
    color: '#9ca3af',
  },
  confirmRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    margin: '20px 0',
    padding: '12px 14px',
    background: '#2a1f00',
    border: '1px solid #b45309',
    borderRadius: 6,
    cursor: 'pointer',
  },
  checkbox: {
    marginTop: 3,
    width: 18,
    height: 18,
    flexShrink: 0,
    cursor: 'pointer',
  },
  confirmText: {
    fontSize: 13,
    lineHeight: 1.6,
    color: '#fcd34d',
  },
  startBtn: {
    padding: '12px 22px',
    background: '#991b1b',
    color: '#fecaca',
    border: '1px solid #b91c1c',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    minHeight: 44,
  },
  startBtnDisabled: {
    padding: '12px 22px',
    background: '#1e293b',
    color: '#475569',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 700,
    cursor: 'not-allowed',
    minHeight: 44,
  },
  secondaryBtn: {
    marginTop: 10,
    padding: '8px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
  },
  runningBox: {
    marginTop: 16,
    padding: '10px 14px',
    background: '#0d1117',
    border: '1px solid #334155',
    borderRadius: 6,
    color: '#93c5fd',
    fontSize: 14,
  },
  degradedBox: {
    marginTop: 16,
    padding: '12px 16px',
    background: '#2a1f00',
    border: '1px solid #b45309',
    borderRadius: 6,
    color: '#fbbf24',
    fontSize: 14,
    lineHeight: 1.6,
  },
  errorBox: {
    marginTop: 16,
    padding: '12px 16px',
    background: '#3b0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: 14,
    lineHeight: 1.6,
  },
  resultBox: {
    marginTop: 16,
    padding: '16px 20px',
    background: '#0d1117',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    fontSize: 14,
  },
  resultHeading: {
    margin: '0 0 10px',
    fontSize: 16,
    fontWeight: 700,
    color: '#6ee7b7',
  },
  resultText: {
    margin: '0 0 10px',
    color: '#d4d4d4',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
  },
  resultMeta: {
    margin: '6px 0',
    fontSize: 13,
    color: '#9ca3af',
  },
  prLink: {
    color: '#60a5fa',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },
  resultBoundary: {
    margin: '12px 0 10px',
    fontSize: 12,
    color: '#fbbf24',
    lineHeight: 1.6,
  },
};
