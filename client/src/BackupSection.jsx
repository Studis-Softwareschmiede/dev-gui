/**
 * BackupSection.jsx — Abschnitt „Backup / Sicherung" (credential-backup S-143, AC11/AC12).
 *
 * Enthält (unverändert extrahiert): BackupSection (Haupt-Export), RestoreSection
 * (S-142 AC13–AC16, intern gerendert), BackupRemoteCredField, BackupStepResults,
 * BackupStatusTile.
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. `fieldStyles` + `BackupReceipt` importiert aus
 * CredentialField.jsx (geteilte Quelle, nichts doppelt gepflegt).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fieldStyles, BackupReceipt } from './CredentialField.jsx';
import {
  MAX_VALUE_LEN,
  fetchBackupStatus,
  fetchBackupConfig,
  saveBackupConfig,
  putBackupRemoteCred,
  deleteBackupRemoteCred,
  postBackupRestore,
} from './settingsApi.js';

// ── RestoreSection (S-142 AC13–AC16) ─────────────────────────────────────────

export function RestoreSection({ fetchFn }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState(null); // { ok, errorClass?, error?, manifest? }
  const fileInputRef = useRef(null);
  const ERROR_ID = 'restore-error';
  const SUCCESS_ID = 'restore-success';

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    // Vorheriges Ergebnis zurücksetzen bei neuer Dateiauswahl
    setResult(null);
  }, []);

  const handleCheckboxChange = useCallback((e) => {
    setConfirmed(e.target.checked);
    setResult(null);
  }, []);

  const handleRestore = useCallback(async () => {
    if (!selectedFile) return;
    if (!confirmed) {
      setResult({ ok: false, errorClass: 'confirm-required', error: 'Bitte bestätige das Überschreiben des aktuellen Stores.' });
      return;
    }

    setRestoring(true);
    setResult(null);

    let artefactBuffer;
    try {
      artefactBuffer = await selectedFile.arrayBuffer();
    } catch {
      setRestoring(false);
      setResult({ ok: false, errorClass: 'restore-invalid', error: 'Datei konnte nicht gelesen werden.' });
      return;
    }

    try {
      const data = await postBackupRestore(artefactBuffer, fetchFn);
      // Floor: artefactBuffer (Klartext nach Entschlüsselung) bleibt nur im Backend;
      // Referenz hier (verschlüsseltes Artefakt) wird nach dem Request GC-freigegeben.
      if (data.ok) {
        setResult({ ok: true, manifest: data.manifest });
        // Formular zurücksetzen nach Erfolg
        setSelectedFile(null);
        setConfirmed(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        setResult({ ok: false, errorClass: data.errorClass, error: data.error ?? 'Restore fehlgeschlagen.' });
      }
    } catch {
      setResult({ ok: false, errorClass: 'error', error: 'Netzwerk-Fehler beim Restore.' });
    } finally {
      setRestoring(false);
    }
  }, [selectedFile, confirmed, fetchFn]);

  const canRestore = selectedFile !== null && confirmed && !restoring;

  return (
    <div style={restoreStyles.wrapper} aria-labelledby="restore-section-heading">
      <h3 id="restore-section-heading" style={restoreStyles.heading}>Restore aus Backup-Artefakt</h3>
      <p style={restoreStyles.desc}>
        Lade ein verschlüsseltes Backup-Artefakt (.gpg) hoch. Es wird mit dem geladenen
        Master-Key entschlüsselt und der Store atomar wiederhergestellt.
        Dieser Vorgang überschreibt den aktuellen Store unwiderruflich.
      </p>

      {/* Datei-Upload (AC13) */}
      <div style={restoreStyles.fieldRow}>
        <label htmlFor="restore-file-input" style={restoreStyles.label}>
          Backup-Artefakt (.gpg):
        </label>
        <input
          id="restore-file-input"
          ref={fileInputRef}
          type="file"
          accept=".gpg,application/octet-stream"
          onChange={handleFileChange}
          style={restoreStyles.fileInput}
          aria-describedby={result && !result.ok ? ERROR_ID : undefined}
          aria-invalid={result && !result.ok ? 'true' : undefined}
          disabled={restoring}
        />
      </div>

      {/* Ausgewählte Datei */}
      {selectedFile && (
        <p style={restoreStyles.fileInfo} aria-live="polite">
          Ausgewählt: <strong>{selectedFile.name}</strong> ({(selectedFile.size / 1024).toFixed(1)} KB)
        </p>
      )}

      {/* Überschreib-Bestätigung (AC14) */}
      <div style={restoreStyles.confirmRow}>
        <label htmlFor="restore-confirm-checkbox" style={restoreStyles.confirmLabel}>
          <input
            id="restore-confirm-checkbox"
            type="checkbox"
            checked={confirmed}
            onChange={handleCheckboxChange}
            disabled={restoring}
            style={restoreStyles.checkbox}
            aria-describedby="restore-confirm-desc"
          />
          {' '}Ich bestätige, dass der aktuelle Credential-Store überschrieben werden soll.
        </label>
        <p id="restore-confirm-desc" style={restoreStyles.confirmDesc}>
          Diese Aktion kann nicht rückgängig gemacht werden. Stelle sicher, dass du das
          richtige Artefakt und den richtigen Master-Key verwendest.
        </p>
      </div>

      {/* Fehler-Feedback (AC15: geheimnisfreier Fehler, AC16: 403) */}
      {result && !result.ok && (
        <div id={ERROR_ID} role="alert" style={restoreStyles.errorBox}>
          <strong>Restore fehlgeschlagen</strong>
          {result.errorClass && (
            <span style={restoreStyles.errorClass}> [{result.errorClass}]</span>
          )}
          <p style={restoreStyles.errorText}>{result.error}</p>
        </div>
      )}

      {/* Erfolgs-Feedback (AC13: Store wiederhergestellt) */}
      {result && result.ok && (
        <div id={SUCCESS_ID} role="status" style={restoreStyles.successBox}>
          <strong>Restore erfolgreich!</strong>
          <p style={restoreStyles.successText}>
            Der Credential-Store wurde wiederhergestellt.
            {result.manifest?.createdAt && (
              <> Backup erstellt am: {new Date(result.manifest.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' })}.</>
            )}
          </p>
        </div>
      )}

      {/* Restore-Button */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleRestore}
          disabled={!canRestore}
          aria-busy={restoring}
          aria-describedby={result && !result.ok ? ERROR_ID : undefined}
          style={canRestore ? restoreStyles.btnPrimary : restoreStyles.btnDisabled}
        >
          {restoring ? 'Restore läuft…' : 'Jetzt wiederherstellen'}
        </button>
      </div>
    </div>
  );
}
export const restoreStyles = {
  wrapper: {
    marginTop: 24,
    paddingTop: 20,
    borderTop: '1px solid #2a2a2a',
  },
  heading: {
    margin: '0 0 8px',
    fontSize: 14,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  desc: {
    margin: '0 0 14px',
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  label: {
    color: '#9ca3af',
    fontSize: 13,
    minWidth: 160,
  },
  fileInput: {
    color: '#e5e7eb',
    fontSize: 13,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    minHeight: 44,
  },
  fileInfo: {
    margin: '4px 0 8px',
    fontSize: 12,
    color: '#9ca3af',
  },
  confirmRow: {
    marginBottom: 12,
  },
  confirmLabel: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    color: '#e5e7eb',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1.4,
    minHeight: 44,
  },
  checkbox: {
    marginTop: 2,
    minWidth: 16,
    minHeight: 16,
    cursor: 'pointer',
  },
  confirmDesc: {
    margin: '6px 0 0 24px',
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 1.4,
  },
  errorBox: {
    padding: '10px 14px',
    marginBottom: 10,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  errorClass: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#fca5a5',
    opacity: 0.7,
  },
  errorText: {
    margin: '4px 0 0',
    fontSize: 12,
  },
  successBox: {
    padding: '10px 14px',
    marginBottom: 10,
    background: '#0d1a0d',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',
    fontSize: 13,
  },
  successText: {
    margin: '4px 0 0',
    fontSize: 12,
    color: '#9ca3af',
  },
  btnPrimary: {
    background: '#7f1d1d',
    border: 'none',
    borderRadius: 4,
    color: '#fecaca',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    padding: '8px 18px',
  },
  btnDisabled: {
    background: '#374151',
    border: 'none',
    borderRadius: 4,
    color: '#6b7280',
    cursor: 'not-allowed',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    padding: '8px 18px',
  },
};

// ── BackupSection (AC12) ──────────────────────────────────────────────────────

/** Remote-Creds-Felder für backup-remote (write-only, analog Credential-Catalog). S3-only seit S-160. */
const BACKUP_REMOTE_FIELDS = [
  { name: 's3_access_key', label: 'S3 Access Key ID' },
  { name: 's3_secret_key', label: 'S3 Secret Access Key' },
];

/**
 * Inline-Feld für einen write-only Remote-Credential-Wert.
 * Folgt dem CredentialField-Muster (write-only, kein Klartext im DOM).
 * AC12: Remote-Creds write-only, kein Secret im DOM/Bundle.
 *
 * @param {{ name: string, label: string, meta: object|null, onSaved: () => void }} props
 */
function BackupRemoteCredField({ name, label, meta, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  // AC11: Backup-Quittung auch für Remote-Cred-Felder
  const [backupResult, setBackupResult] = useState(null);
  const inputRef = useRef(null);
  const errorId = `err-backup-remote-${name}`;

  const isSet = meta?.status === 'set';

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const handleSave = useCallback(async () => {
    setError(null);
    // S1: Quittung zu Beginn jeder async-Op zurücksetzen (Race-Condition-Guard)
    setBackupResult(null);
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
      const data = await putBackupRemoteCred(name, trimmed);
      // AC4/AC2: Klartext sofort verwerfen
      setInputVal('');
      setEditing(false);
      // AC11: Backup-Quittung
      if (data?.backup) setBackupResult(data.backup);
      onSaved();
    } catch (err) {
      setError(err.message);
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [name, inputVal, onSaved]);

  const handleDelete = useCallback(async () => {
    setError(null);
    // S1: Quittung zu Beginn jeder async-Op zurücksetzen
    setBackupResult(null);
    setDeleting(true);
    try {
      const data = await deleteBackupRemoteCred(name);
      // AC11: Backup-Quittung
      if (data?.backup) setBackupResult(data.backup);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [name, onSaved]);

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
          <label htmlFor={`input-backup-remote-${name}`} style={fieldStyles.srOnly}>
            {label} — neuer Wert
          </label>
          <input
            id={`input-backup-remote-${name}`}
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

      {/* AC11: Backup-Quittung nach Schreib-Operation */}
      {backupResult && <BackupReceipt backup={backupResult} />}
    </div>
  );
}

/**
 * Rendert das Stufen-Ergebnis (lokal ✓/⚠, off-host ✓/⚠/–) eines Backups (AC12 / I2-Fix).
 * Metadaten-only: nur 'ok'|'failed'|'disabled'|null — kein Key/Secret/Klartext.
 * A11y: role=img + aria-label auf den einzelnen Stufen-Spans.
 *
 * @param {{ localResult: 'ok'|'failed'|null, offHostResult: 'ok'|'failed'|'disabled'|null }} props
 */
function BackupStepResults({ localResult, offHostResult }) {
  if (!localResult && !offHostResult) return null;

  let localIcon = null;
  let localColor = '#9ca3af';
  let localAriaLabel = null;
  if (localResult === 'ok') {
    localIcon = '✓'; localColor = '#86efac'; localAriaLabel = 'lokal gesichert';
  } else if (localResult === 'failed') {
    localIcon = '⚠'; localColor = '#fca5a5'; localAriaLabel = 'lokal fehlgeschlagen';
  }

  let offHostIcon = null;
  let offHostColor = '#9ca3af';
  let offHostAriaLabel = null;
  if (offHostResult === 'ok') {
    offHostIcon = '✓'; offHostColor = '#86efac'; offHostAriaLabel = 'off-host gesichert';
  } else if (offHostResult === 'failed') {
    offHostIcon = '⚠'; offHostColor = '#fca5a5'; offHostAriaLabel = 'off-host fehlgeschlagen';
  } else if (offHostResult === 'disabled') {
    offHostIcon = '–'; offHostColor = '#9ca3af'; offHostAriaLabel = 'off-host deaktiviert';
  }

  return (
    <p style={backupStyles.statusTileHint}>
      {localIcon && (
        <span style={{ color: localColor, marginRight: 4 }} role="img" aria-label={localAriaLabel}>
          {'lokal ' + localIcon}
        </span>
      )}
      {offHostIcon && (
        <span style={{ color: offHostColor, marginLeft: localIcon ? 8 : 0 }} role="img" aria-label={offHostAriaLabel}>
          {'off-host ' + offHostIcon}
        </span>
      )}
    </p>
  );
}

/**
 * Status-Kachel (AC12): Zeigt Metadaten des letzten Backups — leak-frei.
 * Spec §13: NUR Zeit, Stufen-Ergebnis, Ziel-Typ — KEIN Key/Secret/Klartext.
 *
 * @param {{ status: object|null, loading: boolean, error: string|null }} props
 */
function BackupStatusTile({ status, loading, error }) {
  const tileId = 'backup-status-tile';
  if (loading) {
    return (
      <div style={backupStyles.statusTile} aria-labelledby={tileId} aria-busy="true" role="status">
        <p style={backupStyles.statusTileLabel} id={tileId}>Backup-Status</p>
        <p style={backupStyles.statusTileHint}>Wird geladen…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div style={backupStyles.statusTileError} role="alert" aria-labelledby={tileId}>
        <p style={backupStyles.statusTileLabel} id={tileId}>Backup-Status</p>
        <p style={backupStyles.statusTileHint}>Nicht abrufbar: {error}</p>
      </div>
    );
  }
  const offHostLabel = status?.offHostEnabled
    ? (status.offHostType === 's3' ? 'S3-kompatibel' : status.offHostType ?? 'unbekannt')
    : 'nur lokal';

  return (
    <div style={backupStyles.statusTile} role="status" aria-labelledby={tileId}>
      <p style={backupStyles.statusTileLabel} id={tileId}>Letztes Backup</p>
      {status?.lastBackup ? (
        <>
          <p style={backupStyles.statusTileValue}>
            {new Date(status.lastBackup.at).toLocaleString('de-DE', {
              dateStyle: 'short',
              timeStyle: 'medium',
            })}
          </p>
          {/* AC12 / I2-Fix: Stufen-Ergebnis je Stufe (lokal ✓/⚠, off-host ✓/⚠/–) */}
          <BackupStepResults
            localResult={status.lastBackup.localResult ?? null}
            offHostResult={status.lastBackup.offHostResult ?? null}
          />
          <p style={backupStyles.statusTileHint}>
            Ziel: {offHostLabel}
          </p>
        </>
      ) : (
        <p style={backupStyles.statusTileHint}>Noch kein Backup vorhanden.</p>
      )}
    </div>
  );
}

/**
 * Abschnitt „Backup / Sicherung" in der SettingsView (AC12).
 *
 * Architekt-Entscheid (S-143, Variante B): Nicht-geheime Backup-Konfiguration
 * (Ziel-Typ, Pfad/URL/Bucket/Host/Präfix/Region, Retention, An/Aus) ist in der UI
 * schreibbar und wird persistent als backup-config.json auf dem Credential-Volume
 * gespeichert. Env-Vars gelten als Initial-Default (Migration/Erstkonfig).
 * Remote-Secrets bleiben write-only im CredentialStore.
 *
 * Enthält:
 * - Status-Kachel (letztes Backup: Zeit, Ziel) — leak-frei
 * - Editierbare Ziel-Konfiguration (Ziel-Typ, Felder je Typ, Retention, An/Aus)
 * - Remote-Credentials (write-only, backup-remote Catalog)
 *
 * A11y: Labels mit htmlFor, aria-invalid bei Fehler, Touch-Targets ≥ 44 px,
 *        Fehlerzuordnung via aria-describedby, role=status für Status-Kachel.
 *
 * Security (AC12/Floor): Remote-Creds nur als „•••• gesetzt"-Status — nie Klartext im DOM.
 * Admin-Gate (CRED_ADMIN_EMAILS): PUT /api/settings/backup-config ist Admin-geschützt +
 * Audit-First (im Backend, transparent für die UI → 403 als Fehlermeldung).
 *
 * @param {{ credentials: Array, onSaved: () => void, fetchFn?: typeof fetch }} props
 */
export function BackupSection({ credentials, onSaved, fetchFn }) {
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusData, setStatusData] = useState(null);
  const [statusError, setStatusError] = useState(null);

  // Editierbare Konfig-Felder (Architekt-Entscheid: UI-schreibbar)
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState(null);
  const [configSaved, setConfigSaved] = useState(false);

  // Form-State für die editierbaren Felder
  const [offHostEnabled, setOffHostEnabled] = useState(false);
  const [targetType, setTargetType] = useState('s3');
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  // S3-Präfix (relativer Key-Präfix, z.B. 'dev-gui/')
  const [s3Prefix, setS3Prefix] = useState('dev-gui/');
  const [region, setRegion] = useState('us-east-1');
  const [retentionCount, setRetentionCount] = useState(10);

  const getMeta = useCallback(
    (name) => credentials.find((c) => c.integration === 'backup-remote' && c.name === name) ?? null,
    [credentials],
  );

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const data = await fetchBackupStatus(fetchFn);
      setStatusData(data);
    } catch (err) {
      setStatusError(err.message ?? 'Unbekannter Fehler');
    } finally {
      setStatusLoading(false);
    }
  }, [fetchFn]);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const data = await fetchBackupConfig(fetchFn);
      // Form-State mit geladener Konfiguration befüllen
      const loadedOffHostEnabled = Boolean(data.offHostEnabled);
      setOffHostEnabled(loadedOffHostEnabled);

      // AC18 (S-147, S-160): Normalisierung targetType — bei offHostEnabled=true muss targetType
      // 's3' sein; 'local' (oder unbekannte Werte) werden auf 's3' normalisiert,
      // damit das Dropdown immer einen darstellbaren Wert zeigt und keine stillen Mismatches entstehen.
      // S3-only seit S-160: 'sftp' ist keine gültige Option mehr.
      const loadedType = data.targetType ?? 'local';
      const normalizedType = loadedOffHostEnabled && loadedType !== 's3' ? 's3' : loadedType;
      setTargetType(normalizedType);

      setEndpoint(data.endpoint ?? '');
      setBucket(data.bucket ?? '');
      // AC19 (S-147): Default 'dev-gui/' wenn kein gespeicherter Wert vorhanden
      setS3Prefix(data.prefix || 'dev-gui/');
      setRegion(data.region ?? 'us-east-1');
      setRetentionCount(data.retentionCount ?? 10);
    } catch (err) {
      setConfigError(err.message ?? 'Konfiguration nicht abrufbar');
    } finally {
      setConfigLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    loadStatus();
    loadConfig();
  }, [loadStatus, loadConfig]);

  const handleSaveConfig = useCallback(async () => {
    setConfigError(null);
    setConfigSaved(false);
    setConfigSaving(true);
    try {
      await saveBackupConfig({
        offHostEnabled,
        targetType,
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        prefix: s3Prefix.trim(),
        region: region.trim(),
        retentionCount: Math.max(1, parseInt(String(retentionCount), 10) || 10),
      }, fetchFn);
      setConfigSaved(true);
      // Status neu laden (zeigt aktuellen Zustand)
      loadStatus();
    } catch (err) {
      setConfigError(err.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setConfigSaving(false);
    }
  }, [offHostEnabled, targetType, endpoint, bucket, s3Prefix, region, retentionCount, fetchFn, loadStatus]);

  return (
    <>
      {/* Status-Kachel (AC12: Zeit, Ziel — kein Secret) */}
      <BackupStatusTile status={statusData} loading={statusLoading} error={statusError} />

      {/* Editierbare Ziel-Konfiguration (Architekt-Entscheid: UI-schreibbar, persistent) */}
      <div style={backupStyles.configBlock}>
        <h3 style={backupStyles.subHeading}>Ziel-Konfiguration</h3>
        <p style={backupStyles.envNote}>
          Nicht-geheime Einstellungen persistent gespeichert (Credential-Volume).
          Env-Vars (<code style={backupStyles.code}>BACKUP_OFFHOST_*</code>) dienen als Initial-Default.
        </p>

        {configLoading ? (
          <p style={backupStyles.envNote} aria-busy="true">Konfiguration wird geladen…</p>
        ) : (
          <>
            {/* Off-Host aktiv (An/Aus) */}
            <div style={backupStyles.configFormRow}>
              <label htmlFor="backup-offhost-enabled" style={backupStyles.configFormLabel}>
                Off-Host-Backup aktiv:
              </label>
              <select
                id="backup-offhost-enabled"
                value={offHostEnabled ? 'true' : 'false'}
                onChange={(e) => setOffHostEnabled(e.target.value === 'true')}
                style={backupStyles.configSelect}
                aria-describedby={configError ? 'backup-config-error' : undefined}
              >
                <option value="false">Nein (nur lokal)</option>
                <option value="true">Ja</option>
              </select>
            </div>

            {/* Ziel-Typ */}
            {offHostEnabled && (
              <div style={backupStyles.configFormRow}>
                <label htmlFor="backup-target-type" style={backupStyles.configFormLabel}>
                  Ziel-Typ:
                </label>
                <select
                  id="backup-target-type"
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value)}
                  style={backupStyles.configSelect}
                >
                  <option value="s3">S3-kompatibel</option>
                </select>
              </div>
            )}

            {/* S3-Felder */}
            {offHostEnabled && targetType === 's3' && (
              <>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-s3-bucket" style={backupStyles.configFormLabel}>
                    S3-Bucket:
                  </label>
                  <input
                    id="backup-s3-bucket"
                    type="text"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-backup-bucket"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-s3-endpoint" style={backupStyles.configFormLabel}>
                    S3-Endpoint (URL):
                  </label>
                  <input
                    id="backup-s3-endpoint"
                    type="text"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="leer = AWS S3"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-s3-prefix" style={backupStyles.configFormLabel}>
                    Pfad-Präfix:
                  </label>
                  <input
                    id="backup-s3-prefix"
                    type="text"
                    value={s3Prefix}
                    onChange={(e) => setS3Prefix(e.target.value)}
                    placeholder="dev-gui/"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-s3-region" style={backupStyles.configFormLabel}>
                    AWS-Region:
                  </label>
                  <input
                    id="backup-s3-region"
                    type="text"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="us-east-1"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
              </>
            )}

            {/* Retention */}
            <div style={backupStyles.configFormRow}>
              <label htmlFor="backup-retention" style={backupStyles.configFormLabel}>
                Retention (Kopien):
              </label>
              <input
                id="backup-retention"
                type="number"
                value={retentionCount}
                onChange={(e) => setRetentionCount(parseInt(e.target.value, 10) || 10)}
                min={1}
                max={9999}
                style={{ ...backupStyles.configInput, width: 80 }}
                autoComplete="off"
              />
            </div>

            {/* Fehleranzeige */}
            {configError && (
              <p id="backup-config-error" role="alert" style={backupStyles.configErrorMsg}>
                {configError}
              </p>
            )}

            {/* Erfolgsbestätigung */}
            {configSaved && !configError && (
              <p role="status" style={backupStyles.configSuccessMsg}>
                Konfiguration gespeichert.
              </p>
            )}

            {/* Speichern-Button */}
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={handleSaveConfig}
                disabled={configSaving}
                aria-busy={configSaving}
                style={backupStyles.saveButton}
              >
                {configSaving ? 'Wird gespeichert…' : 'Backup-Konfiguration speichern'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Remote-Credentials (write-only, AC12: nur bei aktiviertem Off-Host) */}
      {offHostEnabled && (
        <div style={backupStyles.credsBlock}>
          <h3 style={backupStyles.subHeading}>Remote-Zugangsdaten</h3>
          <p style={backupStyles.envNote}>
            Write-only — werden sicher im Credential-Store hinterlegt.
            Klartext-Werte werden nach dem Speichern sofort verworfen.
          </p>
          {BACKUP_REMOTE_FIELDS.map(({ name, label }) => (
            <BackupRemoteCredField
              key={name}
              name={name}
              label={label}
              meta={getMeta(name)}
              onSaved={onSaved}
            />
          ))}
        </div>
      )}

      {/* Restore-Abschnitt (S-142 AC13–AC16) */}
      <RestoreSection fetchFn={fetchFn} />
    </>
  );
}
export const backupStyles = {
  statusTile: {
    marginBottom: 16,
    padding: '12px 16px',
    background: '#0d1a0d',
    border: '1px solid #166534',
    borderRadius: 6,
  },
  statusTileError: {
    marginBottom: 16,
    padding: '12px 16px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
  },
  statusTileLabel: {
    margin: '0 0 4px',
    fontSize: 11,
    fontWeight: 700,
    color: '#9ca3af',  // S4-Fix: #9ca3af statt #6b7280 — WCAG 2.1 AA ≥ 4.5:1 auf #0d1a0d
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statusTileValue: {
    margin: '0 0 2px',
    fontSize: 14,
    fontWeight: 600,
    color: '#86efac',   // Grün — Kontrast auf #0d1a0d ≥ 4.5:1
  },
  statusTileHint: {
    margin: 0,
    fontSize: 12,
    color: '#9ca3af',   // Kontrast auf #0d1a0d ≥ 4.5:1
  },
  configBlock: {
    marginBottom: 16,
  },
  credsBlock: {
    marginTop: 8,
  },
  subHeading: {
    margin: '0 0 6px',
    fontSize: 14,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  envNote: {
    margin: '0 0 10px',
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 11,
    padding: '1px 4px',
    background: '#1e293b',
    borderRadius: 3,
    color: '#93c5fd',
  },
  configRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginBottom: 6,
    fontSize: 13,
  },
  configLabel: {
    color: '#9ca3af',
    minWidth: 100,
  },
  configValue: {
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  configValueGreen: {
    color: '#86efac',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  configValueGray: {
    color: '#9ca3af',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  // Formular-Elemente für editierbare Konfig (Architekt-Entscheid S-143)
  configFormRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  configFormLabel: {
    color: '#9ca3af',
    fontSize: 13,
    minWidth: 150,
  },
  configInput: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '4px 8px',
    minHeight: 32,
    flex: 1,
    minWidth: 180,
    outline: 'none',
    fontFamily: 'monospace',
  },
  configSelect: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '4px 8px',
    minHeight: 32,
    outline: 'none',
  },
  saveButton: {
    background: '#166534',
    border: 'none',
    borderRadius: 4,
    color: '#bbf7d0',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    padding: '8px 18px',
  },
  configErrorMsg: {
    color: '#fca5a5',
    fontSize: 13,
    margin: '6px 0 0',
  },
  configSuccessMsg: {
    color: '#86efac',
    fontSize: 13,
    margin: '6px 0 0',
  },
};
