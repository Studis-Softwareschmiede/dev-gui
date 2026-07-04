/**
 * WorkspacePathSection.jsx — Sektion „Workspace-Pfad" (workspace-path-config, WS-AC1/AC3;
 * workspace-health-hinweis AC3). Zeigt den wirksamen Workspace-Root inkl. Quelle und erlaubt
 * setzen/ändern (PUT) und zurücksetzen (DELETE) auf den Env-Default.
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. `wsPathStyles` wird auch von
 * ObsidianVaultPathSection.jsx importiert (geteiltes Muster, einzige Quelle).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { putWorkspacePath, deleteWorkspacePath } from './settingsApi.js';

/**
 * Sektion „Workspace-Pfad" — zeigt den wirksamen Workspace-Root inkl. Quelle und erlaubt
 * setzen/ändern (PUT) und zurücksetzen (DELETE) auf den Env-Default.
 * Platziert in der GitHub-Sektion der Einstellungen, unter den GitHub-App-Credentials.
 *
 * WS-AC1: Anzeige wirksamer Pfad + Quelle; Setzen/Ändern/Zurücksetzen.
 * WS-AC3 (UI): 4xx/422 → feldzugeordnete Fehlermeldung; alter Wert bleibt sichtbar.
 * AC3 (workspace-health-hinweis): Health-Status-Block; grün bei ok, hervorgehoben bei warn/error.
 * A11y: label/htmlFor, aria-describedby, role=status/alert, aria-busy, Fokusführung.
 *
 * @param {{
 *   effectivePath: string|null,
 *   source: "configured"|"env-default",
 *   mountRoot: string,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 *   health?: { overall: string, checks: Array, counts: { repos: number, boardProjects: number } }|null,
 * }} props
 */
