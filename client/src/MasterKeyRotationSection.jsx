/**
 * MasterKeyRotationSection.jsx — Abschnitt „Master-Key-Rotation" in den Einstellungen
 * (credential-key-rotation v2, S-342, AC13).
 *
 * Zweistufige Quittung (Muster BackupSection.jsx / RestoreSection.jsx):
 *   - Stufe 1 „Re-Encryption + Round-trip-Verifikation": Ergebnis von
 *     `CredentialStore#rotate()` — grün sobald `swapped:true` (unabhängig vom
 *     `.env`-Persistenz-Ausgang, der separat als Warnung erscheint).
 *   - Stufe 2 „umgeschaltet + Backup": Bitwarden-Archivierung (`archive`, AC4/AC11 —
 *     NUR wenn Bitwarden-Zugangsdaten mitgegeben wurden) + frisches Backup
 *     (`backup`, AC6/AC12). Bleibt eine Teil-Stufe aus/fehlerhaft, erscheint eine
 *     stufen-genaue, geheimnisfreie Warnung statt einer grünen Quittung.
 *
 * Permanente Entsorgung des Schlüssel-Archivs (AC5) ist eine GETRENNTE, eigens
 * bestätigte Aktion (eigenes Formular, eigener Bitwarden-Login, eigener Endpunkt) —
 * niemals Teil des Rotations-Formulars oben.
 *
 * Security-Floor: Neuer Master-Key + Bitwarden-Passwort sind maskierte
 * Passwort-Felder; nach jedem Request werden die Geheimwerte aus dem Formular-State
 * entfernt (Erfolg wie Fehlschlag) — sie werden NIE geloggt/im Bundle gehalten.
 *
 * A11y: Labels mit htmlFor, aria-describedby-Fehlerzuordnung, role=status/alert für
 * Ergebnis-Regionen, Touch-Targets ≥ 44 px, aria-busy während des Requests.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useCallback } from 'react';
import { postCredentialRotate, postCredentialKeyArchiveDiscard } from './settingsApi.js';

/** Rendert ein einzelnes Stufen-Symbol (✓/⚠/–) mit Label — geheimnisfrei. */
function StageIcon({ ok, label, skippedLabel }) {
  if (ok === undefined) {
    return (
      <span style={rotateStyles.stageMuted} role="img" aria-label={`${label}: ${skippedLabel ?? 'nicht ausgeführt'}`}>
        {label} –
      </span>
    );
  }
  return ok
    ? (
      <span style={rotateStyles.stageOk} role="img" aria-label={`${label}: erfolgreich`}>
        {label} ✓
      </span>
      )
    : (
      <span style={rotateStyles.stageWarn} role="img" aria-label={`${label}: fehlgeschlagen`}>
        {label} ⚠
      </span>
      );
}

