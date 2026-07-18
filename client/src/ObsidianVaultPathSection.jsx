/**
 * ObsidianVaultPathSection.jsx — Sektion „Obsidian-Vault-Pfad" (obsidian-vault-config
 * AC1, UI-Anteil, S-247; obsidian-vault-folder-browser AC6–AC9, S-379).
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. Nutzt `wsPathStyles` aus WorkspacePathSection.jsx
 * (Muster gespiegelt — geteilte Styles, einzige Quelle).
 *
 * S-379 (obsidian-vault-folder-browser): Freitext-Feld bleibt unverändert als Fallback
 * (AC8) — der neue „Durchsuchen"-Button öffnet `ObsidianVaultFolderBrowserOverlay`
 * (server-seitiger, read-only Ordner-Browser, `GET .../obsidian-vault/browse`, S-378)
 * und übernimmt bei „Diesen Ordner verwenden" nur einen KANDIDATEN-Pfad in dasselbe
 * Freitext-Feld — die bestehende PUT-Validierung (AC2/AC3) bleibt unverändert das Gate
 * (kein eigener Validierungs-Pfad im Overlay). Bei `mountStatus` `unusable`/`unconfigured`
 * zeigt die Sektion STATT einer rein technischen Meldung eine Alltagssprache-Anleitung
 * (AC7); der „Durchsuchen"-Button ist in diesem Zustand deaktiviert (kein Browse ohne
 * nutzbare Mount-Schranke).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { wsPathStyles } from './WorkspacePathSection.jsx';
import { putObsidianVaultPath, deleteObsidianVaultPath } from './settingsApi.js';
import { ObsidianVaultFolderBrowserOverlay } from './ObsidianVaultFolderBrowserOverlay.jsx';

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
 * obsidian-vault-folder-browser (S-379):
 * AC6: „Durchsuchen"-Button öffnet `ObsidianVaultFolderBrowserOverlay`; „Diesen Ordner
 *   verwenden" übernimmt den Container-Pfad in `inputVal` (Bearbeiten-Modus wird
 *   geöffnet, falls noch nicht aktiv) — Speichern bleibt ein expliziter Klick des Owners
 *   (kein Auto-Save direkt aus dem Overlay heraus).
 * AC7: Bei `mountStatus` `unusable`/`unconfigured` erscheint eine Alltagssprache-Anleitung
 *   (was los ist + Mac-Schritt `OBSIDIAN_VAULT_HOST_DIR` + Runbook-Verweis); der
 *   „Durchsuchen"-Button ist deaktiviert mit demselben Hinweis (aria-disabled + Text).
 * AC8: Freitext-Feld/Set-/Ändern-/Löschen-Funktion bleibt unverändert (kein Zwang zum Browser).
 * AC9: Tastaturbedienbar, `role=status`/`alert`, `aria-disabled`, Touch-Targets ≥44px.
 *
 * @param {{
 *   vaultPath: string|null,
 *   configured: boolean,
 *   mountStatus?: 'ok'|'unusable'|'unconfigured',
 *   mountRoot?: string,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 * }} props
 */
