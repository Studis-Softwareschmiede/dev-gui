/**
 * ObsidianVaultPathSection.jsx — Sektion „Obsidian-Vault-Pfad" (obsidian-vault-config
 * AC1, UI-Anteil, S-247).
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. Nutzt `wsPathStyles` aus WorkspacePathSection.jsx
 * (Muster gespiegelt — geteilte Styles, einzige Quelle).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { wsPathStyles } from './WorkspacePathSection.jsx';
import { putObsidianVaultPath, deleteObsidianVaultPath } from './settingsApi.js';

/**
 * Sektion „Obsidian-Vault-Pfad" — zeigt den konfigurierten Vault-Pfad inkl. Zustand
 * (konfiguriert / nicht konfiguriert) und erlaubt setzen/ändern (PUT) und
 * löschen/zurücksetzen (DELETE) (obsidian-vault-config AC1 — UI-Anteil, S-247).
 * Platziert in einer eigenen „Obsidian"-Sektion der Einstellungen (Spec-Entscheidung A2 —
 * nicht in der GitHub-Sektion). Muster gespiegelt von `WorkspacePathSection`
 * (workspace-path-config): Anzeige, Set-Feld, Reset, feldzugeordnete Fehleranzeige.
 *
 * AC1: Anzeige konfigurierter Pfad + Zustand (nicht nur Farbe); Setzen/Ändern/Löschen.
 * Fehlerbehandlung: 422-Validierungsfehler des Backends (nicht existent / kein Verzeichnis /
 *   nicht lesbar / „Projekte" fehlt / Traversal) feldzugeordnet angezeigt; bisheriger Wert
 *   bleibt sichtbar (kein onReload bei Fehler). 403 (kein Admin) verständlich angezeigt.
 * A11y: label/htmlFor, aria-describedby, role=status/alert, aria-busy, Fokusführung
 *   bei Erfolg/Fehler.
 *
 * @param {{
 *   vaultPath: string|null,
 *   configured: boolean,
 *   mountRoot?: string,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 * }} props
 */
export function ObsidianVaultPathSection({ vaultPath, configured, mountRoot, onReload, fetchFn }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const inputRef = useRef(null);
  const successRef = useRef(null);
  const ERROR_ID = 'obsidian-vault-path-error';
  const SUCCESS_ID = 'obsidian-vault-path-success';

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
      setError('Obsidian-Vault-Pfad darf nicht leer sein.');
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      await putObsidianVaultPath(trimmed, fetchFn);
      setInputVal('');
      setEditing(false);
      await onReload();
      setSuccessMsg('Obsidian-Vault-Pfad gespeichert.');
      setPendingFocusSuccess(true);
    } catch (err) {
      // 422 (Validierungsfehler: nicht existent / kein Verzeichnis / nicht lesbar /
      // „Projekte" fehlt / Traversal) und 403 (keine Berechtigung) landen beide hier —
      // err.message trägt bereits die Backend-Meldung; bisheriger Wert bleibt sichtbar
      // (kein onReload bei Fehler, State wurde nicht neu geladen).
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
      await deleteObsidianVaultPath(fetchFn);
      await onReload();
      setSuccessMsg('Obsidian-Vault-Pfad zurückgesetzt.');
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

  return (
    <div style={wsPathStyles.wrapper}>
      {/* Effektivwert-Anzeige */}
      <div style={wsPathStyles.pathRow}>
        <span style={wsPathStyles.pathLabel}>Aktueller Obsidian-Vault-Pfad:</span>
        <code style={wsPathStyles.pathValue}>
          {vaultPath ?? '(nicht konfiguriert)'}
        </code>
      </div>
      <div style={wsPathStyles.sourceRow}>
        <span style={wsPathStyles.sourceText}>
          Zustand: <strong>{configured ? 'konfiguriert' : 'nicht konfiguriert'}</strong>
        </span>
        {mountRoot && (
          <span style={wsPathStyles.mountHint}>
            Mount-Schranke: <code style={wsPathStyles.mountCode}>{mountRoot}</code>
          </span>
        )}
      </div>

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

      {/* Fehler-Feedback (feldzugeordnet) — deckt 422-Validierung UND 403 ab */}
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
          <label htmlFor="obsidian-vault-path-input" style={wsPathStyles.fieldLabel}>
            Neuer Obsidian-Vault-Pfad
          </label>
          <input
            id="obsidian-vault-path-input"
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder={mountRoot ? `z.B. ${mountRoot}/vault` : '/vault/obsidian'}
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
            aria-label={configured ? 'Obsidian-Vault-Pfad ändern' : 'Obsidian-Vault-Pfad setzen'}
          >
            {configured ? 'Ändern' : 'Setzen'}
          </button>
          {configured && (
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              style={wsPathStyles.btnDanger}
              aria-label="Obsidian-Vault-Pfad zurücksetzen"
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
