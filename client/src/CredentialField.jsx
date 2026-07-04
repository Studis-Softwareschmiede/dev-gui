/**
 * CredentialField.jsx — Formular-Zeile für ein einzelnes Credential-Feld + geteilte
 * Backup-Quittungs-Anzeige (BackupReceipt) + geteilte fieldStyles.
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. `fieldStyles` und `BackupReceipt` werden auch
 * von BackupSection.jsx (BackupRemoteCredField) und NotificationSection.jsx
 * (Token-Feld) importiert — einzige Quelle, nichts doppelt gepflegt.
 *
 * @param {{
 *   integration: string,
 *   name: string,
 *   label: string,
 *   meta: { status: string, masked?: string, updatedAt?: string } | undefined,
 *   onSaved: () => void,
 * }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { MAX_VALUE_LEN, putCredential, deleteCredential } from './settingsApi.js';

/**
 * Rendert die zweistufige Backup-Quittung (AC11).
 * local: 'ok'|'failed', offHost: 'ok'|'failed'|'disabled'
 * Kein Secret, keine Pfadangabe — nur Stufen-Ergebnis.
 *
 * @param {{ local: string, offHost: string }} backup
 */
export function BackupReceipt({ backup }) {
  if (!backup) return null;
  const { local, offHost } = backup;
  return (
    <div style={backupReceiptStyles.wrapper} role="status" aria-live="polite" aria-label="Backup-Quittung">
      {/* Lokale Stufe */}
      <span
        style={local === 'ok' ? backupReceiptStyles.ok : backupReceiptStyles.warn}
        aria-label={local === 'ok' ? 'lokal gesichert' : 'lokale Sicherung fehlgeschlagen'}
      >
        {local === 'ok' ? 'lokal gesichert ✓' : 'lokal fehlgeschlagen ⚠'}
      </span>
      {/* Off-Host-Stufe: nur anzeigen wenn nicht disabled */}
      {offHost !== 'disabled' && (
        <>
          <span style={backupReceiptStyles.separator} aria-hidden="true">{' · '}</span>
          <span
            style={offHost === 'ok' ? backupReceiptStyles.ok : backupReceiptStyles.warn}
            aria-label={offHost === 'ok' ? 'off-host gesichert' : 'off-host Sicherung fehlgeschlagen'}
          >
            {offHost === 'ok' ? 'off-host gesichert ✓' : 'off-host fehlgeschlagen ⚠'}
          </span>
        </>
      )}
    </div>
  );
}

export const backupReceiptStyles = {
  wrapper: {
    marginTop: 6,
    fontSize: 12,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
  },
  ok: {
    color: '#86efac',   // Grün — Kontrast ≥ 4.5:1 auf #111
    fontFamily: 'monospace',
  },
  warn: {
    color: '#fca5a5',   // Rot — Kontrast ≥ 4.5:1 auf #111
    fontFamily: 'monospace',
  },
  separator: {
    color: '#6b7280',
    userSelect: 'none',
  },
};

