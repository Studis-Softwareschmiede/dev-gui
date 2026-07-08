/**
 * SettingsView.jsx — Orchestrierungs-Shell der Einstellungen-Ansicht (settings-panel-navigation
 * AC15). Hält den geteilten State/Effects/Fetch-Code und reicht ihn unverändert an die
 * 7 Kategorie-Wrapper durch (`client/src/settings/*.jsx`); rendert zudem den kategorieüber-
 * greifenden Bitwarden-Unlock-Banner + Dialog (AC3) sowie die Kopfzeile mit „Zurück"-Button
 * (AC17). Die 7 Kategorien werden vorerst gestapelt untereinander gerendert (Nav/Routing/
 * Tastatur-Steuerung folgen in späteren Stories — AC1, AC3–AC14, AC18–AC20 sind NICHT
 * Teil dieser Story).
 *
 * Kategorie-Zuordnung (AC2, siehe docs/specs/settings-panel-navigation.md §Verträge):
 *   Workspace            → WorkspaceCategory.jsx        (WorkspacePathSection)
 *   Zugänge & Schlüssel   → ZugaengeCategory.jsx         (GitHub/Cloudflare/VPS-Credentials,
 *                                                          SshKeysSection)
 *   Sicherung             → SicherungCategory.jsx        (BackupSection inkl. RestoreSection)
 *   Benachrichtigungen    → BenachrichtigungenCategory.jsx (NotificationSection)
 *   Automatisierung       → AutomatisierungCategory.jsx  (NightWatchSettings)
 *   Integrationen         → IntegrationenCategory.jsx    (ObsidianVaultPathSection)
 *   Diverses              → DiversesCategory.jsx         (MiscSection)
 *
 * Extrahierte Sektions-Komponenten + deren AC-Herkunft (unverändert, reine Umverpackung,
 * S-266 hat KEINE Logik/Prop/Endpunkt geändert):
 *   - CredentialField.jsx  — settings-credentials AC1–AC6/AC8; BackupReceipt (credential-backup
 *     AC11); fieldStyles (geteilt).
 *   - MiscSection.jsx      — settings-credentials AC5.
 *   - WorkspacePathSection.jsx — workspace-path-config AC1/AC3, workspace-health-hinweis AC3.
 *   - ObsidianVaultPathSection.jsx — obsidian-vault-config AC1 (UI-Anteil, S-247).
 *   - BackupSection.jsx    — credential-backup S-143 AC11/AC12 (inkl. RestoreSection S-142
 *     AC13–AC16, BackupRemoteCredField, BackupStepResults, BackupStatusTile).
 *   - SshKeysSection.jsx   — settings-ssh-keys SSH-AC1–AC10; ssh-key-generation
 *     GEN-AC1/AC3/AC4/AC6/AC7/AC8 (#116); ssh-key-rotation ROT-AC1/AC5/AC7 (#119).
 *   - NotificationSection.jsx — push-notifications S-183 AC3/AC10; notification-event-defaults
 *     AC6; regression-failed-notification AC5 (S-315).
 *   - settingsApi.js       — geteilte API-Helfer + Konstanten (einzige Quelle, kein Code
 *     doppelt gepflegt).
 *
 * In dieser Shell verbleiben (nur hier direkt gebraucht, nicht von einem Kategorie-Wrapper
 * importiert): BitwardenUnlockDialog (credential-unlock-dialog #185, AC2–AC5/AC5a/AC9/AC11/AC12)
 * + der kategorieübergreifende Unlock-Banner + unlockStyles/unlockDialogStyles.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { WorkspaceCategory } from './settings/WorkspaceCategory.jsx';
import { ZugaengeCategory } from './settings/ZugaengeCategory.jsx';
import { SicherungCategory } from './settings/SicherungCategory.jsx';
import { BenachrichtigungenCategory } from './settings/BenachrichtigungenCategory.jsx';
import { AutomatisierungCategory } from './settings/AutomatisierungCategory.jsx';
import { IntegrationenCategory } from './settings/IntegrationenCategory.jsx';
import { DiversesCategory } from './settings/DiversesCategory.jsx';

// ── Kategorien-Navigation (settings-panel-navigation D1/D13, S-267) ───────────
// Feste Reihenfolge + Slugs gemäß docs/design.md „Settings-Panel Navigation".
export const SETTINGS_CATEGORIES = [
  { slug: 'workspace',          label: 'Workspace' },
  { slug: 'zugaenge',           label: 'Zugänge & Schlüssel' },
  { slug: 'sicherung',          label: 'Sicherung' },
  { slug: 'benachrichtigungen', label: 'Benachrichtigungen' },
  { slug: 'automatisierung',    label: 'Automatisierung' },
  { slug: 'integrationen',      label: 'Integrationen' },
  { slug: 'diverses',           label: 'Diverses' },
];

/** #/settings/<slug> -> gültiger Kategorie-Slug; sonst 'workspace' (D13). */
export function parseSettingsHash(hash) {
  const m = /^#\/settings\/([a-z-]+)\/?$/.exec(String(hash ?? '').toLowerCase());
  const slug = m?.[1] ?? null;
  return SETTINGS_CATEGORIES.some((c) => c.slug === slug) ? slug : 'workspace';
}
import {
  fetchCredentialStatus,
  postCredentialUnlock,
  fetchCredentials,
  fetchSshKeys,
  fetchWorkspacePath,
  fetchWorkspaceHealth,
  fetchObsidianVaultPath,
} from './settingsApi.js';

