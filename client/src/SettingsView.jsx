/**
 * SettingsView.jsx — Settings-Ansicht mit Credential-, SSH-Key- und Workspace-Pfad-Formularen.
 *
 * Credentials (settings-credentials):
 *   AC1  — Je Integrations-Sektion: Credential-Felder mit Status (gesetzt/nicht gesetzt),
 *           maskierte Anzeige; kein Klartext.
 *   AC2  — Setzen/Überschreiben eines Credentials via PUT; nach Speichern kein Klartext angezeigt.
 *   AC3  — Löschen eines gesetzten Credentials via DELETE; Status wechselt auf „nicht gesetzt".
 *   AC4  — Kein API-Endpunkt liefert Klartext; Frontend zeigt Klartext nach Speichern nicht erneut.
 *   AC5  — „Weitere Credentials" (misc) als benannte Schlüssel/Wert-Einträge.
 *   AC6  — Rückkehr zum Panel möglich.
 *   AC8  — Eingabe-Validierung im Frontend (Pflichtfeld, Längenlimit) + klare Fehlermeldung.
 *
 * workspace-path-config (AC1 + UI-Anteil AC3 — #92):
 *   WS-AC1  — Eintrag „Workspace-Pfad" in der GitHub-Sektion (unter den GitHub-App-Credentials):
 *             zeigt wirksamen Pfad inkl. Quelle (konfiguriert / Env-Default);
 *             erlaubt setzen/ändern (PUT) und zurücksetzen (DELETE).
 *   WS-AC3  — 4xx/422 → feldzugeordnete Fehlermeldung (role=alert); alter Wert bleibt sichtbar.
 *   A11y    — label/htmlFor, aria-describedby, role=status/alert, aria-busy,
 *             Touch-Target ≥44px, Fokusführung via activeElement, Kontrast #9ca3af.
 *
 * SSH-Keys (settings-ssh-keys Stufe A + B):
 *   SSH-AC1  — Je Benutzer-Label: Public-Key hinterlegen/anzeigen/ändern (vollständig sichtbar).
 *   SSH-AC2  — Private-Key setzen/überschreiben: write-only/maskiert, niemals im Klartext angezeigt.
 *   SSH-AC3  — Public- und/oder Private-Key löschen; danach Status „nicht gesetzt".
 *   SSH-AC4  — Public-Key-Format-Validierung im Frontend (OpenSSH); klare Fehlermeldung.
 *   SSH-AC5  — Aktionen auditiert; Private-Key-Klartext nie im Frontend-Bundle/Log.
 *   SSH-AC6  — Endpunkte hinter Access-Mauer; mutierende identitäts-/rollengeschützt.
 *   SSH-AC7  — Provision-Button je Benutzer: Public-Key idempotent in authorized_keys eintragen.
 *   SSH-AC8  — Wiederholte Provisionierung idempotent (Backend-Garantie, UI zeigt 'already-present').
 *   SSH-AC9  — Provision-Ergebnis (added/already-present/error) ohne Geheim-Leak angezeigt.
 *   SSH-AC10 — Provision-Aktion nur berechtigter Identität zugänglich (403 sonst).
 *
 * A11y: WCAG 2.1 AA — Überschriften-Struktur, sichtbarer Fokus, Touch-Target ≥ 44 px,
 *       Kontrast ≥ 4.5:1, Fehler programmatisch zugeordnet (aria-describedby).
 *
 * Security (Floor):
 *   - Kein Secret im Frontend-Bundle.
 *   - Private-Key-Klartext wird nach erfolgreichem Speichern sofort verworfen (nur State).
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
    { name: 'ionos_api_token', label: 'IONOS API-Token' },
    { name: 'hostinger_api_token', label: 'Hostinger API-Token' },
  ],
};

/**
 * Gültige OpenSSH-Public-Key-Typen (Frontend-Validierung, sync mit Backend).
 * AC4: verhindert das Absenden offensichtlich ungültiger Formate.
 */
