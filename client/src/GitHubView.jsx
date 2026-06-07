/**
 * GitHubView.jsx — GitHub-Ansicht mit Formular zum Anlegen eines Repositories.
 *
 * github-repo-create:
 *   AC1  — Formular zum Anlegen eines Repos (Name Pflicht, Sichtbarkeit, Beschreibung,
 *           README-Init); bei Erfolg wird die Repo-URL klickbar angezeigt.
 *   AC5  — Fehler-Antworten (403, 409, 422, 500, 502) werden klar dargestellt.
 *   AC6  — Leerer Name → Fehlermeldung, kein Request.
 *
 * A11y (NFR):
 *   - Alle Felder mit <label> beschriftet.
 *   - Fehler programmatisch zugeordnet (aria-describedby).
 *   - Erfolgs-URL fokussierbar (tabIndex, Fokusführung nach Submit).
 *   - Touch-Target ≥ 44 px für Buttons.
 *   - Kontrast ≥ 4.5:1 für alle sichtbaren Textelemente.
 *
 * Security (Floor):
 *   - Keine Secrets in Request/Response.
 *   - API-Fehler werden verkürzt angezeigt; kein Stack-Trace-Leak.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useRef, useCallback, useEffect } from 'react';

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

        <RepoCreateForm fetchFn={fetchFn} />

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
};