// ── BitwardenUnlockDialog (credential-unlock-dialog #185) ─────────────────────

/**
 * Modaler Unlock-Dialog für Bitwarden-Login + Store-Entsperrung.
 *
 * AC2   — E-Mail-, Master-Passwort- (type=password) und optionales 2FA-Feld;
 *          A11y: label/htmlFor, aria-describedby, role=alert, Fokus beim Öffnen.
 * AC3   — Submit ruft POST /api/settings/credential-unlock; Erfolg → onSuccess().
 * AC4   — not-found → explizites Erstellungs-Angebot; erst bei Bestätigung create:true.
 * AC5   — twofa-required/twofa-invalid → Fehlermeldung + 2FA-Feld erzwungen (TOTP-Flow).
 * AC5a  — email-otp-required/email-otp-invalid → EIGENES E-Mail-OTP-Feld mit eigener Meldung
 *          (bitwarden-new-device-otp); textlich UNTERSCHIEDLICH von 2FA-Fall.
 * AC9   — Klartext nach Submit verworfen; kein console.log.
 * AC11  — Master-Passwort bleibt bei Retry-Antworten (twofa-/email-otp-required/invalid)
 *          erhalten; nur bei terminalem Ausgang (Erfolg/Fehler) verworfen.
 * AC12  — Show/Hide-Toggle (showPassword-State): type=password ↔ type=text; A11y-Button
 *          mit zustandsabhängigem aria-label, Touch-Target ≥ 44 px.
 *
 * @param {{
 *   onSuccess: () => void,
 *   onClose: () => void,
 *   fetchFn?: typeof fetch,
 * }} props
 */
