/**
 * SettingsView.jsx — Settings-Ansicht mit Credential-Formularen.
 *
 * AC1  — Je Integrations-Sektion: Credential-Felder mit Status (gesetzt/nicht gesetzt),
 *         maskierte Anzeige; kein Klartext.
 * AC2  — Setzen/Überschreiben eines Credentials via PUT; nach Speichern kein Klartext angezeigt.
 * AC3  — Löschen eines gesetzten Credentials via DELETE; Status wechselt auf „nicht gesetzt".
 * AC4  — Kein API-Endpunkt liefert Klartext; Frontend zeigt Klartext nach Speichern nicht erneut.
 * AC5  — „Weitere Credentials" (misc) als benannte Schlüssel/Wert-Einträge.
 * AC6  — Rückkehr zum Panel möglich.
 * AC8  — Eingabe-Validierung im Frontend (Pflichtfeld, Längenlimit) + klare Fehlermeldung.
 *
 * A11y: WCAG 2.1 AA — Überschriften-Struktur, sichtbarer Fokus, Touch-Target ≥ 44 px,
 *       Kontrast ≥ 4.5:1, Fehler programmatisch zugeordnet (aria-describedby).
 *
 * Security (Floor):
 *   - Kein Secret im Frontend-Bundle.
 *   - Klartext-Werte werden nach erfolgreichem Speichern sofort verworfen (nur State).
 *   - Kein Klartext-Wert in irgendwelchen Logs oder Konsolen-Ausgaben.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Konstanten ────────────────────────────────────────────────────────────────

/** Maximale Länge eines Credential-Werts (muss mit Backend-Limit übereinstimmen). */
const MAX_VALUE_LEN = 65536;

/** Maximale Länge eines misc-Schlüsselnamens. */
const MAX_MISC_NAME_LEN = 128;

/** Bekannte Felder je Integration (muss mit CREDENTIAL_CATALOG im Backend übereinstimmen). */
const KNOWN_FIELDS = {
  github: [
    { name: 'app_id', label: 'App-ID' },
    { name: 'installation_id', label: 'Installation-ID' },
    { name: 'private_key', label: 'Private Key' },
  ],
  cloudflare: [
    { name: 'api_token', label: 'API-Token' },
    { name: 'account_id', label: 'Account-ID' },
  ],
  vps: [
    { name: 'hetzner_api_token', label: 'Hetzner API-Token' },
  ],
};

// ── API-Helfer ────────────────────────────────────────────────────────────────

async function fetchCredentials() {
  const res = await fetch('/api/settings/credentials');
  if (!res.ok) throw new Error(`Laden fehlgeschlagen (${res.status})`);
  return res.json();
}