export function MasterKeyRotationSection({ fetchFn }) {
  const [newKey, setNewKey] = useState('');
  const [bwEmail, setBwEmail] = useState('');
  const [bwPassword, setBwPassword] = useState('');
  const [bwTwofa, setBwTwofa] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState(null);

  const [discardBwEmail, setDiscardBwEmail] = useState('');
  const [discardBwPassword, setDiscardBwPassword] = useState('');
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardResult, setDiscardResult] = useState(null);

  const handleRotate = useCallback(async () => {
    setResult(null);
    if (!newKey.trim()) {
      setResult({ ok: false, error: 'Neuer Master-Key ist ein Pflichtfeld.' });
      return;
    }
    if (!confirmed) {
      setResult({ ok: false, error: 'Bitte bestätige die Rotation.' });
      return;
    }

    setRotating(true);
    try {
      const data = await postCredentialRotate(
        { newKey: newKey.trim(), bwEmail, bwPassword, bwTwofa },
        fetchFn,
      );
      setResult(data);
    } catch {
      setResult({ ok: false, error: 'Netzwerk-Fehler bei der Rotation.' });
    } finally {
      // Security-Floor: Geheimwerte NIE über den Request hinaus im Formular-State halten.
      setNewKey('');
      setBwPassword('');
      setBwTwofa('');
      setConfirmed(false);
      setRotating(false);
    }
  }, [newKey, bwEmail, bwPassword, bwTwofa, confirmed, fetchFn]);

  const handleDiscard = useCallback(async () => {
    setDiscardResult(null);
    if (!discardConfirmed) {
      setDiscardResult({ ok: false, error: 'Bitte bestätige die permanente Entsorgung.' });
      return;
    }
    if (!discardBwEmail.trim() || !discardBwPassword) {
      setDiscardResult({ ok: false, error: 'Bitwarden-E-Mail und -Passwort sind Pflichtfelder.' });
      return;
    }

    setDiscarding(true);
    try {
      const data = await postCredentialKeyArchiveDiscard(
        { bwEmail: discardBwEmail, bwPassword: discardBwPassword },
        fetchFn,
      );
      setDiscardResult(data);
    } catch {
      setDiscardResult({ ok: false, error: 'Netzwerk-Fehler bei der Entsorgung.' });
    } finally {
      setDiscardBwPassword('');
      setDiscardConfirmed(false);
      setDiscarding(false);
    }
  }, [discardBwEmail, discardBwPassword, discardConfirmed, fetchFn]);

  const canRotate = newKey.trim() !== '' && confirmed && !rotating;
  const canDiscard = discardConfirmed && discardBwEmail.trim() !== '' && discardBwPassword !== '' && !discarding;

  // Stufe 1: swapped:true ⇒ Re-Encryption + Round-trip-Verifikation erfolgreich
  // (unabhängig vom .env-Persistenz-Ausgang — separat als Warnung ausgewiesen).
  const stage1Attempted = result != null && (result.swapped !== undefined || result.reason !== undefined);
  const stage1Ok = result?.swapped === true;
  const persistWarn = result && !result.ok && result.reason === 'persist-failed';

  const backupOk = result?.backup ? result.backup.local === 'ok' : undefined;
  const archiveOk = result?.archive ? result.archive.ok === true : undefined;
  // Stufe 2 gilt nur als vollständig grün wenn Backup UND (falls angefordert) Archivierung ok sind.
  const stage2Ok = stage1Ok && backupOk === true && (archiveOk === undefined || archiveOk === true);

  return (
    <div style={rotateStyles.wrapper} aria-labelledby="rotate-section-heading">
      <h3 id="rotate-section-heading" style={rotateStyles.heading}>Master-Key-Rotation</h3>
      <p style={rotateStyles.desc}>
        Re-verschlüsselt den Credential-Store mit einem neuen Master-Key. Optional werden mit
        Bitwarden-Zugangsdaten der neue Key im Bitwarden-Item aktiv geschaltet und der bisherige
        Key datiert im Feld „Schlüssel-Archiv" archiviert (nicht gelöscht).
      </p>

      <div style={rotateStyles.fieldRow}>
        <label htmlFor="rotate-new-key" style={rotateStyles.label}>
          Neuer Master-Key <span aria-hidden="true" style={rotateStyles.required}>*</span>
        </label>
        <input
          id="rotate-new-key"
          type="password"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          style={rotateStyles.input}
          autoComplete="off"
          disabled={rotating}
          aria-required="true"
        />
      </div>

      <div style={rotateStyles.fieldRow}>
        <label htmlFor="rotate-bw-email" style={rotateStyles.label}>
          Bitwarden E-Mail <span style={rotateStyles.optional}>(optional — für Archivierung)</span>
        </label>
        <input
          id="rotate-bw-email"
          type="email"
          value={bwEmail}
          onChange={(e) => setBwEmail(e.target.value)}
          style={rotateStyles.input}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      <div style={rotateStyles.fieldRow}>
        <label htmlFor="rotate-bw-password" style={rotateStyles.label}>
          Bitwarden Passwort <span style={rotateStyles.optional}>(optional)</span>
        </label>
        <input
          id="rotate-bw-password"
          type="password"
          value={bwPassword}
          onChange={(e) => setBwPassword(e.target.value)}
          style={rotateStyles.input}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      <div style={rotateStyles.fieldRow}>
        <label htmlFor="rotate-bw-twofa" style={rotateStyles.label}>
          2FA-Code <span style={rotateStyles.optional}>(optional)</span>
        </label>
        <input
          id="rotate-bw-twofa"
          type="text"
          value={bwTwofa}
          onChange={(e) => setBwTwofa(e.target.value)}
          style={rotateStyles.input}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      <div style={rotateStyles.confirmRow}>
        <label htmlFor="rotate-confirm-checkbox" style={rotateStyles.confirmLabel}>
          <input
            id="rotate-confirm-checkbox"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={rotating}
            style={rotateStyles.checkbox}
          />
          {' '}Ich bestätige die Master-Key-Rotation.
        </label>
      </div>

      {result && !stage1Attempted && (
        <div role="alert" style={rotateStyles.errorBox}>
          <p style={rotateStyles.errorText}>{result.error}</p>
        </div>
      )}

      {stage1Attempted && (
        <div role="status" style={stage1Ok && stage2Ok ? rotateStyles.successBox : rotateStyles.warnBox}>
          <p style={rotateStyles.stageLine}>
            <StageIcon ok={stage1Ok} label="Stufe 1 — Re-Encryption + Verifikation" />
          </p>
          {stage1Ok && (
            <p style={rotateStyles.stageLine}>
              <StageIcon ok={backupOk} label="Stufe 2 — Backup" />
              {' '}
              <StageIcon ok={archiveOk} label="Stufe 2 — Bitwarden umgeschaltet" skippedLabel="nicht angefordert" />
            </p>
          )}
          {persistWarn && (
            <p style={rotateStyles.warnText}>
              Neuer Key ist aktiv, konnte aber nicht in <code>.env</code> persistiert werden — Reboot-Risiko.
            </p>
          )}
          {!stage1Ok && result?.reason && (
            <p style={rotateStyles.errorText}>Rotation abgelehnt: {result.reason}</p>
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleRotate}
          disabled={!canRotate}
          aria-busy={rotating}
          style={canRotate ? rotateStyles.btnPrimary : rotateStyles.btnDisabled}
        >
          {rotating ? 'Rotation läuft…' : 'Master-Key rotieren'}
        </button>
      </div>

      {/* AC5/AC13: Permanente Entsorgung — GETRENNTE, explizit bestätigte Aktion */}
      <div style={rotateStyles.discardWrapper}>
        <h4 style={rotateStyles.discardHeading}>Archivierte Schlüssel endgültig entsorgen</h4>
        <p style={rotateStyles.desc}>
          Löscht PERMANENT den Inhalt des Feldes „Schlüssel-Archiv" in Bitwarden. Nur bei
          Kompromittierung verwenden — im normalen Rotations-Flow werden alte Keys nie gelöscht.
        </p>

        <div style={rotateStyles.fieldRow}>
          <label htmlFor="discard-bw-email" style={rotateStyles.label}>
            Bitwarden E-Mail <span aria-hidden="true" style={rotateStyles.required}>*</span>
          </label>
          <input
            id="discard-bw-email"
            type="email"
            value={discardBwEmail}
            onChange={(e) => setDiscardBwEmail(e.target.value)}
            style={rotateStyles.input}
            autoComplete="off"
            disabled={discarding}
            aria-required="true"
          />
        </div>

        <div style={rotateStyles.fieldRow}>
          <label htmlFor="discard-bw-password" style={rotateStyles.label}>
            Bitwarden Passwort <span aria-hidden="true" style={rotateStyles.required}>*</span>
          </label>
          <input
            id="discard-bw-password"
            type="password"
            value={discardBwPassword}
            onChange={(e) => setDiscardBwPassword(e.target.value)}
            style={rotateStyles.input}
            autoComplete="off"
            disabled={discarding}
            aria-required="true"
          />
        </div>

        <div style={rotateStyles.confirmRow}>
          <label htmlFor="discard-confirm-checkbox" style={rotateStyles.confirmLabel}>
            <input
              id="discard-confirm-checkbox"
              type="checkbox"
              checked={discardConfirmed}
              onChange={(e) => setDiscardConfirmed(e.target.checked)}
              disabled={discarding}
              style={rotateStyles.checkbox}
            />
            {' '}Ich bestätige die PERMANENTE Entsorgung der archivierten Schlüssel (Kompromittierung).
          </label>
        </div>

        {discardResult && (
          <div role={discardResult.ok ? 'status' : 'alert'} style={discardResult.ok ? rotateStyles.successBox : rotateStyles.errorBox}>
            <p style={discardResult.ok ? rotateStyles.successText : rotateStyles.errorText}>
              {discardResult.ok ? 'Archivierte Schlüssel wurden entsorgt.' : (discardResult.error ?? `Entsorgung fehlgeschlagen (${discardResult.reason ?? 'error'}).`)}
            </p>
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={handleDiscard}
            disabled={!canDiscard}
            aria-busy={discarding}
            style={canDiscard ? rotateStyles.btnDanger : rotateStyles.btnDisabled}
          >
            {discarding ? 'Entsorgung läuft…' : 'Endgültig entsorgen'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const rotateStyles = {
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
    minWidth: 200,
  },
  required: { color: '#fca5a5' },
  optional: { color: '#6b7280', fontSize: 11 },
  input: {
    flex: 1,
    minWidth: 200,
    minHeight: 44,
    padding: '8px 10px',
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
  },
  confirmRow: { marginBottom: 12 },
  confirmLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: '#e5e7eb',
    minHeight: 44,
  },
  checkbox: { width: 18, height: 18 },
  errorBox: {
    marginTop: 12,
    padding: '10px 12px',
    background: '#2a1414',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
  },
  warnBox: {
    marginTop: 12,
    padding: '10px 12px',
    background: '#2a2414',
    border: '1px solid #7f6a1d',
    borderRadius: 6,
  },
  successBox: {
    marginTop: 12,
    padding: '10px 12px',
    background: '#142a1a',
    border: '1px solid #1d7f4a',
    borderRadius: 6,
  },
  errorText: { margin: 0, fontSize: 12, color: '#fca5a5' },
  warnText: { margin: '4px 0 0', fontSize: 12, color: '#fcd34d' },
  successText: { margin: 0, fontSize: 12, color: '#86efac' },
  stageLine: { margin: '2px 0', fontSize: 12 },
  stageOk: { color: '#86efac' },
  stageWarn: { color: '#fcd34d' },
  stageMuted: { color: '#6b7280' },
  btnPrimary: {
    minHeight: 44,
    padding: '10px 18px',
    background: '#2563eb',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDanger: {
    minHeight: 44,
    padding: '10px 18px',
    background: '#b91c1c',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDisabled: {
    minHeight: 44,
    padding: '10px 18px',
    background: '#374151',
    border: 'none',
    borderRadius: 6,
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  discardWrapper: {
    marginTop: 28,
    paddingTop: 16,
    borderTop: '1px dashed #7f1d1d',
  },
  discardHeading: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 700,
    color: '#fca5a5',
  },
};
