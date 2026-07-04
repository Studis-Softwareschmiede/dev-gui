/**
 * SshKeysSection.jsx — Sektion für SSH-Key-Verwaltung je Benutzer-Label.
 *
 * Enthält (unverändert extrahiert): SshKeysSection (Haupt-Export), SshKeyEntry,
 * ProvisionForm (ssh-key-generation/VPS-Provisionierung), RotationForm
 * (ssh-key-rotation), KeygenPanel (ssh-key-generation).
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. `fieldStyles` importiert aus
 * CredentialField.jsx (geteilte Quelle, nichts doppelt gepflegt).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fieldStyles } from './CredentialField.jsx';
import {
  validatePublicKeyFormat,
  putSshKey,
  deleteSshKey,
  provisionSshKey,
  generateSshKeypair,
  rotateSshKey,
  exportAndDownloadPrivateKey,
} from './settingsApi.js';

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

// ── RotationForm ──────────────────────────────────────────────────────────────

/**
 * Formular zum Auslösen einer vollautomatischen SSH-Key-Rotation (ssh-key-rotation AC1/AC5/AC7).
 * Felder: host (Pflicht), port (optional), targetUser (Pflicht), hostFingerprint (optional).
 *
 * Zeigt nach Abschluss:
 *   - Erfolg (result:'rotated'): neuer Public-Key aktiv + oldKeyRemoved-Status (role=status).
 *   - Fehler rotation-verify-failed: klare Aussage „alter Key erhalten" (role=alert).
 *   - 403: keine Berechtigung (role=alert).
 *   - Andere Fehler: Grund anzeigen (role=alert).
 *
 * AC7: Kein Private-Key in der Anzeige — nur newPublicKey + oldKeyRemoved-Status.
 * A11y: alle Felder mit label/htmlFor; Ergebnis-Region programmatisch zugeordnet;
 *       Touch-Targets ≥ 44 px; Loading-State (aria-busy).
 *
 * @param {{
 *   user: string,
 *   onClose: () => void,
 * }} props
 */