export function WorkspacePathSection({ effectivePath, source, mountRoot, onReload, fetchFn, health }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const inputRef = useRef(null);
  const successRef = useRef(null);
  const ERROR_ID = 'workspace-path-error';
  const SUCCESS_ID = 'workspace-path-success';

  // Fokus auf Input wenn Bearbeiten-Modus öffnet
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  // Fokus auf Erfolgsmeldung sobald sie gerendert wird (nach State-Update + Re-render)
  const [pendingFocusSuccess, setPendingFocusSuccess] = useState(false);
  useEffect(() => {
    if (pendingFocusSuccess && successRef.current) {
      successRef.current.focus();
      setPendingFocusSuccess(false);
    }
  });

  const handleSave = useCallback(async () => {
    setError(null);
    setSuccessMsg(null);

    const trimmed = inputVal.trim();
    if (!trimmed) {
      setError('Workspace-Pfad darf nicht leer sein.');
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      await putWorkspacePath(trimmed, fetchFn);
      setInputVal('');
      setEditing(false);
      await onReload();
      setSuccessMsg('Workspace-Pfad gespeichert.');
      setPendingFocusSuccess(true);
    } catch (err) {
      setError(err.message);
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [inputVal, onReload, fetchFn]);

  const handleReset = useCallback(async () => {
    setError(null);
    setSuccessMsg(null);
    setResetting(true);
    try {
      await deleteWorkspacePath(fetchFn);
      await onReload();
      setSuccessMsg('Workspace-Pfad auf Env-Default zurückgesetzt.');
      setPendingFocusSuccess(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  }, [onReload, fetchFn]);

  const handleCancel = useCallback(() => {
    setInputVal('');
    setError(null);
    setEditing(false);
  }, []);

  const isConfigured = source === 'configured';
  const sourceLabel = isConfigured ? 'konfiguriert' : 'Default aus Env';

  return (
    <div style={wsPathStyles.wrapper}>
      {/* Effektivwert-Anzeige */}
      <div style={wsPathStyles.pathRow}>
        <span style={wsPathStyles.pathLabel}>Aktueller Workspace-Root:</span>
        <code style={wsPathStyles.pathValue}>
          {effectivePath ?? '(nicht gesetzt)'}
        </code>
      </div>
      <div style={wsPathStyles.sourceRow}>
        <span style={wsPathStyles.sourceText}>
          Quelle: <strong>{sourceLabel}</strong>
        </span>
        {mountRoot && (
          <span style={wsPathStyles.mountHint}>
            Mount-Schranke: <code style={wsPathStyles.mountCode}>{mountRoot}</code>
          </span>
        )}
      </div>

      {/* AC3 (workspace-health-hinweis): Health-Status-Block */}
      {health && typeof health.overall === 'string' && health.overall === 'ok' && (
        <div style={healthStyles.ok} role="status" aria-live="polite">
          <span style={healthStyles.okIcon} aria-hidden="true">✓</span>
          {' '}Workspace korrekt konfiguriert — {health.counts.repos} Repo(s), {health.counts.boardProjects} Board-Projekt(e)
        </div>
      )}
      {health && typeof health.overall === 'string' && health.overall !== 'ok' && Array.isArray(health.checks) && (
        <div
          style={health.overall === 'error' ? healthStyles.error : healthStyles.warn}
          role={health.overall === 'error' ? 'alert' : 'status'}
          aria-live={health.overall === 'error' ? 'assertive' : 'polite'}
        >
          <p style={healthStyles.alertTitle}>
            {health.overall === 'error' ? 'Workspace-Fehlkonfiguration erkannt' : 'Workspace-Hinweis'}
          </p>
          <ul style={healthStyles.checkList} aria-label="Health-Checks">
            {health.checks.filter((c) => c.status !== 'ok').map((c) => (
              <li key={c.key} style={healthStyles.checkItem}>
                <span style={c.status === 'error' ? healthStyles.checkIconError : healthStyles.checkIconWarn} aria-hidden="true">
                  {c.status === 'error' ? '✗' : '⚠'}
                </span>
                {' '}<strong>{c.key}:</strong> {c.message}
                {c.fix && (
                  <span style={healthStyles.fixHint}>
                    {' → '}{c.fix}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Erfolgs-Feedback */}
      {successMsg && (
        <p
          id={SUCCESS_ID}
          ref={successRef}
          style={wsPathStyles.success}
          role="status"
          tabIndex={-1}
        >
          {successMsg}
        </p>
      )}

      {/* Fehler-Feedback (feldzugeordnet) */}
      {error && (
        <p
          id={ERROR_ID}
          style={wsPathStyles.error}
          role="alert"
        >
          {error}
        </p>
      )}

      {editing ? (
        <div style={wsPathStyles.editArea}>
          <label htmlFor="workspace-path-input" style={wsPathStyles.fieldLabel}>
            Neuer Workspace-Pfad
          </label>
          <input
            id="workspace-path-input"
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder={mountRoot ? `z.B. ${mountRoot}/projekt` : '/workspace/projekt'}
            style={{ ...wsPathStyles.input, color: '#e5e7eb', caretColor: '#e5e7eb' }}
            aria-describedby={error ? ERROR_ID : undefined}
            autoComplete="off"
            disabled={saving}
          />
          <div style={wsPathStyles.actionRow}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={wsPathStyles.btnPrimary}
              aria-busy={saving}
            >
              {saving ? 'Speichern…' : 'Speichern'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              style={wsPathStyles.btnSecondary}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <div style={wsPathStyles.actionRow}>
          <button
            type="button"
            onClick={() => { setError(null); setSuccessMsg(null); setInputVal(''); setEditing(true); }}
            style={wsPathStyles.btnSmall}
            aria-label={isConfigured ? 'Workspace-Pfad ändern' : 'Workspace-Pfad setzen'}
          >
            {isConfigured ? 'Ändern' : 'Setzen'}
          </button>
          {isConfigured && (
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              style={wsPathStyles.btnDanger}
              aria-label="Workspace-Pfad auf Env-Default zurücksetzen"
              aria-busy={resetting}
            >
              {resetting ? 'Zurücksetzen…' : 'Zurücksetzen'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export const wsPathStyles = {
  wrapper: {
    marginTop: 16,
    paddingTop: 16,
    borderTop: '1px solid #2a2a2a',
  },
  pathRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  pathLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
    flexShrink: 0,
  },
  pathValue: {
    fontSize: 13,
    color: '#86efac',    // Kontrast auf #111 ≥ 4.5:1
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
  sourceRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 16,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  sourceText: {
    fontSize: 13,
    color: '#9ca3af',    // Kontrast auf #111 ≥ 4.5:1 (geprüft: ~4.6:1) — NICHT #6b7280
  },
  mountHint: {
    fontSize: 12,
    color: '#9ca3af',
  },
  mountCode: {
    fontSize: 12,
    color: '#9ca3af',
    fontFamily: 'monospace',
  },
  success: {
    margin: '0 0 10px',
    padding: '8px 12px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',
    fontSize: 13,
  },
  error: {
    margin: '0 0 10px',
    padding: '8px 12px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  editArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 8,
  },
  fieldLabel: {
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
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  btnPrimary: {
    padding: '8px 16px',
    background: '#1d4ed8',    // Kontrast #fff/#1d4ed8 ≥ 4.5:1
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    fontWeight: 600,
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
  btnSmall: {
    padding: '6px 14px',
    background: '#1e293b',
    color: '#93c5fd',         // Kontrast auf #111 ≈ 5.8:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnDanger: {
    padding: '8px 16px',
    background: '#7f1d1d',
    color: '#fecaca',         // Kontrast auf #7f1d1d ≥ 4.5:1
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
  },
};
export const healthStyles = {
  ok: {
    marginTop: 10,
    padding: '8px 12px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',   // Grün, Kontrast auf #052e16 ≥ 4.5:1
    fontSize: 13,
    lineHeight: 1.5,
  },
  okIcon: {
    fontWeight: 700,
  },
  warn: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#1c1200',
    border: '1px solid #854d0e',
    borderRadius: 4,
    color: '#fef08a',   // Gelb, Kontrast auf #1c1200 ≥ 4.5:1
    fontSize: 13,
  },
  error: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #991b1b',
    borderRadius: 4,
    color: '#fca5a5',   // Rot, Kontrast auf #2d0f0f ≥ 4.5:1
    fontSize: 13,
  },
  alertTitle: {
    margin: '0 0 8px',
    fontWeight: 700,
    fontSize: 13,
  },
  checkList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  checkItem: {
    fontSize: 13,
    lineHeight: 1.5,
  },
  checkIconError: {
    fontWeight: 700,
    color: '#f87171',
  },
  checkIconWarn: {
    fontWeight: 700,
    color: '#fbbf24',
  },
  fixHint: {
    fontSize: 12,
    color: '#d4d4d4',
    fontStyle: 'italic',
  },
};
