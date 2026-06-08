/**
 * GitHubView.jsx — GitHub-Ansicht mit Repo-Liste und Formular zum Anlegen eines Repositories.
 *
 * github-repo-create:
 *   AC1  — Formular zum Anlegen eines Repos (Name Pflicht, Sichtbarkeit, Beschreibung,
 *           README-Init); bei Erfolg wird die Repo-URL klickbar angezeigt.
 *   AC5  — Fehler-Antworten (403, 409, 422, 500, 502) werden klar dargestellt.
 *   AC6  — Leerer Name → Fehlermeldung, kein Request.
 *
 * github-repos-overview (AC3, AC4, AC5, AC6 — Frontend-Anteil):
 *   AC3  — Rendert Repo-Liste aus GET /api/github/repos: Name, Sichtbarkeit, offene Issues,
 *           letzter CI-Status, klickbarer GitHub-Link (htmlUrl) pro Zeile.
 *   AC4  — Über der Liste Andockpunkt „Neues Repo" (togglet RepoCreateForm);
 *           pro Zeile Andockpunkt „Klonen" (disabled placeholder für #62).
 *   AC5  — Badge „lokal vorhanden" auf Repos, die laut GET /api/workspace/repos bereits
 *           im Workspace liegen; Klonen-Button entfällt/ist deaktiviert für diese Repos.
 *           Workspace-Endpunkt nicht erreichbar → Badge entfällt still, Liste bleibt nutzbar.
 *           Nach erfolgreichem Klonen: workspace/repos wird neu abgerufen → Badge erscheint.
 *   AC6  — Graceful degradation bei Nichterreichbarkeit (Felder „unbekannt",
 *           leere Liste mit Hinweis, kein Crash/Whitescreen).
 *
 * github-repo-clone (AC1, AC4, AC6 — Frontend-Anteil, #62):
 *   AC1  — „Klonen"-Button in RepoRow löst POST /api/github/repos/clone aus;
 *           bei Erfolg (201) wird Status „geklont" inkl. Ziel-Pfad angezeigt.
 *   AC4  — 409 already-present: klar dargestellt + explizite Bestätigungsoption für
 *           force-Re-Clone (kein stilles Überschreiben).
 *   AC6  — Fehlerpfade (403/404/422/500/502/Netzwerk) klar dargestellt ohne Secret;
 *           während Klonens: Button disabled/Loading-State (Mehrfachklick-Schutz).
 *
 * workspace-repos (AC6, AC9 — Frontend-Anteil, #68):
 *   AC9  — Workspace-Übersicht unterhalb der Org-Repo-Liste: pro Klon Name, Branch,
 *           clean/dirty-Status, letzter Commit, credential-freie origin-URL, Aktionen Pull + Löschen.
 *   AC6  — Lösch-Bestätigung via Dialog (nennt Klon-Name); Dialog tastaturbedienbar
 *           (Escape schließt, Fokus in Dialog beim Öffnen, zurück zum Auslöser bei Abbruch).
 *
 * workspace-path-config (AC1 + UI-Anteil AC3):
 *   — WorkspacePathSection lebt seit #92 in SettingsView.jsx (GitHub-Sektion der Einstellungen).
 *
 * State-Design-Entscheidung (#68):
 *   workspaceRepos wird zentral in RepoList gehalten (volle Array-Form statt nur Set<string>).
 *   Das Set<string> für Badge-Vergleiche wird daraus abgeleitet (localRepoNames).
 *   WorkspaceOverview erhält dieselben workspaceRepos + fetchWorkspaceRepos-Callback.
 *   Nach Pull/Löschen im WorkspaceOverview wird fetchWorkspaceRepos() aufgerufen →
 *   Badge in der Org-Liste verschwindet/erscheint automatisch.
 *
 * A11y (NFR):
 *   - Alle Felder mit <label> beschriftet.
 *   - Fehler programmatisch zugeordnet (aria-describedby).
 *   - Erfolgs-URL fokussierbar (tabIndex, Fokusführung nach Submit).
 *   - Touch-Target ≥ 44 px für Buttons.
 *   - Kontrast ≥ 4.5:1 für alle sichtbaren Textelemente (Sekundärfarbe #9ca3af, nie #6b7280).
 *   - Repo-Liste als semantische Tabelle; Links + Aktionen tastaturerreichbar.
 *   - Clone-Status/Fehler mit role=status/alert, programmatische Zuordnung, Fokusführung.
 *   - Badge „lokal vorhanden": Text + aria-label (kein reines Farb-Signal).
 *   - Lösch-Dialog: Fokus-Trap, Escape schließt, Fokus zurück zum Auslöser bei Abbruch.
 *
 * Security (Floor):
 *   - Keine Secrets in Request/Response.
 *   - API-Fehler werden verkürzt angezeigt; kein Stack-Trace-Leak.
 *   - htmlUrl wird nur als href eingesetzt (kein eval / dangerouslySetInnerHTML).
 *
 * @param {{ onNavigate: (view: string) => void, fetchFn?: typeof fetch }} props
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ── CI-Status-Metadaten (analog Dashboard.jsx) ───────────────────────────────

/**
 * CI status metadata: label + icon (a11y) + color (supplemental only).
 * Color is never the sole indicator — label+icon carry the primary meaning.
 */
const CI_META = {
  success:     { label: 'Erfolg',        icon: '✓', color: '#4ade80' },
  failure:     { label: 'Fehlgeschlagen', icon: '✕', color: '#f87171' },
  in_progress: { label: 'Läuft',         icon: '↻', color: '#fbbf24' },
  none:        { label: 'Kein CI',       icon: '—', color: '#9ca3af' },
  unknown:     { label: 'Unbekannt',     icon: '?', color: '#9ca3af' },
};

// ── API-Helfer ────────────────────────────────────────────────────────────────

/**
 * POST /api/github/repos
 * @param {{ name: string, visibility: string, description?: string, autoInit?: boolean }} body
 * @returns {Promise<{ name: string, fullName: string, htmlUrl: string, visibility: string }>}
 * @throws {Error} mit `.status` (HTTP-Statuscode) und `.message`
 */
