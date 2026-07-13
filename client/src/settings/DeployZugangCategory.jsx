/**
 * DeployZugangCategory.jsx — Settings-Kategorie „Deploy-Zugang" (F-072, S-333).
 *
 * Hinterlegt den UNBEAUFSICHTIGTEN Bitwarden-Zugang (Variante B), mit dem dev-gui
 * beim Deployment fremder Apps deren per-App-GPG-Passphrase aus Bitwarden liest
 * (Item `deploy-gpg-<app>`) und als GPG_PASSPHRASE in den Ziel-Container injiziert.
 *
 * Alle Felder sind WRITE-ONLY (Spec AC6): der Status zeigt nur „gesetzt/nicht
 * gesetzt", nie den Wert; Klartext wird nach dem Speichern sofort verworfen.
 * „Zugang prüfen" (AC7) macht einen Probe-Login+Unlock und zeigt das Ergebnis.
 *
 * Self-contained: lädt seinen Status selbst (fetchDeployAccessStatus) — SettingsView
 * reicht nur fetchFn durch.
 *
 * Props:
 *   - fetchFn: typeof fetch (optional; Default globalThis.fetch)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fieldStyles } from '../CredentialField.jsx';
import {
  DEPLOY_ACCESS_FIELDS,
  fetchDeployAccessStatus,
  putDeployAccessField,
  deleteDeployAccessField,
  validateDeployAccess,
} from '../settingsApi.js';

const styles = {
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: { margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#e5e7eb' },
  sectionDesc: { margin: '0 0 16px', fontSize: 13, color: '#9ca3af', lineHeight: 1.5 },
  loadError: {
    padding: '12px 16px', marginBottom: 16, background: '#2d0f0f',
    border: '1px solid #7f1d1d', borderRadius: 4, color: '#fca5a5', fontSize: 14,
  },
  readyRow: { margin: '0 0 16px', fontSize: 13, fontWeight: 600 },
  ready: { color: '#86efac' },
  notReady: { color: '#fbbf24' },
  validateRow: { marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 },
  btnValidate: {
    padding: '10px 20px', background: '#1d4ed8', color: '#fff', border: 'none',
    borderRadius: 4, fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
    alignSelf: 'flex-start',
  },
  validateOk: { color: '#86efac', fontSize: 13, fontWeight: 600 },
  validateErr: { color: '#fca5a5', fontSize: 13, fontWeight: 600 },
  hint: { margin: '2px 0 0', fontSize: 12, color: '#9ca3af', fontStyle: 'italic' },
  help: { margin: '4px 0 8px', fontSize: 12, color: '#9ca3af' },
  helpSummary: { cursor: 'pointer', color: '#93c5fd', fontWeight: 600, userSelect: 'none' },
  helpBody: { margin: '6px 0 0 0', paddingLeft: 18, lineHeight: 1.6 },
};

/** Fundort-Hilfe je Feld — wo der Wert im Bitwarden-Konto zu finden ist. */
const FIELD_HELP = {
  server_url: [
    'Bitwarden-App oder Browser-Erweiterung öffnen: auf dem Login-Bildschirm steht „Anmelden bei: …".',
    'Steht dort bitwarden.com → Feld leer lassen (Standard).',
    'Steht dort bitwarden.eu → https://vault.bitwarden.eu eintragen.',
    'Eigener Server (self-hosted) → dessen Adresse eintragen.',
  ],
  client_id: [
    'Web-Tresor öffnen (https://vault.bitwarden.com) und anmelden.',
    'Oben rechts Profil-Symbol → Kontoeinstellungen → Sicherheit → Reiter „Schlüssel".',
    '„API-Schlüssel anzeigen" klicken (Master-Passwort nötig).',
    'Den Wert client_id komplett kopieren — er beginnt mit „user.".',
  ],
  client_secret: [
    'Steht im selben Fenster wie die Client-ID (Web-Tresor → Kontoeinstellungen → Sicherheit → Schlüssel → „API-Schlüssel anzeigen").',
    'Den zweiten Wert client_secret komplett kopieren.',
  ],
  master_password: [
    'Das normale Master-Passwort des Bitwarden-Kontos — dasselbe, mit dem du dich in der App anmeldest.',
  ],
};

