/**
 * AdoptSection.jsx — dritte "Neues Projekt"-Option "Adopt" (neues-projekt-auswahl-dialog,
 * S-301, AC4–AC8).
 *
 * Eigenständige, isoliert testbare Komponente (analog `ObsidianImportSection.jsx`).
 * Der Mount-Punkt im 3-Wege-Auswahl-Dialog selbst ist Scope der Folge-Story S-302
 * (Auswahl-Dialog-Shell, AC1/AC2/AC8, `depends: [S-300, S-301]`) — diese Story liefert
 * nur den Adopt-Weg als eigenständige, einbaubare Komponente.
 *
 * Covers (neues-projekt-auswahl-dialog):
 *   AC4 — URL-Eingabefeld mit Validierung: nur gültige GitHub-Repo-URLs
 *         (`https?://[www.]github.com/<owner>/<repo>[.git][/]`) werden akzeptiert;
 *         ungültige/leere Eingabe → textliche Validierungsmeldung, "Weiter/Übernehmen"
 *         bleibt deaktiviert. SSH-Form (`git@github.com:owner/repo.git`) wird NICHT
 *         akzeptiert (Edge-Case). Überzählige Pfadsegmente (`/tree/main`, `/pull/1`, …)
 *         werden konservativ als ungültig behandelt (Offene Annahme A2 der Spec).
 *   AC5 — Vor der Auslösung zeigt eine Bestätigungs-Zusammenfassung die erkannte
 *         Quelle `<owner>/<repo>` + "wird geforkt: ja/nein" (ja ⇔ owner ≠ eigene Org,
 *         case-insensitiver Vergleich). Ausgelöst wird erst nach expliziter
 *         Bestätigung (kein Auto-Start).
 *   AC6 — Bei Bestätigung POSTet der Weg GENAU EINMAL
 *         { command: '/agent-flow:adopt <owner/repo>' } an POST /api/command;
 *         <owner/repo> ist zu einer Zeile ohne Steuerzeichen kollabiert (kein roher
 *         Freitext). Nutzt die bereits gelistete Allowlist / Sanitisierung
 *         ([[flow-trigger]] AC2) unverändert.
 *   AC7 — Busy-Sperre + Kill: GET /api/session state:"busy" ODER 409 → "Auslösen"
 *         disabled (disabled-Attribut + Text-/Lock-Hinweis, nie nur Farbe); Kill-Knopf
 *         aktiv während des Laufs, POSTet /api/command/cancel. 202 → inline
 *         Lauf-Status; 409 → "Ein Job läuft bereits"; 400/500/Netzwerkfehler →
 *         sichtbare Fehlermeldung mit Reset, kein Crash.
 *   AC8 — Reiner Frontend-Change: nutzt ausschließlich die bestehenden Endpunkte
 *         POST /api/command, POST /api/command/cancel, GET /api/session sowie (für
 *         die Eigene-Org-Ableitung, AC5) GET /api/github/repos (nicht-geheime,
 *         bereits vorhandene Quelle). Kein dangerouslySetInnerHTML, keine Secrets.
 *
 * NFR A11y (WCAG 2.1 AA):
 *   - URL-Feld + Buttons beschriftet, Tastatur bedienbar, Touch-Targets ≥ 44 px.
 *   - Disabled-Zustände: disabled-Attribut UND Text-Label (nie nur Farbe).
 *   - Validierungs-/Status-/Fehlermeldungen: role="alert" bzw. role="status", aria-live.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - <owner>/<repo> wird vor dem Senden kollabiert (collapseToLine) — keine
 *     Steuerzeichen/Mehrzeiligkeit im Command-Argument (defense in depth; Server
 *     bleibt autoritativ über Allowlist + Sanitisierung, [[flow-trigger]] AC2).
 *   - Kein neuer Backend-Endpunkt, keine neue Trust-Boundary (AC8, Nicht-Ziele).
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { collapseToLine } from './costMode.js';

// ── Konstanten ────────────────────────────────────────────────────────────────

/** Der Adopt-Trigger-Befehlspräfix (bereits Allowlist-gelistet, [[flow-trigger]] AC2). */
const ADOPT_CMD = '/agent-flow:adopt';