async function createRepo(body) {
  const res = await fetch('/api/github/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? `Anlegen fehlgeschlagen (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * GET /api/github/repos
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ repos: Array<{ name, fullName, visibility, openIssues, lastCi, htmlUrl }> }>}
 */
async function listRepos(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/github/repos');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * GET /api/workspace/repos
 * Returns the full list of workspace clone objects.
 * Silently returns an empty array on any error (AC5: graceful degradation).
 *
 * Shape per entry: { name, branch, dirty, lastCommit, originUrl }
 * lastCommit may be a string (short info) or an object { hash, subject, date }.
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Array<{ name: string, branch: string, dirty: boolean, lastCommit: *, originUrl: string|null }>>}
 */
async function listWorkspaceRepos(fetchImpl) {
  try {
    const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
    const res = await fn('/api/workspace/repos');
    if (!res.ok) return [];
    const data = await res.json();
    return data?.repos ?? [];
  } catch {
    // Workspace endpoint unreachable → graceful empty list (AC5)
    return [];
  }
}

/**
 * POST /api/workspace/repos/pull
 * @param {{ name: string }} body
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ name: string, status: "pulled", summary?: string }>}
 * @throws {Error} mit `.status` (HTTP-Statuscode) und `.message`
 */
async function pullWorkspaceRepo(body, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/workspace/repos/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? `Pull fehlgeschlagen (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * POST /api/workspace/repos/delete
 * @param {{ name: string }} body
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ name: string, status: "deleted" }>}
 * @throws {Error} mit `.status` (HTTP-Statuscode) und `.message`
 */
async function deleteWorkspaceRepo(body, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/workspace/repos/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? `Löschen fehlgeschlagen (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * POST /api/github/repos/clone
 * @param {{ repo: string, force?: boolean }} body
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ repo: string, status: string, path: string }>}
 * @throws {Error} mit `.status` (HTTP-Statuscode), `.message` und optional `.alreadyPresent` + `.path`
 */