async function putCredential(integration, name, value) {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(integration)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

async function deleteCredential(integration, name) {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(integration)}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Löschen fehlgeschlagen (${res.status})`);
  return data;
}

// ── CredentialField ───────────────────────────────────────────────────────────

/**
 * Formular-Zeile für ein einzelnes Credential-Feld.
 *
 * @param {{
 *   integration: string,
 *   name: string,
 *   label: string,
 *   meta: { status: string, masked?: string, updatedAt?: string } | undefined,
 *   onSaved: () => void,
 * }} props
 */
function CredentialField({ integration, name, label, meta, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const errorId = `err-${integration}-${name}`;

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
      await putCredential(integration, name, trimmed);
      // AC4/AC2: Klartext sofort verwerfen nach Speichern
      setInputVal('');
      setEditing(false);
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
      await deleteCredential(integration, name);
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
          <input
            id={`input-${integration}-${name}`}
            ref={inputRef}
            type="password"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder={isSet ? 'Neuen Wert eingeben (überschreibt bestehenden)' : 'Wert eingeben'}
            style={fieldStyles.input}
            aria-describedby={error ? errorId : undefined}
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
    </div>
  );
}

// ── MiscSection ───────────────────────────────────────────────────────────────

/**
 * Sektion für generische „weitere Credentials" (misc).
 *
 * @param {{ miscItems: Array, onSaved: () => void }} props
 */
function MiscSection({ miscItems, onSaved }) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const keyInputRef = useRef(null);

  useEffect(() => {
    if (adding && keyInputRef.current) {
      keyInputRef.current.focus();
    }
  }, [adding]);

  const handleAdd = useCallback(async () => {
    setError(null);
    const trimKey = newKey.trim();
    const trimVal = newVal.trim();
    if (!trimKey) {
      setError('Schlüsselname ist ein Pflichtfeld.');
      keyInputRef.current?.focus();
      return;
    }
    if (trimKey.length > MAX_MISC_NAME_LEN) {
      setError(`Schlüsselname überschreitet Limit (${MAX_MISC_NAME_LEN} Zeichen).`);
      keyInputRef.current?.focus();
      return;
    }
    if (!trimVal) {
      setError('Wert ist ein Pflichtfeld.');
      return;
    }
    if (trimVal.length > MAX_VALUE_LEN) {
      setError(`Wert überschreitet das Längenlimit (${MAX_VALUE_LEN} Zeichen).`);
      return;
    }

    setSaving(true);
    try {
      await putCredential('misc', trimKey, trimVal);
      setNewKey('');
      setNewVal('');
      setAdding(false);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [newKey, newVal, onSaved]);

  return (
    <div>
      {miscItems.map((item) => (
        <CredentialField
          key={item.name}
          integration="misc"
          name={item.name}
          label={item.name}
          meta={item}
          onSaved={onSaved}
        />
      ))}

      {adding ? (
        <div style={fieldStyles.editArea}>
          <label htmlFor="misc-new-key" style={fieldStyles.fieldLabel}>
            Schlüsselname
          </label>
          <input
            id="misc-new-key"
            ref={keyInputRef}
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="z.B. openai-api-key"
            style={fieldStyles.input}
            autoComplete="off"
            aria-describedby={error ? 'misc-add-error' : undefined}
          />
          <label htmlFor="misc-new-val" style={fieldStyles.fieldLabel}>
            Wert
          </label>
          <input
            id="misc-new-val"
            type="password"
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            placeholder="Geheimwert"
            style={fieldStyles.input}
            autoComplete="off"
            data-lpignore="true"
            aria-describedby={error ? 'misc-add-error' : undefined}
          />
          {error && (
            <p id="misc-add-error" style={fieldStyles.error} role="alert" aria-live="polite">
              {error}
            </p>
          )}
          <div style={fieldStyles.actionRow}>
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving}
              style={fieldStyles.btnPrimary}
              aria-busy={saving}
            >
              {saving ? 'Speichern…' : 'Hinzufügen'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewKey(''); setNewVal(''); setError(null); }}
              disabled={saving}
              style={fieldStyles.btnSecondary}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={fieldStyles.btnSmall}
          aria-label="Weiteres Credential hinzufügen"
        >
          + Weiteres Credential
        </button>
      )}
    </div>
  );
}

// ── SettingsView ──────────────────────────────────────────────────────────────

export function SettingsView({ onNavigate }) {
  const [credentials, setCredentials] = useState([]);
  const [loadState, setLoadState] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const data = await fetchCredentials();
      setCredentials(data);
      setLoadState('ok');
    } catch (err) {
      setLoadError(err.message);
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Hilfsfunktion: Metadaten eines bestimmten Felds aus der Liste. */
  const getMeta = useCallback((integration, name) => {
    return credentials.find((c) => c.integration === integration && c.name === name);
  }, [credentials]);

  const miscItems = credentials.filter((c) => c.integration === 'misc');

  return (
    <main style={styles.view} aria-label="Einstellungen-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Einstellungen</h1>

        {loadState === 'error' && (
          <p style={styles.loadError} role="alert" aria-live="polite">
            Credentials konnten nicht geladen werden: {loadError}
          </p>
        )}

        {/* GitHub */}
        <section aria-labelledby="settings-section-github" style={styles.section}>
          <h2 id="settings-section-github" style={styles.sectionHeading}>GitHub</h2>
          <p style={styles.sectionDesc}>GitHub-App-Credentials, Token und Organisations-Zugang.</p>
          {KNOWN_FIELDS.github.map(({ name, label }) => (
            <CredentialField
              key={name}
              integration="github"
              name={name}
              label={label}
              meta={getMeta('github', name)}
              onSaved={load}
            />
          ))}
        </section>

        {/* Cloudflare */}
        <section aria-labelledby="settings-section-cloudflare" style={styles.section}>
          <h2 id="settings-section-cloudflare" style={styles.sectionHeading}>Cloudflare</h2>
          <p style={styles.sectionDesc}>API-Token für Tunnel, Access und DNS-Verwaltung.</p>
          {KNOWN_FIELDS.cloudflare.map(({ name, label }) => (
            <CredentialField
              key={name}
              integration="cloudflare"
              name={name}
              label={label}
              meta={getMeta('cloudflare', name)}
              onSaved={load}
            />
          ))}
        </section>

        {/* Hetzner / VPS */}
        <section aria-labelledby="settings-section-hetzner" style={styles.section}>
          <h2 id="settings-section-hetzner" style={styles.sectionHeading}>Hetzner / VPS</h2>
          <p style={styles.sectionDesc}>Hetzner-API-Key und VPS-Konfiguration für Provisionierung.</p>
          {KNOWN_FIELDS.vps.map(({ name, label }) => (
            <CredentialField
              key={name}
              integration="vps"
              name={name}
              label={label}
              meta={getMeta('vps', name)}
              onSaved={load}
            />
          ))}
        </section>

        {/* Weitere Credentials (misc) */}
        <section aria-labelledby="settings-section-misc" style={styles.section}>
          <h2 id="settings-section-misc" style={styles.sectionHeading}>Weitere Credentials</h2>
          <p style={styles.sectionDesc}>Generische Schlüssel/Wert-Einträge für weitere Integrationen.</p>
          <MiscSection miscItems={miscItems} onSaved={load} />
        </section>

        {/* SSH-Keys — Platzhalter (folgt in #46) */}
        <section aria-labelledby="settings-section-ssh-keys" style={styles.section}>
          <h2 id="settings-section-ssh-keys" style={styles.sectionHeading}>SSH-Keys</h2>
          <p style={styles.sectionDesc}>Öffentliche und private SSH-Schlüssel für VPS-Zugang.</p>
          <div style={styles.placeholder} aria-label="SSH-Keys — folgt">
            <span style={styles.placeholderText}>folgt</span>
          </div>
        </section>

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
    margin: '0 0 16px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  loadError: {
    padding: '12px 16px',
    marginBottom: 24,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 14,
  },
  placeholder: {
    padding: '12px 16px',
    background: '#1a1a1a',
    border: '1px dashed #3a3a3a',
    borderRadius: 4,
  },
  placeholderText: {
    fontSize: 13,
    color: '#9ca3af',
    fontStyle: 'italic',
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

const fieldStyles = {
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
