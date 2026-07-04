/**
 * MiscSection.jsx — Sektion für generische „weitere Credentials" (misc).
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CredentialField, fieldStyles } from './CredentialField.jsx';
import { MAX_MISC_NAME_LEN, MAX_VALUE_LEN, putCredential } from './settingsApi.js';


/**
 * Sektion für generische „weitere Credentials" (misc).
 *
 * @param {{ miscItems: Array, onSaved: () => void }} props
 */
export function MiscSection({ miscItems, onSaved }) {
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