async function cloneRepo(body, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/github/repos/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 409) {
    // AC4: already-present — eigener Fehlertyp damit der Aufrufer force anbieten kann
    const err = new Error(data.error ?? `Zielverzeichnis bereits vorhanden`);
    err.status = 409;
    err.alreadyPresent = true;
    err.path = data.path ?? null;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `Klonen fehlgeschlagen (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── CiBadge ──────────────────────────────────────────────────────────────────

/**
 * Renders a CI status badge: icon + label (+ supplemental color).
 * @param {{ status: string }} props
 */
function CiBadge({ status }) {
  const meta = CI_META[status] ?? CI_META.unknown;
  return (
    <span style={{ ...styles.ciBadge, color: meta.color }} aria-label={`CI-Status: ${meta.label}`}>
      <span aria-hidden="true">{meta.icon}</span>
      {' '}
      {meta.label}
    </span>
  );
}

// ── RepoRow ───────────────────────────────────────────────────────────────────

/**
 * Single repo row inside the repo list table.
 * Wired in #62: "Klonen"-Button löst POST /api/github/repos/clone aus.
 * Clone states: idle → cloning → cloned | alreadyPresent | error
 * alreadyPresent: zeigt explizite force-Bestätigung (AC4).
 *
 * AC5: wenn isLocal=true, zeigt Badge „lokal vorhanden" und blendet den Klonen-Button aus.
 * Nach erfolgreichem Klon ruft onCloneSuccess() den Parent auf, der workspace/repos neu abruft.
 *
 * @param {{
 *   repo: { name, fullName, visibility, openIssues, lastCi, htmlUrl },
 *   fetchFn?: typeof fetch,
 *   isLocal?: boolean,
 *   onCloneSuccess?: () => void,
 * }} props
 */
function RepoRow({ repo, fetchFn, isLocal = false, onCloneSuccess }) {
  const { name, visibility, openIssues, lastCi, htmlUrl } = repo;

  // Clone state machine
  // cloneState: 'idle' | 'cloning' | 'cloned' | 'alreadyPresent' | 'error'
  const [cloneState, setCloneState]   = useState('idle');
  const [clonePath, setClonePath]     = useState(null);   // path on success / alreadyPresent
  const [cloneError, setCloneError]   = useState(null);   // error message string

  // Ref to the status/alert region for focus management (lessons: activeElement assertion)
  const statusRef = useRef(null);

  // Focus the status region after clone completes or errors (A11y Fokusführung)
  useEffect(() => {
    if ((cloneState === 'cloned' || cloneState === 'error' || cloneState === 'alreadyPresent') && statusRef.current) {
      statusRef.current.focus();
    }
  }, [cloneState]);

  // Guard: only render <a href> for http(s) URLs (security/R02)
  const safeUrl = /^https?:\/\//i.test(htmlUrl ?? '') ? htmlUrl : null;

  const openIssuesDisplay =
    openIssues === 'unknown' || openIssues == null ? 'unbekannt' : String(openIssues);

  const visibilityLabel = visibility === 'public' ? 'Öffentlich' : 'Privat';

  /**
   * Triggers a clone (or force re-clone).
   * @param {boolean} force - true = force-Re-Clone (AC4)
   */
  const handleClone = useCallback(async (force = false) => {
    setCloneState('cloning');
    setCloneError(null);
    setClonePath(null);

    try {
      const data = await cloneRepo({ repo: name, ...(force ? { force: true } : {}) }, fetchFn);
      setClonePath(data.path ?? null);
      setCloneState('cloned');
      // AC5: nach Klon-Erfolg workspace/repos neu abrufen → Badge erscheint
      onCloneSuccess?.();
    } catch (err) {
      if (err.alreadyPresent) {
        // AC4: 409 — zeige explizite force-Bestätigung, kein stilles Überschreiben
        setClonePath(err.path ?? null);
        setCloneState('alreadyPresent');
      } else {
        // AC6: alle anderen Fehler klar darstellen (error-Text vom Backend, kein Secret)
        setCloneError(err.message ?? 'Klonen fehlgeschlagen');
        setCloneState('error');
      }
    }
  }, [name, fetchFn]);

  const handleForceConfirm = useCallback(() => {
    handleClone(true);
  }, [handleClone]);

  const handleReset = useCallback(() => {
    setCloneState('idle');
    setCloneError(null);
    setClonePath(null);
  }, []);

  const isCloning = cloneState === 'cloning';

  // Unique IDs for aria-describedby (per-row, use repo name slug)
  const safeId = name ? name.replace(/[^a-z0-9]/gi, '-') : 'repo';
  const cloneStatusId = `clone-status-${safeId}`;
  const cloneErrorId  = `clone-error-${safeId}`;

  return (
    <tr style={styles.tableRow}>
      <td style={styles.td}>
        <span style={styles.repoName}>{name ?? 'unbekannt'}</span>
        {/* AC5: Badge „lokal vorhanden" — Text + aria-label (kein reines Farb-Signal) */}
        {isLocal && (
          <span
            style={styles.localBadge}
            aria-label="lokal vorhanden"
            title="Dieses Repo ist bereits lokal im Workspace geklont"
          >
            lokal vorhanden
          </span>
        )}
      </td>
      <td style={styles.td}>
        <span
          style={{
            ...styles.visibilityPill,
            background: visibility === 'public' ? '#052e16' : '#0f172a',
            color: visibility === 'public' ? '#86efac' : '#94a3b8',
            border: visibility === 'public' ? '1px solid #166534' : '1px solid #334155',
          }}
        >
          {visibilityLabel}
        </span>
      </td>
      <td style={styles.td}>{openIssuesDisplay}</td>
      <td style={styles.td}>
        <CiBadge status={lastCi ?? 'unknown'} />
      </td>
      <td style={styles.td}>
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.ghLink}
            aria-label={`${name} auf GitHub öffnen`}
          >
            GitHub ↗
          </a>
        ) : (
          <span style={styles.unknownText}>—</span>
        )}
      </td>
      <td style={styles.td}>
        {/* AC1/#62: Clone-Button + Statusanzeige */}
        <div style={styles.cloneCell}>
          {/* Primärer Klon-Button — nur im idle/error-Zustand aktiv; AC5: entfällt wenn lokal vorhanden */}
          {(cloneState === 'idle' || cloneState === 'error') && !isLocal && (
            <button
              type="button"
              disabled={isCloning}
              style={styles.btnClone}
              onClick={() => handleClone(false)}
              aria-label={`${name} klonen`}
              aria-describedby={cloneState === 'error' ? cloneErrorId : undefined}
            >
              Klonen
            </button>
          )}

          {/* Lade-Zustand (Mehrfachklick-Schutz, AC6) */}
          {cloneState === 'cloning' && (
            <button
              type="button"
              disabled
              style={{ ...styles.btnClone, cursor: 'wait' }}
              aria-label={`${name} wird geklont…`}
              aria-busy="true"
            >
              Klont…
            </button>
          )}

          {/* Erfolg (AC1) — role=status für A11y-Ankündigung */}
          {cloneState === 'cloned' && (
            <div
              ref={statusRef}
              id={cloneStatusId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              tabIndex={-1}
              style={styles.cloneSuccess}
            >
              <span>Geklont</span>
              {clonePath && (
                <span style={styles.clonePath} title={clonePath}>
                  {' '}→ {clonePath}
                </span>
              )}
              <button
                type="button"
                style={styles.btnCloneSmall}
                onClick={handleReset}
                aria-label={`${name} erneut klonen`}
              >
                Erneut klonen
              </button>
            </div>
          )}

          {/* AC4: 409 already-present — explizite Bestätigung vor force-Re-Clone */}
          {cloneState === 'alreadyPresent' && (
            <div
              ref={statusRef}
              id={cloneStatusId}
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              tabIndex={-1}
              style={styles.cloneAlreadyPresent}
            >
              <span>Bereits vorhanden{clonePath ? ` (${clonePath})` : ''}</span>
              <div style={styles.cloneForceRow}>
                <button
                  type="button"
                  style={styles.btnCloneForce}
                  onClick={handleForceConfirm}
                  aria-label={`${name} erneut klonen und vorhandenes Verzeichnis überschreiben`}
                >
                  Überschreiben
                </button>
                <button
                  type="button"
                  style={styles.btnCloneSmall}
                  onClick={handleReset}
                  aria-label={`Klonen von ${name} abbrechen`}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}

          {/* Fehler (AC6) — role=alert für sofortige A11y-Ankündigung */}
          {cloneState === 'error' && (
            <p
              ref={statusRef}
              id={cloneErrorId}
              role="alert"
              tabIndex={-1}
              style={styles.cloneError}
            >
              {cloneError}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── ConfirmDeleteDialog ───────────────────────────────────────────────────────

/**
 * Modal-Dialog zur Bestätigung des Löschens eines Workspace-Klons.
 *
 * AC6 (workspace-repos): Lösch-Bestätigung; Dialog nennt den Klon-Namen.
 * A11y: Fokus beim Öffnen auf den Dialog, Escape schließt, Fokus zurück zum Auslöser.
 * Tastaturbedienbar: Tab bleibt im Dialog (Fokus-Trap zwischen den zwei Buttons).
 *
 * @param {{
 *   cloneName: string,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 * }} props
 */
function ConfirmDeleteDialog({ cloneName, onConfirm, onCancel }) {
  const dialogRef    = useRef(null);
  const cancelBtnRef = useRef(null);

  // Fokus beim Öffnen auf Abbrechen-Button (sicherer Default: kein versehentliches Löschen)
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);

  // Escape schließt den Dialog
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      // Fokus-Trap: Tab-Zyklus zwischen Abbrechen und Löschen-Buttons
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll('button:not([disabled])'),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    /* Overlay */
    <div style={styles.dialogOverlay} aria-modal="true" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-heading"
        aria-describedby="confirm-delete-desc"
        style={styles.dialogBox}
      >
        <h2 id="confirm-delete-heading" style={styles.dialogHeading}>
          Klon löschen?
        </h2>
        <p id="confirm-delete-desc" style={styles.dialogDesc}>
          Der lokale Klon{' '}
          <strong style={styles.dialogCloneName}>{cloneName}</strong>{' '}
          wird unwiderruflich aus dem Workspace gelöscht.
          Diese Aktion kann nicht rückgängig gemacht werden.
        </p>
        <div style={styles.dialogActions}>
          <button
            ref={cancelBtnRef}
            type="button"
            style={styles.btnDialogCancel}
            onClick={onCancel}
            aria-label={`Löschen von ${cloneName} abbrechen`}
          >
            Abbrechen
          </button>
          <button
            type="button"
            style={styles.btnDialogConfirm}
            onClick={onConfirm}
            aria-label={`${cloneName} endgültig löschen`}
          >
            Endgültig löschen
          </button>
        </div>
      </div>
    </div>
  );
}

// ── WorkspaceCloneRow ─────────────────────────────────────────────────────────

/**
 * Eine Zeile in der Workspace-Übersichts-Tabelle.
 * Zeigt: Name, Branch, dirty-Status, letzten Commit, credential-freie origin-URL.
 * Aktionen: Pull + Löschen (AC9). Löschen nur nach Bestätigungs-Dialog (AC6).
 *
 * @param {{
 *   clone: { name: string, branch: string, dirty: boolean, lastCommit: *, originUrl: string|null },
 *   fetchFn?: typeof fetch,
 *   onDeleted: (name: string) => void,
 *   onPulled: () => void,
 * }} props
 */
function WorkspaceCloneRow({ clone, fetchFn, onDeleted, onPulled }) {
  const { name, branch, dirty, lastCommit, originUrl } = clone;

  // Pull state: 'idle' | 'pulling' | 'pulled' | 'error'
  const [pullState, setPullState]   = useState('idle');
  const [pullError, setPullError]   = useState(null);
  const [pullSummary, setPullSummary] = useState(null);

  // Delete state: 'idle' | 'confirming' | 'deleting' | 'error'
  const [deleteState, setDeleteState] = useState('idle');
  const [deleteError, setDeleteError] = useState(null);

  // Ref to the Delete-trigger button (for focus-return on dialog cancel)
  const deleteBtnRef = useRef(null);
  // Track previous deleteState to detect confirming→idle transition
  const prevDeleteStateRef = useRef('idle');

  // Refs for status/alert regions (focus management, lessons: activeElement assertion)
  const pullStatusRef = useRef(null);
  const deleteErrorRef = useRef(null);

  // Focus pull status after completion
  useEffect(() => {
    if ((pullState === 'pulled' || pullState === 'error') && pullStatusRef.current) {
      pullStatusRef.current.focus();
    }
  }, [pullState]);

  // Focus management for deleteState transitions
  useEffect(() => {
    const prev = prevDeleteStateRef.current;
    prevDeleteStateRef.current = deleteState;

    if (deleteState === 'error' && deleteErrorRef.current) {
      deleteErrorRef.current.focus();
    }
    // After dialog cancel (confirming → idle): focus the delete-trigger button
    // The button is now back in the DOM so the ref should be valid
    if (prev === 'confirming' && deleteState === 'idle' && deleteBtnRef.current) {
      deleteBtnRef.current.focus();
    }
  }, [deleteState]);

  // Safe ID for aria-describedby
  const safeId = name ? name.replace(/[^a-z0-9]/gi, '-') : 'clone';
  const pullStatusId  = `ws-pull-status-${safeId}`;
  const pullErrorId   = `ws-pull-error-${safeId}`;
  const deleteErrorId = `ws-delete-error-${safeId}`;

  /** Format lastCommit for display (may be string or object { hash, subject, date }). */
  function formatLastCommit(lc) {
    if (!lc) return '—';
    if (typeof lc === 'string') return lc;
    if (typeof lc === 'object') {
      const parts = [lc.hash, lc.subject, lc.date].filter(Boolean);
      return parts.length > 0 ? parts.join(' · ') : '—';
    }
    return '—';
  }

  const handlePull = useCallback(async () => {
    setPullState('pulling');
    setPullError(null);
    setPullSummary(null);
    try {
      const result = await pullWorkspaceRepo({ name }, fetchFn);
      setPullSummary(result.summary ?? null);
      setPullState('pulled');
      onPulled();
    } catch (err) {
      setPullError(err.message ?? 'Pull fehlgeschlagen');
      setPullState('error');
    }
  }, [name, fetchFn, onPulled]);

  const handleDeleteRequest = useCallback(() => {
    setDeleteState('confirming');
    setDeleteError(null);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    setDeleteState('idle');
    setDeleteError(null);
    // Focus return to delete-trigger button is handled by useEffect (confirming → idle transition)
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    setDeleteState('deleting');
    try {
      await deleteWorkspaceRepo({ name }, fetchFn);
      // Notify parent to refresh the workspace list (remove this entry)
      onDeleted(name);
    } catch (err) {
      setDeleteError(err.message ?? 'Löschen fehlgeschlagen');
      setDeleteState('error');
      // Focus delete error region
      setTimeout(() => deleteErrorRef.current?.focus(), 0);
    }
  }, [name, fetchFn, onDeleted]);

  const isPulling  = pullState === 'pulling';
  const isDeleting = deleteState === 'deleting';

  return (
    <tr style={styles.tableRow}>
      {/* Name */}
      <td style={styles.td}>
        <span style={styles.repoName}>{name}</span>
      </td>
      {/* Branch */}
      <td style={styles.td}>
        <span style={styles.wsMonoText}>{branch ?? '—'}</span>
      </td>
      {/* Clean / Dirty */}
      <td style={styles.td}>
        {dirty ? (
          <span style={styles.wsDirtyBadge} aria-label="Uncommitted changes vorhanden">
            dirty
          </span>
        ) : (
          <span style={styles.wsCleanBadge} aria-label="Kein uncommitted changes">
            clean
          </span>
        )}
      </td>
      {/* Last Commit */}
      <td style={styles.td}>
        <span style={{ ...styles.wsMonoText, ...styles.wsSmallText }}
          title={typeof lastCommit === 'object' && lastCommit ? JSON.stringify(lastCommit) : undefined}
        >
          {formatLastCommit(lastCommit)}
        </span>
      </td>
      {/* Origin URL (credential-free, AC9/AC2) */}
      <td style={styles.td}>
        {originUrl ? (
          <span style={{ ...styles.wsMonoText, ...styles.wsSmallText, wordBreak: 'break-all' }}>
            {originUrl}
          </span>
        ) : (
          <span style={styles.unknownText}>—</span>
        )}
      </td>
      {/* Aktionen */}
      <td style={styles.td}>
        <div style={styles.wsActionsCell}>
          {/* Pull-Aktion */}
          <div style={styles.wsActionGroup}>
            {pullState !== 'pulling' ? (
              <button
                type="button"
                style={styles.btnWsPull}
                onClick={handlePull}
                disabled={isPulling || isDeleting || deleteState === 'confirming'}
                aria-label={`${name} pullen`}
                aria-describedby={pullState === 'error' ? pullErrorId : undefined}
              >
                Pull
              </button>
            ) : (
              <button
                type="button"
                disabled
                style={{ ...styles.btnWsPull, cursor: 'wait' }}
                aria-label={`${name} wird gepullt…`}
                aria-busy="true"
              >
                Pullt…
              </button>
            )}

            {/* Pull-Erfolg */}
            {pullState === 'pulled' && (
              <div
                ref={pullStatusRef}
                id={pullStatusId}
                role="status"
                aria-live="polite"
                aria-atomic="true"
                tabIndex={-1}
                style={styles.wsPullSuccess}
              >
                {pullSummary ? `Gepullt: ${pullSummary}` : 'Gepullt'}
              </div>
            )}

            {/* Pull-Fehler */}
            {pullState === 'error' && (
              <p
                ref={pullStatusRef}
                id={pullErrorId}
                role="alert"
                tabIndex={-1}
                style={styles.wsActionError}
              >
                {pullError}
              </p>
            )}
          </div>

          {/* Delete-Aktion */}
          <div style={styles.wsActionGroup}>
            {deleteState !== 'confirming' && deleteState !== 'deleting' && (
              <button
                ref={deleteBtnRef}
                type="button"
                style={styles.btnWsDelete}
                onClick={handleDeleteRequest}
                disabled={isPulling || isDeleting}
                aria-label={`${name} löschen`}
                aria-describedby={deleteState === 'error' ? deleteErrorId : undefined}
              >
                Löschen
              </button>
            )}

            {deleteState === 'deleting' && (
              <button
                type="button"
                disabled
                style={{ ...styles.btnWsDelete, cursor: 'wait' }}
                aria-label={`${name} wird gelöscht…`}
                aria-busy="true"
              >
                Löscht…
              </button>
            )}

            {/* Delete-Fehler */}
            {deleteState === 'error' && (
              <p
                ref={deleteErrorRef}
                id={deleteErrorId}
                role="alert"
                tabIndex={-1}
                style={styles.wsActionError}
              >
                {deleteError}
              </p>
            )}
          </div>
        </div>

        {/* AC6: Bestätigungs-Dialog (modal, Fokus-Trap, Escape) */}
        {deleteState === 'confirming' && (
          <ConfirmDeleteDialog
            cloneName={name}
            onConfirm={handleDeleteConfirm}
            onCancel={handleDeleteCancel}
          />
        )}
      </td>
    </tr>
  );
}

// ── WorkspaceOverview ─────────────────────────────────────────────────────────

/**
 * Workspace-Übersicht: listet alle lokalen Klone aus GET /api/workspace/repos.
 * Pro Klon: Name, Branch, clean/dirty, letzter Commit, credential-freie origin-URL,
 * Aktionen Pull + Löschen (AC9).
 *
 * State-Design (#68): workspaceRepos und onRefresh kommen von RepoList (zentraler State).
 * Nach Pull/Löschen: onRefresh() wird aufgerufen → Badge in der Org-Liste bleibt synchron.
 *
 * Die Workspace-Pfad-Konfiguration (WS-AC1/WS-AC3) lebt seit #92 in SettingsView.jsx.
 *
 * @param {{
 *   workspaceRepos: Array<{ name, branch, dirty, lastCommit, originUrl }>,
 *   onRefresh: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 * }} props
 */
function WorkspaceOverview({ workspaceRepos, onRefresh, fetchFn }) {
  const handleDeleted = useCallback(async (_name) => {
    await onRefresh();
  }, [onRefresh]);

  const handlePulled = useCallback(async () => {
    await onRefresh();
  }, [onRefresh]);

  return (
    <section style={styles.section} aria-labelledby="workspace-overview-heading">
      <h2 id="workspace-overview-heading" style={styles.sectionHeading}>
        Workspace-Klone
      </h2>
      <p style={styles.sectionDesc}>
        Lokale Klone im Workspace. Pull aktualisiert den Stand vom Remote; Löschen entfernt den Klon dauerhaft.
      </p>

      {workspaceRepos.length === 0 ? (
        <p style={styles.emptyHint}>
          Keine lokalen Klone im Workspace vorhanden.
        </p>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table} aria-label="Workspace-Klone">
            <thead>
              <tr>
                <th scope="col" style={styles.th}>Name</th>
                <th scope="col" style={styles.th}>Branch</th>
                <th scope="col" style={styles.th}>Status</th>
                <th scope="col" style={styles.th}>Letzter Commit</th>
                <th scope="col" style={styles.th}>Origin-URL</th>
                <th scope="col" style={styles.th}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {workspaceRepos.map((clone) => (
                <WorkspaceCloneRow
                  key={clone.name}
                  clone={clone}
                  fetchFn={fetchFn}
                  onDeleted={handleDeleted}
                  onPulled={handlePulled}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── RepoList ─────────────────────────────────────────────────────────────────

/**
 * Fetches and renders the org repo list from GET /api/github/repos.
 * AC4 anchor: "Neues Repo"-Button togglet das RepoCreateForm über der Liste.
 * AC5: fetches GET /api/workspace/repos to determine which repos are locally present;
 *      workspace fetch failures are silent (no error banner; list remains fully usable).
 *      After a successful clone, re-fetches workspace repos to show the badge immediately.
 * AC6: graceful degradation bei Nichterreichbarkeit.
 * AC9 (#68): workspaceRepos (full array) is held here centrally and passed to
 *      WorkspaceOverview — single fetch/refetch, no double fetching; Badge and overview
 *      stay in sync after pull/delete via fetchWorkspaceRepos callback.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */
function RepoList({ fetchFn }) {
  const [repos, setRepos]           = useState(null);     // null = nicht geladen
  const [loadState, setLoadState]   = useState('loading'); // 'loading'|'ok'|'error'
  const [showCreateForm, setShowCreateForm] = useState(false);
  // AC5/AC9: full workspace repos array (authoritative state shared with WorkspaceOverview)
  const [workspaceRepos, setWorkspaceRepos] = useState(/** @type {Array} */ ([]));

  const fetchFnRef = useRef(fetchFn ?? null);
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? null;
  }, [fetchFn]);

  /**
   * Fetches workspace repos and updates state.
   * Serves as single onRefresh callback for WorkspaceOverview.
   * Silent on failure (AC5).
   */
  const fetchWorkspaceRepos = useCallback(async () => {
    const repos = await listWorkspaceRepos(fetchFnRef.current);
    setWorkspaceRepos(repos);
  }, []);

  // Derive localRepoNames Set from workspaceRepos (no extra state needed)
  const localRepoNames = new Set(workspaceRepos.map((r) => r.name));

  useEffect(() => {
    let cancelled = false;
    async function doFetch() {
      try {
        const data = await listRepos(fetchFnRef.current);
        if (!cancelled) {
          setRepos(data.repos ?? []);
          setLoadState('ok');
        }
      } catch {
        if (!cancelled) {
          setRepos([]);
          setLoadState('error');
        }
      }
    }
    doFetch();
    // AC5: fetch workspace repos — failure is silent (graceful degradation)
    fetchWorkspaceRepos();
    return () => { cancelled = true; };
  }, [fetchWorkspaceRepos]);

  return (
    <>
      <section style={styles.section} aria-labelledby="repo-list-heading">
        {/* AC4 anchor: Neues Repo — über der Liste */}
        <div style={styles.listHeader}>
          <h2 id="repo-list-heading" style={styles.sectionHeading}>
            Repositories
          </h2>
          <button
            type="button"
            style={styles.btnNewRepo}
            onClick={() => setShowCreateForm((v) => !v)}
            aria-expanded={showCreateForm}
            aria-controls="repo-create-section"
          >
            {showCreateForm ? 'Formular schließen' : '+ Neues Repo'}
          </button>
        </div>

        {/* AC4 anchor: RepoCreateForm ein-/ausblendbar (immer im DOM; aria-controls braucht existierendes Element) */}
        <div id="repo-create-section" hidden={!showCreateForm}>
          {showCreateForm && <RepoCreateForm fetchFn={fetchFn} />}
        </div>

        {/* AC6: Lade-Indikator */}
        {loadState === 'loading' && (
          <div role="status" aria-live="polite" style={styles.notice}>
            Lade Repositories…
          </div>
        )}

        {/* AC6: Fehler-Hinweis */}
        {loadState === 'error' && (
          <div role="alert" style={styles.errorNotice}>
            Repositories konnten nicht geladen werden — GitHub-Quelle nicht erreichbar.
          </div>
        )}

        {/* AC3: Tabelle */}
        {loadState !== 'loading' && (
          <div style={styles.tableWrapper}>
            {repos && repos.length === 0 ? (
              <p style={styles.emptyHint}>
                {loadState === 'error'
                  ? 'Keine Daten verfügbar.'
                  : 'Keine Repositories in der Org gefunden.'}
              </p>
            ) : repos && repos.length > 0 ? (
              <table style={styles.table} aria-label="Org-Repositories">
                <thead>
                  <tr>
                    <th scope="col" style={styles.th}>Name</th>
                    <th scope="col" style={styles.th}>Sichtbarkeit</th>
                    <th scope="col" style={styles.th}>Offene Issues</th>
                    <th scope="col" style={styles.th}>Letzter CI</th>
                    <th scope="col" style={styles.th}>GitHub</th>
                    <th scope="col" style={styles.th}>Aktionen</th>
                  </tr>
                </thead>
                <tbody>
                  {repos.map((repo) => (
                    <RepoRow
                      key={repo.name}
                      repo={repo}
                      fetchFn={fetchFn}
                      isLocal={localRepoNames.has(repo.name)}
                      onCloneSuccess={fetchWorkspaceRepos}
                    />
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        )}
      </section>

      {/* AC9 (#68): Workspace-Übersicht unterhalb der Org-Repo-Liste */}
      <WorkspaceOverview
        workspaceRepos={workspaceRepos}
        onRefresh={fetchWorkspaceRepos}
        fetchFn={fetchFn}
      />
    </>
  );
}

// ── RepoCreateForm ────────────────────────────────────────────────────────────

/**
 * Formular zum Anlegen eines GitHub-Repositories in der Org.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 *   fetchFn: optional injectable fetch-Funktion (für Tests).
 */
function RepoCreateForm({ fetchFn }) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [description, setDescription] = useState('');
  const [autoInit, setAutoInit] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { name, fullName, htmlUrl, visibility }

  const nameInputRef = useRef(null);
  const successUrlRef = useRef(null);

  // Fehler-IDs für aria-describedby
  const nameErrorId = 'repo-name-error';
  const formErrorId = 'repo-form-error';

  // Fokus auf Erfolgs-URL setzen (A11y: Fokusführung nach Erfolg)
  useEffect(() => {
    if (result && successUrlRef.current) {
      successUrlRef.current.focus();
    }
  }, [result]);

  /** Wählt die passende Fehlermeldung je Statuscode. */
  function formatApiError(err) {
    const status = err.status;
    if (status === 403) {
      return `Keine Berechtigung (403): ${err.message}`;
    }
    if (status === 409) {
      return `Repo-Name bereits vergeben (409): ${err.message}`;
    }
    if (status === 422) {
      return `Ungültige Eingabe (422): ${err.message}`;
    }
    if (status === 500) {
      return `Interner Fehler (500): ${err.message}`;
    }
    if (status === 502) {
      return `GitHub-API-Fehler (502): ${err.message}`;
    }
    return err.message;
  }

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    // AC6: Frontend-Validierung — kein Request bei leerem Name
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Repository-Name ist ein Pflichtfeld.');
      nameInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const apiFn = fetchFn ? _wrapFetch(fetchFn) : createRepo;
      const data = await apiFn({ name: trimmedName, visibility, description: description.trim() || undefined, autoInit });
      setResult(data);
      // Formular-Felder nach Erfolg zurücksetzen (außer Sichtbarkeit — bleibt für weiteres Anlegen)
      setName('');
      setDescription('');
      setAutoInit(false);
    } catch (err) {
      setError(formatApiError(err));
      nameInputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }, [name, visibility, description, autoInit, fetchFn]);

  const handleNewRepo = useCallback(() => {
    setResult(null);
    setError(null);
    // Fokus auf Name-Input für nächste Eingabe
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, []);

  return (
    <section style={styles.section} aria-labelledby="repo-create-heading">
      <h2 id="repo-create-heading" style={styles.sectionHeading}>
        Neues Repository anlegen
      </h2>
      <p style={styles.sectionDesc}>
        Legt ein neues Repository in der Organisations-GitHub-Org an.
      </p>

      {/* Erfolgs-Anzeige */}
      {result && (
        <div style={styles.successBox} role="status" aria-live="polite" aria-atomic="true">
          <p style={styles.successText}>
            Repository <strong>{result.fullName}</strong> wurde erfolgreich angelegt.
          </p>
          <a
            ref={successUrlRef}
            href={result.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={styles.repoLink}
            tabIndex={0}
            aria-label={`Repository ${result.fullName} auf GitHub öffnen`}
          >
            {result.htmlUrl}
          </a>
          <div style={styles.successMeta}>
            <span style={styles.visibilityBadge}>
              {result.visibility === 'public' ? 'Öffentlich' : 'Privat'}
            </span>
          </div>
          <button
            type="button"
            onClick={handleNewRepo}
            style={styles.btnSecondary}
            aria-label="Weiteres Repository anlegen"
          >
            Weiteres Repository anlegen
          </button>
        </div>
      )}

      {/* Formular — nur anzeigen wenn kein Erfolg */}
      {!result && (
        <form onSubmit={handleSubmit} noValidate aria-describedby={error ? formErrorId : undefined}>
          {/* Name */}
          <div style={styles.fieldRow}>
            <label htmlFor="repo-name" style={styles.label}>
              Repository-Name{' '}
              <span aria-hidden="true" style={styles.required}>*</span>
            </label>
            <input
              id="repo-name"
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z.B. mein-projekt"
              style={styles.input}
              aria-required="true"
              aria-describedby={error && !error.includes('Pflichtfeld') ? undefined : (error ? nameErrorId : undefined)}
              autoComplete="off"
              disabled={submitting}
            />
            {/* Name-spezifische Fehlermeldung (Pflichtfeld) */}
            {error && error.includes('Pflichtfeld') && (
              <p id={nameErrorId} style={styles.fieldError} role="alert">
                {error}
              </p>
            )}
          </div>

          {/* Sichtbarkeit */}
          <div style={styles.fieldRow}>
            <label htmlFor="repo-visibility" style={styles.label}>
              Sichtbarkeit
            </label>
            <select
              id="repo-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
              style={styles.select}
              disabled={submitting}
              aria-describedby={error && !error.includes('Pflichtfeld') ? formErrorId : undefined}
            >
              <option value="private">Privat (empfohlen)</option>
              <option value="public">Öffentlich</option>
            </select>
          </div>

          {/* Beschreibung (optional) */}
          <div style={styles.fieldRow}>
            <label htmlFor="repo-description" style={styles.label}>
              Beschreibung{' '}
              <span style={styles.optional}>(optional)</span>
            </label>
            <input
              id="repo-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Kurze Beschreibung des Projekts"
              style={styles.input}
              autoComplete="off"
              disabled={submitting}
              aria-describedby={error && !error.includes('Pflichtfeld') ? formErrorId : undefined}
            />
          </div>

          {/* README-Init (optional) */}
          <div style={styles.checkboxRow}>
            <input
              id="repo-auto-init"
              type="checkbox"
              checked={autoInit}
              onChange={(e) => setAutoInit(e.target.checked)}
              disabled={submitting}
              style={styles.checkbox}
              aria-describedby={error && !error.includes('Pflichtfeld') ? formErrorId : undefined}
            />
            <label htmlFor="repo-auto-init" style={styles.checkboxLabel}>
              Mit README initialisieren
            </label>
          </div>

          {/* API-Fehlermeldung (allgemein) */}
          {error && !error.includes('Pflichtfeld') && (
            <p id={formErrorId} style={styles.formError} role="alert">
              {error}
            </p>
          )}

          <div style={styles.actionRow}>
            <button
              type="submit"
              disabled={submitting}
              style={styles.btnPrimary}
              aria-busy={submitting}
            >
              {submitting ? 'Wird angelegt…' : 'Repository anlegen'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Hilfs-Wrapper: ermöglicht das Injizieren einer Test-fetch-Funktion
 * mit denselben throw-on-error Semantiken wie createRepo().
 * Nur für Tests — in Production wird createRepo() direkt genutzt.
 *
 * Die Indirektion ist bewusst: createRepo() nutzt das globale fetch (Prod),
 * _wrapFetch() nutzt das injizierte fetchFn (Tests). So bleibt createRepo()
 * testunabhängig und der Test kontrolliert die HTTP-Schicht vollständig.
 */
function _wrapFetch(fetchFn) {
  return async (body) => {
    const res = await fetchFn('/api/github/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error ?? `Anlegen fehlgeschlagen (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

// ── GitHubView ────────────────────────────────────────────────────────────────

export function GitHubView({ onNavigate, fetchFn }) {
  return (
    <main style={styles.view} aria-label="GitHub-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>GitHub</h1>

        {/* AC3, AC4, AC6 — Repo-Liste mit Andockpunkten */}
        <RepoList fetchFn={fetchFn} />

        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          ← Zurück zum Panel
        </button>
      </div>
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
    maxWidth: 720,
  },
  title: {
    margin: '0 0 32px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
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
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
  },
  required: {
    color: '#fca5a5',
    marginLeft: 2,
  },
  optional: {
    fontWeight: 400,
    color: '#9ca3af',
    fontSize: 12,
    marginLeft: 4,
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
  checkbox: {
    width: 16,
    height: 16,
    cursor: 'pointer',
    accentColor: '#3b82f6',
  },
  checkboxLabel: {
    fontSize: 13,
    color: '#d4d4d4',
    cursor: 'pointer',
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
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
  fieldError: {
    margin: 0,
    fontSize: 13,
    color: '#fca5a5',           // Kontrast auf #111 ≥ 4.5:1
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
  successBox: {
    padding: '16px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 6,
    marginBottom: 16,
  },
  successText: {
    margin: '0 0 8px',
    fontSize: 14,
    color: '#86efac',           // Kontrast auf #052e16 ≥ 4.5:1
    lineHeight: 1.4,
  },
  repoLink: {
    display: 'block',
    marginBottom: 8,
    fontSize: 14,
    color: '#93c5fd',           // Kontrast auf #052e16 ≥ 4.5:1
    wordBreak: 'break-all',
    textDecoration: 'underline',
  },
  successMeta: {
    marginBottom: 4,
  },
  visibilityBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    background: '#0f172a',
    color: '#94a3b8',           // Kontrast auf #0f172a ≥ 4.5:1
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #334155',
  },
  homeBtn: {
    marginTop: 8,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  // ── RepoList styles ──────────────────────────────────────────────────────
  listHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  btnNewRepo: {
    padding: '8px 16px',
    background: '#1d4ed8',    // Kontrast #fff/#1d4ed8 ≥ 4.5:1
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
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
  tableWrapper: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    padding: '8px 12px',
    textAlign: 'left',
    fontWeight: 600,
    color: '#9ca3af',
    borderBottom: '1px solid #2a2a2a',
    whiteSpace: 'nowrap',
  },
  tableRow: {
    borderBottom: '1px solid #1e1e1e',
  },
  td: {
    padding: '10px 12px',
    verticalAlign: 'middle',
    color: '#d4d4d4',
  },
  repoName: {
    fontWeight: 600,
    color: '#e5e7eb',
  },
  // AC5: Badge „lokal vorhanden"
  // Text-Badge: nicht nur farblich — Kontrast #86efac auf #052e16 ≥ 4.5:1
  localBadge: {
    display: 'inline-block',
    marginLeft: 8,
    padding: '1px 7px',
    background: '#052e16',
    color: '#86efac',          // Kontrast auf #052e16 ≥ 4.5:1
    border: '1px solid #166534',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  visibilityPill: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
  },
  ciBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
  },
  ghLink: {
    color: '#93c5fd',           // Kontrast auf #111 ≥ 4.5:1
    textDecoration: 'underline',
    fontSize: 13,
    whiteSpace: 'nowrap',
  },
  unknownText: {
    color: '#9ca3af',           // Kontrast auf #111 ≥ 4.5:1 (7.44:1)
  },
  btnClone: {
    padding: '5px 12px',
    background: '#1e293b',
    color: '#9ca3af',           // Kontrast auf #1e293b ≥ 4.5:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  cloneCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  cloneSuccess: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '4px 8px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    fontSize: 12,
    color: '#86efac',           // Kontrast auf #052e16 ≥ 4.5:1
  },
  clonePath: {
    fontSize: 11,
    color: '#9ca3af',           // Kontrast auf #052e16 ≥ 4.5:1
    wordBreak: 'break-all',
  },
  cloneAlreadyPresent: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '4px 8px',
    background: '#1c1407',
    border: '1px solid #78350f',
    borderRadius: 4,
    fontSize: 12,
    color: '#fcd34d',           // Kontrast auf #1c1407 ≥ 4.5:1
  },
  cloneForceRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  cloneError: {
    margin: 0,
    padding: '4px 8px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 12,
    color: '#fca5a5',           // Kontrast auf #2d0f0f ≥ 4.5:1
  },
  btnCloneSmall: {
    padding: '4px 10px',
    background: '#1e293b',
    color: '#9ca3af',           // Kontrast auf #1e293b ≥ 4.5:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnCloneForce: {
    padding: '4px 10px',
    background: '#451a03',
    color: '#fcd34d',           // Kontrast auf #451a03 ≥ 4.5:1
    border: '1px solid #78350f',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
  },
  // ── WorkspaceOverview / WorkspaceCloneRow styles ─────────────────────────
  wsMonoText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#d4d4d4',
  },
  wsSmallText: {
    fontSize: 11,
    color: '#9ca3af',           // Kontrast auf #111 ≥ 4.5:1
  },
  wsCleanBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    background: '#052e16',
    color: '#86efac',           // Kontrast auf #052e16 ≥ 4.5:1
    border: '1px solid #166534',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
  },
  wsDirtyBadge: {
    display: 'inline-block',
    padding: '1px 7px',
    background: '#1c1407',
    color: '#fcd34d',           // Kontrast auf #1c1407 ≥ 4.5:1
    border: '1px solid #78350f',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
  },
  wsActionsCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  wsActionGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  btnWsPull: {
    padding: '5px 12px',
    background: '#1e293b',
    color: '#9ca3af',           // Kontrast auf #1e293b ≥ 4.5:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnWsDelete: {
    padding: '5px 12px',
    background: '#450a0a',
    color: '#fca5a5',           // Kontrast auf #450a0a ≥ 4.5:1
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  wsActionError: {
    margin: 0,
    padding: '4px 8px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 11,
    color: '#fca5a5',           // Kontrast auf #2d0f0f ≥ 4.5:1
  },
  wsPullSuccess: {
    padding: '4px 8px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    fontSize: 11,
    color: '#86efac',           // Kontrast auf #052e16 ≥ 4.5:1
  },
  // ── ConfirmDeleteDialog styles ────────────────────────────────────────────
  dialogOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialogBox: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '24px 28px',
    maxWidth: 420,
    width: '90%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
  },
  dialogHeading: {
    margin: '0 0 12px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  dialogDesc: {
    margin: '0 0 20px',
    fontSize: 14,
    color: '#d4d4d4',
    lineHeight: 1.6,
  },
  dialogCloneName: {
    color: '#fca5a5',           // Kontrast auf #1e293b ≥ 4.5:1
    fontFamily: 'monospace',
  },
  dialogActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  btnDialogCancel: {
    padding: '8px 16px',
    background: '#1a1a1a',
    color: '#d4d4d4',           // Kontrast auf #1a1a1a ≥ 4.5:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnDialogConfirm: {
    padding: '8px 16px',
    background: '#7f1d1d',
    color: '#fca5a5',           // Kontrast auf #7f1d1d ≥ 4.5:1
    border: '1px solid #b91c1c',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },
};

