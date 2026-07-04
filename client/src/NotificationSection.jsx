/**
 * NotificationSection.jsx — Sektion „Benachrichtigungen (ntfy)" (push-notifications
 * S-183 AC3/AC10, notification-event-defaults AC6).
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. `fieldStyles` importiert aus CredentialField.jsx
 * (geteilte Quelle, nichts doppelt gepflegt).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fieldStyles } from './CredentialField.jsx';
import {
  MAX_VALUE_LEN,
  putCredential,
  deleteCredential,
  fetchNotificationSettings,
  putNotificationSettings,
  postNotificationTest,
} from './settingsApi.js';

/**
 * Ereignis-Katalog, gruppiert nach Meldeklasse (notification-event-defaults AC6).
 * Sync mit Backend `ALLOWED_EVENTS` (src/NotificationSettingsStore.js).
 *
 * Meldeklassen-Zuordnung (Spec-Konzeptteil „Meldeklassen", notification-event-defaults
 * Zeilen 30-37 — die einzige Stelle, die Klassen-Zugehörigkeit definiert):
 *   „Eingabe zwingend nötig" — questions_pending (primär, wartende Owner-Eingabe) +
 *     tunnel_missing (verwandte „Aktion nötig"-Infrastruktur-Meldung, Spec-Zeile 33f.).
 *   „Arbeit fertig" — drain_done (primär, Lauf abgeschlossen mit Bilanz) + die dort
 *     genannten feingranularen story_done/feature_done.
 *   ANNAHME zu story_blocked: die Spec-Definition (Zeilen 30-37) erwähnt story_blocked
 *     NICHT explizit — hier wird es der Story-Lifecycle-Familie (push-notifications AC8,
 *     notification-event-defaults Nicht-Ziele/A3: story_done/story_blocked/feature_done
 *     bleiben als Gruppe verfügbar) unter „Arbeit fertig" zugeordnet. Eine alternative
 *     Lesart („Eingabe zwingend nötig", da ein blockierter Lauf konzeptionell nicht
 *     abgeschlossen ist) ist denkbar — offene Klärung beim Owner, keine Spec-gedeckte
 *     Tatsache.
 */
const NOTIFICATION_EVENT_GROUPS = [
  {
    id: 'input-required',
    heading: 'Eingabe zwingend nötig',
    events: [
      { key: 'questions_pending', label: 'Rückfragen offen (Import wartet auf Antwort)', isDefault: false },
      { key: 'tunnel_missing', label: 'Tunnel fehlt (Cloudflare-Verbindung gestört)', isDefault: true },
    ],
  },
  {
    id: 'work-done',
    heading: 'Arbeit fertig',
    events: [
      { key: 'drain_done', label: 'Board-Durchlauf abgeschlossen (Bilanz)', isDefault: true },
      { key: 'story_done', label: 'Story fertig (→ Done)', isDefault: false },
      { key: 'story_blocked', label: 'Story blockiert (→ Blocked)', isDefault: false },
      { key: 'feature_done', label: 'Feature komplett (alle Stories Done)', isDefault: false },
    ],
  },
];
/**
 * Sektion „Benachrichtigungen (ntfy)" in der SettingsView (S-183 AC3).
 *
 * Felder: Ein/Aus-Schalter, Server-URL, Topic, Priorität (1–5 oder Default),
 * Token (write-only via Credential-Pfad, maskiert als gesetzt/nicht gesetzt),
 * Ereignis-Checkboxen.
 *
 * Gespeicherte Werte werden beim Laden angezeigt (via GET /api/settings/notifications).
 * Token-Feld speichert über PUT /api/settings/credentials/notifications/ntfy_token.
 * Test-Benachrichtigung via POST /api/settings/notifications/test.
 *
 * Security (AC10): Token NIE im Klartext im State oder DOM — nur „gesetzt/nicht gesetzt".
 *
 * A11y: label/htmlFor, role=status/role=alert, aria-live, aria-busy, Touch-Target ≥ 44 px.
 *
 * @param {{
 *   notificationsCredMeta: { status: string, masked?: string }|null,
 *   onCredSaved: () => void,
 *   fetchFn?: typeof fetch,
 * }} props
 */
