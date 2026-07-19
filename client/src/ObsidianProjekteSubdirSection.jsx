/**
 * ObsidianProjekteSubdirSection.jsx — Sektion „Obsidian-Projekt-Unterordner"
 * (docs/specs/obsidian-vault-config.md v3, AC8/AC13/AC15, S-381).
 *
 * Zeigt den WIRKSAMEN Projekt-Unterordner + dessen Quelle (`persisted`/`env`/`default`,
 * AC8/AC10) und erlaubt, ihn zu setzen/ändern (PUT) und zu löschen/zurückzusetzen
 * (DELETE, AC8). Muster 1:1 gespiegelt von `ObsidianVaultPathSection.jsx` (gleiche
 * `wsPathStyles`, gleicher Set-/Ändern-/Löschen-Interaktionspfad, gleiche PUT-Validierung
 * als alleiniges Gate) — Nicht-Ziel A6 nennt den `designer` als nicht dispatchbar; diese
 * Sektion ist bewusst eine minimale, gespiegelte Erweiterung.
 *
 * AC13: Der „Durchsuchen…"-Button öffnet den BESTEHENDEN Ordner-Browser
 * (`ObsidianVaultFolderBrowserOverlay`, obsidian-vault-folder-browser AC6, kein neuer
 * Browser). „Diesen Ordner verwenden" liefert einen ABSOLUTEN Container-Pfad — diese
 * Sektion leitet daraus (`deriveVaultRelativeSegment`) ein vault-RELATIVES Segment ab
 * und übernimmt es als Kandidaten in das Freitext-Feld; das Speichern (PUT-Validierung
 * AC11/AC12) bleibt ein expliziter Owner-Klick (kein Auto-Save). Liegt der gewählte
 * Ordner außerhalb des konfigurierten Vaults, ist kein Vault konfiguriert, ODER wurde
 * der Vault-Root selbst gewählt (leeres Segment), zeigt die Sektion eine eigene, dem
 * jeweiligen Fall angemessene Meldung statt eines ungültigen Segments — das Freitext-
 * Feld bleibt in jedem Fall als Fallback nutzbar (kein Zwang zum Browser).
 *
 * AC15 (A11y, WCAG 2.1 AA): Feld beschriftet (label/htmlFor), Quelle/Zustand nicht nur
 * über Farbe (Text „Quelle: <strong>…</strong>"), Fehler programmatisch zugeordnet
 * (aria-describedby, role=alert), Erfolgs-/Zustandsmeldungen via role=status,
 * Fokusführung bei Erfolg/Fehler/Overlay-Übernahme, Touch-Ziele ≥44px (wsPathStyles-
 * Buttons, identisch zur Vault-Pfad-Sektion), vollständig tastaturbedienbar.
 *
 * @param {{
 *   effective: string,
 *   source: 'persisted'|'env'|'default',
 *   persisted: string|null,
 *   vaultPath: string|null,
 *   vaultConfigured?: boolean,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 * }} props  `vaultConfigured` wird aktuell nicht separat ausgewertet — `deriveVaultRelativeSegment`
 *   leitet „kein Vault" bereits aus einem leeren/fehlenden `vaultPath` ab (Reason `no-vault`);
 *   das Prop bleibt Teil des Vertrags (Aufrufer reicht denselben Zustand wie an
 *   `ObsidianVaultPathSection` durch) für spätere, differenziertere Meldungen.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { wsPathStyles } from './WorkspacePathSection.jsx';
import { putObsidianProjekteSubdir, deleteObsidianProjekteSubdir } from './settingsApi.js';
import { ObsidianVaultFolderBrowserOverlay } from './ObsidianVaultFolderBrowserOverlay.jsx';

const SOURCE_LABELS = {
  persisted: 'persistiert (GUI)',
  env: 'Umgebungsvariable (OBSIDIAN_PROJEKTE_SUBDIR)',
  default: 'Standard ("Projekte")',
};

/**
 * Leitet aus einem absoluten (Browser-)Container-Pfad ein zum konfigurierten Vault
 * relatives Segment ab (AC13). Reine Frontend-Herleitung als Kandidaten-Vorbelegung —
 * die Confinement-Härte/Validierung bleibt Aufgabe der PUT-Validierung (AC11/AC12).
 *
 * @param {string|null|undefined} vaultPath  Konfigurierter (absoluter) Vault-Pfad.
 * @param {string} browsedPath  Vom Ordner-Browser gewählter absoluter Container-Pfad.
 * @returns {{ ok: true, segment: string } | { ok: false, reason: 'no-vault'|'is-vault-root'|'outside-vault' }}
 */