/** Busy-Guard-Poll-Intervall (analog TriggerPanel/ObsidianImportSection, AC7). */
const ADOPT_SESSION_POLL_MS = 3_000;

/**
 * Die eigene Org (Fork-ja/nein-Vergleich, AC5). Konservativer Fallback, falls die
 * Org-Repo-Übersicht (GET /api/github/repos) nicht erreichbar/leer ist — siehe
 * Spec „Verträge / Eigene-Org-Ableitung": Auslösung wird dadurch NICHT blockiert.
 */
const OWN_ORG = 'Studis-Softwareschmiede';

/**
 * GitHub-Repo-URL-Regex (AC4):
 *   https?://[www.]github.com/<owner>/<repo>[.git][/]
 * Akzeptiert genau zwei Pfadsegmente (owner, repo) — überzählige Segmente
 * (/tree/main, /pull/1, Query, Anchor) machen die Eingabe ungültig (Offene
 * Annahme A2: konservativ, um Fehl-Adoptions zu vermeiden). Kein Match für
 * SSH-Form (git@github.com:owner/repo.git) — kein http(s)-Schema.
 */
const GITHUB_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Parst eine GitHub-Repo-URL und liefert `{owner, repo}` oder `null` bei
 * ungültiger Eingabe (AC4).
 *
 * @param {string} rawUrl
 * @returns {{owner: string, repo: string} | null}
 */
export function parseGithubRepoUrl(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) return null;
  const match = GITHUB_URL_RE.exec(trimmed);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}

// ── API-Helfer ────────────────────────────────────────────────────────────────

/**
 * GET /api/github/repos — nicht-geheime Quelle zur Ableitung der eigenen Org
 * (AC5, Verträge „Eigene-Org-Ableitung"). Degradiert defensiv: bei Fehler/leerer
 * Liste wird der konservative Fallback OWN_ORG genutzt (kein Blockieren der
 * Auslösung).
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string>} die aus der Repo-Liste abgeleitete eigene Org
 */
async function fetchOwnOrg(fetchImpl) {
  try {
    const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
    const res = await fn('/api/github/repos');
    if (!res.ok) return OWN_ORG;
    const data = await res.json();
    const repos = Array.isArray(data?.repos) ? data.repos : [];
    const first = repos.find((r) => typeof r?.fullName === 'string' && r.fullName.includes('/'));
    if (!first) return OWN_ORG;
    const org = first.fullName.split('/')[0];
    return org || OWN_ORG;
  } catch {
    return OWN_ORG;
  }
}

/**
 * GET /api/session — Busy-Guard-Poll (AC7, spiegelt TriggerPanel.jsx/ObsidianImportSection.jsx).
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean|null>} true=busy, false=ready, null=unbekannt (Zustand halten)
 */