export function NotificationSection({ notificationsCredMeta, onCredSaved, fetchFn }) {
  // Form-State
  const [enabled, setEnabled] = useState(false);
  const [server, setServer] = useState('https://ntfy.sh');
  const [topic, setTopic] = useState('');
  const [priority, setPriority] = useState('');  // '' = ntfy-Default
  const [events, setEvents] = useState([]);

  // Token-Feld (write-only — AC10: NIE Klartext im State)
  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenDeleting, setTokenDeleting] = useState(false);
  const [tokenError, setTokenError] = useState(null);

  // Load state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [hasToken, setHasToken] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveFieldError, setSaveFieldError] = useState(null); // { field, message }
  const [saved, setSaved] = useState(false);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, error?, status? }

  const tokenInputRef = useRef(null);
  const TOKEN_ERROR_ID = 'notif-token-error';
  const SAVE_ERROR_ID = 'notif-save-error';
  const TEST_RESULT_ID = 'notif-test-result';

  // Lade gespeicherte Settings beim Mount
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchNotificationSettings(fetchFn);
      setEnabled(Boolean(data.enabled));
      setServer(data.server ?? 'https://ntfy.sh');
      setTopic(data.topic ?? '');
      setPriority(data.priority !== null && data.priority !== undefined ? String(data.priority) : '');
      setEvents(Array.isArray(data.events) ? data.events : []);
      setHasToken(Boolean(data.has_token));
    } catch (err) {
      setLoadError(err.message ?? 'Laden fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // has_token aus dem Credential-Meta synchronisieren (wenn von außen neu geladen)
  useEffect(() => {
    if (notificationsCredMeta !== undefined) {
      setHasToken(notificationsCredMeta?.status === 'set');
    }
  }, [notificationsCredMeta]);

  const handleEventChange = useCallback((key, checked) => {
    setEvents((prev) =>
      checked ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((e) => e !== key),
    );
  }, []);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    setSaveFieldError(null);
    setSaved(false);
    setSaving(true);
    try {
      await putNotificationSettings({
        enabled,
        server: server.trim(),
        topic: topic.trim(),
        priority: priority !== '' ? Number(priority) : null,
        events,
      }, fetchFn);
      setSaved(true);
    } catch (err) {
      if (err.field) {
        setSaveFieldError({ field: err.field, message: err.message });
      } else {
        setSaveError(err.message ?? 'Speichern fehlgeschlagen');
      }
    } finally {
      setSaving(false);
    }
  }, [enabled, server, topic, priority, events, fetchFn]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await postNotificationTest(fetchFn);
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: 'Netzwerk-Fehler beim Test-Versand.' });
    } finally {
      setTesting(false);
    }
  }, [fetchFn]);

  // Token setzen/löschen (write-only via Credential-Pfad — AC10)
  const handleTokenSave = useCallback(async () => {
    setTokenError(null);
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setTokenError('Token darf nicht leer sein.');
      tokenInputRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_VALUE_LEN) {
      setTokenError(`Token überschreitet Längenlimit (${MAX_VALUE_LEN} Zeichen).`);
      tokenInputRef.current?.focus();
      return;
    }
    setTokenSaving(true);
    try {
      // AC10: Token geht NUR über diesen Credential-Pfad — NIE über /api/settings/notifications
      await putCredential('notifications', 'ntfy_token', trimmed);
      // AC10: Klartext sofort verwerfen nach Speichern
      setTokenInput('');
      setTokenEditing(false);
      setHasToken(true);
      onCredSaved();
    } catch (err) {
      setTokenError(err.message ?? 'Speichern fehlgeschlagen');
      tokenInputRef.current?.focus();
    } finally {
      setTokenSaving(false);
    }
  }, [tokenInput, onCredSaved]);

  const handleTokenDelete = useCallback(async () => {
    setTokenError(null);
    setTokenDeleting(true);
    try {
      await deleteCredential('notifications', 'ntfy_token');
      setHasToken(false);
      onCredSaved();
    } catch (err) {
      setTokenError(err.message ?? 'Löschen fehlgeschlagen');
    } finally {
      setTokenDeleting(false);
    }
  }, [onCredSaved]);

  const handleTokenCancel = useCallback(() => {
    setTokenInput('');
    setTokenError(null);
    setTokenEditing(false);
  }, []);

  useEffect(() => {
    if (tokenEditing && tokenInputRef.current) tokenInputRef.current.focus();
  }, [tokenEditing]);

  if (loading) {
    return <p style={notifStyles.hint} aria-busy="true">Einstellungen werden geladen…</p>;
  }

  if (loadError) {
    return (
      <p style={notifStyles.errorBox} role="alert">
        Einstellungen konnten nicht geladen werden: {loadError}
      </p>
    );
  }

  return (
    <div>
      {/* Ein/Aus-Schalter */}
      <div style={notifStyles.fieldRow}>
        <label htmlFor="notif-enabled" style={notifStyles.label}>
          Benachrichtigungen:
        </label>
        <select
          id="notif-enabled"
          value={enabled ? 'true' : 'false'}
          onChange={(e) => { setEnabled(e.target.value === 'true'); setSaved(false); }}
          style={notifStyles.select}
        >
          <option value="false">Deaktiviert</option>
          <option value="true">Aktiviert</option>
        </select>
      </div>

      {/* Server-URL */}
      <div style={notifStyles.fieldRow}>
        <label htmlFor="notif-server" style={notifStyles.label}>
          Server-URL:
        </label>
        <input
          id="notif-server"
          type="text"
          value={server}
          onChange={(e) => { setServer(e.target.value); setSaved(false); }}
          placeholder="https://ntfy.sh"
          style={notifStyles.input}
          autoComplete="off"
          aria-describedby={saveFieldError?.field === 'server' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'server' ? 'true' : undefined}
        />
      </div>

      {/* Topic */}
      <div style={notifStyles.fieldRow}>
        <label htmlFor="notif-topic" style={notifStyles.label}>
          Topic:
        </label>
        <input
          id="notif-topic"
          type="text"
          value={topic}
          onChange={(e) => { setTopic(e.target.value); setSaved(false); }}
          placeholder="mein-board-topic"
          style={notifStyles.input}
          autoComplete="off"
          aria-describedby={saveFieldError?.field === 'topic' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'topic' ? 'true' : undefined}
        />
      </div>

      {/* Priorität */}
      <div style={notifStyles.fieldRow}>
        <label htmlFor="notif-priority" style={notifStyles.label}>
          Priorität:
        </label>
        <select
          id="notif-priority"
          value={priority}
          onChange={(e) => { setPriority(e.target.value); setSaved(false); }}
          style={notifStyles.select}
          aria-describedby={saveFieldError?.field === 'priority' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'priority' ? 'true' : undefined}
        >
          <option value="">Standard (ntfy-Default)</option>
          <option value="1">1 — Minimal</option>
          <option value="2">2 — Niedrig</option>
          <option value="3">3 — Standard</option>
          <option value="4">4 — Hoch</option>
          <option value="5">5 — Maximal (Dringend)</option>
        </select>
      </div>

      {/* Token (write-only, maskiert — AC10) */}
      <div style={fieldStyles.row} role="group" aria-label="ntfy-Token">
        <div style={fieldStyles.labelRow}>
          <span style={fieldStyles.fieldLabel}>ntfy-Token (optional, für geschützte Topics)</span>
          <span
            style={hasToken ? fieldStyles.statusSet : fieldStyles.statusUnset}
            aria-label={hasToken ? 'gesetzt' : 'nicht gesetzt'}
          >
            {hasToken ? '•••• gesetzt' : 'nicht gesetzt'}
          </span>
        </div>
        {tokenEditing ? (
          <div style={fieldStyles.editArea}>
            <label htmlFor="notif-token-input" style={fieldStyles.srOnly}>
              ntfy-Token — neuer Wert
            </label>
            <input
              id="notif-token-input"
              ref={tokenInputRef}
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={hasToken ? 'Neuen Token eingeben (überschreibt bestehenden)' : 'Token eingeben'}
              style={fieldStyles.input}
              aria-describedby={tokenError ? TOKEN_ERROR_ID : undefined}
              aria-invalid={tokenError ? 'true' : undefined}
              autoComplete="off"
              data-lpignore="true"
            />
            {tokenError && (
              <p id={TOKEN_ERROR_ID} style={fieldStyles.error} role="alert" aria-live="polite">
                {tokenError}
              </p>
            )}
            <div style={fieldStyles.actionRow}>
              <button
                type="button"
                onClick={handleTokenSave}
                disabled={tokenSaving}
                style={fieldStyles.btnPrimary}
                aria-busy={tokenSaving}
              >
                {tokenSaving ? 'Speichern…' : 'Speichern'}
              </button>
              <button
                type="button"
                onClick={handleTokenCancel}
                disabled={tokenSaving}
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
              onClick={() => setTokenEditing(true)}
              style={fieldStyles.btnSmall}
              aria-label={hasToken ? 'ntfy-Token ändern' : 'ntfy-Token setzen'}
            >
              {hasToken ? 'Ändern' : 'Setzen'}
            </button>
            {hasToken && (
              <button
                type="button"
                onClick={handleTokenDelete}
                disabled={tokenDeleting}
                style={fieldStyles.btnDanger}
                aria-label="ntfy-Token löschen"
                aria-busy={tokenDeleting}
              >
                {tokenDeleting ? 'Löschen…' : 'Löschen'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Ereignis-Auswahl, gruppiert nach Meldeklasse (notification-event-defaults AC6) */}
      <fieldset style={notifStyles.fieldset}>
        <legend style={notifStyles.legend}>Ereignisse</legend>
        {NOTIFICATION_EVENT_GROUPS.map((group) => (
          <div
            key={group.id}
            role="group"
            aria-labelledby={`notif-group-${group.id}`}
            style={notifStyles.eventGroup}
          >
            <p id={`notif-group-${group.id}`} style={notifStyles.groupHeading}>
              {group.heading}
            </p>
            {group.events.map(({ key, label, isDefault }) => (
              <div key={key} style={notifStyles.checkboxRow}>
                <label htmlFor={`notif-event-${key}`} style={notifStyles.checkboxLabel}>
                  <input
                    id={`notif-event-${key}`}
                    type="checkbox"
                    checked={events.includes(key)}
                    onChange={(e) => { handleEventChange(key, e.target.checked); setSaved(false); }}
                    style={notifStyles.checkbox}
                  />
                  {' '}{label}
                  {isDefault && <span style={notifStyles.defaultBadge}>Standard</span>}
                </label>
              </div>
            ))}
          </div>
        ))}
      </fieldset>

      {/* Speichern-Fehler (feldzugeordnet oder allgemein) */}
      {(saveFieldError || saveError) && (
        <p id={SAVE_ERROR_ID} role="alert" style={notifStyles.errorBox}>
          {saveFieldError ? `${saveFieldError.field}: ${saveFieldError.message}` : saveError}
        </p>
      )}

      {/* Erfolgs-Feedback */}
      {saved && !saveFieldError && !saveError && (
        <p role="status" style={notifStyles.successMsg}>
          Einstellungen gespeichert.
        </p>
      )}

      {/* Speichern-Button */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
          style={notifStyles.btnPrimary}
        >
          {saving ? 'Wird gespeichert…' : 'Einstellungen speichern'}
        </button>

        {/* Test-Benachrichtigung */}
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || saving}
          aria-busy={testing}
          style={notifStyles.btnSecondary}
        >
          {testing ? 'Wird gesendet…' : 'Test-Benachrichtigung senden'}
        </button>
      </div>

      {/* Test-Ergebnis (role=status / role=alert — A11y) */}
      {testResult && (
        <div
          id={TEST_RESULT_ID}
          role={testResult.ok ? 'status' : 'alert'}
          aria-live={testResult.ok ? 'polite' : 'assertive'}
          style={testResult.ok ? notifStyles.testSuccess : notifStyles.testError}
        >
          {testResult.ok
            ? 'Test-Benachrichtigung erfolgreich gesendet.'
            : `Test-Benachrichtigung fehlgeschlagen: ${testResult.error ?? 'Unbekannter Fehler'}`}
          {testResult.status && ` (HTTP ${testResult.status})`}
        </div>
      )}
    </div>
  );
}
const notifStyles = {
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  label: {
    color: '#9ca3af',
    fontSize: 13,
    minWidth: 140,
  },
  input: {
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
  select: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '4px 8px',
    minHeight: 32,
    outline: 'none',
  },
  fieldset: {
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
    marginTop: 4,
  },
  legend: {
    color: '#9ca3af',
    fontSize: 13,
    padding: '0 4px',
  },
  eventGroup: {
    marginBottom: 12,
  },
  groupHeading: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    margin: '4px 0 6px',
  },
  checkboxRow: {
    marginBottom: 6,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#e5e7eb',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1.4,
    minHeight: 32,
  },
  defaultBadge: {
    marginLeft: 6,
    padding: '1px 6px',
    fontSize: 11,
    fontWeight: 600,
    color: '#93c5fd',
    background: '#1e3a5f',
    border: '1px solid #2563eb',
    borderRadius: 999,
  },
  checkbox: {
    minWidth: 16,
    minHeight: 16,
    cursor: 'pointer',
  },
  hint: {
    color: '#9ca3af',
    fontSize: 13,
    margin: '8px 0',
  },
  errorBox: {
    padding: '8px 12px',
    marginBottom: 8,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  successMsg: {
    color: '#86efac',
    fontSize: 13,
    margin: '8px 0',
  },
  btnPrimary: {
    background: '#166534',
    border: 'none',
    borderRadius: 4,
    color: '#bbf7d0',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    padding: '8px 16px',
  },
  btnSecondary: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#d4d4d4',
    cursor: 'pointer',
    fontSize: 13,
    minHeight: 44,
    padding: '8px 16px',
  },
  testSuccess: {
    marginTop: 8,
    padding: '8px 12px',
    background: '#0d1a0d',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',
    fontSize: 13,
  },
  testError: {
    marginTop: 8,
    padding: '8px 12px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
};