function BitwardenUnlockDialog({ onSuccess, onClose, fetchFn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // AC12: Show/Hide-Toggle für Master-Passwort (default verborgen)
  const [showPassword, setShowPassword] = useState(false);
  const [twofa, setTwofa] = useState('');
  const [showTwofa, setShowTwofa] = useState(false);
  // AC5a (bitwarden-new-device-otp): eigener State für E-Mail-OTP — GETRENNT von TOTP-2FA
  const [emailOtp, setEmailOtp] = useState('');
  const [showEmailOtp, setShowEmailOtp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState(null); // { field: 'email'|'password'|'twofa'|'emailOtp', msg }
  // AC4: not-found → Erstellungs-Angebot; create-Mode bei Bestätigung
  const [showCreateOffer, setShowCreateOffer] = useState(false);

  const dialogRef = useRef(null);       // outer overlay
  const dialogBoxRef = useRef(null);    // inner dialog box (fokussierbarer Container)
  const emailRef = useRef(null);
  const twofaRef = useRef(null);
  const emailOtpRef = useRef(null);     // AC9 (bitwarden-new-device-otp): Fokus auf OTP-Feld
  const errorRef = useRef(null);

  const DIALOG_TITLE_ID = 'bw-unlock-dialog-title';
  const ERROR_ID = 'bw-unlock-error';
  const EMAIL_ERROR_ID = 'bw-unlock-email-error';
  const PASSWORD_ERROR_ID = 'bw-unlock-password-error';
  const TWOFA_ERROR_ID = 'bw-unlock-twofa-error';
  const EMAIL_OTP_ERROR_ID = 'bw-unlock-email-otp-error';

  // AC2: Fokus auf E-Mail-Feld beim Öffnen des Dialogs
  useEffect(() => {
    if (emailRef.current) {
      emailRef.current.focus();
    }
  }, []);

  // AC5: Fokus auf 2FA-Feld wenn 2FA erzwungen wird
  useEffect(() => {
    if (showTwofa && twofaRef.current) {
      twofaRef.current.focus();
    }
  }, [showTwofa]);

  // AC9 (bitwarden-new-device-otp): Fokus auf E-Mail-OTP-Feld wenn es erscheint
  useEffect(() => {
    if (showEmailOtp && emailOtpRef.current) {
      emailOtpRef.current.focus();
    }
  }, [showEmailOtp]);

  // Fokus auf Fehlermeldung nach Submit-Fehler (A11y)
  const [pendingFocusError, setPendingFocusError] = useState(false);
  useEffect(() => {
    if (pendingFocusError && errorRef.current) {
      errorRef.current.focus();
      setPendingFocusError(false);
    }
  });

  const doSubmit = useCallback(async (opts = {}) => {
    setError(null);
    setFieldError(null);

    // Frontend-Validierung — Pflichtfelder (AC2)
    const trimEmail = email.trim();
    const trimPassword = password.trim();
    if (!trimEmail) {
      setFieldError({ field: 'email', msg: 'E-Mail ist ein Pflichtfeld.' });
      emailRef.current?.focus();
      return;
    }
    if (!trimPassword) {
      setFieldError({ field: 'password', msg: 'Master-Passwort ist ein Pflichtfeld.' });
      return;
    }

    setSubmitting(true);
    let result;
    try {
      result = await postCredentialUnlock(
        {
          email: trimEmail,
          password: trimPassword,
          twofa: twofa.trim() || undefined,
          // AC5a (bitwarden-new-device-otp): E-Mail-OTP-Code — NICHT geloggt (AC7)
          emailOtp: emailOtp.trim() || undefined,
          create: opts.create === true ? true : undefined,
        },
        fetchFn,
      );
    } catch {
      setError('Netzwerkfehler — Verbindung zum Server fehlgeschlagen.');
      setPendingFocusError(true);
      // AC9: Klartext nach Submit verwerfen
      setPassword('');
      setTwofa('');
      setEmailOtp('');
      return;
    } finally {
      // Bedingungslos zurücksetzen — deckt Erfolg, Fehler und unerwarteten Throw ab
      setSubmitting(false);
    }

    // AC3: Erfolg
    if (result.ok && result.state === 'unlocked') {
      // AC9: Klartext nach terminalem Submit verwerfen (Security-Floor)
      setPassword('');
      setTwofa('');
      setEmailOtp('');
      // Kein console.log (AC9)
      onSuccess();
      return;
    }

    // AC4: not-found → Erstellungs-Angebot anzeigen
    // AC9-Ausnahme: Klartext NICHT verwerfen — Nutzer muss mit denselben Credentials create:true senden
    // AC12: showPassword auf false zurücksetzen beim Phasenwechsel → Passwort nicht dauerhaft sichtbar
    if (!result.ok && result.status === 'not-found') {
      setShowCreateOffer(true);
      setShowPassword(false);
      return;
    }

    // AC5: 2FA-Fehler → 2FA-Feld erzwingen + Fehlermeldung (TOTP-Flow — UNVERÄNDERT, AC4)
    // AC11: Retry-Fall — Master-Passwort NICHT leeren; nur verbrauchten Code leeren
    if (!result.ok && (result.errorClass === 'twofa-required' || result.errorClass === 'twofa-invalid')) {
      setTwofa('');
      setShowTwofa(true);
      const msg = result.errorClass === 'twofa-invalid'
        ? '2FA-Code ungültig oder abgelaufen. Bitte erneut eingeben.'
        : '2FA-Authentifizierung erforderlich. Bitte 2FA-Code eingeben.';
      setFieldError({ field: 'twofa', msg });
      return;
    }

    // AC5a (bitwarden-new-device-otp): E-Mail-OTP-Fehler → EIGENES Feld einblenden
    // AC11: Retry-Fall — Master-Passwort NICHT leeren; nur verbrauchten OTP-Code leeren
    // Meldung textlich UNTERSCHIEDLICH vom 2FA-Fall (AC5 spec)
    if (!result.ok && (result.errorClass === 'email-otp-required' || result.errorClass === 'email-otp-invalid')) {
      setEmailOtp('');
      setShowEmailOtp(true);
      const msg = result.errorClass === 'email-otp-invalid'
        ? 'Der eingegebene Code ist ungültig oder abgelaufen. Bitte erneut eingeben.'
        : 'Bitwarden hat dir einen Einmalcode per E-Mail geschickt — bitte eingeben.';
      setFieldError({ field: 'emailOtp', msg });
      return;
    }

    // AC6/AC11: terminaler Fehler — Klartext nach terminalem Submit verwerfen (Security-Floor)
    // E-Mail-OTP-Code wird nach Submit verworfen — nächster Versuch braucht neuen Code (AC7)
    setPassword('');
    setTwofa('');
    setEmailOtp('');

    // AC6: Fehlerklassen → klare Meldung ohne Geheimnis-Leak
    const errorMessages = {
      'auth-failed': 'Bitwarden-Authentifizierung fehlgeschlagen (E-Mail oder Passwort falsch).',
      'bw-unreachable': 'Bitwarden nicht erreichbar. Bitte Verbindung prüfen.',
      'invalid-key': 'Master-Key passt nicht zum bestehenden Store. Store bleibt gesperrt.',
      'persist-failed': 'Key konnte nicht persistiert werden (.env nicht schreibbar). Status prüfen.',
      'forbidden': 'Keine Berechtigung für diese Aktion.',
    };
    const msg = errorMessages[result.errorClass] ?? 'Unbekannter Fehler beim Entsperren.';
    setError(msg);
    setPendingFocusError(true);
  }, [email, password, twofa, emailOtp, onSuccess, fetchFn]);

  const handleSubmit = useCallback(() => {
    doSubmit({});
  }, [doSubmit]);

  const handleCreateConfirm = useCallback(() => {
    setShowCreateOffer(false);
    doSubmit({ create: true });
  }, [doSubmit]);

  const handleCreateCancel = useCallback(() => {
    setShowCreateOffer(false);
    // AC12: showPassword beim Reset auf false → Passwort nicht dauerhaft im Klartext sichtbar
    setShowPassword(false);
  }, []);

  const emailErrorId = fieldError?.field === 'email' ? EMAIL_ERROR_ID : undefined;
  const passwordErrorId = fieldError?.field === 'password' ? PASSWORD_ERROR_ID : undefined;
  const twofaErrorId = fieldError?.field === 'twofa' ? TWOFA_ERROR_ID : undefined;
  // AC5a (bitwarden-new-device-otp): eigene Error-ID für E-Mail-OTP-Feld
  const emailOtpErrorId = fieldError?.field === 'emailOtp' ? EMAIL_OTP_ERROR_ID : undefined;

  /**
   * S2/AC2: Fokus-Trap — hält Tab/Shift+Tab innerhalb der fokussierbaren Dialog-Elemente.
   * Escape schließt den Dialog (wie Abbrechen).
   * WCAG 2.1.2 (No Keyboard Trap: modale Dialoge müssen den Fokus halten).
   */
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = dialogBoxRef.current;
    if (!box) return;
    const focusable = Array.from(
      box.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose]);

  return (
    /* S1: Overlay-Wrapper ohne ARIA-Dialog-Rolle — semantisch korrekt ist der innere Container */
    <div
      role="presentation"
      style={unlockDialogStyles.overlay}
      ref={dialogRef}
    >
      {/* S1: role=dialog/aria-modal/aria-labelledby auf dem inneren sichtbaren Dialog-Container */}
      {/* S2: onKeyDown-Fokus-Trap (Tab/Shift+Tab + Escape) — WCAG 2.1.2 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_TITLE_ID}
        style={unlockDialogStyles.dialog}
        ref={dialogBoxRef}
        onKeyDown={handleKeyDown}
      >
        <h2 id={DIALOG_TITLE_ID} style={unlockDialogStyles.title}>
          Bitwarden verbinden
        </h2>
        <p style={unlockDialogStyles.desc}>
          Mit Bitwarden anmelden, um den Master-Key zu laden und den Store zu entsperren.
        </p>

        {/* Allgemeine Fehlermeldung (AC5/AC6) — role=alert, aria-describedby */}
        {error && (
          <p
            id={ERROR_ID}
            ref={errorRef}
            style={unlockDialogStyles.errorMsg}
            role="alert"
            tabIndex={-1}
          >
            {error}
          </p>
        )}

        {/* AC4: Erstellungs-Angebot (not-found) */}
        {showCreateOffer && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bw-create-offer-title"
            aria-describedby="bw-create-offer-desc"
            style={unlockDialogStyles.createOffer}
          >
            <p id="bw-create-offer-title" style={unlockDialogStyles.createOfferTitle}>
              Master-Key in Bitwarden erstellen?
            </p>
            <p id="bw-create-offer-desc" style={unlockDialogStyles.createOfferDesc}>
              Es wurde kein Master-Key in Bitwarden gefunden. Soll ein neuer Zufalls-Key erzeugt
              und in Bitwarden gespeichert werden?
            </p>
            <div style={unlockDialogStyles.actionRow}>
              <button
                type="button"
                onClick={handleCreateConfirm}
                disabled={submitting}
                style={unlockDialogStyles.btnPrimary}
                aria-busy={submitting}
              >
                {submitting ? 'Erstellen…' : 'Ja, Key erstellen'}
              </button>
              <button
                type="button"
                onClick={handleCreateCancel}
                disabled={submitting}
                style={unlockDialogStyles.btnSecondary}
              >
                Abbrechen
              </button>
            </div>
          </div>
        )}

        {/* Eingabe-Felder (nur wenn kein Erstellungs-Angebot aktiv) */}
        {!showCreateOffer && (
          <div style={unlockDialogStyles.form}>
            {/* E-Mail-Feld */}
            <div style={unlockDialogStyles.fieldRow}>
              <label htmlFor="bw-unlock-email" style={unlockDialogStyles.label}>
                E-Mail <span aria-hidden="true" style={unlockDialogStyles.required}>*</span>
              </label>
              <input
                id="bw-unlock-email"
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="bitwarden@example.com"
                style={unlockDialogStyles.input}
                aria-required="true"
                aria-describedby={emailErrorId ?? (error ? ERROR_ID : undefined)}
                autoComplete="off"
                disabled={submitting}
              />
              {fieldError?.field === 'email' && (
                <p id={EMAIL_ERROR_ID} style={unlockDialogStyles.fieldError} role="alert">
                  {fieldError.msg}
                </p>
              )}
            </div>

            {/* Master-Passwort-Feld — AC2: type=password, autoComplete=off
                AC12: Show/Hide-Toggle schaltet type password ↔ text; Klartext nur im Feld,
                      nie in Log/URL/Response. */}
            <div style={unlockDialogStyles.fieldRow}>
              <label htmlFor="bw-unlock-password" style={unlockDialogStyles.label}>
                Master-Passwort <span aria-hidden="true" style={unlockDialogStyles.required}>*</span>
              </label>
              <div style={unlockDialogStyles.passwordWrapper}>
                <input
                  id="bw-unlock-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Bitwarden Master-Passwort"
                  style={unlockDialogStyles.inputInWrapper}
                  aria-required="true"
                  aria-describedby={passwordErrorId ?? (error ? ERROR_ID : undefined)}
                  autoComplete="off"
                  data-lpignore="true"
                  disabled={submitting}
                />
                {/* AC12: A11y-konformer Toggle-Button — zustandsabhängiges aria-label, Touch-Target ≥ 44 px */}
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  style={unlockDialogStyles.passwordToggle}
                  aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                  title={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                  tabIndex={0}
                  disabled={submitting}
                >
                  <span aria-hidden="true">{showPassword ? '🙈' : '👁'}</span>
                </button>
              </div>
              {fieldError?.field === 'password' && (
                <p id={PASSWORD_ERROR_ID} style={unlockDialogStyles.fieldError} role="alert">
                  {fieldError.msg}
                </p>
              )}
            </div>

            {/* 2FA-Feld — optional (AC2); erzwungen bei twofa-required/invalid (AC5) */}
            {showTwofa && (
              <div style={unlockDialogStyles.fieldRow}>
                <label htmlFor="bw-unlock-twofa" style={unlockDialogStyles.label}>
                  2FA-Code <span style={unlockDialogStyles.optional}>(Authenticator-App)</span>
                </label>
                <input
                  id="bw-unlock-twofa"
                  ref={twofaRef}
                  type="text"
                  inputMode="numeric"
                  value={twofa}
                  onChange={(e) => setTwofa(e.target.value)}
                  placeholder="6-stelliger Code"
                  style={unlockDialogStyles.input}
                  aria-describedby={twofaErrorId ?? (error ? ERROR_ID : undefined)}
                  autoComplete="one-time-code"
                  disabled={submitting}
                />
                {fieldError?.field === 'twofa' && (
                  <p id={TWOFA_ERROR_ID} style={unlockDialogStyles.fieldError} role="alert">
                    {fieldError.msg}
                  </p>
                )}
              </div>
            )}

            {/* Button: 2FA-Feld einblenden (bevor erzwungen) */}
            {!showTwofa && (
              <button
                type="button"
                onClick={() => setShowTwofa(true)}
                style={unlockDialogStyles.btnLink}
                aria-label="2FA-Code-Feld einblenden"
              >
                2FA-Code eingeben
              </button>
            )}

            {/* AC5a (bitwarden-new-device-otp): EIGENES E-Mail-OTP-Feld —
                Erscheint NUR bei email-otp-required/email-otp-invalid; getrennt vom TOTP-2FA-Feld.
                Meldung ist textlich UNTERSCHIEDLICH vom 2FA-Fall (Spec AC5).
                AC9 (new-device-otp): type=text, autoComplete=one-time-code (kein Passwort-Mgr);
                code wird nach Submit verworfen (AC7). Touch-Target ≥ 44 px (AC9). */}
            {showEmailOtp && (
              <div style={unlockDialogStyles.fieldRow}>
                <label htmlFor="bw-unlock-email-otp" style={unlockDialogStyles.label}>
                  Einmalcode (E-Mail) <span style={unlockDialogStyles.optional}>(New Device Verification)</span>
                </label>
                <input
                  id="bw-unlock-email-otp"
                  ref={emailOtpRef}
                  type="text"
                  inputMode="numeric"
                  value={emailOtp}
                  onChange={(e) => setEmailOtp(e.target.value)}
                  placeholder="Code aus der E-Mail eingeben"
                  style={unlockDialogStyles.input}
                  aria-describedby={emailOtpErrorId ?? (error ? ERROR_ID : undefined)}
                  autoComplete="one-time-code"
                  disabled={submitting}
                />
                {fieldError?.field === 'emailOtp' && (
                  <p id={EMAIL_OTP_ERROR_ID} style={unlockDialogStyles.fieldError} role="alert">
                    {fieldError.msg}
                  </p>
                )}
              </div>
            )}

            {/* Submit-Button — aria-busy bei Ladezustand (AC2, Edge-Cases) */}
            <div style={unlockDialogStyles.actionRow}>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                style={unlockDialogStyles.btnPrimary}
                aria-busy={submitting}
              >
                {submitting ? 'Verbinden…' : 'Verbinden'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={unlockDialogStyles.btnSecondary}
              >
                Abbrechen
              </button>
            </div>
          </div>
        )}
      </div>
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
  // AC3 (workspace-health-hinweis): health state
  const [workspaceHealth, setWorkspaceHealth] = useState(null);
  // obsidian-vault-config AC1 (UI-Anteil, S-247): Obsidian-Vault-Pfad state
  const [obsidianVaultPath, setObsidianVaultPath] = useState(null);
  const [obsidianVaultPathError, setObsidianVaultPathError] = useState(null);
  // credential-unlock-dialog #185: Bitwarden-Unlock-Status + Dialog
  const [credentialStatus, setCredentialStatus] = useState(null); // null = noch nicht geladen
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  // S-267 (D11): genau EINE sichtbare Kategorie; Default workspace (D13).
  // S-268 (D13/D14): Deep-Link #/settings/<slug> — Initial aus dem Hash,
  // Tab-Klick schreibt den Hash (Browser-Historie -> Vor/Zurück wechselt die
  // Kategorie), hashchange synct den State; unbekanntes Segment -> workspace.
  const [activeCategory, setActiveCategoryState] = useState(() => parseSettingsHash(window.location.hash));
  const setActiveCategory = useCallback((slug) => {
    const next = SETTINGS_CATEGORIES.some((c) => c.slug === slug) ? slug : 'workspace';
    setActiveCategoryState(next);
    const hash = `#/settings/${next}`;
    if (window.location.hash !== hash) window.location.hash = hash; // D14: echte Historie
  }, []);
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash;
      if (!/^#\/settings(\/|$)/.test(h)) return; // fremde Views nicht anfassen
      setActiveCategoryState(parseSettingsHash(h));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // AC1/AC10: Credential-Status laden (Sichtbarkeits-Steuerung für Unlock-Bereich)
  const reloadCredentialStatus = useCallback(async () => {
    try {
      const status = await fetchCredentialStatus(fetchFn);
      setCredentialStatus(status);
    } catch {
      // Fehler beim Status-Laden: status bleibt null (Unlock-Bereich wird nicht angezeigt)
    }
  }, [fetchFn]);

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

  /**
   * AC3 (workspace-health-hinweis): Fetches health status and updates state.
   * Silenced on error (health block simply stays hidden if endpoint not available).
   */
  const reloadWorkspaceHealth = useCallback(async () => {
    try {
      const data = await fetchWorkspaceHealth(fetchFn);
      setWorkspaceHealth(data);
    } catch {
      // Non-critical: health block stays absent on error (no crash, no error message)
    }
  }, [fetchFn]);

  /**
   * obsidian-vault-config AC1 (UI-Anteil, S-247): Fetches the configured Obsidian-Vault-Pfad
   * + Zustand. Used as onReload callback for ObsidianVaultPathSection.
   */
  const reloadObsidianVaultPath = useCallback(async () => {
    try {
      const data = await fetchObsidianVaultPath(fetchFn);
      setObsidianVaultPath(data);
      setObsidianVaultPathError(null);
    } catch (err) {
      setObsidianVaultPath(null);
      setObsidianVaultPathError(err.message ?? 'Unbekannter Fehler');
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
    reloadWorkspacePath();
    reloadWorkspaceHealth();
    reloadObsidianVaultPath();
    reloadCredentialStatus();
  }, [load, reloadWorkspacePath, reloadWorkspaceHealth, reloadObsidianVaultPath, reloadCredentialStatus]);

  /** Hilfsfunktion: Metadaten eines bestimmten Felds aus der Liste. */
  const getMeta = useCallback((integration, name) => {
    return credentials.find((c) => c.integration === integration && c.name === name);
  }, [credentials]);

  const miscItems = credentials.filter((c) => c.integration === 'misc');

  // AC10: Nach Erfolg Status neu laden; Dialog schließen; Unlock-Bereich verschwindet
  const handleUnlockSuccess = useCallback(async () => {
    setShowUnlockDialog(false);
    await reloadCredentialStatus();
    // Credentials + SSH-Keys neu laden (jetzt entsperrt)
    await load();
  }, [reloadCredentialStatus, load]);

  return (
    <main style={styles.view} aria-label="Einstellungen-Ansicht">
      <div style={styles.inner}>
        {/* AC17: Kopfzeile mit Titel und Zurück-Button */}
        <div style={styles.header}>
          <h1 style={styles.title}>Einstellungen</h1>
          <button
            type="button"
            style={styles.headerBtn}
            onClick={() => onNavigate('panel')}
            aria-label="Zurück zum Einstiegs-Panel"
          >
            ← Zurück
          </button>
        </div>

        {/* AC3: Bitwarden-Unlock-Banner kategorieübergreifend oberhalb von Nav+Content */}
        {credentialStatus !== null && (
          <section aria-labelledby="settings-section-unlock" style={unlockStyles.section}>
            <h2 id="settings-section-unlock" style={unlockStyles.heading}>
              Bitwarden-Verbindung
            </h2>
            {credentialStatus.state === 'unlocked' ? (
              /* AC5: unlocked → "entsperrt" + quellenabhängiger Hinweis; KEIN Verbinden-Button (AC6) */
              <p style={unlockStyles.desc} aria-live="polite">
                {'🔓 entsperrt'}
                {credentialStatus.keySource === 'manual'
                  ? ' (Quelle: via Bitwarden entsperrt)'
                  : ' (Quelle: automatischer Schlüssel)'}
              </p>
            ) : (
              /* AC5: locked → "gesperrt" + Verbinden-Button (AC6) */
              <>
                <p style={unlockStyles.desc} aria-live="polite">
                  {'🔒 gesperrt'}{' — '}
                  {'Der Credential-Store ist gesperrt. Verbinde Bitwarden, um Credentials zu nutzen.'}
                </p>
                <button
                  type="button"
                  onClick={() => setShowUnlockDialog(true)}
                  style={unlockStyles.btnConnect}
                  aria-label="Bitwarden verbinden und Store entsperren"
                >
                  Bitwarden verbinden
                </button>
              </>
            )}
          </section>
        )}

        {/* AC2: Modaler Dialog (role=dialog/aria-modal) */}
        {showUnlockDialog && (
          <BitwardenUnlockDialog
            onSuccess={handleUnlockSuccess}
            onClose={() => setShowUnlockDialog(false)}
            fetchFn={fetchFn}
          />
        )}

        {loadError && (
          <p style={styles.loadError} role="alert" aria-live="polite">
            Credentials konnten nicht geladen werden: {loadError}
          </p>
        )}

        {/* S-267 (D4–D11, D18): linke Kategorien-Nav + genau EIN sichtbares Tabpanel.
            Layout/Zustände (220px-Spalte ab 1024px, horizontale Tab-Leiste darunter,
            Hover/Fokus) leben als CSS-Klassen in client/index.html (D9/D20-Muster). */}
        <div className="settings-layout">
          <nav aria-label="Einstellungs-Kategorien" className="settings-nav">
            <div
              role="tablist"
              aria-orientation="vertical"
              className="settings-tablist"
              onKeyDown={(e) => {
                // D12 (S-269): Pfeiltasten bewegen UND aktivieren sofort (automatic
                // activation); Home/End springen zum ersten/letzten Eintrag. Beide
                // Achsen akzeptiert (vertikale Nav ab 1024px, horizontale Leiste
                // darunter — aria-orientation wechselt nicht dynamisch).
                const idx = SETTINGS_CATEGORIES.findIndex((c) => c.slug === activeCategory);
                let next = null;
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % SETTINGS_CATEGORIES.length;
                else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = SETTINGS_CATEGORIES.length - 1;
                if (next === null) return;
                e.preventDefault();
                const slug = SETTINGS_CATEGORIES[next].slug;
                setActiveCategory(slug); // aktiviert sofort (+ Deep-Link-Hash, S-268)
                document.getElementById(`settings-tab-${slug}`)?.focus(); // Roving-Fokus
              }}
            >
              {SETTINGS_CATEGORIES.map(({ slug, label }) => {
                const selected = activeCategory === slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    role="tab"
                    id={`settings-tab-${slug}`}
                    aria-selected={selected}
                    aria-controls={`settings-panel-${slug}`}
                    tabIndex={selected ? 0 : -1}
                    className={`settings-nav-item${selected ? ' active' : ''}`}
                    onClick={() => setActiveCategory(slug)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </nav>
          <div
            role="tabpanel"
            id={`settings-panel-${activeCategory}`}
            aria-labelledby={`settings-tab-${activeCategory}`}
            tabIndex={0}
            className="settings-panel"
          >
            {activeCategory === 'workspace' && (
        <WorkspaceCategory
                workspacePath={workspacePath}
                workspacePathError={workspacePathError}
                workspaceHealth={workspaceHealth}
                onReload={async () => { await reloadWorkspacePath(); await reloadWorkspaceHealth(); }}
                fetchFn={fetchFn}
              />
            )}
            {activeCategory === 'zugaenge' && (
        <ZugaengeCategory
                sshKeys={sshKeys}
                sshLoadError={sshLoadError}
                setSshKeys={setSshKeys}
                onLoad={load}
                getMeta={getMeta}
              />
            )}
            {activeCategory === 'sicherung' && (
        <SicherungCategory
                credentials={credentials}
                onLoad={load}
                fetchFn={fetchFn}
              />
            )}
            {activeCategory === 'benachrichtigungen' && (
        <BenachrichtigungenCategory
                notificationsCredMeta={getMeta('notifications', 'ntfy_token') ?? null}
                onCredSaved={load}
                fetchFn={fetchFn}
              />
            )}
            {activeCategory === 'automatisierung' && (
        <AutomatisierungCategory
                fetchFn={fetchFn}
              />
            )}
            {activeCategory === 'integrationen' && (
        <IntegrationenCategory
                obsidianVaultPath={obsidianVaultPath}
                obsidianVaultPathError={obsidianVaultPathError}
                onReload={reloadObsidianVaultPath}
                fetchFn={fetchFn}
              />
            )}
            {activeCategory === 'diverses' && (
        <DiversesCategory
                miscItems={miscItems}
                onLoad={load}
              />
            )}
          </div>
        </div>
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
    maxWidth: 1000,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 32,
    gap: 16,
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  headerBtn: {
    padding: '8px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    flexShrink: 0,
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
};

// ── BitwardenUnlockDialog styles (credential-unlock-dialog #185) ──────────────

const unlockStyles = {
  section: {
    marginBottom: 24,
    padding: '16px 20px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  heading: {
    margin: '0 0 8px',
    fontSize: 16,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  desc: {
    margin: '0 0 10px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  btnConnect: {
    padding: '8px 16px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },
};

const unlockDialogStyles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    width: '100%',
    maxWidth: 480,
    margin: '0 16px',
    padding: '24px 28px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    color: '#d4d4d4',
    boxSizing: 'border-box',
  },
  title: {
    margin: '0 0 8px',
    fontSize: 20,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  desc: {
    margin: '0 0 20px',
    fontSize: 13,
    color: '#9ca3af',   // Kontrast ≥ 4.5:1 auf #111
    lineHeight: 1.5,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 13,
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
  input: {
    width: '100%',
    padding: '9px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 14,
    boxSizing: 'border-box',
    minHeight: 44,
  },
  // AC12: Wrapper für Passwort-Feld + Show/Hide-Toggle nebeneinander
  passwordWrapper: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 0,
  },
  // AC12: Passwort-Input im Wrapper (kein width:100% — Toggle-Button daneben)
  inputInWrapper: {
    flex: 1,
    padding: '9px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRight: 'none',
    borderRadius: '4px 0 0 4px',
    fontSize: 14,
    boxSizing: 'border-box',
    minHeight: 44,
  },
  // AC12: Toggle-Button — A11y-konform, Touch-Target ≥ 44 px
  passwordToggle: {
    padding: '0 12px',
    background: '#1e293b',
    color: '#9ca3af',
    border: '1px solid #334155',
    borderLeft: 'none',
    borderRadius: '0 4px 4px 0',
    fontSize: 16,
    cursor: 'pointer',
    minWidth: 44,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fieldError: {
    margin: '2px 0 0',
    fontSize: 12,
    color: '#fca5a5',   // Kontrast auf #111 ≥ 4.5:1
  },
  errorMsg: {
    marginBottom: 16,
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',   // Kontrast ≥ 4.5:1
    fontSize: 13,
    outline: 'none',
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  btnPrimary: {
    padding: '10px 20px',
    background: '#1d4ed8',    // Kontrast #fff/#1d4ed8 ≥ 4.5:1
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: 700,
    minHeight: 44,
  },
  btnSecondary: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnLink: {
    padding: '6px 0',
    background: 'transparent',
    color: '#93c5fd',       // Kontrast auf #111 ≈ 5.8:1
    border: 'none',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    textDecoration: 'underline',
    minHeight: 44,
  },
  createOffer: {
    marginBottom: 16,
    padding: '14px 16px',
    background: '#1a1a0a',
    border: '1px solid #854d0e',
    borderRadius: 6,
  },
  createOfferTitle: {
    margin: '0 0 6px',
    fontSize: 15,
    fontWeight: 700,
    color: '#fde68a',   // Kontrast auf #1a1a0a ≥ 4.5:1 (gelb-orange Warnung)
  },
  createOfferDesc: {
    margin: '0 0 14px',
    fontSize: 13,
    color: '#d4d4d4',
    lineHeight: 1.5,
  },
};