const SSH_PUBKEY_PREFIXES = [
  'ssh-rsa ',
  'ssh-dss ',
  'ssh-ed25519 ',
  'ecdsa-sha2-nistp256 ',
  'ecdsa-sha2-nistp384 ',
  'ecdsa-sha2-nistp521 ',
  'sk-ssh-ed25519@openssh.com ',
  'sk-ecdsa-sha2-nistp256@openssh.com ',
];

/**
 * Prüft ob ein String ein erkennbares OpenSSH-Public-Key-Format hat (AC4).
 * @param {string} key
 * @returns {{ ok: boolean, error?: string }}
 */
function validatePublicKeyFormat(key) {
  const trimmed = (key ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Public-Key darf nicht leer sein.' };
  // I1: Newline-Injection-Vorsorge (authorized_keys)
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: 'Public-Key darf keine Zeilenumbrüche enthalten.' };
  }
  const isKnown = SSH_PUBKEY_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!isKnown) {
    return { ok: false, error: 'Unbekanntes Public-Key-Format. Erwartet: OpenSSH-Format (z.B. ssh-ed25519 …).' };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts[1].length < 20) {
    return { ok: false, error: 'Public-Key unvollständig (fehlender Base64-Teil).' };
  }
  return { ok: true };
}

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

// ── Workspace-Path-API-Helfer ─────────────────────────────────────────────────

/**
 * GET /api/settings/workspace-path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effectivePath: string|null, source: "configured"|"env-default", mountRoot: string }>}
 */
async function fetchWorkspacePath(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/workspace-path');
  if (!res.ok) throw new Error(`Workspace-Pfad laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * PUT /api/settings/workspace-path
 * @param {string} path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effectivePath: string, source: "configured" }>}
 */
async function putWorkspacePath(path, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/workspace-path', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * DELETE /api/settings/workspace-path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effectivePath: string|null, source: "env-default" }>}
 */
async function deleteWorkspacePath(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/workspace-path', { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Zurücksetzen fehlgeschlagen (${res.status})`);
  return data;
}

// ── SSH-Key-API-Helfer ────────────────────────────────────────────────────────

async function fetchSshKeys() {
  const res = await fetch('/api/settings/ssh-keys');
  if (!res.ok) throw new Error(`SSH-Keys laden fehlgeschlagen (${res.status})`);
  return res.json();
}