export function deriveVaultRelativeSegment(vaultPath, browsedPath) {
  if (!vaultPath || !vaultPath.trim()) return { ok: false, reason: 'no-vault' };
  const normVault = vaultPath.trim().replace(/\/+$/, '');
  const normBrowsed = (browsedPath ?? '').replace(/\/+$/, '');
  if (normBrowsed === normVault) return { ok: false, reason: 'is-vault-root' };
  const prefix = `${normVault}/`;
  if (!normBrowsed.startsWith(prefix)) return { ok: false, reason: 'outside-vault' };
  const segment = normBrowsed.slice(prefix.length);
  if (!segment) return { ok: false, reason: 'is-vault-root' };
  return { ok: true, segment };
}

export function ObsidianProjekteSubdirSection({
  effective,
  source,
  persisted,
  vaultPath,
  onReload,
  fetchFn,
}) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const inputRef = useRef(null);
  const successRef = useRef(null);
  const errorRef = useRef(null);
  const browseBtnRef = useRef(null);
  const ERROR_ID = 'obsidian-projekte-subdir-error';
  const SUCCESS_ID = 'obsidian-projekte-subdir-success';

  const isPersisted = Boolean(persisted && persisted.trim());
  const sourceLabel = SOURCE_LABELS[source] ?? source;

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
  }, [pendingFocusSuccess]);

  // Fokus auf die Fehlermeldung, wenn sie außerhalb des Bearbeiten-Modus entsteht
  // (Overlay-Übernahme-Fehler, AC13/AC15 — im Bearbeiten-Modus übernimmt handleSave
  // den Fokus stattdessen auf das sichtbare Eingabefeld).
  const [pendingFocusError, setPendingFocusError] = useState(false);
  useEffect(() => {
    if (pendingFocusError && errorRef.current) {
      errorRef.current.focus();
      setPendingFocusError(false);
    }
  }, [pendingFocusError]);

  const handleSave = useCallback(async () => {
    setError(null);
    setSuccessMsg(null);

    const trimmed = inputVal.trim();
    if (!trimmed) {
      setError('Obsidian-Projekt-Unterordner darf nicht leer sein.');
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      await putObsidianProjekteSubdir(trimmed, fetchFn);
      setInputVal('');
      setEditing(false);
      await onReload();
      setSuccessMsg('Obsidian-Projekt-Unterordner gespeichert.');
      setPendingFocusSuccess(true);
    } catch (err) {
      // 4xx/422 (kein Vault konfiguriert / nicht existent / kein Verzeichnis / nicht
      // lesbar / Traversal, AC11/AC12) und 403 (keine Berechtigung) landen beide hier —
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
      await deleteObsidianProjekteSubdir(fetchFn);
      await onReload();
      setSuccessMsg('Obsidian-Projekt-Unterordner zurückgesetzt.');
      setPendingFocusSuccess(true);
    } catch (err) {
      setError(err.message);
      setPendingFocusError(true);
    } finally {
      setResetting(false);
    }
  }, [onReload, fetchFn]);

  const handleCancel = useCallback(() => {
    setInputVal('');
    setError(null);
    setEditing(false);
  }, []);

  // AC13: öffnet den bestehenden Ordner-Browser (kein neuer Browser).
  const handleOpenBrowser = useCallback(() => {
    setBrowserOpen(true);
  }, []);

  // AC13: leitet aus dem gewählten absoluten Container-Pfad ein vault-relatives
  // Segment ab und übernimmt es als Kandidaten in `inputVal` (Bearbeiten-Modus wird
  // geöffnet). Liegt der Ordner außerhalb des Vaults, IST er der Vault selbst (leeres
  // Segment) oder ist kein Vault konfiguriert, erscheint eine eigene, präzise Meldung
  // statt eines ungültigen Segments — kein Feld-Update.
  const handleBrowserSelect = useCallback((path) => {
    setSuccessMsg(null);
    const derived = deriveVaultRelativeSegment(vaultPath, path);
    if (!derived.ok) {
      const messages = {
        'no-vault': 'Kein Obsidian-Vault konfiguriert — zuerst den Obsidian-Vault-Pfad setzen.',
        'is-vault-root': 'Der Vault selbst kann nicht als Unterordner verwendet werden — bitte einen Unterordner wählen.',
        'outside-vault': `Der gewählte Ordner liegt außerhalb des konfigurierten Vaults (${vaultPath}).`,
      };
      setError(messages[derived.reason] ?? messages['outside-vault']);
      setPendingFocusError(true);
      return;
    }
    setError(null);
    setInputVal(derived.segment);
    setEditing(true);
  }, [vaultPath]);

  return (
    <div style={wsPathStyles.wrapper}>
      {/* Effektivwert-Anzeige */}
      <div style={wsPathStyles.pathRow}>
        <span style={wsPathStyles.pathLabel}>Aktueller Obsidian-Projekt-Unterordner:</span>
        <code style={wsPathStyles.pathValue}>{effective}</code>
      </div>
      <div style={wsPathStyles.sourceRow}>
        <span style={wsPathStyles.sourceText}>
          Quelle: <strong>{sourceLabel}</strong>
        </span>
      </div>

      {/* AC13: Durchsuchen-Button — öffnet den bestehenden Ordner-Browser */}
      <div style={wsPathStyles.actionRow}>
        <button
          type="button"
          ref={browseBtnRef}
          onClick={handleOpenBrowser}
          style={wsPathStyles.btnSmall}
          aria-label="Obsidian-Vault durchsuchen, um den Projekt-Unterordner auszuwählen"
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

      {/* Fehler-Feedback (feldzugeordnet) — deckt 422-Validierung, 403, 409
          (kein Vault) UND die Browser-Übernahme-Ablehnung (AC13) ab. */}
      {error && (
        <p
          id={ERROR_ID}
          ref={errorRef}
          style={wsPathStyles.error}
          role="alert"
          tabIndex={-1}
        >
          {error}
        </p>
      )}

      {editing ? (
        <div style={wsPathStyles.editArea}>
          <label htmlFor="obsidian-projekte-subdir-input" style={wsPathStyles.fieldLabel}>
            Neuer Obsidian-Projekt-Unterordner (relativ zum Vault)
          </label>
          <input
            id="obsidian-projekte-subdir-input"
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder="z.B. 300 Projekte/Studis Softwareschmiede"
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
            aria-label={isPersisted ? 'Obsidian-Projekt-Unterordner ändern' : 'Obsidian-Projekt-Unterordner setzen'}
          >
            {isPersisted ? 'Ändern' : 'Setzen'}
          </button>
          {isPersisted && (
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              style={wsPathStyles.btnDanger}
              aria-label="Obsidian-Projekt-Unterordner zurücksetzen"
              aria-busy={resetting}
            >
              {resetting ? 'Zurücksetzen…' : 'Zurücksetzen'}
            </button>
          )}
        </div>
      )}

      {/* AC13: Ordner-Browser-Overlay (bestehende Komponente, kein neuer Browser) */}
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