function RotationForm({ user, onClose }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [targetUser, setTargetUser] = useState('');
  const [hostFingerprint, setHostFingerprint] = useState('');
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState(null); // null = kein Ergebnis; Erfolg- oder Fehler-Shape
  const [error, setError] = useState(null);   // Validierungsfehler (Frontend)
  const hostInputRef = useRef(null);
  const errorId = `rotation-err-${user}`;
  const resultId = `rotation-result-${user}`;

  useEffect(() => {
    if (hostInputRef.current) hostInputRef.current.focus();
  }, []);

  const handleRotate = useCallback(async () => {
    setError(null);
    setResult(null);

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

    setRotating(true);
    try {
      const res = await rotateSshKey(user, {
        host: trimHost,
        port: trimPort !== '' ? trimPort : undefined,
        targetUser: trimTargetUser,
        hostFingerprint: hostFingerprint.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      // Netzwerkfehler (fetch selbst gescheitert)
      setError(err.message ?? 'Rotation fehlgeschlagen');
    } finally {
      setRotating(false);
    }
  }, [user, host, port, targetUser, hostFingerprint]);

  const isSuccess = result?.result === 'rotated';
  const isVerifyFailed = result?.errorClass === 'rotation-verify-failed';
  const isForbidden = result?.httpStatus === 403;
  const isFailed = result?.result === 'error';

  return (
    <div style={rotationStyles.form} role="region" aria-label={`SSH-Key-Rotation für ${user}`}>
      <h4 style={rotationStyles.heading}>SSH-Key-Rotation für <code>{user}</code></h4>
      <p style={rotationStyles.hint}>
        Rotiert den SSH-Key vollautomatisch: neues Keypair erzeugen → additiv einspielen →
        Verbindungstest → bei Erfolg alten Key entfernen. Kein Bestätigungs-Halt.
      </p>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`rot-host-${user}`} style={provisionStyles.label}>
          Host <span aria-hidden="true" style={provisionStyles.required}>*</span>
        </label>
        <input
          id={`rot-host-${user}`}
          ref={hostInputRef}
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="z.B. 1.2.3.4 oder vps.example.com"
          style={fieldStyles.input}
          aria-required="true"
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`rot-port-${user}`} style={provisionStyles.label}>
          Port <span style={provisionStyles.optional}>(optional, Default: 22)</span>
        </label>
        <input
          id={`rot-port-${user}`}
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="22"
          style={{ ...fieldStyles.input, width: 120 }}
          min="1"
          max="65535"
          aria-describedby={error ? errorId : undefined}
          disabled={rotating}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`rot-user-${user}`} style={provisionStyles.label}>
          Ziel-Benutzer <span aria-hidden="true" style={provisionStyles.required}>*</span>
        </label>
        <input
          id={`rot-user-${user}`}
          type="text"
          value={targetUser}
          onChange={(e) => setTargetUser(e.target.value)}
          placeholder="z.B. root oder alex"
          style={fieldStyles.input}
          aria-required="true"
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      <div style={provisionStyles.fieldRow}>
        <label htmlFor={`rot-fp-${user}`} style={provisionStyles.label}>
          Host-Key-Fingerprint <span style={provisionStyles.optional}>(optional, SHA256-Base64)</span>
        </label>
        <input
          id={`rot-fp-${user}`}
          type="text"
          value={hostFingerprint}
          onChange={(e) => setHostFingerprint(e.target.value)}
          placeholder="Ohne 'SHA256:' Prefix — leer lassen für TOFU"
          style={fieldStyles.input}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          disabled={rotating}
        />
      </div>

      {/* Frontend-Validierungsfehler */}
      {error && (
        <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">
          {error}
        </p>
      )}

      {/* Ergebnis-Anzeige — AC5 */}
      {result && (
        <div
          id={resultId}
          style={isSuccess ? rotationStyles.resultSuccess : rotationStyles.resultError}
          role={isSuccess ? 'status' : 'alert'}
          aria-live={isSuccess ? 'polite' : 'assertive'}
        >
          {isSuccess && (
            <span>
              Key erfolgreich rotiert — neuer Public-Key aktiv.
              {result.oldKeyRemoved
                ? ' Alter Key entfernt.'
                : ' Alter Key konnte nicht entfernt werden (neuer Key ist aktiv).'}
              {result.newPublicKey && (
                <pre style={rotationStyles.newPubKey} aria-label={`Neuer Public-Key für ${user}`}>
                  {result.newPublicKey}
                </pre>
              )}
            </span>
          )}
          {isFailed && isVerifyFailed && (
            <span>
              Verbindungstest fehlgeschlagen — alter Key blieb erhalten, kein Zugang verloren.
              {result.reason && (
                <span style={rotationStyles.reason}> ({result.reason})</span>
              )}
            </span>
          )}
          {isFailed && isForbidden && (
            <span>Keine Berechtigung für diese Aktion (403).</span>
          )}
          {isFailed && !isVerifyFailed && !isForbidden && (
            <span>
              Rotation fehlgeschlagen: {result.error ?? result.reason ?? 'unbekannter Fehler'}
            </span>
          )}
        </div>
      )}

      <div style={{ ...fieldStyles.actionRow, marginTop: 12 }}>
        <button
          type="button"
          onClick={handleRotate}
          disabled={rotating}
          style={rotationStyles.btnRotate}
          aria-busy={rotating}
          aria-label={`SSH-Key für ${user} rotieren`}
        >
          {rotating ? 'Rotation läuft…' : 'Jetzt rotieren'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={rotating}
          style={fieldStyles.btnSecondary}
        >
          Schliessen
        </button>
      </div>
    </div>
  );
}

// ── KeygenPanel ───────────────────────────────────────────────────────────────