/** Ein write-only Zugangs-Feld. */
function DeployAccessField({ field, label, optional, placeholder, meta, fetchFn, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const errorId = `err-deploy-${field}`;
  const isSet = meta?.set === true;
  const isServerUrl = field === 'server_url';

  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  const handleSave = useCallback(async () => {
    setError(null);
    const trimmed = inputVal.trim();
    if (!trimmed) { setError('Wert darf nicht leer sein.'); inputRef.current?.focus(); return; }
    setSaving(true);
    try {
      await putDeployAccessField(field, trimmed, fetchFn);
      setInputVal(''); // Klartext sofort verwerfen (AC6)
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err.message);
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [field, inputVal, fetchFn, onSaved]);

  const handleDelete = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      await deleteDeployAccessField(field, fetchFn);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [field, fetchFn, onSaved]);

  const handleCancel = useCallback(() => { setInputVal(''); setError(null); setEditing(false); }, []);

  return (
    <div style={fieldStyles.row} role="group" aria-label={label}>
      <div style={fieldStyles.labelRow}>
        <span style={fieldStyles.fieldLabel}>
          {label}{optional && <span style={{ fontWeight: 400, color: '#6b7280' }}> (optional)</span>}
        </span>
        <span
          style={isSet ? fieldStyles.statusSet : fieldStyles.statusUnset}
          aria-label={isSet ? 'gesetzt' : 'nicht gesetzt'}
        >
          {isSet ? '•••• gesetzt' : 'nicht gesetzt'}
        </span>
      </div>

      {FIELD_HELP[field] && (
        <details style={styles.help}>
          <summary style={styles.helpSummary}>Wo finde ich das?</summary>
          <ul style={styles.helpBody}>
            {FIELD_HELP[field].map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </details>
      )}

      {editing ? (
        <div style={fieldStyles.editArea}>
          <label htmlFor={`input-deploy-${field}`} style={fieldStyles.srOnly}>{label} — neuer Wert</label>
          <input
            id={`input-deploy-${field}`}
            ref={inputRef}
            type={isServerUrl ? 'text' : 'password'}
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder={placeholder ?? (isSet ? 'Neuen Wert eingeben (überschreibt bestehenden)' : 'Wert eingeben')}
            style={fieldStyles.input}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? 'true' : undefined}
            autoComplete="off"
            data-lpignore="true"
          />
          {error && <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">{error}</p>}
          <div style={fieldStyles.actionRow}>
            <button type="button" onClick={handleSave} disabled={saving} style={fieldStyles.btnPrimary} aria-busy={saving}>
              {saving ? 'Speichern…' : 'Speichern'}
            </button>
            <button type="button" onClick={handleCancel} disabled={saving} style={fieldStyles.btnSecondary}>Abbrechen</button>
          </div>
        </div>
      ) : (
        <div style={fieldStyles.actionRow}>
          <button type="button" onClick={() => setEditing(true)} style={fieldStyles.btnSmall}
            aria-label={isSet ? `${label} ändern` : `${label} setzen`}>
            {isSet ? 'Ändern' : 'Setzen'}
          </button>
          {isSet && (
            <button type="button" onClick={handleDelete} disabled={deleting} style={fieldStyles.btnDanger}
              aria-label={`${label} löschen`} aria-busy={deleting}>
              {deleting ? 'Löschen…' : 'Löschen'}
            </button>
          )}
          {error && <p style={fieldStyles.error} role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function DeployZugangCategory({ fetchFn }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null); // { ok, error? }

  const reload = useCallback(async () => {
    try {
      const s = await fetchDeployAccessStatus(fetchFn);
      setStatus(s);
      setLoadError(null);
    } catch (err) {
      setStatus(null);
      setLoadError(err.message ?? 'Unbekannter Fehler');
    }
  }, [fetchFn]);

  useEffect(() => { reload(); }, [reload]);

  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidateResult(null);
    try {
      const r = await validateDeployAccess(fetchFn);
      if (r.httpStatus === 403) setValidateResult({ ok: false, error: 'Keine Berechtigung für diese Aktion.' });
      else if (r.httpStatus === 503) setValidateResult({ ok: false, error: 'Prüf-Dienst nicht verfügbar.' });
      else setValidateResult({ ok: r.ok === true, error: r.ok ? null : (r.error ?? 'Zugang ungültig.') });
    } catch (err) {
      setValidateResult({ ok: false, error: err.message ?? 'Prüfung fehlgeschlagen.' });
    } finally {
      setValidating(false);
    }
  }, [fetchFn]);

  const ready = status?.ready === true;

  return (
    <section aria-labelledby="settings-section-deploy-zugang" style={styles.section}>
      <h2 id="settings-section-deploy-zugang" style={styles.sectionHeading}>Deploy-Zugang</h2>
      <p style={styles.sectionDesc}>
        Zum <strong>unbeaufsichtigten Deployment fremder Apps</strong>: dev-gui meldet sich mit
        diesem Bitwarden-Zugang an (API-Key, kein 2FA/OTP) und liest daraus die GPG-Passphrase
        der jeweiligen App (Item <code>deploy-gpg-&lt;app&gt;</code>), um sie beim Deploy in den
        Container zu injizieren. Der Zugang liegt lokal in einer geschützten Datei (nicht im
        verschlüsselten Store) und verlässt dev-gui nie.
      </p>

      {loadError && (
        <p style={styles.loadError} role="alert" aria-live="polite">
          Deploy-Zugang konnte nicht geladen werden: {loadError}
        </p>
      )}

      {status && (
        <>
          <p style={styles.readyRow} aria-live="polite">
            {ready
              ? <span style={styles.ready}>✓ Zugang vollständig hinterlegt</span>
              : <span style={styles.notReady}>Zugang unvollständig — Client-ID, Client-Secret und Master-Passwort nötig</span>}
          </p>

          {DEPLOY_ACCESS_FIELDS.map((f) => (
            <DeployAccessField
              key={f.name}
              field={f.name}
              label={f.label}
              optional={f.optional}
              placeholder={f.placeholder}
              meta={status.fields?.[f.name]}
              fetchFn={fetchFn}
              onSaved={reload}
            />
          ))}

          <div style={styles.validateRow}>
            <button
              type="button"
              onClick={handleValidate}
              disabled={validating || !ready}
              style={styles.btnValidate}
              aria-busy={validating}
              aria-label="Deploy-Zugang gegen Bitwarden prüfen"
            >
              {validating ? 'Prüfe…' : 'Zugang prüfen'}
            </button>
            {!ready && <p style={styles.hint}>Erst alle Pflichtfelder setzen, dann prüfen.</p>}
            {validateResult && (
              <p style={validateResult.ok ? styles.validateOk : styles.validateErr} role="alert" aria-live="polite">
                {validateResult.ok ? '✓ Zugang gültig — Login und Entsperren erfolgreich.' : `✗ ${validateResult.error}`}
              </p>
            )}
            {!status.persisted && (
              <p style={styles.hint}>
                Hinweis: CRED_STORE_DIR ist nicht gesetzt — der Zugang wird nur im Speicher gehalten (nicht dauerhaft).
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