export function ObsidianVaultPathSection({ vaultPath, configured, mountStatus, mountRoot, onReload, fetchFn }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const inputRef = useRef(null);
  const successRef = useRef(null);
  const browseBtnRef = useRef(null);
  const ERROR_ID = 'obsidian-vault-path-error';
  const SUCCESS_ID = 'obsidian-vault-path-success';
  const mountNoticeNeeded = mountStatus === 'unusable' || mountStatus === 'unconfigured';

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

  // obsidian-vault-folder-browser AC6: öffnet den Ordner-Browser (nur wenn die
  // Mount-Schranke nutzbar ist — Durchsuchen-Button ist sonst deaktiviert, AC7).
  const handleOpenBrowser = useCallback(() => {
    if (mountNoticeNeeded) return;
    setBrowserOpen(true);
  }, [mountNoticeNeeded]);

  // AC6: „Diesen Ordner verwenden" übernimmt den Container-Pfad in `inputVal` und
  // öffnet den Bearbeiten-Modus — Speichern (PUT-Validierung, AC2/AC3) bleibt ein
  // expliziter Owner-Klick, kein Auto-Save aus dem Overlay heraus.
  const handleBrowserSelect = useCallback((path) => {
    setError(null);
    setSuccessMsg(null);
    setInputVal(path);
    setEditing(true);
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

      {/* obsidian-vault-folder-browser AC7: Alltagssprache-Anleitung statt der
          technischen Schranken-Meldung, wenn der Mount nicht nutzbar ist. */}
      {mountNoticeNeeded && (
        <div
          style={localStyles.mountNotice}
          role="status"
          aria-live="polite"
          data-testid="obsidian-mount-notice"
        >
          <p style={localStyles.mountNoticeTitle}>
            {mountStatus === 'unconfigured'
              ? 'Der Obsidian-Ordner ist noch nicht in den Container hineingereicht.'
              : 'Der Obsidian-Ordner ist im Container nicht nutzbar (Mount fehlt oder ist kein Verzeichnis).'}
          </p>
          <p style={localStyles.mountNoticeBody}>
            Setze auf dem Mac in der lokalen <code>.env</code>-Datei neben{' '}
            <code>docker-compose.yml</code> die Zeile{' '}
            <code>OBSIDIAN_VAULT_HOST_DIR=&lt;Pfad-zu-deinem-Obsidian-Vault&gt;</code>{' '}
            und erstelle den Container danach neu. Details:{' '}
            <code>docs/obsidian-vault-mount-runbook.md</code>.
          </p>
          <p style={localStyles.mountNoticeDetail}>
            Technischer Status: <code>mountStatus = {mountStatus}</code>
          </p>
        </div>
      )}

      {/* obsidian-vault-folder-browser AC6/AC7: Durchsuchen-Button — deaktiviert
          mit Hinweis, solange die Mount-Schranke nicht nutzbar ist. */}
      <div style={wsPathStyles.actionRow}>
        <button
          type="button"
          ref={browseBtnRef}
          onClick={handleOpenBrowser}
          disabled={mountNoticeNeeded}
          aria-disabled={mountNoticeNeeded}
          style={mountNoticeNeeded ? localStyles.btnBrowseDisabled : wsPathStyles.btnSmall}
          aria-label={
            mountNoticeNeeded
              ? 'Durchsuchen — nicht verfügbar, solange der Obsidian-Vault-Mount fehlt'
              : 'Obsidian-Vault-Ordner durchsuchen'
          }
        >
          Durchsuchen…
        </button>
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

      {/* obsidian-vault-folder-browser AC6: Ordner-Browser-Overlay */}
      {browserOpen && (
        <ObsidianVaultFolderBrowserOverlay
          onClose={() => setBrowserOpen(false)}
          onSelect={handleBrowserSelect}
          triggerRef={browseBtnRef}
          fetchFn={fetchFn}
        />
      )}
    </div>
  );
}

/** Component-lokale Styles (obsidian-vault-folder-browser AC7/AC9, S-379). */
const localStyles = {
  mountNotice: {
    margin: '0 0 14px',
    padding: '12px 14px',
    background: '#1c1200',
    border: '1px solid #854d0e',
    borderRadius: 6,
    color: '#fef08a',   // Kontrast auf #1c1200 ≥ 4.5:1 (WCAG AA)
    fontSize: 13,
    lineHeight: 1.5,
  },
  mountNoticeTitle: {
    margin: '0 0 8px',
    fontWeight: 700,
  },
  mountNoticeBody: {
    margin: 0,
  },
  mountNoticeDetail: {
    margin: '8px 0 0',
    fontSize: 12,
    color: '#d4d4d4',
    fontStyle: 'italic',
  },
  btnBrowseDisabled: {
    padding: '6px 14px',
    background: '#1e293b',
    color: '#4b5563',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'not-allowed',
    minHeight: 44,
  },
};