export function CredentialField({ integration, name, label, meta, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  // AC11: Backup-Quittung nach Credential-Schreib-Operation
  const [backupResult, setBackupResult] = useState(null);
  const inputRef = useRef(null);
  const errorId = `err-${integration}-${name}`;

  // AC5 (github-app-key-format-tolerant): private_key uses a multiline textarea
  // so that pasted PEMs retain their newlines intact.  All other fields stay
  // single-line (type=password).  Write-only semantics are unchanged — the
  // component never renders the stored value as cleartext.
  const isPrivateKeyField = integration === 'github' && name === 'private_key';

  const isSet = meta?.status === 'set';

  // Fokus auf Input wenn Bearbeiten-Modus öffnet
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const handleSave = useCallback(async () => {
    setError(null);
    // AC8: Frontend-Validierung
    const trimmed = inputVal.trim();
    if (!trimmed) {
      setError('Wert darf nicht leer sein.');
      inputRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_VALUE_LEN) {
      setError(`Wert überschreitet das Längenlimit (${MAX_VALUE_LEN} Zeichen).`);
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      const data = await putCredential(integration, name, trimmed);
      // AC4/AC2: Klartext sofort verwerfen nach Speichern
      setInputVal('');
      setEditing(false);
      // AC11: Backup-Quittung anzeigen (falls Backup-Ergebnis in der Antwort vorhanden)
      if (data?.backup) setBackupResult(data.backup);
      onSaved();
    } catch (err) {
      setError(err.message);
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [integration, name, inputVal, onSaved]);

  const handleDelete = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      const data = await deleteCredential(integration, name);
      // AC11: Backup-Quittung anzeigen (falls Backup-Ergebnis in der Antwort vorhanden)
      if (data?.backup) setBackupResult(data.backup);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [integration, name, onSaved]);

  const handleCancel = useCallback(() => {
    setInputVal('');
    setError(null);
    setEditing(false);
  }, []);

  return (
    <div style={fieldStyles.row} role="group" aria-label={label}>
      <div style={fieldStyles.labelRow}>
        <span style={fieldStyles.fieldLabel}>{label}</span>
        <span
          style={isSet ? fieldStyles.statusSet : fieldStyles.statusUnset}
          aria-label={isSet ? 'gesetzt' : 'nicht gesetzt'}
        >
          {isSet ? (meta.masked ?? '•••• gesetzt') : 'nicht gesetzt'}
        </span>
      </div>

      {editing ? (
        <div style={fieldStyles.editArea}>
          <label htmlFor={`input-${integration}-${name}`} style={fieldStyles.srOnly}>
            {label} — neuer Wert
          </label>
          {isPrivateKeyField ? (
            /* AC5: mehrzeilige Textarea für private_key — Newlines bleiben erhalten */
            <textarea
              id={`input-${integration}-${name}`}
              ref={inputRef}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder={isSet ? 'PEM einfügen (überschreibt bestehenden Key)' : 'PEM einfügen (-----BEGIN … KEY-----)'}
              style={{ ...fieldStyles.input, minHeight: 160, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? 'true' : undefined}
              autoComplete="off"
              data-lpignore="true"
              spellCheck={false}
            />
          ) : (
            <input
              id={`input-${integration}-${name}`}
              ref={inputRef}
              type="password"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder={isSet ? 'Neuen Wert eingeben (überschreibt bestehenden)' : 'Wert eingeben'}
              style={fieldStyles.input}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? 'true' : undefined}
              autoComplete="off"
              data-lpignore="true"
            />
          )}
          {error && (
            <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">
              {error}
            </p>
          )}
          <div style={fieldStyles.actionRow}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={fieldStyles.btnPrimary}
              aria-busy={saving}
            >
              {saving ? 'Speichern…' : 'Speichern'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              style={fieldStyles.btnSecondary}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <div style={fieldStyles.actionRow}>
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={fieldStyles.btnSmall}
            aria-label={isSet ? `${label} ändern` : `${label} setzen`}
          >
            {isSet ? 'Ändern' : 'Setzen'}
          </button>
          {isSet && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              style={fieldStyles.btnDanger}
              aria-label={`${label} löschen`}
              aria-busy={deleting}
            >
              {deleting ? 'Löschen…' : 'Löschen'}
            </button>
          )}
        </div>
      )}

      {/* AC11: Zweistufige Backup-Quittung nach Schreib-Operation */}
      {backupResult && <BackupReceipt backup={backupResult} />}
    </div>
  );
}

export const fieldStyles = {
  row: {
    padding: '12px 0',
    borderBottom: '1px solid #2a2a2a',
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
  },
  statusSet: {
    fontSize: 12,
    color: '#86efac',   // Kontrast ≥ 4.5:1 auf #111
    fontFamily: 'monospace',
  },
  statusUnset: {
    fontSize: 12,
    color: '#9ca3af',  // Kontrast ≥ 4.5:1 auf #111 (geprüft: ~4.6:1)
    fontStyle: 'italic',
  },
  editArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 8,
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
  error: {
    margin: 0,
    fontSize: 13,
    color: '#fca5a5',         // Kontrast auf #111 ≥ 4.5:1
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
};