async function fetchAdoptSessionBusy(fetchImpl) {
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

// ── AdoptSection ──────────────────────────────────────────────────────────────

/**
 * AdoptSection — vierte... genauer: dritte "Neues Projekt"-Option "Adopt":
 * beliebige GitHub-Repo-URL → Validierung → Fork-ja/nein-Bestätigung →
 * /agent-flow:adopt-Auslösung (AC4–AC7).
 *
 * State machine (submitState): 'idle' | 'starting' | 'running' | 'error'.
 * Zusätzlicher State `confirmState`: 'input' (URL-Eingabe) | 'confirm'
 * (Bestätigungs-Zusammenfassung sichtbar) — AC5.
 * Busy-Guard (AC7) wird unabhängig per Poll auf GET /api/session gehalten.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */
export function AdoptSection({ fetchFn }) {
  const [urlInput, setUrlInput] = useState('');
  /** 'input' | 'confirm' — AC5: Bestätigungs-Zusammenfassung erst nach Validierung. */
  const [phase, setPhase] = useState('input');
  /** 'idle' | 'starting' | 'running' | 'error' */
  const [submitState, setSubmitState] = useState('idle');
  const [errorMsg, setErrorMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ownOrg, setOwnOrg] = useState(OWN_ORG);

  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  // AC5: eigene Org einmalig laden (nicht-geheime Quelle GET /api/github/repos).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const org = await fetchOwnOrg(fetchFnRef.current);
      if (!cancelled) setOwnOrg(org);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // AC7: Busy-Guard-Poll (analog TriggerPanel/ObsidianImportSection).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const isBusy = await fetchAdoptSessionBusy(fetchFnRef.current);
      if (!cancelled && isBusy !== null) setBusy(isBusy);
    }
    poll();
    const timer = setInterval(poll, ADOPT_SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // AC4: Validierung der URL-Eingabe.
  const parsed = parseGithubRepoUrl(urlInput);
  const showValidationError = urlInput.trim().length > 0 && !parsed;
  const canProceed = Boolean(parsed) && phase === 'input';

  const handleUrlChange = useCallback((e) => {
    setUrlInput(e.target.value);
  }, []);

  // AC5: "Weiter" → zeigt die Bestätigungs-Zusammenfassung (kein Auto-Start).
  const handleProceed = useCallback(() => {
    if (!parsed) return;
    setPhase('confirm');
  }, [parsed]);

  // AC5: zurück zur Eingabe (z.B. Owner/Repo falsch erkannt).
  const handleBackToInput = useCallback(() => {
    setPhase('input');
  }, []);

  const isStarting = submitState === 'starting';
  const isRunning = submitState === 'running';
  const canConfirm = phase === 'confirm' && Boolean(parsed) && !isStarting && !isRunning && !busy;

  // AC5/AC6: Fork-Einschätzung — ja ⇔ owner ≠ eigene Org (case-insensitiv).
  const willFork = parsed ? parsed.owner.toLowerCase() !== ownOrg.toLowerCase() : false;

  // AC6: Auslösung — POSTet GENAU EINMAL /api/command bei Bestätigung.
  const handleConfirm = useCallback(async () => {
    // Guard: keine gültige Auswahl, bereits starting/running oder busy → no-op
    // (kein zweiter POST — Doppelklick-/Race-Schutz, AC7 Edge-Cases).
    if (!parsed || isStarting || isRunning || busy) return;

    // AC6: <owner/repo> zu einer Zeile ohne Steuerzeichen kollabieren (defense
    // in depth — Server bleibt autoritativ via Allowlist + Sanitisierung).
    const ownerRepo = collapseToLine(`${parsed.owner}/${parsed.repo}`);
    if (!ownerRepo) return;

    setSubmitState('starting');
    setErrorMsg(null);

    const command = `${ADOPT_CMD} ${ownerRepo}`;
    const body = { command };

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
      // AC7 (Rückmeldung, Verhalten Punkt 9): inline Lauf-Status statt Navigate
      // (kein eingebettetes Terminal an dieser Stelle — Offene Annahme A3 der Spec).
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
  }, [parsed, isStarting, isRunning, busy]);

  // AC7: Kill — POSTet /api/command/cancel, aktiv während des Laufs.
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
      setPhase('input');
      setUrlInput('');
    } else {
      setSubmitState('error');
      setErrorMsg('Abbrechen fehlgeschlagen — bitte erneut versuchen.');
    }
  }, []);

  // AC7: Reset nach Fehler (kein Crash, neue Eingabe möglich).
  const handleReset = useCallback(() => {
    setSubmitState('idle');
    setErrorMsg(null);
  }, []);

  return (
    <section style={styles.section} aria-labelledby="adopt-heading">
      <h2 id="adopt-heading" style={styles.sectionHeading}>
        Adopt
      </h2>
      <p style={styles.sectionDesc}>
        Übernimmt ein beliebiges GitHub-Repo. Fremde Repos werden automatisch in
        die eigene Org geforkt und übernommen.
      </p>

      {/* AC4: URL-Eingabefeld */}
      <div style={styles.fieldRow}>
        <label htmlFor="adopt-url-input" style={styles.label}>
          GitHub-Repo-URL
        </label>
        <input
          id="adopt-url-input"
          type="text"
          style={styles.input}
          placeholder="https://github.com/owner/repo"
          value={urlInput}
          disabled={phase === 'confirm' || isStarting || isRunning}
          aria-disabled={phase === 'confirm' || isStarting || isRunning}
          aria-invalid={showValidationError}
          onChange={handleUrlChange}
        />
      </div>

      {/* AC4: Validierungsmeldung */}
      {showValidationError && (
        <div role="alert" style={styles.errorNotice}>
          Ungültige GitHub-Repo-URL. Erwartet: https://github.com/&lt;owner&gt;/&lt;repo&gt;
        </div>
      )}

      {/* AC5: "Weiter" — nur sichtbar in der Eingabe-Phase */}
      {phase === 'input' && (
        <div style={styles.actionRow}>
          <button
            type="button"
            style={canProceed ? styles.btnPrimary : styles.btnPrimaryDisabled}
            disabled={!canProceed}
            aria-disabled={!canProceed}
            aria-label={canProceed ? 'Weiter — Zusammenfassung anzeigen' : 'Weiter — gültige URL erforderlich'}
            onClick={handleProceed}
            data-testid="adopt-proceed-btn"
          >
            Weiter
          </button>
        </div>
      )}

      {/* AC5: Bestätigungs-Zusammenfassung */}
      {phase === 'confirm' && parsed && (
        <div style={styles.confirmBox} role="status" data-testid="adopt-confirm-summary">
          <p style={styles.confirmLine}>
            Quelle: <strong>{parsed.owner}/{parsed.repo}</strong>
          </p>
          <p style={styles.confirmLine}>
            Wird geforkt: <strong>{willFork ? 'ja' : 'nein'}</strong>
          </p>

          {/* AC7: Busy-Hinweis — Text-Label, nicht nur Farbe */}
          {busy && (
            <div role="status" aria-live="polite" style={styles.lockNotice}>
              <span aria-hidden="true">⚙</span> Ein Job läuft bereits — Übernehmen gesperrt.
            </div>
          )}

          {/* AC7 (Rückmeldung, Verhalten Punkt 9): inline Lauf-Status nach 202 */}
          {isRunning && (
            <div role="status" aria-live="polite" style={styles.runningNotice}>
              <span aria-hidden="true">⚙</span> Adopt-Lauf läuft…
            </div>
          )}

          <div style={styles.actionRow}>
            <button
              type="button"
              style={styles.btnSecondary}
              onClick={handleBackToInput}
              disabled={isStarting || isRunning}
              aria-disabled={isStarting || isRunning}
              aria-label="Zurück zur URL-Eingabe"
            >
              Zurück
            </button>

            {/* AC5/AC6: "Übernehmen" — Auslösung erst nach Bestätigung */}
            <button
              type="button"
              style={canConfirm ? styles.btnPrimary : styles.btnPrimaryDisabled}
              disabled={!canConfirm}
              aria-disabled={!canConfirm}
              aria-busy={isStarting}
              aria-label={
                busy
                  ? 'Übernehmen — gesperrt (Job läuft bereits)'
                  : isRunning
                  ? 'Übernehmen — Lauf bereits gestartet'
                  : isStarting
                  ? 'Übernehmen — wird gesendet'
                  : `Übernehmen: ${parsed.owner}/${parsed.repo}`
              }
              onClick={handleConfirm}
              data-testid="adopt-confirm-btn"
            >
              {isStarting ? 'Wird ausgelöst…' : 'Übernehmen'}
            </button>

            {/* AC7: Kill — aktiv während des Laufs */}
            <button
              type="button"
              style={isRunning ? styles.btnKill : styles.btnKillDisabled}
              disabled={!isRunning}
              aria-disabled={!isRunning}
              aria-label={isRunning ? 'Laufenden Adopt-Job abbrechen (Kill)' : 'Kill — kein Job läuft'}
              onClick={handleKill}
            >
              Kill
            </button>
          </div>
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
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
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
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  confirmBox: {
    marginTop: 12,
    padding: '14px 16px',
    background: '#0d1520',
    border: '1px solid #334155',
    borderRadius: 6,
  },
  confirmLine: {
    margin: '0 0 6px',
    fontSize: 14,
    color: '#e5e7eb',
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
  lockNotice: {
    padding: '8px 10px',
    background: '#1a1500',
    border: '1px solid #3a2f00',
    borderRadius: 4,
    color: '#fbbf24',           // Kontrast auf #1a1500 ≥ 4.5:1
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
    color: '#fca5a5',           // Kontrast auf #2d0f0f ≥ 4.5:1
  },
};