/**
 * Panel zum Erzeugen eines neuen ed25519-Keypairs (ssh-key-generation GEN-AC1/AC3/AC4/AC7).
 * Nur sichtbar für Rollen-Labels root|alex (die einzigen, die generate unterstützen).
 *
 * Zeigt nach erfolgreicher Generierung:
 *   - Public-Key vollständig (kopierbar) (GEN-AC3)
 *   - „Private-Key herunterladen"-Button (dauerhaft wiederholbar) (GEN-AC4)
 *
 * Private-Key-Klartext erscheint NIEMALS in der normalen Sektion-Anzeige (GEN-AC3).
 *
 * GEN-AC7: 409 key-exists → Overwrite-Bestätigung (role=alertdialog, aria-labelledby/describedby).
 * GEN-AC8: Nach Generierung ruft onSaved() → Reload der Label-Liste für VPS-Create.
 *
 * @param {{
 *   user: string,
 *   hasPrivKey: boolean,
 *   onSaved: () => void,
 * }} props
 */
function KeygenPanel({ user, hasPrivKey, onSaved }) {
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [successPubKey, setSuccessPubKey] = useState(null); // null = kein letztes Ergebnis
  const [copied, setCopied] = useState(false);
  // Overwrite-Bestätigung (GEN-AC7)
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);

  const errorId = `keygen-err-${user}`;
  const overwriteDialogId = `keygen-overwrite-${user}`;
  const overwriteDescId = `keygen-overwrite-desc-${user}`;
  const confirmBtnRef = useRef(null);

  // Fokus auf Bestätigungs-Button wenn Dialog öffnet (A11y: Fokus-Management)
  useEffect(() => {
    if (showOverwriteConfirm && confirmBtnRef.current) {
      confirmBtnRef.current.focus();
    }
  }, [showOverwriteConfirm]);

  const doGenerate = useCallback(async (overwrite) => {
    setError(null);
    setGenerating(true);
    try {
      const result = await generateSshKeypair(user, { overwrite });
      if (result.httpStatus === 409 && result.errorClass === 'key-exists') {
        // GEN-AC7: belegtes Label → Overwrite-Bestätigung zeigen
        setShowOverwriteConfirm(true);
        return;
      }
      if (result.httpStatus !== 200) {
        setError(result.error ?? `Generierung fehlgeschlagen (${result.httpStatus})`);
        return;
      }
      // Erfolg: Public-Key anzeigen (GEN-AC3); Private-Key NIE im State
      setSuccessPubKey(result.publicKey ?? null);
      setShowOverwriteConfirm(false);
      // GEN-AC8: Label-Liste neu laden
      onSaved();
    } catch (err) {
      setError(err.message ?? 'Generierung fehlgeschlagen');
    } finally {
      setGenerating(false);
    }
  }, [user, onSaved]);

  const handleGenerate = useCallback(() => {
    doGenerate(false);
  }, [doGenerate]);

  const handleOverwriteConfirm = useCallback(() => {
    setShowOverwriteConfirm(false);
    doGenerate(true);
  }, [doGenerate]);

  const handleOverwriteCancel = useCallback(() => {
    setShowOverwriteConfirm(false);
  }, []);

  const handleCopyPubKey = useCallback(async () => {
    if (!successPubKey) return;
    try {
      await globalThis.navigator.clipboard.writeText(successPubKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Kopieren fehlgeschlagen — bitte manuell markieren und kopieren.');
    }
  }, [successPubKey]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const result = await exportAndDownloadPrivateKey(user);
      if (!result.ok) {
        setError(result.error ?? 'Export fehlgeschlagen');
      }
    } catch (err) {
      setError(err.message ?? 'Export fehlgeschlagen');
    } finally {
      setExporting(false);
    }
  }, [user]);

  return (
    <div style={keygenStyles.wrapper}>
      {/* Generieren-Button */}
      {!showOverwriteConfirm && (
        <div style={fieldStyles.actionRow}>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            style={keygenStyles.btnGenerate}
            aria-busy={generating}
            aria-label={`Neues ed25519-Keypair für ${user} erzeugen`}
            aria-describedby={error ? errorId : undefined}
          >
            {generating ? 'Erzeugen…' : 'Keypair erzeugen'}
          </button>
          {/* Private-Key-Export: dauerhaft sichtbar wenn Private-Key gesetzt (GEN-AC4) */}
          {hasPrivKey && (
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              style={keygenStyles.btnExport}
              aria-busy={exporting}
              aria-label={`Private-Key für ${user} herunterladen`}
            >
              {exporting ? 'Exportiere…' : 'Private-Key herunterladen'}
            </button>
          )}
        </div>
      )}

      {/* Overwrite-Bestätigung (GEN-AC7) — programmatisch zugeordnet (role=alertdialog) */}
      {showOverwriteConfirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={overwriteDialogId}
          aria-describedby={overwriteDescId}
          style={keygenStyles.overwriteBox}
        >
          <p id={overwriteDialogId} style={keygenStyles.overwriteTitle}>
            Vorhandenen Key überschreiben?
          </p>
          <p id={overwriteDescId} style={keygenStyles.overwriteDesc}>
            Für Rollen-Label <strong>{user}</strong> ist bereits ein Key gesetzt.
            Das Überschreiben entfernt den bisherigen Private-Key unwiderruflich —
            Server, die diesen Key noch nutzen, verlieren den Zugang.
          </p>
          <div style={fieldStyles.actionRow}>
            <button
              type="button"
              ref={confirmBtnRef}
              onClick={handleOverwriteConfirm}
              disabled={generating}
              style={keygenStyles.btnOverwriteConfirm}
              aria-label={`Bestätigen: Keypair für ${user} überschreiben`}
            >
              {generating ? 'Erzeugen…' : 'Ja, überschreiben'}
            </button>
            <button
              type="button"
              onClick={handleOverwriteCancel}
              disabled={generating}
              style={fieldStyles.btnSecondary}
              aria-label="Abbrechen — bestehenden Key behalten"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Fehler-Anzeige */}
      {error && (
        <p id={errorId} style={fieldStyles.error} role="alert" aria-live="polite">
          {error}
        </p>
      )}

      {/* Public-Key-Anzeige nach Generierung (GEN-AC3) */}
      {successPubKey && (
        <div style={keygenStyles.pubKeyResult} aria-live="polite">
          <div style={keygenStyles.pubKeyResultHeader}>
            <span style={keygenStyles.pubKeyResultLabel}>Erzeugter Public-Key:</span>
            <button
              type="button"
              onClick={handleCopyPubKey}
              style={keygenStyles.btnCopy}
              aria-label={`Public-Key für ${user} in Zwischenablage kopieren`}
            >
              {copied ? 'Kopiert!' : 'Kopieren'}
            </button>
          </div>
          <pre
            style={sshStyles.pubKeyDisplay}
            aria-label={`Erzeugter Public-Key für ${user}`}
          >
            {successPubKey}
          </pre>
          {/* Private-Key-Export-Button erscheint nach Generierung immer (GEN-AC4) */}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              style={keygenStyles.btnExport}
              aria-busy={exporting}
              aria-label={`Private-Key für ${user} herunterladen`}
            >
              {exporting ? 'Exportiere…' : 'Private-Key herunterladen'}
            </button>
          </div>
          <p style={keygenStyles.exportHint}>
            Der Private-Key ist dauerhaft über den Export-Button abrufbar — solange er im Store liegt.
            Jeder Export wird auditiert.
          </p>
        </div>
      )}
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
  const [showRotation, setShowRotation] = useState(false);
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

  // GEN-AC1 / ROT-AC1: nur root|alex unterstützen Keypair-Generierung und Rotation
  const isGenerateSupported = user === 'root' || user === 'alex';
  const isRotationSupported = user === 'root' || user === 'alex';

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
          {/* ROT-AC1: Rotation-Button — nur root|alex, nur wenn Private-Key vorhanden */}
          {isRotationSupported && (
            <button
              type="button"
              onClick={() => setShowRotation((v) => !v)}
              disabled={!hasPrivKey || deleting}
              style={hasPrivKey ? fieldStyles.btnSmall : { ...fieldStyles.btnSmall, opacity: 0.45, cursor: 'not-allowed' }}
              aria-label={`SSH-Key für ${user} rotieren`}
              aria-expanded={showRotation}
              title={hasPrivKey ? 'SSH-Key vollautomatisch rotieren' : 'Kein Private-Key hinterlegt — zuerst ein Keypair erzeugen'}
            >
              {showRotation ? 'Rotation schliessen' : 'Rotieren'}
            </button>
          )}
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

      {/* ROT-AC1/AC5/AC7: Rotations-Formular (ausgeklappt) — nur root|alex mit Private-Key */}
      {showRotation && isRotationSupported && hasPrivKey && (
        <RotationForm
          user={user}
          onClose={() => setShowRotation(false)}
        />
      )}

      {/* GEN-AC1/AC3/AC4/AC7/AC8: Keypair-Generierung + Export (nur root|alex) */}
      {isGenerateSupported && (
        <div style={keygenStyles.sectionWrapper}>
          <h4 style={keygenStyles.sectionHeading}>Keypair erzeugen</h4>
          <KeygenPanel
            user={user}
            hasPrivKey={hasPrivKey}
            onSaved={onSaved}
          />
        </div>
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
export function SshKeysSection({ sshKeys, setSshKeys, onSaved }) {
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

// ── Styles ────────────────────────────────────────────────────────────────────

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
const rotationStyles = {
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
    color: '#9ca3af',    // Kontrast ≥ 4.5:1 auf #0d1117
    lineHeight: 1.4,
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
  newPubKey: {
    display: 'block',
    marginTop: 8,
    padding: '6px 10px',
    background: '#0a1a0a',
    border: '1px solid #166534',
    borderRadius: 4,
    fontSize: 11,
    color: '#86efac',
    fontFamily: 'monospace',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 80,
    overflowY: 'auto',
  },
  reason: {
    display: 'block',
    marginTop: 4,
    fontSize: 12,
    color: '#fca5a5',
    fontStyle: 'italic',
  },
  btnRotate: {
    padding: '8px 16px',
    background: '#1e3a5f',    // dunkles Blau — Rotation ist privilegiert, aber nicht destruktiv
    color: '#93c5fd',          // Kontrast auf #1e3a5f ≈ 5.5:1
    border: '1px solid #2563eb',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    fontWeight: 600,
  },
};
const keygenStyles = {
  wrapper: {
    marginTop: 4,
  },
  sectionWrapper: {
    marginTop: 12,
    padding: '10px 12px',
    background: '#0d1117',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
  },
  sectionHeading: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  btnGenerate: {
    padding: '8px 16px',
    background: '#065f46',    // Kontrast #d1fae5/#065f46 — grün für Erzeuge-Aktion
    color: '#d1fae5',
    border: '1px solid #047857',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    fontWeight: 600,
  },
  btnExport: {
    padding: '8px 16px',
    background: '#1e293b',
    color: '#93c5fd',         // Kontrast auf #1e293b ≈ 5.8:1
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnCopy: {
    padding: '4px 10px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnOverwriteConfirm: {
    padding: '8px 16px',
    background: '#7f1d1d',    // Rot: Warnung/Destruktiv
    color: '#fecaca',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    fontWeight: 600,
  },
  overwriteBox: {
    padding: '12px 16px',
    background: '#1c0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    marginBottom: 8,
  },
  overwriteTitle: {
    margin: '0 0 6px',
    fontSize: 14,
    fontWeight: 700,
    color: '#fca5a5',         // Kontrast auf #1c0a0a ≥ 4.5:1
  },
  overwriteDesc: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#fca5a5',
    lineHeight: 1.5,
  },
  pubKeyResult: {
    marginTop: 12,
    padding: '10px 12px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 6,
  },
  pubKeyResultHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  pubKeyResultLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#86efac',
  },
  exportHint: {
    margin: '8px 0 0',
    fontSize: 11,
    color: '#9ca3af',         // Kontrast auf #052e16 ≥ 4.5:1
    lineHeight: 1.4,
  },
};