async function putSshKey(user, body) {
  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

async function deleteSshKey(user, target = 'both') {
  const res = await fetch(
    `/api/settings/ssh-keys/${encodeURIComponent(user)}?target=${encodeURIComponent(target)}`,
    { method: 'DELETE' },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Löschen fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * Provisioniert den Public-Key eines Benutzers auf einem VPS-Ziel (AC7–AC9).
 * Body: { host, port?, targetUser, hostFingerprint? }
 *
 * @returns {Promise<{ result: 'added'|'already-present'|'error', reason?: string, hostKeyHash?: string }>}
 */
async function provisionSshKey(user, { host, port, targetUser, hostFingerprint }) {
  const body = { host, targetUser };
  if (port !== undefined && port !== '') body.port = Number(port);
  if (hostFingerprint && hostFingerprint.trim()) body.hostFingerprint = hostFingerprint.trim();

  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // Für Provision: HTTP-Fehler geben result:'error' + reason zurück — immer JSON
  return { ...data, httpStatus: res.status };
}

// ── WorkspacePathSection ──────────────────────────────────────────────────────

/**
 * Sektion „Workspace-Pfad" — zeigt den wirksamen Workspace-Root inkl. Quelle und erlaubt
 * setzen/ändern (PUT) und zurücksetzen (DELETE) auf den Env-Default.
 * Platziert in der GitHub-Sektion der Einstellungen, unter den GitHub-App-Credentials.
 *
 * WS-AC1: Anzeige wirksamer Pfad + Quelle; Setzen/Ändern/Zurücksetzen.
 * WS-AC3 (UI): 4xx/422 → feldzugeordnete Fehlermeldung; alter Wert bleibt sichtbar.
 * A11y: label/htmlFor, aria-describedby, role=status/alert, aria-busy, Fokusführung.
 *
 * @param {{
 *   effectivePath: string|null,
 *   source: "configured"|"env-default",
 *   mountRoot: string,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 * }} props
 */
function WorkspacePathSection({ effectivePath, source, mountRoot, onReload, fetchFn }) {
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

// ── ProvisionForm ─────────────────────────────────────────────────────────────

/**
 * Formular zum Auslösen einer VPS-Provisionierung (AC7–AC9).
 * Felder: host (Pflicht), port (optional), targetUser (Pflicht), hostFingerprint (optional).
 * Ergebnis wird angezeigt ohne Geheim-Leak.
 *
 * @param {{
 *   user: string,
 *   onClose: () => void,
 * }} props
 */
function ProvisionForm({ user, onClose }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [targetUser, setTargetUser] = useState('');
  const [hostFingerprint, setHostFingerprint] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult] = useState(null); // { result, reason?, hostKeyHash? }
  const [error, setError] = useState(null);
  const hostInputRef = useRef(null);
  const errorId = `provision-err-${user}`;
  const resultId = `provision-result-${user}`;

  useEffect(() => {
    if (hostInputRef.current) hostInputRef.current.focus();
  }, []);

  const handleProvision = useCallback(async () => {
    setError(null);
    setResult(null);

    // Frontend-Validierung
    const trimHost = host.trim();
    const trimTargetUser = targetUser.trim();
    const trimPort = port.trim();

    if (!trimHost) {
      setError('Host ist ein Pflichtfeld.');
      hostInputRef.current?.focus();
      return;
    }
    if (!trimTargetUser) {
      setError('Ziel-Benutzer ist ein Pflichtfeld.');
      return;
    }
    if (trimPort !== '') {
      const p = Number(trimPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        setError('Port muss eine ganze Zahl zwischen 1 und 65535 sein.');
        return;
      }
    }

    setProvisioning(true);
    try {
      const res = await provisionSshKey(user, {
        host: trimHost,
        port: trimPort !== '' ? trimPort : undefined,
        targetUser: trimTargetUser,
        hostFingerprint: hostFingerprint.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      // Netzwerkfehler (fetch selbst gescheitert)
      setError(err.message ?? 'Provisionierung fehlgeschlagen');
    } finally {
      setProvisioning(false);
    }
  }, [user, host, port, targetUser, hostFingerprint]);

  const isSuccess = result?.result === 'added' || result?.result === 'already-present';
  const isAlreadyPresent = result?.result === 'already-present';
  const isFailed = result?.result === 'error';

  return (
    <div style={provisionStyles.form} role="region" aria-label={`VPS-Provisionierung für ${user}`}>
      <h4 style={provisionStyles.heading}>VPS-Provisionierung für <code>{user}</code></h4>
      <p style={provisionStyles.hint}>
        Trägt den hinterlegten Public-Key in <code>authorized_keys</code> des Ziel-Benutzers ein.
      </p>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`prov-host-${user}`} style={provisionStyles.label}>
          Host <span aria-hidden="true" style={provisionStyles.required}>*</span>
        </label>
        <input
          id={`prov-host-${user}`}
          ref={hostInputRef}
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="z.B. 1.2.3.4 oder vps.example.com"
          style={fieldStyles.input}
          aria-required="true"
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={provisioning}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`prov-port-${user}`} style={provisionStyles.label}>
          Port <span style={provisionStyles.optional}>(optional, Default: 22)</span>
        </label>
        <input
          id={`prov-port-${user}`}
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="22"
          style={{ ...fieldStyles.input, width: 120 }}
          min="1"
          max="65535"
          aria-describedby={error ? errorId : undefined}
          disabled={provisioning}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`prov-user-${user}`} style={provisionStyles.label}>
          Ziel-Benutzer <span aria-hidden="true" style={provisionStyles.required}>*</span>
        </label>
        <input
          id={`prov-user-${user}`}
          type="text"
          value={targetUser}
          onChange={(e) => setTargetUser(e.target.value)}
          placeholder="z.B. root oder alex"
          style={fieldStyles.input}
          aria-required="true"
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={provisioning}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`prov-fp-${user}`} style={provisionStyles.label}>
          Host-Key-Fingerprint <span style={provisionStyles.optional}>(optional, SHA256-Base64)</span>
        </label>
        <input
          id={`prov-fp-${user}`}
          type="text"
          value={hostFingerprint}
          onChange={(e) => setHostFingerprint(e.target.value)}
          placeholder="Ohne 'SHA256:' Prefix — leer lassen für TOFU"
          style={fieldStyles.input}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={provisioning}
        />
      </div>

      {error && (
        <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">
          {error}
        </p>
      )}

      {result && (
        <div
          id={resultId}
          style={isSuccess ? provisionStyles.resultSuccess : provisionStyles.resultError}
          role="status"
          aria-live="polite"
        >
          {isSuccess && (
            <span>
              {isAlreadyPresent
                ? 'Key war bereits vorhanden (idempotent).'
                : 'Key erfolgreich eingetragen.'}
              {result.hostKeyHash && (
                <span style={provisionStyles.hostKeyNote}>
                  {' '}Host-Key-Fingerprint: <code>{result.hostKeyHash}</code>
                </span>
              )}
            </span>
          )}
          {isFailed && (
            <span>
              Fehlgeschlagen: {result.reason ?? result.error ?? 'unbekannter Fehler'}
            </span>
          )}
        </div>
      )}

      <div style={{ ...fieldStyles.actionRow, marginTop: 12 }}>
        <button
          type="button"
          onClick={handleProvision}
          disabled={provisioning}
          style={fieldStyles.btnPrimary}
          aria-busy={provisioning}
        >
          {provisioning ? 'Provisioniere…' : 'Jetzt provisionieren'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={provisioning}
          style={fieldStyles.btnSecondary}
        >
          Schliessen
        </button>
      </div>
    </div>
  );
}

// ── SshKeyEntry ───────────────────────────────────────────────────────────────

/**
 * Zeile für einen einzelnen SSH-Benutzer (Public-Key + Private-Key).
 * Public-Key darf vollständig angezeigt werden (nicht geheim).
 * Private-Key ist write-only/maskiert — niemals im Klartext.
 *
 * @param {{
 *   entry: { user: string, publicKey?: string, privateKeyStatus: 'set'|'unset' },
 *   onSaved: () => void,
 * }} props
 */
function SshKeyEntry({ entry, onSaved }) {
  const { user } = entry;
  const [editingPub, setEditingPub] = useState(false);
  const [editingPriv, setEditingPriv] = useState(false);
  const [showProvision, setShowProvision] = useState(false);
  const [pubInput, setPubInput] = useState('');
  const [privInput, setPrivInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const pubInputRef = useRef(null);
  const privInputRef = useRef(null);
  const errorId = `ssh-err-${user}`;

  const hasPubKey = !!entry.publicKey;
  const hasPrivKey = entry.privateKeyStatus === 'set';

  useEffect(() => {
    if (editingPub && pubInputRef.current) pubInputRef.current.focus();
  }, [editingPub]);

  useEffect(() => {
    if (editingPriv && privInputRef.current) privInputRef.current.focus();
  }, [editingPriv]);

  const handleSavePub = useCallback(async () => {
    setError(null);
    // AC4: Frontend-Validierung Public-Key-Format
    const trimmed = pubInput.trim();
    const validation = validatePublicKeyFormat(trimmed);
    if (!validation.ok) {
      setError(validation.error);
      pubInputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await putSshKey(user, { publicKey: trimmed });
      setPubInput('');
      setEditingPub(false);
      onSaved();
    } catch (err) {
      setError(err.message);
      pubInputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [user, pubInput, onSaved]);

  const handleSavePriv = useCallback(async () => {
    setError(null);
    const trimmed = privInput.trim();
    if (!trimmed) {
      setError('Private-Key darf nicht leer sein.');
      privInputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await putSshKey(user, { privateKey: trimmed });
      // AC2: Private-Key-Klartext sofort verwerfen nach Speichern
      setPrivInput('');
      setEditingPriv(false);
      onSaved();
    } catch (err) {
      setError(err.message);
      privInputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [user, privInput, onSaved]);

  const handleDeletePub = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      await deleteSshKey(user, 'public');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [user, onSaved]);

  const handleDeletePriv = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      await deleteSshKey(user, 'private');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [user, onSaved]);

  const handleDeleteAll = useCallback(async () => {
    setError(null);
    setDeleting(true);
    try {
      await deleteSshKey(user, 'both');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }, [user, onSaved]);

  return (
    <div style={fieldStyles.row} role="group" aria-label={`SSH-Schlüssel für ${user}`}>
      {/* Benutzer-Label */}
      <div style={sshStyles.userHeader}>
        <span style={sshStyles.userLabel}>{user}</span>
        <div style={fieldStyles.actionRow}>
          {/* AC7: Provision-Button — nur aktiv wenn Public-Key vorhanden */}
          <button
            type="button"
            onClick={() => setShowProvision((v) => !v)}
            disabled={!hasPubKey || deleting}
            style={hasPubKey ? fieldStyles.btnSmall : { ...fieldStyles.btnSmall, opacity: 0.45, cursor: 'not-allowed' }}
            aria-label={`Public-Key von ${user} auf VPS provisionieren`}
            aria-expanded={showProvision}
            title={hasPubKey ? 'Public-Key auf VPS eintragen' : 'Kein Public-Key hinterlegt'}
          >
            {showProvision ? 'Provision schliessen' : 'Provisionieren'}
          </button>
          <button
            type="button"
            onClick={handleDeleteAll}
            disabled={deleting || (!hasPubKey && !hasPrivKey)}
            style={fieldStyles.btnDanger}
            aria-label={`Alle SSH-Schlüssel für ${user} löschen`}
            aria-busy={deleting}
          >
            {deleting ? 'Löschen…' : 'Alle löschen'}
          </button>
        </div>
      </div>

      {/* Fehler-Anzeige */}
      {error && (
        <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">
          {error}
        </p>
      )}

      {/* AC7–AC9: VPS-Provision-Formular (ausgeklappt) */}
      {showProvision && hasPubKey && (
        <ProvisionForm
          user={user}
          onClose={() => setShowProvision(false)}
        />
      )}

      {/* Public-Key */}
      <div style={sshStyles.keyRow}>
        <div style={sshStyles.keyLabel}>
          <span style={fieldStyles.fieldLabel}>Public-Key</span>
          {hasPubKey ? (
            <span style={fieldStyles.statusSet} aria-label="Public-Key gesetzt">gesetzt</span>
          ) : (
            <span style={fieldStyles.statusUnset} aria-label="Public-Key nicht gesetzt">nicht gesetzt</span>
          )}
        </div>

        {/* Public-Key-Anzeige (darf vollständig angezeigt werden) */}
        {hasPubKey && !editingPub && (
          <pre style={sshStyles.pubKeyDisplay} aria-label={`Public-Key von ${user}`}>
            {entry.publicKey}
          </pre>
        )}

        {editingPub ? (
          <div style={fieldStyles.editArea}>
            <label htmlFor={`ssh-pub-${user}`} style={fieldStyles.srOnly}>
              Public-Key für {user} (OpenSSH-Format)
            </label>
            <textarea
              id={`ssh-pub-${user}`}
              ref={pubInputRef}
              value={pubInput}
              onChange={(e) => setPubInput(e.target.value)}
              placeholder="ssh-ed25519 AAAA… oder ssh-rsa AAAA…"
              style={sshStyles.textarea}
              aria-describedby={error ? errorId : undefined}
              autoComplete="off"
              rows={3}
            />
            <div style={fieldStyles.actionRow}>
              <button
                type="button"
                onClick={handleSavePub}
                disabled={saving}
                style={fieldStyles.btnPrimary}
                aria-busy={saving}
              >
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={() => { setPubInput(''); setError(null); setEditingPub(false); }}
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
              onClick={() => setEditingPub(true)}
              style={fieldStyles.btnSmall}
              aria-label={hasPubKey ? `Public-Key von ${user} ändern` : `Public-Key für ${user} setzen`}
            >
              {hasPubKey ? 'Ändern' : 'Setzen'}
            </button>
            {hasPubKey && (
              <button
                type="button"
                onClick={handleDeletePub}
                disabled={deleting}
                style={fieldStyles.btnDanger}
                aria-label={`Public-Key von ${user} löschen`}
                aria-busy={deleting}
              >
                {deleting ? 'Löschen…' : 'Löschen'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Private-Key (write-only / maskiert) */}
      <div style={sshStyles.keyRow}>
        <div style={sshStyles.keyLabel}>
          <span style={fieldStyles.fieldLabel}>Private-Key</span>
          {hasPrivKey ? (
            <span style={fieldStyles.statusSet} aria-label="Private-Key gesetzt">•••• gesetzt</span>
          ) : (
            <span style={fieldStyles.statusUnset} aria-label="Private-Key nicht gesetzt">nicht gesetzt</span>
          )}
        </div>

        {editingPriv ? (
          <div style={fieldStyles.editArea}>
            <label htmlFor={`ssh-priv-${user}`} style={fieldStyles.srOnly}>
              Private-Key für {user} (PEM-Format)
            </label>
            <textarea
              id={`ssh-priv-${user}`}
              ref={privInputRef}
              value={privInput}
              onChange={(e) => setPrivInput(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              style={sshStyles.textareaSecret}
              aria-describedby={error ? errorId : undefined}
              autoComplete="off"
              data-lpignore="true"
              rows={5}
            />
            <div style={fieldStyles.actionRow}>
              <button
                type="button"
                onClick={handleSavePriv}
                disabled={saving}
                style={fieldStyles.btnPrimary}
                aria-busy={saving}
              >
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={() => { setPrivInput(''); setError(null); setEditingPriv(false); }}
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
              onClick={() => setEditingPriv(true)}
              style={fieldStyles.btnSmall}
              aria-label={hasPrivKey ? `Private-Key von ${user} ändern` : `Private-Key für ${user} setzen`}
            >
              {hasPrivKey ? 'Ändern' : 'Setzen'}
            </button>
            {hasPrivKey && (
              <button
                type="button"
                onClick={handleDeletePriv}
                disabled={deleting}
                style={fieldStyles.btnDanger}
                aria-label={`Private-Key von ${user} löschen`}
                aria-busy={deleting}
              >
                {deleting ? 'Löschen…' : 'Löschen'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SshKeysSection ────────────────────────────────────────────────────────────

/** Erlaubte Zeichen für Benutzer-Labels (sync mit Backend). */
const USER_LABEL_RE_FRONTEND = /^[a-zA-Z0-9_\-.:@]+$/;

/**
 * Sektion für SSH-Key-Verwaltung je Benutzer-Label.
 * Zeigt alle vorhandenen SSH-Benutzer und ermöglicht das Hinzufügen neuer.
 *
 * @param {{ sshKeys: Array, setSshKeys: Function, onSaved: () => void }} props
 */
function SshKeysSection({ sshKeys, setSshKeys, onSaved }) {
  const [addingUser, setAddingUser] = useState(false);
  const [newUser, setNewUser] = useState('');
  const [error, setError] = useState(null);
  const userInputRef = useRef(null);

  useEffect(() => {
    if (addingUser && userInputRef.current) userInputRef.current.focus();
  }, [addingUser]);

  const handleAddUser = useCallback(() => {
    setError(null);
    const trimUser = newUser.trim();
    if (!trimUser) {
      setError('Benutzer-Label ist ein Pflichtfeld.');
      userInputRef.current?.focus();
      return;
    }
    if (!USER_LABEL_RE_FRONTEND.test(trimUser)) {
      setError('Benutzer-Label enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ - . : @).');
      userInputRef.current?.focus();
      return;
    }
    // Prüfen ob Benutzer bereits existiert
    if (sshKeys.some((k) => k.user === trimUser)) {
      setError(`Benutzer-Label "${trimUser}" ist bereits vorhanden.`);
      userInputRef.current?.focus();
      return;
    }
    // C1: In-Memory-Stub einfügen — kein Server-Roundtrip hier.
    // Der Benutzer wird erst beim ersten Key-PUT im Backend angelegt;
    // bis dahin zeigt das Frontend den leeren Stub an (AC1).
    setSshKeys((prev) => [...prev, { user: trimUser, privateKeyStatus: 'unset' }]);
    setNewUser('');
    setAddingUser(false);
  }, [newUser, sshKeys, setSshKeys]);

  return (
    <div>
      {sshKeys.length === 0 && !addingUser && (
        <p style={sshStyles.emptyState}>Keine SSH-Schlüssel hinterlegt.</p>
      )}

      {sshKeys.map((entry) => (
        <SshKeyEntry
          key={entry.user}
          entry={entry}
          onSaved={onSaved}
        />
      ))}

      {addingUser ? (
        <div style={fieldStyles.editArea}>
          <label htmlFor="ssh-new-user" style={fieldStyles.fieldLabel}>
            Benutzer-Label
          </label>
          <input
            id="ssh-new-user"
            ref={userInputRef}
            type="text"
            value={newUser}
            onChange={(e) => setNewUser(e.target.value)}
            placeholder="z.B. root oder alex"
            style={fieldStyles.input}
            autoComplete="off"
            aria-describedby={error ? 'ssh-add-error' : undefined}
          />
          {error && (
            <p id="ssh-add-error" style={fieldStyles.error} role="alert" aria-live="polite">
              {error}
            </p>
          )}
          <div style={fieldStyles.actionRow}>
            <button
              type="button"
              onClick={handleAddUser}
              style={fieldStyles.btnPrimary}
            >
              Hinzufügen
            </button>
            <button
              type="button"
              onClick={() => { setAddingUser(false); setNewUser(''); setError(null); }}
              style={fieldStyles.btnSecondary}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddingUser(true)}
          style={fieldStyles.btnSmall}
          aria-label="SSH-Benutzer hinzufügen"
        >
          + SSH-Benutzer hinzufügen
        </button>
      )}
    </div>
  );
}

// ── SettingsView ──────────────────────────────────────────────────────────────

export function SettingsView({ onNavigate, fetchFn }) {
  const [credentials, setCredentials] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [sshKeys, setSshKeys] = useState([]);
  const [sshLoadError, setSshLoadError] = useState(null);
  // WS-AC1 (#92): workspace path state
  const [workspacePath, setWorkspacePath] = useState(null);
  const [workspacePathError, setWorkspacePathError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setSshLoadError(null);
    const [credsData, sshData] = await Promise.allSettled([
      fetchCredentials(),
      fetchSshKeys(),
    ]);
    if (credsData.status === 'fulfilled') {
      setCredentials(credsData.value);
    } else {
      setLoadError(credsData.reason?.message ?? 'Unbekannter Fehler');
    }
    if (sshData.status === 'fulfilled') {
      setSshKeys(sshData.value);
    } else {
      setSshLoadError(sshData.reason?.message ?? 'Unbekannter Fehler');
    }
  }, []);

  /**
   * Fetches workspace path and updates state. Used as onReload callback for WorkspacePathSection.
   * Exposes path errors in the GitHub section (not silenced — path is actively configured here).
   */
  const reloadWorkspacePath = useCallback(async () => {
    try {
      const data = await fetchWorkspacePath(fetchFn);
      setWorkspacePath(data);
      setWorkspacePathError(null);
    } catch (err) {
      setWorkspacePath(null);
      setWorkspacePathError(err.message ?? 'Unbekannter Fehler');
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
    reloadWorkspacePath();
  }, [load, reloadWorkspacePath]);

  /** Hilfsfunktion: Metadaten eines bestimmten Felds aus der Liste. */
  const getMeta = useCallback((integration, name) => {
    return credentials.find((c) => c.integration === integration && c.name === name);
  }, [credentials]);

  const miscItems = credentials.filter((c) => c.integration === 'misc');

  return (
    <main style={styles.view} aria-label="Einstellungen-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Einstellungen</h1>

        {loadError && (
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
          {/* WS-AC1 (#92): Workspace-Pfad-Konfiguration in der GitHub-Sektion */}
          <div>
            <h3 style={styles.subSectionHeading}>Workspace-Pfad</h3>
            <p style={styles.subSectionDesc}>
              Workspace-Root für Klon-, Listing- und Pull-Operationen.
              Muss innerhalb der gemounteten Schranke ({workspacePath?.mountRoot || 'WORKSPACE_DIR'}) liegen.
            </p>
            {workspacePathError && (
              <p style={styles.loadError} role="alert" aria-live="polite">
                Workspace-Pfad konnte nicht geladen werden: {workspacePathError}
              </p>
            )}
            {workspacePath && (
              <WorkspacePathSection
                effectivePath={workspacePath.effectivePath}
                source={workspacePath.source}
                mountRoot={workspacePath.mountRoot}
                onReload={reloadWorkspacePath}
                fetchFn={fetchFn}
              />
            )}
          </div>
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

        {/* VPS-Provider */}
        <section aria-labelledby="settings-section-vps" style={styles.section}>
          <h2 id="settings-section-vps" style={styles.sectionHeading}>VPS-Provider</h2>
          <p style={styles.sectionDesc}>API-Token je Provider (Hetzner, IONOS, Hostinger) für Provisionierung und Verwaltung.</p>
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

        {/* SSH-Keys */}
        <section aria-labelledby="settings-section-ssh-keys" style={styles.section}>
          <h2 id="settings-section-ssh-keys" style={styles.sectionHeading}>SSH-Keys</h2>
          <p style={styles.sectionDesc}>
            Öffentliche und private SSH-Schlüssel je Benutzer-Label (z.B. root, alex).
            Public-Keys dürfen vollständig angezeigt werden. Private-Keys sind write-only.
          </p>
          {sshLoadError && (
            <p style={styles.loadError} role="alert" aria-live="polite">
              SSH-Keys konnten nicht geladen werden: {sshLoadError}
            </p>
          )}
          <SshKeysSection sshKeys={sshKeys} setSshKeys={setSshKeys} onSaved={load} />
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
  subSectionHeading: {
    margin: '0 0 6px',
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  subSectionDesc: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',    // Kontrast auf #111 ≥ 4.5:1 (geprüft: ~4.6:1) — NICHT #6b7280
    lineHeight: 1.5,
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

const provisionStyles = {
  form: {
    margin: '12px 0',
    padding: '16px',
    background: '#0d1117',
    border: '1px solid #334155',
    borderRadius: 6,
  },
  heading: {
    margin: '0 0 6px',
    fontSize: 14,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  hint: {
    margin: '0 0 14px',
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 1.4,
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 10,
  },
  label: {
    fontSize: 12,
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
    fontSize: 11,
    marginLeft: 4,
  },
  resultSuccess: {
    marginTop: 10,
    padding: '8px 12px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',
    fontSize: 13,
  },
  resultError: {
    marginTop: 10,
    padding: '8px 12px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  hostKeyNote: {
    display: 'block',
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 4,
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
};

const sshStyles = {
  userHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingBottom: 8,
    borderBottom: '1px solid #2a2a2a',
  },
  userLabel: {
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    fontFamily: 'monospace',
  },
  keyRow: {
    padding: '8px 0 8px 12px',
    borderBottom: '1px solid #1e1e1e',
  },
  keyLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  pubKeyDisplay: {
    margin: '0 0 8px',
    padding: '8px 12px',
    background: '#0d1117',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    fontSize: 11,
    color: '#86efac',        // Kontrast auf #0d1117 ≥ 4.5:1
    fontFamily: 'monospace',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 80,
    overflowY: 'auto',
  },
  textarea: {
    width: '100%',
    padding: '8px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    fontFamily: 'monospace',
    boxSizing: 'border-box',
    resize: 'vertical',
  },
  textareaSecret: {
    width: '100%',
    padding: '8px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    fontFamily: 'monospace',
    boxSizing: 'border-box',
    resize: 'vertical',
    // keine spezielle Maskierung im Browser-Text — der User tippt PEM-Text
  },
  emptyState: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
};

// ── WorkspacePathSection styles (WS-AC1/#92) ──────────────────────────────────

/** Styles für WorkspacePathSection (Pfad-Konfiguration in der GitHub-Sektion der Einstellungen). */
const wsPathStyles = {
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
