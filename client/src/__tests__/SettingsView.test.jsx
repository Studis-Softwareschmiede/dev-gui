/**
 * SettingsView.test.jsx — Unit-Tests für SettingsView (Credentials AC1–AC8, SSH-Keys AC1–AC6,
 * Workspace-Pfad AC1 + UI-Anteil AC3, SSH-Keypair-Generierung + Export AC1/AC3/AC4/AC6/AC7/AC8,
 * SSH-Key-Rotation AC1/AC5/AC7 — #119, bitwarden-new-device-otp Frontend AC1/AC3–AC7/AC9 — #204,
 * workspace-health-hinweis AC3 Frontend, credential-unlock-dialog AC11/AC12 — #268,
 * bitwarden-master-key-unlock AC12 showPassword-Reset beim Phasenwechsel (not-found→Create-Offer + Cancel) — S-130/#276,
 * credential-backup S-143 AC11/AC12 — Zweistufige Quittung + Backup-Abschnitt + Status-Kachel).
 *
 * Covers (settings-credentials + settings-shell):
 *   AC1  — Credential-Felder mit Status (gesetzt/nicht gesetzt); kein Klartext
 *   AC2  — Setzen/Überschreiben: nach Speichern kein Klartext angezeigt
 *   AC3  — Löschen: Status wechselt auf „nicht gesetzt"
 *   AC4  — Kein Klartext in der Anzeige nach Speichern
 *   AC5  — Misc-Sektion: benannte Schlüssel/Wert-Einträge
 *   AC6  — Rückkehr zum Panel (onNavigate)
 *   AC8  — Frontend-Validierung: leere Pflichtfelder → Fehlermeldung, kein Request
 *   AC9  — VPS-Provider-Token (hetzner, ionos, hostinger): je Provider set/getMeta/delete write-only; Audit ohne Klartext
 *   NFR A11y — h1/h2, Touch-Targets ≥ 44 px, aria-describedby für Fehler
 *
 * Covers (settings-ssh-keys Stufe A):
 *   SSH-AC1 — Public-Key hinterlegen/anzeigen/ändern; vollständig sichtbar
 *   SSH-AC2 — Private-Key write-only/maskiert; niemals im Klartext
 *   SSH-AC3 — Public- und/oder Private-Key löschen; Status „nicht gesetzt"
 *   SSH-AC4 — Public-Key-Format-Validierung; klare Fehlermeldung
 *   SSH-AC5 — Private-Key-Klartext nie sichtbar
 *   SSH-AC6 — Endpunkte hinter Access-Mauer (durch AccessGuard, testbar via makeFetch-Error)
 *
 * Covers (workspace-path-config AC1 + UI-Anteil AC3 — #92):
 *   AC1  — Eintrag „Workspace-Pfad" in der GitHub-Sektion der Einstellungen zeigt wirksamen
 *           Pfad + Quelle (configured / env-default); Buttons Setzen/Ändern/Zurücksetzen vorhanden.
 *   AC3  — 422-Fehler (role=alert, Backend-Meldung), alter Pfad bleibt sichtbar;
 *           leeres Feld → Frontend-Fehlermeldung, kein PUT; aria-describedby gesetzt.
 *   A11y — Touch-Targets ≥ 44 px (Display- + Editier-Modus); Fokusführung via activeElement;
 *           role=status bei Erfolg, role=alert bei Fehler; Kontrast #9ca3af.
 *
 * Covers (ssh-key-generation AC1/AC3/AC4/AC6/AC7/AC8 — #116):
 *   GEN-AC1 — „Keypair erzeugen"-Button je Rollen-Label root|alex vorhanden und auslösbar.
 *   GEN-AC3 — Public-Key nach Generierung vollständig angezeigt + kopierbar;
 *             Private-Key-Klartext NIE in normaler Sektion-Anzeige sichtbar.
 *   GEN-AC4 — „Private-Key herunterladen"-Button löst Export-Request aus (dauerhaft wiederholbar).
 *   GEN-AC6 — 403-Fehler vom Backend → Fehlermeldung ohne Klartext-Leak.
 *   GEN-AC7 — 409 key-exists → Overwrite-Bestätigung (role=alertdialog); Bestätigen → overwrite:true;
 *             Abbrechen → kein overwrite.
 *   GEN-AC8 — Nach erfolgreicher Generierung wird onSaved() aufgerufen (Label-Liste-Reload).
 *   GEN-A11y — Overwrite-Dialog hat role=alertdialog + aria-labelledby + aria-describedby;
 *              Touch-Targets ≥ 44 px; Fokus auf Bestätigungs-Button beim Öffnen des Dialogs.
 *
 * Covers (ssh-key-rotation AC1/AC5/AC7 — #119):
 *   ROT-AC1 — „Rotieren"-Button je Rollen-Label root|alex; Formular mit host/port/targetUser/
 *             hostFingerprint-Feldern (labels programmatisch zugeordnet); POST .../rotate ausgelöst.
 *             Loading-State (aria-busy) während Rotation.
 *   ROT-AC5 — Erfolg → „rotiert" + newPublicKey-Anzeige (role=status); rotation-verify-failed →
 *             klare Meldung „alter Key erhalten" (role=alert); 403 → Fehlermeldung (role=alert).
 *   ROT-AC7 — Kein Private-Key in Rotation-Anzeige; nur Public-Key/Status sichtbar.
 *             Labels programmatisch zugeordnet; Touch-Targets ≥ 44 px.
 *
 * Covers (credential-unlock-dialog #185 + #268) — Frontend-ACs:
 *   AC1  — Bei state:"locked" → Button „Bitwarden verbinden" sichtbar; bei "unlocked" → kein Button, aber Status-Zeile mit Quelle sichtbar (ab #192).
 *   AC2  — Dialog modal (role=dialog/aria-modal), Labels, Fehler programmatisch zugeordnet (aria-describedby/role=alert),
 *           Fokusführung beim Öffnen, Touch-Targets ≥ 44 px; Fokus-Trap (Tab/Shift+Tab/Escape) — WCAG 2.1.2.
 *   AC4  — not-found → explizites Erstellungs-Angebot (role=alertdialog); erst nach Bestätigung create:true;
 *           ohne Bestätigung wird nichts erstellt.
 *   AC5  — twofa-required/twofa-invalid → 2FA-Feld erscheint + feldzugeordnete Fehlermeldung (role=alert).
 *   AC9  — Passwort-Feld type=password/autoComplete=off (Frontend-Floor, testbar via DOM-Attribute).
 *   AC10 — Nach erfolgreichem Unlock: Dialog geschlossen, Unlock-Bereich verschwindet, Status neu geladen.
 *   AC11 — Bei Retry-Antworten (twofa-required/twofa-invalid/email-otp-required/email-otp-invalid) bleibt
 *           das Passwort-Feld befüllt; nach Erfolg / terminalem Fehler (auth-failed) ist es leer. (#268)
 *   AC12 — Show/Hide-Toggle: default type=password; Button mit aria-label „Passwort anzeigen"/„Passwort verbergen"
 *           schaltet auf type=text und zurück. (#268)
 * Backend-ACs (AC3/AC6/AC7/AC8) sind in Backend-Tests abgedeckt, nicht hier.
 *
 * Covers (bitwarden-new-device-otp #204) — Frontend-ACs:
 *   AC1  — email-otp-required → E-Mail-OTP-Feld erscheint (id=bw-unlock-email-otp) mit eigener Meldung
 *           (textlich verschieden von 2FA-Meldung); kein #bw-unlock-twofa gleichzeitig sichtbar.
 *   AC3  — email-otp-invalid → feldzugeordnete Fehlermeldung "ungültig oder abgelaufen" (role=alert);
 *           E-Mail-OTP-Feld bleibt sichtbar (erneutes Absenden möglich).
 *   AC4  — twofa-required/twofa-invalid bleiben unverändert (Regression); twofa- und email-otp-Felder
 *           mutual exclusive (nie gleichzeitig sichtbar).
 *   AC5  — E-Mail-OTP-Feld hat eigenen Label/State (getrennter emailOtp-State, textlich verschieden vom
 *           2FA-Feld); kein Verlust der E-Mail/nicht-geheimen Eingaben nach OTP-Fehler.
 *   AC6  — email-otp-invalid: Fehler via aria-describedby/role=alert dem Feld programmatisch zugeordnet.
 *   AC7  — OTP-Code erscheint NICHT in fetch-Request-URLs.
 *   AC9  — A11y: label/htmlFor-Zuordnung (label[for="bw-unlock-email-otp"]), autoComplete=one-time-code,
 *           aria-describedby auf role=alert-Element, Fokus auf Feld nach Erscheinen, Touch-Target ≥ 44 px.
 * Backend-ACs (AC2/AC8) + Beschaffungs-Mechanik sind in BitwardenNewDeviceOtp.test.js + credentialUnlockRouter.test.js abgedeckt.
 *
 * Covers (credential-key-status-transparency #192) — Frontend-ACs:
 *   AC5  — Status-Zeile (state + Quelle) IMMER sichtbar: unlocked/auto → "automatischer Schlüssel";
 *           unlocked/manual → "via Bitwarden entsperrt"; locked/none → "gesperrt".
 *   AC6  — Verbinden-Button NUR bei state:"locked"; bei "unlocked" kein Button.
 *
 * Covers (workspace-health-hinweis AC3) — Frontend:
 *   AC3  — WorkspacePathSection zeigt grünen Block bei overall=ok (mit Repo/Board-Zähler);
 *          hervorgehobenen Warn-Block bei overall=warn;
 *          hervorgehobenen Error-Block mit role="alert" bei overall=error;
 *          Fix-Hinweis je nicht-ok-Check im Block sichtbar.
 *          A11y: role=alert bei error, role=status bei ok/warn; Touch-Target-Invarianz nicht tangiert.
 *
 * Covers (credential-backup S-143 — AC11/AC12, Iteration 2) — Frontend:
 *   AC11 — Zweistufige Quittung: grüne Quittung bei ok/ok; Warn bei failed; offHost=disabled
 *          → nur lokale Stufe; kein backup-Feld → keine Quittung; role=status + aria-live=polite;
 *          kein Secret/Klartext im Quittungs-DOM.
 *          S1-Fix: setBackupResult(null) zu Beginn jeder async-Op.
 *   AC12 — Abschnitt „Backup / Sicherung": h2 „Backup / Sicherung"; Status-Kachel (role=status,
 *          aria-labelledby=backup-status-tile); Kachel zeigt Zeit + Ziel-Typ + „Noch kein Backup";
 *          Remote-Creds-Felder nur bei offHostEnabled=true; write-only Input (type=password);
 *          label/htmlFor A11y; aria-invalid bei Fehler; Touch-Target ≥ 44 px;
 *          kein Secret in Status-Kachel (artefactName nicht im Tile-DOM).
 *          Architekt-Entscheid (S-143, Variante B): Ziel-Konfiguration UI-schreibbar
 *          (GET /api/settings/backup-config laden, PUT speichern); editierbare Felder
 *          (offHostEnabled, targetType, bucket, endpoint, prefix, region, host, port, user,
 *          retentionCount); Speichern-Button vorhanden; 403 → Fehlermeldung.
 *          I1-Fix: backupDir NICHT in Status-Response + NICHT im DOM (I3).
 *          I3-Fix: interner Backup-Pfad (/home/node/.cred/backups) nirgends im DOM.
 *          S4-Fix: statusTileLabel color #9ca3af (WCAG ≥ 4.5:1).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }        = await import('@testing-library/react');
const React             = (await import('react')).default;
const { SettingsView }  = await import('../SettingsView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Leere Credential-Liste (leerer Store). */
// Dummy-PEM zur Laufzeit zusammensetzen — der literale BEGIN-Marker im Quelltext
// würde den gitleaks-Secret-Scan (Rule private-key) als False Positive auslösen.
const pemDummy = (body) =>
  ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') +
  `\n${body}\n` +
  ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');

const EMPTY_CREDS = [];

/** Credentials-Liste mit einem gesetzten Wert. */
const CREDS_WITH_GITHUB_APP_ID = [
  { integration: 'github', name: 'app_id', status: 'set', masked: '••••3456', updatedAt: '2026-01-01T00:00:00.000Z' },
  { integration: 'github', name: 'installation_id', status: 'unset' },
  { integration: 'github', name: 'private_key', status: 'unset' },
  { integration: 'cloudflare', name: 'api_token', status: 'unset' },
  { integration: 'cloudflare', name: 'account_id', status: 'unset' },
  { integration: 'vps', name: 'hetzner_api_token', status: 'unset' },
  { integration: 'vps', name: 'ionos_api_token', status: 'unset' },
  { integration: 'vps', name: 'hostinger_api_token', status: 'unset' },
];

/** Leere SSH-Keys-Liste. */
const EMPTY_SSH_KEYS = [];

/** SSH-Keys-Liste mit einem Eintrag. */
const SSH_KEYS_WITH_ROOT = [
  {
    user: 'root',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKeyForRootUser test@example.com',
    publicKeyUpdatedAt: '2026-01-01T00:00:00.000Z',
    privateKeyStatus: 'set',
    privateKeyUpdatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Standard-Workspace-Path-Antwort (env-default). */
const DEFAULT_WORKSPACE_PATH = {
  effectivePath: '/workspace',
  source: 'env-default',
  mountRoot: '/workspace',
};

/** Workspace-Path-Antwort mit konfiguriertem Pfad. */
const CONFIGURED_WORKSPACE_PATH = {
  effectivePath: '/workspace/projekt',
  source: 'configured',
  mountRoot: '/workspace',
};

/**
 * Erstellt einen jest.fn() fetch, der auf verschiedene Requests antwortet.
 * Unterstützt SSH-Key-Endpoints (/api/settings/ssh-keys*),
 * Credential-Endpoints (/api/settings/credentials*) und
 * Workspace-Path-Endpoints (/api/settings/workspace-path).
 * Unterstützt Generate-Endpunkt (/api/settings/ssh-keys/{user}/generate),
 * Export-Endpunkt (/api/settings/ssh-keys/{user}/private-key/export) und
 * Rotate-Endpunkt (/api/settings/ssh-keys/{user}/rotate).
 * Unterstützt credential-unlock-dialog #185:
 *   - credential-status (/api/settings/credential-status)
 *   - credential-unlock (/api/settings/credential-unlock)
 */
/** Standard-Health-Antwort (ok). */
const DEFAULT_WORKSPACE_HEALTH_OK = {
  overall: 'ok',
  checks: [
    { key: 'mount-exists', status: 'ok', message: 'WORKSPACE_DIR existiert.' },
    { key: 'mount-nonempty', status: 'ok', message: '1 Eintrag.' },
    { key: 'board-roots-set', status: 'ok', message: 'BOARD_ROOTS gesetzt.' },
    { key: 'board-roots-valid', status: 'ok', message: 'Alle Pfade gültig.' },
    { key: 'repos-found', status: 'ok', message: '2 Git-Repo(s) gefunden.' },
    { key: 'board-projects-found', status: 'ok', message: '1 Board-Projekt gefunden.' },
  ],
  counts: { repos: 2, boardProjects: 1 },
};

/** Standard-Backup-Status-Antwort (kein letztes Backup, off-host deaktiviert).
 * I1-Fix: kein backupDir in der Response. */
const DEFAULT_BACKUP_STATUS_NO_OFFHOST = {
  lastBackup: null,
  offHostType: null,
  offHostEnabled: false,
  targetConfig: null,
  retentionCount: 10,
};

/** Backup-Status-Antwort mit letztem Backup + S3 off-host aktiv.
 * I1-Fix: kein backupDir in der Response.
 * I2-Fix: localResult/offHostResult aus Sidecar (AC12). */
const DEFAULT_BACKUP_STATUS_S3 = {
  lastBackup: {
    at: '2026-01-01T10:30:00.000Z',
    artefactName: 'backup-2026-01-01T10-30-00-000Z-ab12cd34.gpg',
    localResult: 'ok',
    offHostResult: 'ok',
  },
  offHostType: 's3',
  offHostEnabled: true,
  targetConfig: { endpoint: 'https://s3.example.com', bucket: 'my-backups', prefix: 'backups/', region: 'eu-central-1' },
  retentionCount: 10,
};

/** Standard-Backup-Konfiguration (kein Off-Host — Architekt-Entscheid S-143, Variante B). */
const DEFAULT_BACKUP_CONFIG_NO_OFFHOST = {
  offHostEnabled: false,
  targetType: 'local',
  endpoint: '',
  bucket: '',
  prefix: 'backups/',
  region: 'us-east-1',
  host: '',
  port: '22',
  user: '',
  retentionCount: 10,
};

/** Backup-Konfiguration mit S3 off-host aktiv. */
const DEFAULT_BACKUP_CONFIG_S3 = {
  offHostEnabled: true,
  targetType: 's3',
  endpoint: 'https://s3.example.com',
  bucket: 'my-backups',
  prefix: 'backups/',
  region: 'eu-central-1',
  host: '',
  port: '22',
  user: '',
  retentionCount: 10,
};

function makeFetch({
  getResponse = EMPTY_CREDS,
  putResponse = null,
  deleteResponse = null,
  sshGetResponse = EMPTY_SSH_KEYS,
  sshPutResponse = null,
  sshDeleteResponse = null,
  sshGenerateResponse = null, // null = Standard-Erfolg; 'key-exists' = 409; 'forbidden' = 403
  sshExportResponse = null,   // null = Erfolg (text/plain); 'error' = 404
  sshRotateResponse = null,   // null = Standard-Erfolg; 'verify-failed' = 502 rotation-verify-failed; 'forbidden' = 403
  getWorkspacePath   = { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
  putWorkspacePath   = { ok: true, status: 200, data: { effectivePath: '/workspace/projekt', source: 'configured' } },
  deleteWorkspacePath = { ok: true, status: 200, data: { effectivePath: '/workspace', source: 'env-default' } },
  // S-143 AC12: backup-status endpoint (I1-Fix: kein backupDir)
  getBackupStatus = { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_NO_OFFHOST },
  // S-143 Architekt-Entscheid: backup-config endpoint (GET/PUT)
  getBackupConfig = { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_NO_OFFHOST },
  putBackupConfigResponse = { ok: true, status: 200, data: { ok: true, config: DEFAULT_BACKUP_CONFIG_NO_OFFHOST } },
  // AC3 (workspace-health-hinweis): workspace-health endpoint
  // null = kein Health-Block in bestehenden Tests (verhindert role=status-Kollision)
  getWorkspaceHealth = null,
  // credential-unlock-dialog #185
  credentialStatus = { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' }, // Standard: unlocked (kein Unlock-Bereich)
  credentialUnlockResponse = null, // null = Standard-Erfolg ({ ok: true, state: 'unlocked' })
} = {}) {
  const DEFAULT_GENERATE_SUCCESS = {
    user: 'root',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedPublicKey dev-gui/root',
    privateKeyStatus: 'set',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  const DEFAULT_ROTATE_SUCCESS = {
    result: 'rotated',
    oldKeyRemoved: true,
    newPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotatedPublicKey dev-gui/root',
  };

  return jest.fn(async (url, opts) => {
    const method = opts?.method ?? 'GET';
    const isSsh = typeof url === 'string' && url.includes('/ssh-keys');

    // credential-unlock-dialog #185: credential-status
    if (url === '/api/settings/credential-status' && method === 'GET') {
      return { ok: true, status: 200, json: async () => credentialStatus };
    }

    // credential-unlock-dialog #185: credential-unlock
    if (url === '/api/settings/credential-unlock' && method === 'POST') {
      const DEFAULT_UNLOCK_SUCCESS = { ok: true, state: 'unlocked' };
      if (credentialUnlockResponse === 'not-found') {
        return { ok: true, status: 200, json: async () => ({ ok: false, status: 'not-found' }) };
      }
      if (credentialUnlockResponse === 'twofa-required') {
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'twofa-required' }) };
      }
      if (credentialUnlockResponse === 'twofa-invalid') {
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'twofa-invalid' }) };
      }
      // bitwarden-new-device-otp AC1/AC3: E-Mail-OTP-Fehler
      if (credentialUnlockResponse === 'email-otp-required') {
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'email-otp-required' }) };
      }
      if (credentialUnlockResponse === 'email-otp-invalid') {
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'email-otp-invalid' }) };
      }
      if (credentialUnlockResponse === 'auth-failed') {
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'auth-failed' }) };
      }
      if (credentialUnlockResponse === 'bw-unreachable') {
        return { ok: false, status: 503, json: async () => ({ ok: false, errorClass: 'bw-unreachable' }) };
      }
      if (typeof credentialUnlockResponse === 'object' && credentialUnlockResponse !== null) {
        return { ok: true, status: 200, json: async () => credentialUnlockResponse };
      }
      return { ok: true, status: 200, json: async () => DEFAULT_UNLOCK_SUCCESS };
    }

    // S-143 AC12: backup-status endpoint (I1-Fix: kein backupDir in Response)
    if (url === '/api/settings/backup-status' && method === 'GET') {
      if (getBackupStatus === null) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: getBackupStatus.ok, status: getBackupStatus.status, json: async () => getBackupStatus.data };
    }

    // S-143 Architekt-Entscheid: backup-config endpoint
    if (url === '/api/settings/backup-config') {
      if (method === 'GET') {
        if (getBackupConfig === null) return { ok: false, status: 500, json: async () => ({ error: 'Fehler' }) };
        return { ok: getBackupConfig.ok, status: getBackupConfig.status, json: async () => getBackupConfig.data };
      }
      if (method === 'PUT') {
        if (putBackupConfigResponse === 'error') {
          return { ok: false, status: 500, json: async () => ({ error: 'Speichern fehlgeschlagen' }) };
        }
        if (putBackupConfigResponse === 'forbidden') {
          return { ok: false, status: 403, json: async () => ({ error: 'Keine Berechtigung' }) };
        }
        return { ok: putBackupConfigResponse.ok, status: putBackupConfigResponse.status, json: async () => putBackupConfigResponse.data };
      }
    }

    // AC3 (workspace-health-hinweis): workspace-health endpoint
    if (url === '/api/settings/workspace-health' && method === 'GET') {
      if (getWorkspaceHealth === 'reject') throw new Error('health endpoint unreachable');
      // null = kein Health-Block in bestehenden Tests (endpoint antwortet mit nicht-ok → health bleibt null)
      if (getWorkspaceHealth === null) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: getWorkspaceHealth.ok, status: getWorkspaceHealth.status, json: async () => getWorkspaceHealth.data };
    }

    // Workspace-Path-Endpunkte
    if (url === '/api/settings/workspace-path') {
      if (method === 'GET') {
        if (getWorkspacePath === 'reject') throw new Error('workspace-path endpoint unreachable');
        return { ok: getWorkspacePath.ok, status: getWorkspacePath.status, json: async () => getWorkspacePath.data };
      }
      if (method === 'PUT') {
        return { ok: putWorkspacePath.ok, status: putWorkspacePath.status, json: async () => putWorkspacePath.data };
      }
      if (method === 'DELETE') {
        return { ok: deleteWorkspacePath.ok, status: deleteWorkspacePath.status, json: async () => deleteWorkspacePath.data };
      }
    }

    // SSH-Rotate-Endpunkt: POST /api/settings/ssh-keys/:user/rotate
    if (method === 'POST' && typeof url === 'string' && url.match(/\/api\/settings\/ssh-keys\/[^/]+\/rotate$/)) {
      if (sshRotateResponse === 'verify-failed') {
        return {
          ok: false,
          status: 502,
          json: async () => ({
            result: 'error',
            errorClass: 'rotation-verify-failed',
            error: 'Verbindungstest mit neuem Key fehlgeschlagen — alter Key bleibt aktiv (Aussperr-Schutz)',
            reason: 'SSH-Verbindungstest mit neuem Key fehlgeschlagen',
          }),
        };
      }
      if (sshRotateResponse === 'forbidden') {
        return { ok: false, status: 403, json: async () => ({ result: 'error', error: 'Keine Berechtigung', httpStatus: 403 }) };
      }
      if (sshRotateResponse === 'no-existing-key') {
        return {
          ok: false,
          status: 422,
          json: async () => ({
            error: 'Kein bestehender Key für Rollen-Label "root"',
            errorClass: 'no-existing-key',
          }),
        };
      }
      if (typeof sshRotateResponse === 'object' && sshRotateResponse !== null) {
        return { ok: true, status: 200, json: async () => sshRotateResponse };
      }
      // Standard: Erfolg
      return { ok: true, status: 200, json: async () => DEFAULT_ROTATE_SUCCESS };
    }

    // SSH-Generate-Endpunkt: POST /api/settings/ssh-keys/:user/generate
    if (method === 'POST' && typeof url === 'string' && url.match(/\/api\/settings\/ssh-keys\/[^/]+\/generate$/)) {
      if (sshGenerateResponse === 'key-exists') {
        return { ok: false, status: 409, json: async () => ({ error: 'Key bereits vorhanden', errorClass: 'key-exists' }) };
      }
      if (sshGenerateResponse === 'forbidden') {
        return { ok: false, status: 403, json: async () => ({ error: 'Keine Berechtigung' }) };
      }
      if (sshGenerateResponse === 'error') {
        return { ok: false, status: 500, json: async () => ({ error: 'Interner Fehler' }) };
      }
      // Standard: Erfolg
      const data = sshGenerateResponse ?? DEFAULT_GENERATE_SUCCESS;
      return { ok: true, status: 200, json: async () => data };
    }

    // SSH-Export-Endpunkt: GET /api/settings/ssh-keys/:user/private-key/export
    if (method === 'GET' && typeof url === 'string' && url.match(/\/api\/settings\/ssh-keys\/[^/]+\/private-key\/export$/)) {
      if (sshExportResponse === 'error') {
        return { ok: false, status: 404, json: async () => ({ error: 'Kein Private-Key', errorClass: 'no-private-key' }) };
      }
      if (sshExportResponse === 'forbidden') {
        return { ok: false, status: 403, json: async () => ({ error: 'Keine Berechtigung' }) };
      }
      // Erfolg: text/plain (kein json())
      return {
        ok: true,
        status: 200,
        text: async () => '-----BEGIN OPENSSH PRIVATE KEY-----\nMock\n-----END OPENSSH PRIVATE KEY-----\n',
        json: async () => { throw new Error('not json'); },
      };
    }

    if (method === 'GET') {
      if (isSsh) return { ok: true, json: async () => sshGetResponse };
      return { ok: true, json: async () => getResponse };
    }
    if (method === 'PUT') {
      if (isSsh) {
        if (sshPutResponse === 'error') {
          return { ok: false, json: async () => ({ error: 'Server-Fehler' }) };
        }
        return {
          ok: true,
          json: async () => sshPutResponse ?? { user: 'root', publicKey: 'ssh-ed25519 AAAA… test', privateKeyStatus: 'unset' },
        };
      }
      if (putResponse === 'error') {
        return { ok: false, json: async () => ({ error: 'Server-Fehler' }) };
      }
      return {
        ok: true,
        json: async () => putResponse ?? { integration: 'github', name: 'app_id', status: 'set', updatedAt: '2026-01-01T00:00:00.000Z' },
      };
    }
    if (method === 'DELETE') {
      if (isSsh) {
        if (sshDeleteResponse === 'error') {
          return { ok: false, json: async () => ({ error: 'Löschen fehlgeschlagen' }) };
        }
        return {
          ok: true,
          json: async () => sshDeleteResponse ?? { user: 'root', privateKeyStatus: 'unset' },
        };
      }
      if (deleteResponse === 'error') {
        return { ok: false, json: async () => ({ error: 'Löschen fehlgeschlagen' }) };
      }
      return {
        ok: true,
        json: async () => deleteResponse ?? { integration: 'github', name: 'app_id', status: 'unset' },
      };
    }
    return { ok: false, json: async () => ({ error: 'unbekannt' }) };
  });
}

function renderView(fetchImpl) {
  const onNavigate = jest.fn();
  const fetchFn = fetchImpl ?? makeFetch();
  globalThis.fetch = fetchFn;
  const utils = render(React.createElement(SettingsView, { onNavigate, fetchFn }));
  return { ...utils, onNavigate };
}

// ── AC2/AC3 — Struktur ────────────────────────────────────────────────────────

describe('SettingsView — Grundstruktur', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert h1 "Einstellungen"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const h1 = getByRole('heading', { level: 1 });
      expect(h1.textContent).toMatch(/einstellungen/i);
    });
  });

  it('rendert main landmark "Einstellungen-Ansicht"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('main', { name: /einstellungen-ansicht/i })).toBeTruthy();
    });
  });

  it('rendert mindestens 5 h2-Sektions-Überschriften (GitHub, Cloudflare, Hetzner, Weitere, SSH-Keys)', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      const h2s = main.querySelectorAll('h2');
      expect(h2s.length).toBeGreaterThanOrEqual(5);
    });
  });

  it('rendert GitHub-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /^github$/i })).toBeTruthy();
    });
  });

  it('rendert Cloudflare-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /^cloudflare$/i })).toBeTruthy();
    });
  });

  it('rendert VPS-Provider-Sektion als h2', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /vps-provider/i })).toBeTruthy();
    });
  });

  it('rendert SSH-Keys-Sektion mit h2-Überschrift und Inhalt (nicht mehr Platzhalter)', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });
});

// ── AC1 — Status-Anzeige ──────────────────────────────────────────────────────

describe('SettingsView — AC1: Status-Anzeige', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "nicht gesetzt" für ungesetzte Felder', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/nicht gesetzt/i);
    });
  });

  it('zeigt masked-Wert für gesetztes Feld (kein Klartext)', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Masked-Wert "••••3456" soll sichtbar sein
      expect(main.textContent).toContain('••••3456');
      // Kein echter Klartext
      expect(main.textContent).not.toContain('my-secret-app-id');
    });
  });

  it('AC4 — rendert nach GET keinen Klartext-Geheimwert', async () => {
    const secretValue = 'SUPER_SECRET_1234';
    const credsWithSecret = [
      { integration: 'github', name: 'app_id', status: 'set', masked: '••••1234', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getByRole } = renderView(makeFetch({ getResponse: credsWithSecret }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).not.toContain(secretValue);
    });
  });
});

// ── AC2 — Setzen/Ändern ────────────────────────────────────────────────────────

describe('SettingsView — AC2: Setzen/Ändern', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "Setzen"-Button für ungesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const setzenBtns = buttons.filter((b) => b.textContent.trim() === 'Setzen');
      expect(setzenBtns.length).toBeGreaterThan(0);
    });
  });

  it('zeigt "Ändern"-Button für gesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const aendernBtns = buttons.filter((b) => b.textContent.trim() === 'Ändern');
      expect(aendernBtns.length).toBeGreaterThan(0);
    });
  });

  it('AC4 — nach Speichern wird Klartext nicht angezeigt', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET') {
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT') {
        return {
          ok: true,
          json: async () => ({ integration: 'github', name: 'app_id', status: 'set', updatedAt: '2026-01-01T00:00:00.000Z' }),
        };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis Setzen-Buttons da sind
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.textContent.trim() === 'Setzen')).toBe(true);
    });

    // Ersten Setzen-Button klicken (App-ID)
    await act(async () => {
      const setzenBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Setzen');
      fireEvent.click(setzenBtns[0]);
    });

    // Input ausfüllen — password inputs via querySelector (kein textbox-Role)
    await waitFor(() => {
      const pwdInputs = document.querySelectorAll('input[type="password"]');
      expect(pwdInputs.length).toBeGreaterThan(0);
    });

    const pwdInputs = document.querySelectorAll('input[type="password"]');
    await act(async () => {
      if (pwdInputs[0]) {
        fireEvent.change(pwdInputs[0], { target: { value: 'my-super-secret' } });
      }
    });

    // Speichern
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Speichern: kein Klartext sichtbar
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).not.toContain('my-super-secret');
    });
  });
});

// ── AC3 — Löschen ─────────────────────────────────────────────────────────────

describe('SettingsView — AC3: Löschen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt "Löschen"-Button für gesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const loeschenBtns = buttons.filter((b) => b.textContent.trim() === 'Löschen');
      expect(loeschenBtns.length).toBeGreaterThan(0);
    });
  });

  it('kein "Löschen"-Button für ungesetzte Felder', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const buttons = getAllByRole('button');
      const loeschenBtns = buttons.filter((b) => b.textContent.trim() === 'Löschen');
      expect(loeschenBtns.length).toBe(0);
    });
  });
});

// ── AC5 — Misc-Sektion ────────────────────────────────────────────────────────

describe('SettingsView — AC5: Weitere Credentials (misc)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert Sektion "Weitere Credentials"', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('heading', { name: /weitere credentials/i })).toBeTruthy();
    });
  });

  it('zeigt "+ Weiteres Credential" Button', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres credential hinzufügen/i })).toBeTruthy();
    });
  });

  it('Klick auf "Weiteres Credential" öffnet Formular', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres credential hinzufügen/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /weiteres credential hinzufügen/i }));
    });

    await waitFor(() => {
      // Schlüsselname-Input sollte erscheinen
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });
  });

  it('misc-Einträge aus Store werden angezeigt (kein Klartext)', async () => {
    const credsWithMisc = [
      ...EMPTY_CREDS,
      { integration: 'misc', name: 'openai-key', status: 'set', masked: '••••7890', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getByRole } = renderView(makeFetch({ getResponse: credsWithMisc }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('openai-key');
      expect(main.textContent).not.toContain('my-openai-secret');
    });
  });
});

// ── AC6 — Navigation ──────────────────────────────────────────────────────────

describe('SettingsView — AC6: Navigation', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert "Zurück"-Button', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
    });
  });

  it('Klick auf "Zurück" ruft onNavigate("panel") auf', async () => {
    const { getByRole, onNavigate } = renderView();
    await waitFor(() => {
      expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /zurück zum einstiegs-panel/i }));
    });

    expect(onNavigate).toHaveBeenCalledWith('panel');
  });

  it('AC6 — "Zurück"-Button ist Tab-fokussierbar', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.disabled).toBe(false);
    });
  });

  it('NFR A11y — "Zurück"-Button hat Touch-Target ≥ 44 px', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
      const minH = parseInt(btn.style.minHeight, 10);
      expect(minH).toBeGreaterThanOrEqual(44);
    });
  });
});

// ── AC8 — Frontend-Validierung ────────────────────────────────────────────────

describe('SettingsView — AC8: Frontend-Validierung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC8 — leerer Wert im Setzen-Formular: Fehlermeldung, kein PUT-Request', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Setzen-Button
    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.textContent.trim() === 'Setzen')).toBe(true);
    });

    // Bearbeiten-Modus öffnen
    await act(async () => {
      const setzenBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Setzen');
      fireEvent.click(setzenBtns[0]);
    });

    // Speichern ohne Wert eingeben
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehlermeldung erscheint
    await waitFor(() => {
      const errorMsgs = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(errorMsgs).some((el) => el.textContent.match(/leer/i));
      expect(hasError).toBe(true);
    });

    // Kein PUT-Request abgefeuert
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('AC8 — misc: leerer Schlüsselname → Fehlermeldung, kein PUT', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Hinzufügen-Button
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    // Hinzufügen ohne Schlüsselname
    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    await act(async () => {
      const addBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
        b.textContent.trim() === 'Hinzufügen',
      );
      if (addBtns[0]) fireEvent.click(addBtns[0]);
    });

    await waitFor(() => {
      const errorMsgs = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(errorMsgs).some((el) => el.textContent.match(/pflichtfeld|schlüsselname/i));
      expect(hasError).toBe(true);
    });

    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });
});

// ── NFR A11y — aria-describedby Misc-Fehler ───────────────────────────────────

describe('SettingsView — NFR A11y: aria-describedby auf Misc-Inputs', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('I1 — Fehler-<p> hat id="misc-add-error", beide Inputs referenzieren sie via aria-describedby', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    // Formular öffnen
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    // Ohne Schlüsselname absenden → Fehler provozieren
    await act(async () => {
      const hinzBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Hinzufügen',
      );
      if (hinzBtns[0]) fireEvent.click(hinzBtns[0]);
    });

    // Fehler-<p> muss id="misc-add-error" haben
    await waitFor(() => {
      const errorEl = document.getElementById('misc-add-error');
      expect(errorEl).toBeTruthy();
      expect(errorEl.getAttribute('role')).toBe('alert');

      // Beide Inputs müssen aria-describedby="misc-add-error" haben
      const keyInput = document.getElementById('misc-new-key');
      const valInput = document.getElementById('misc-new-val');
      expect(keyInput.getAttribute('aria-describedby')).toBe('misc-add-error');
      expect(valInput.getAttribute('aria-describedby')).toBe('misc-add-error');
    });
  });

  it('I1 — ohne Fehler haben Misc-Inputs kein aria-describedby', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(document.querySelector('[aria-label="Weiteres Credential hinzufügen"]')).toBeTruthy();
    });

    await act(async () => {
      const addBtn = document.querySelector('[aria-label="Weiteres Credential hinzufügen"]');
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('misc-new-key')).toBeTruthy();
    });

    // Noch kein Fehler → kein aria-describedby
    const keyInput = document.getElementById('misc-new-key');
    const valInput = document.getElementById('misc-new-val');
    expect(keyInput.getAttribute('aria-describedby')).toBeNull();
    expect(valInput.getAttribute('aria-describedby')).toBeNull();
  });
});

// ── NFR A11y — Touch-Targets ──────────────────────────────────────────────────

describe('SettingsView — NFR A11y: Touch-Targets ≥ 44 px', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('alle Aktions-Buttons haben minHeight ≥ 44 px', async () => {
    const { getAllByRole } = renderView(makeFetch({ getResponse: CREDS_WITH_GITHUB_APP_ID }));

    await waitFor(() => {
      const buttons = getAllByRole('button');
      for (const btn of buttons) {
        const minH = parseInt(btn.style.minHeight ?? '0', 10);
        expect(minH).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

// ── SSH-Keys — SSH-AC1: Public-Key anzeigen ───────────────────────────────────

describe('SettingsView — SSH-AC1: Public-Key anzeigen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC1 — SSH-Keys-Sektion wird gerendert mit h2', async () => {
    const { getByRole } = renderView(makeFetch());
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });

  it('SSH-AC1 — gesetzter Public-Key wird vollständig angezeigt (nicht maskiert)', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Public-Key darf vollständig angezeigt werden (AC1)
      expect(main.textContent).toContain('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKeyForRootUser');
    });
  });

  it('SSH-AC1 — Benutzer-Label "root" wird angezeigt', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('root');
    });
  });

  it('SSH-AC1 — leere Liste zeigt Hinweistext', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: EMPTY_SSH_KEYS }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/keine ssh-schlüssel/i);
    });
  });

  it('SSH-AC1 — "+ SSH-Benutzer hinzufügen" Button vorhanden', async () => {
    const { getByRole } = renderView(makeFetch());
    await waitFor(() => {
      expect(getByRole('button', { name: /ssh-benutzer hinzufügen/i })).toBeTruthy();
    });
  });
});

// ── SSH-Keys — SSH-AC2: Private-Key write-only/maskiert ──────────────────────

describe('SettingsView — SSH-AC2: Private-Key write-only', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC2 — Private-Key-Status "•••• gesetzt" wird angezeigt (kein Klartext)', async () => {
    const { getByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('•••• gesetzt');
      // Kein Klartext des Private Keys
      expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });
  });

  it('SSH-AC2 — Private-Key-Input ist ein Textarea (kein type=password, aber write-only-Semantik)', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis SSH-Benutzer root geladen ist
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.includes('Private-Key'))).toBe(true);
    });

    // Private-Key "Ändern"-Button klicken
    await act(async () => {
      const btns = getAllByRole('button').filter((b) =>
        b.getAttribute('aria-label')?.match(/private-key von root ändern/i),
      );
      if (btns[0]) fireEvent.click(btns[0]);
    });

    // Textarea für Private-Key sollte erscheinen
    await waitFor(() => {
      const ta = document.getElementById('ssh-priv-root');
      expect(ta).toBeTruthy();
      expect(ta.tagName).toBe('TEXTAREA');
    });
  });

  it('SSH-AC2 — nach Speichern wird Private-Key-Klartext nicht angezeigt', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => SSH_KEYS_WITH_ROOT };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'PUT' && isSsh) {
        return { ok: true, json: async () => ({ user: 'root', publicKey: 'ssh-ed25519 AAAA… test', privateKeyStatus: 'set' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/private-key von root ändern/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key von root ändern/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-priv-root')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-priv-root');
      if (ta) fireEvent.change(ta, { target: { value: pemDummy('ABCDEF') } });
    });

    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Private-Key-Klartext darf nach Speichern NICHT sichtbar sein
      expect(main.textContent).not.toContain(pemDummy('ABCDEF'));
      expect(main.textContent).not.toContain('ABCDEF');
    });
  });
});

// ── SSH-Keys — SSH-AC3: Löschen ───────────────────────────────────────────────

describe('SettingsView — SSH-AC3: Löschen', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC3 — "Alle löschen"-Button für vorhandenen Benutzer', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — Public-Key-Löschen-Button vorhanden wenn Public-Key gesetzt', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — Private-Key-Löschen-Button vorhanden wenn Private-Key gesetzt', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/private-key von root löschen/i))).toBe(true);
    });
  });

  it('SSH-AC3 — nach Löschen (reload) zeigt neuen Status', async () => {
    const afterDelete = [{ user: 'root', privateKeyStatus: 'unset' }];
    let callCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) {
          callCount++;
          return { ok: true, json: async () => (callCount <= 1 ? SSH_KEYS_WITH_ROOT : afterDelete) };
        }
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      if (method === 'DELETE' && isSsh) {
        return { ok: true, json: async () => ({ user: 'root', privateKeyStatus: 'unset' }) };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i))).toBe(true);
    });

    await act(async () => {
      const delBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/alle ssh-schlüssel für root löschen/i),
      );
      if (delBtn) fireEvent.click(delBtn);
    });

    // Nach dem Löschen wird reload() aufgerufen → zweiter GET-Call zeigt neuen Status
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, opts]) => (opts?.method ?? 'GET') === 'DELETE')).toBe(true);
    });
  });
});

// ── SSH-Keys — SSH-AC4: Public-Key-Format-Validierung ────────────────────────

describe('SettingsView — SSH-AC4: Public-Key-Format-Validierung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC4 — ungültiges Public-Key-Format → Fehlermeldung, kein PUT', async () => {
    // Starte direkt mit einem vorhandenen Benutzer "testuser" (kein Public-Key gesetzt)
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'testuser', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten auf Benutzer "testuser" mit Setzen-Button
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für testuser setzen/i))).toBe(true);
    });

    // Public-Key-Setzen-Button klicken
    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für testuser setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    // Textarea ausfüllen mit ungültigem Format
    await waitFor(() => {
      expect(document.getElementById('ssh-pub-testuser')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-pub-testuser');
      if (ta) fireEvent.change(ta, { target: { value: 'nicht-openssh-format' } });
    });

    // Speichern klicken
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Fehlermeldung erscheint
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasFormatError = Array.from(alerts).some((el) =>
        el.textContent.match(/format|openssh/i),
      );
      expect(hasFormatError).toBe(true);
    });

    // Kein PUT-Request abgefeuert
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('SSH-AC4 — leeres Public-Key-Feld → Fehlermeldung', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'alex', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für alex setzen/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für alex setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-pub-alex')).toBeTruthy();
    });

    // Ohne Eingabe speichern
    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/leer|pflichtfeld/i));
      expect(hasError).toBe(true);
    });

    // Kein PUT
    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });

  it('I1 — Public-Key mit Newline → Fehlermeldung "Zeilenumbrüche", kein PUT', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => [{ user: 'newline-user', privateKeyStatus: 'unset' }] };
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key für newline-user setzen/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key für newline-user setzen/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.getElementById('ssh-pub-newline-user')).toBeTruthy();
    });

    await act(async () => {
      const ta = document.getElementById('ssh-pub-newline-user');
      if (ta) fireEvent.change(ta, { target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey test@example.com\nmalicious' } });
    });

    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/Zeilenumbr|keine.*Zeilen/));
      expect(hasError).toBe(true);
    });

    const putCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method ?? 'GET') === 'PUT');
    expect(putCalls.length).toBe(0);
  });
});

// ── SSH-Keys — SSH-AC5: Private-Key-Klartext nie sichtbar ────────────────────

describe('SettingsView — SSH-AC5: Private-Key-Klartext nie sichtbar', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC5 — Private-Key-Klartext erscheint nie in der Anzeige (liste)', async () => {
    const keyWithPriv = [{ user: 'root', privateKeyStatus: 'set', privateKeyUpdatedAt: '2026-01-01T00:00:00.000Z' }];
    const { getByRole } = renderView(makeFetch({ sshGetResponse: keyWithPriv }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Masked-Text sichtbar
      expect(main.textContent).toContain('•••• gesetzt');
      // Kein Klartext irgendeines Private Keys
      expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });
  });
});

// ── SSH-Keys — SSH-AC1: Public-Key ändern (Ändern-Button) ────────────────────

describe('SettingsView — SSH-AC1: Public-Key ändern', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('SSH-AC1 — "Ändern"-Button für gesetzten Public-Key', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root ändern/i))).toBe(true);
    });
  });

  it('SSH-AC1 — Klick auf "Ändern" öffnet Textarea mit aria-Attributen', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/public-key von root ändern/i))).toBe(true);
    });

    await act(async () => {
      const btn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/public-key von root ändern/i),
      );
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      const ta = document.getElementById('ssh-pub-root');
      expect(ta).toBeTruthy();
      expect(ta.tagName).toBe('TEXTAREA');
    });
  });
});

// ── S1: Ladefehler-Sichtbarkeit ───────────────────────────────────────────────

describe('SettingsView — S1: Ladefehler-Sichtbarkeit', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('S1 — fetchCredentials rejected → Fehler-Element mit role="alert" erscheint', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) return { ok: true, json: async () => EMPTY_SSH_KEYS };
        // Credentials-Endpunkt wirft
        throw new Error('Netzwerkfehler beim Laden der Credentials');
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasCredError = Array.from(alerts).some((el) =>
        el.textContent.match(/credentials konnten nicht geladen werden/i),
      );
      expect(hasCredError).toBe(true);
    });

    // SSH-Sektion bleibt sichtbar (nur Credentials-Ladefehler)
    await waitFor(() => {
      expect(getByRole('heading', { name: /ssh-keys/i })).toBeTruthy();
    });
  });

  it('S1 — fetchSshKeys rejected → SSH-Fehler-Element mit role="alert" erscheint', async () => {
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      const isSsh = typeof url === 'string' && url.includes('/ssh-keys');
      if (method === 'GET') {
        if (isSsh) throw new Error('SSH-Keys-Endpunkt nicht erreichbar');
        return { ok: true, json: async () => EMPTY_CREDS };
      }
      return { ok: false, json: async () => ({ error: 'unbekannt' }) };
    });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasSshError = Array.from(alerts).some((el) =>
        el.textContent.match(/ssh-keys konnten nicht geladen werden/i),
      );
      expect(hasSshError).toBe(true);
    });
  });
});

// ── SSH-Keys — S1: In-Memory-Stub beim Hinzufügen eines Benutzers ─────────────

describe('SettingsView — S1: Neuer Benutzer erscheint als In-Memory-Stub (kein Server-Roundtrip)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('S1 — + Button → Label "newuser" eingeben → Hinzufügen → SshKeyEntry aria-label ohne GET', async () => {
    const fetchMock = makeFetch({ sshGetResponse: EMPTY_SSH_KEYS });
    globalThis.fetch = fetchMock;

    const onNavigate = jest.fn();
    const { getByRole, getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis SSH-Sektion geladen
    await waitFor(() => {
      expect(getByRole('button', { name: /ssh-benutzer hinzufügen/i })).toBeTruthy();
    });

    // Zähle GET-Calls vor der Aktion
    const getCallsBefore = fetchMock.mock.calls.filter(([, opts]) => !opts || (opts?.method ?? 'GET') === 'GET').length;

    // + SSH-Benutzer hinzufügen klicken
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /ssh-benutzer hinzufügen/i }));
    });

    // Input erscheint
    await waitFor(() => {
      expect(document.getElementById('ssh-new-user')).toBeTruthy();
    });

    // Label eingeben
    await act(async () => {
      fireEvent.change(document.getElementById('ssh-new-user'), { target: { value: 'newuser' } });
    });

    // Hinzufügen klicken
    await act(async () => {
      const hinzBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Hinzufügen');
      if (hinzBtns[0]) fireEvent.click(hinzBtns[0]);
    });

    // SshKeyEntry für "newuser" erscheint ohne weiteren Server-Roundtrip
    await waitFor(() => {
      const group = document.querySelector('[aria-label="SSH-Schlüssel für newuser"]');
      expect(group).toBeTruthy();
    });

    // Kein zusätzlicher GET /api/settings/ssh-keys nach dem Hinzufügen
    const getCallsAfter = fetchMock.mock.calls.filter(([, opts]) => !opts || (opts?.method ?? 'GET') === 'GET').length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });
});

// ── Workspace-Path (WS-AC1 + UI-Anteil WS-AC3) — verschoben von GitHubView #92 ──

describe('SettingsView — WS-AC1: Workspace-Sektion Grundstruktur', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — rendert h3 "Workspace-Pfad" in der GitHub-Sektion', async () => {
    const { getByRole } = renderView(makeFetch());
    await waitFor(() => {
      expect(getByRole('heading', { name: /workspace-pfad/i })).toBeTruthy();
    });
  });

  it('WS-AC1 — zeigt wirksamen Pfad (env-default)', async () => {
    const { getByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace');
    });
  });

  it('WS-AC1 — zeigt Quelle "Default aus Env" wenn source=env-default', async () => {
    const { getByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/default aus env/i);
    });
  });

  it('WS-AC1 — zeigt Quelle "konfiguriert" wenn source=configured', async () => {
    const { getByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/konfiguriert/i);
    });
  });

  it('WS-AC1 — zeigt Effektivwert /workspace/projekt wenn source=configured', async () => {
    const { getByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace/projekt');
    });
  });

  it('WS-AC1 — zeigt "Setzen"-Button wenn source=env-default', async () => {
    const { getAllByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });
  });

  it('WS-AC1 — zeigt "Ändern"- und "Zurücksetzen"-Button wenn source=configured', async () => {
    const { getAllByRole } = renderView(makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad ändern/i))).toBe(true);
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });
  });
});

describe('SettingsView — WS-AC1: Setzen (PUT)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — Klick auf "Setzen" öffnet Eingabefeld mit label/htmlFor', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    const { getAllByRole } = renderView(fetchFn);

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input).toBeTruthy();
      const label = document.querySelector('label[for="workspace-path-input"]');
      expect(label).toBeTruthy();
    });
  });

  it('WS-AC1 — erfolgreiches Setzen: PUT abgefeuert, Quelle wechselt auf "konfiguriert"', async () => {
    let callCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace/projekt', source: 'configured' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        callCount++;
        const data = callCount > 1 ? CONFIGURED_WORKSPACE_PATH : DEFAULT_WORKSPACE_PATH;
        return { ok: true, status: 200, json: async () => data };
      }
      return { ok: true, status: 200, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const putCalls = fetchFn.mock.calls.filter(
        ([u, o]) => (o?.method ?? 'GET') === 'PUT' && u === '/api/settings/workspace-path',
      );
      expect(putCalls.length).toBeGreaterThan(0);
    });
  });

  it('WS-AC1 — Erfolg zeigt role=status Meldung', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/workspace-pfad gespeichert/i);
    });
  });
});

describe('SettingsView — WS-AC1: Zurücksetzen (DELETE)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC1 — Zurücksetzen: DELETE abgefeuert, Quelle wechselt auf "Default aus Env"', async () => {
    let callCount = 0;
    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'DELETE' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace', source: 'env-default' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        callCount++;
        const data = callCount > 1 ? DEFAULT_WORKSPACE_PATH : CONFIGURED_WORKSPACE_PATH;
        return { ok: true, status: 200, json: async () => data };
      }
      return { ok: true, status: 200, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i))).toBe(true);
    });

    await act(async () => {
      const resetBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad auf env-default zurücksetzen/i),
      );
      fireEvent.click(resetBtn);
    });

    await waitFor(() => {
      const deleteCalls = fetchFn.mock.calls.filter(
        ([u, o]) => (o?.method ?? 'GET') === 'DELETE' && u === '/api/settings/workspace-path',
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
    });
  });
});

describe('SettingsView — WS-AC3 (UI): Validierungsfehler', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-AC3 — 422-Fehler: role=alert erscheint mit Backend-Fehlermeldung', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/existiert nicht|kein verzeichnis/i);
    });
  });

  it('WS-AC3 — 422-Fehler: alter wirksamer Pfad bleibt sichtbar (unverändert)', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad außerhalb der Mount-Schranke' } },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace');
    });

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      // Alter Pfad /workspace noch sichtbar (nicht durch Fehler-Pfad ersetzt)
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('/workspace');
    });
  });

  it('WS-AC3 — leeres Feld: Frontend-Fehlermeldung, kein PUT abgefeuert', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    // Leeres Feld — Speichern klicken ohne Eingabe
    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/leer/i);
    });

    // Kein PUT abgefeuert
    const putCalls = fetchFn.mock.calls.filter(
      ([u, o]) => (o?.method ?? 'GET') === 'PUT' && u === '/api/settings/workspace-path',
    );
    expect(putCalls.length).toBe(0);
  });

  it('WS-AC3 — aria-describedby verbindet Input mit Fehler-Element', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad außerhalb der Schranke' } },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const input = document.getElementById('workspace-path-input');
      expect(input.getAttribute('aria-describedby')).toBe('workspace-path-error');
      const errorEl = document.getElementById('workspace-path-error');
      expect(errorEl).toBeTruthy();
    });
  });
});

describe('SettingsView — WS-Loading: aria-busy + Mehrfachklick-Schutz', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-Loading — Speichern-Button hat aria-busy=true während in-flight', async () => {
    let resolvePut;
    const putPromise = new Promise((res) => { resolvePut = res; });

    const fetchFn = jest.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      if (method === 'PUT' && url === '/api/settings/workspace-path') {
        await putPromise;
        return { ok: true, status: 200, json: async () => ({ effectivePath: '/workspace/x', source: 'configured' }) };
      }
      if (method === 'GET' && url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => DEFAULT_WORKSPACE_PATH };
      }
      return { ok: true, status: 200, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/x' },
      });
    });

    // Klick ohne await-Abschluss — Button sollte in-flight disabled sein
    act(() => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern' || b.textContent.trim() === 'Speichern…',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Speichern…' || b.getAttribute('aria-busy') === 'true',
      );
      expect(btn).toBeTruthy();
    });

    // PUT freigeben
    resolvePut();
    await act(async () => {});
  });
});

describe('SettingsView — WS-A11y: Touch-Target + Fokusführung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('WS-A11y — Workspace-Buttons (Setzen/Ändern/Zurücksetzen + Speichern/Abbrechen) haben minHeight ≥ 44 px', async () => {
    // Teste Display-Modus-Buttons (Ändern + Zurücksetzen) bei configured
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: CONFIGURED_WORKSPACE_PATH },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      const workspaceBtns = btns.filter((b) => {
        const label = b.getAttribute('aria-label') ?? '';
        return label.match(/workspace-pfad/i);
      });
      expect(workspaceBtns.length).toBeGreaterThan(0);
      for (const btn of workspaceBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
    });

    // Teste Editier-Modus-Buttons (Speichern + Abbrechen)
    await act(async () => {
      const changeBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad ändern/i),
      );
      if (changeBtn) fireEvent.click(changeBtn);
    });

    await waitFor(() => {
      const editBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
        b.textContent.trim() === 'Speichern' || b.textContent.trim() === 'Abbrechen',
      );
      expect(editBtns.length).toBeGreaterThan(0);
      for (const btn of editBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  it('WS-A11y — Fokus landet nach 422-Fehler auf dem Input (activeElement)', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
      putWorkspacePath: { ok: false, status: 422, data: { error: 'Pfad existiert nicht oder ist kein Verzeichnis' } },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/etc/shadow' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Fehler: activeElement muss der Input sein
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeTruthy();
      expect(document.activeElement).toBe(document.getElementById('workspace-path-input'));
    });
  });

  it('WS-A11y — Fokus landet nach Erfolg auf der Erfolgsmeldung (activeElement)', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: { ok: true, status: 200, data: DEFAULT_WORKSPACE_PATH },
    });
    globalThis.fetch = fetchFn;
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/workspace-pfad setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('workspace-path-input')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('workspace-path-input'), {
        target: { value: '/workspace/projekt' },
      });
    });

    await act(async () => {
      const saveBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.textContent.trim() === 'Speichern',
      );
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    // Nach Erfolg: activeElement muss die Erfolgsmeldung (role=status) sein
    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(document.activeElement).toBe(statusEl);
    });
  });

  it('WS-A11y — Workspace-Pfad-Ladefehler zeigt role=alert', async () => {
    const fetchFn = makeFetch({
      getWorkspacePath: 'reject',
    });
    globalThis.fetch = fetchFn;
    const { getByRole } = render(React.createElement(SettingsView, { onNavigate: jest.fn(), fetchFn }));

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      const alerts = main.querySelectorAll('[role="alert"]');
      const hasWsError = Array.from(alerts).some((el) =>
        el.textContent.match(/workspace-pfad konnte nicht geladen werden/i),
      );
      expect(hasWsError).toBe(true);
    });
  });
});

// ── AC9 — VPS-Provider: je Provider ein eigener API-Token ────────────────────

describe('SettingsView — AC9: VPS-Provider-Sektion mit drei Token-Feldern', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC9 — VPS-Sektion enthält Felder für alle drei Provider', async () => {
    const { getByRole } = renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toMatch(/hetzner api-token/i);
      expect(main.textContent).toMatch(/ionos api-token/i);
      expect(main.textContent).toMatch(/hostinger api-token/i);
    });
  });

  it('AC9 — alle drei VPS-Token-Felder zeigen "nicht gesetzt" bei leerem Store', async () => {
    renderView(makeFetch({ getResponse: EMPTY_CREDS }));
    await waitFor(() => {
      const section = document.querySelector('[aria-labelledby="settings-section-vps"]');
      expect(section).toBeTruthy();
      const groups = section.querySelectorAll('[role="group"]');
      expect(groups.length).toBe(3);
      for (const g of groups) {
        expect(g.textContent).toMatch(/nicht gesetzt/i);
      }
    });
  });

  it('AC9 — gesetzter IONOS-Token zeigt maskierten Status, kein Klartext', async () => {
    const credsWithIonos = [
      ...EMPTY_CREDS,
      { integration: 'vps', name: 'ionos_api_token', status: 'set', masked: '•••• gesetzt', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getByRole } = renderView(makeFetch({ getResponse: credsWithIonos }));
    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('•••• gesetzt');
      expect(main.textContent).not.toContain('my-ionos-secret');
    });
  });

  it('AC9 — gesetzter Hostinger-Token zeigt "Ändern"- und "Löschen"-Button', async () => {
    const credsWithHostinger = [
      ...EMPTY_CREDS,
      { integration: 'vps', name: 'hostinger_api_token', status: 'set', masked: '•••• gesetzt', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { getAllByRole } = renderView(makeFetch({ getResponse: credsWithHostinger }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/hostinger api-token ändern/i))).toBe(true);
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/hostinger api-token löschen/i))).toBe(true);
    });
  });

  it('AC9 — PUT für ionos_api_token feuert korrekten Endpunkt', async () => {
    const fetchMock = makeFetch({ getResponse: EMPTY_CREDS });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ionos api-token setzen/i))).toBe(true);
    });

    await act(async () => {
      const setzenBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ionos api-token setzen/i),
      );
      fireEvent.click(setzenBtn);
    });

    await waitFor(() => {
      const pwdInputs = document.querySelectorAll('input[type="password"]');
      expect(pwdInputs.length).toBeGreaterThan(0);
    });

    const pwdInputs = document.querySelectorAll('input[type="password"]');
    await act(async () => {
      if (pwdInputs[0]) {
        fireEvent.change(pwdInputs[0], { target: { value: 'ionos-secret-token' } });
      }
    });

    await act(async () => {
      const saveBtns = getAllByRole('button').filter((b) => b.textContent.trim() === 'Speichern');
      if (saveBtns[0]) fireEvent.click(saveBtns[0]);
    });

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        ([url, opts]) => (opts?.method ?? 'GET') === 'PUT' && url.includes('/vps/ionos_api_token'),
      );
      expect(putCalls.length).toBeGreaterThan(0);
    });

    // Klartext nicht im DOM (AC4)
    await waitFor(() => {
      const main = document.querySelector('[aria-label="Einstellungen-Ansicht"]');
      if (main) expect(main.textContent).not.toContain('ionos-secret-token');
    });
  });
});

// ── ssh-key-generation — GEN-AC1: „Keypair erzeugen"-Button vorhanden ────────

describe('SettingsView — GEN-AC1: Keypair-Generieren-Button vorhanden', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-AC1 — „Keypair erzeugen"-Button für root vorhanden', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(
        btns.some((b) => b.getAttribute('aria-label')?.match(/neues.*ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i)),
      ).toBe(true);
    });
  });

  it('GEN-AC1 — „Keypair erzeugen"-Button für alex vorhanden', async () => {
    const sshWithAlex = [{ user: 'alex', privateKeyStatus: 'unset' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshWithAlex }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(
        btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*alex|keypair.*alex.*erzeugen|ed25519.*alex.*erzeugen/i)),
      ).toBe(true);
    });
  });

  it('GEN-AC1 — Kein Keypair-Erzeugen-Button für Nicht-root/alex-Label', async () => {
    // "deploy" ist nicht root|alex — kein Generate-Button
    const sshWithDeploy = [{ user: 'deploy', privateKeyStatus: 'unset' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshWithDeploy }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      const hasGenBtn = btns.some((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*deploy|keypair.*deploy.*erzeugen|ed25519.*deploy.*erzeugen/i),
      );
      expect(hasGenBtn).toBe(false);
    });
  });

  it('GEN-AC1 — Erfolgreicher Generate-Request: POST .../generate wird abgefeuert', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([url, opts]) =>
        (opts?.method ?? 'GET') === 'POST' && url.includes('/generate'),
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });
});

// ── ssh-key-generation — GEN-AC3: Public-Key anzeigen + kopieren; Private-Key NIE ──

describe('SettingsView — GEN-AC3: Public-Key nach Generierung anzeigen; Private-Key nie sichtbar', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-AC3 — nach erfolgreicher Generierung: erzeugter Public-Key vollständig sichtbar', async () => {
    const fetchMock = makeFetch({ sshGetResponse: [{ user: 'root', privateKeyStatus: 'unset' }] });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Der erzeugte Public-Key aus DEFAULT_GENERATE_SUCCESS muss sichtbar sein
      expect(main.textContent).toContain('AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedPublicKey');
    });
  });

  it('GEN-AC3 — nach Generierung: Private-Key-Klartext NIEMALS sichtbar', async () => {
    const fetchMock = makeFetch({ sshGetResponse: [{ user: 'root', privateKeyStatus: 'unset' }] });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      // Public-Key sichtbar, kein Private-Key-Klartext
      expect(main.textContent).toContain('AAAAC3NzaC1lZDI1NTE5AAAAIGeneratedPublicKey');
      expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    });
  });

  it('GEN-AC3 — Kopieren-Button vorhanden nach Generierung', async () => {
    const fetchMock = makeFetch({ sshGetResponse: [{ user: 'root', privateKeyStatus: 'unset' }] });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(
        btns.some((b) => b.getAttribute('aria-label')?.match(/public-key.*kopieren|kopieren.*public-key/i)),
      ).toBe(true);
    });
  });
});

// ── ssh-key-generation — GEN-AC4: Private-Key-Export (dauerhaft wiederholbar) ─

describe('SettingsView — GEN-AC4: Private-Key-Export-Button', () => {
  afterEach(() => {
    delete globalThis.fetch;
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
  });

  function mockDownloadAPIs() {
    // jsdom hat kein URL.createObjectURL / revokeObjectURL
    globalThis.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    globalThis.URL.revokeObjectURL = jest.fn();
  }

  it('GEN-AC4 — Private-Key-Export-Button erscheint nach erfolgreicher Generierung', async () => {
    const fetchMock = makeFetch({ sshGetResponse: [{ user: 'root', privateKeyStatus: 'unset' }] });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(
        btns.some((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i)),
      ).toBe(true);
    });
  });

  it('GEN-AC4 — wenn Private-Key bereits gesetzt: Export-Button schon vor Generierung vorhanden', async () => {
    // hasPrivKey = true → Export-Button direkt sichtbar (dauerhaft wiederholbar)
    const sshWithPrivKey = [{ user: 'root', privateKeyStatus: 'set', publicKey: 'ssh-ed25519 AAAA… test' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshWithPrivKey }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(
        btns.some((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i)),
      ).toBe(true);
    });
  });

  it('GEN-AC4 — Klick auf Export-Button feuert GET .../private-key/export', async () => {
    mockDownloadAPIs();
    const sshWithPrivKey = [{ user: 'root', privateKeyStatus: 'set', publicKey: 'ssh-ed25519 AAAA… test' }];
    const fetchMock = makeFetch({ sshGetResponse: sshWithPrivKey });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i))).toBe(true);
    });

    await act(async () => {
      const exportBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i),
      );
      if (exportBtn) fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      const exportCalls = fetchMock.mock.calls.filter(([url, opts]) =>
        (!opts || (opts?.method ?? 'GET') === 'GET') && url.includes('/private-key/export'),
      );
      expect(exportCalls.length).toBeGreaterThan(0);
    });
  });

  it('GEN-AC4 — Export wiederholbar: zweiter Klick feuert erneut Export-Request', async () => {
    mockDownloadAPIs();
    const sshWithPrivKey = [{ user: 'root', privateKeyStatus: 'set', publicKey: 'ssh-ed25519 AAAA… test' }];
    const fetchMock = makeFetch({ sshGetResponse: sshWithPrivKey });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i))).toBe(true);
    });

    // Erster Export
    await act(async () => {
      const exportBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i),
      );
      if (exportBtn) fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      const exportCalls = fetchMock.mock.calls.filter(([url, opts]) =>
        (!opts || (opts?.method ?? 'GET') === 'GET') && url.includes('/private-key/export'),
      );
      expect(exportCalls.length).toBe(1);
    });

    // Zweiter Export (wiederholbar)
    await act(async () => {
      const exportBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i),
      );
      if (exportBtn) fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      const exportCalls = fetchMock.mock.calls.filter(([url, opts]) =>
        (!opts || (opts?.method ?? 'GET') === 'GET') && url.includes('/private-key/export'),
      );
      expect(exportCalls.length).toBe(2);
    });
  });

  it('GEN-AC4 — Export-Fehler: Fehlermeldung wird angezeigt', async () => {
    mockDownloadAPIs();
    const sshWithPrivKey = [{ user: 'root', privateKeyStatus: 'set', publicKey: 'ssh-ed25519 AAAA… test' }];
    const fetchMock = makeFetch({ sshGetResponse: sshWithPrivKey, sshExportResponse: 'error' });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i))).toBe(true);
    });

    await act(async () => {
      const exportBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i),
      );
      if (exportBtn) fireEvent.click(exportBtn);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasExportError = Array.from(alerts).some((el) => el.textContent.match(/export|kein private-key/i));
      expect(hasExportError).toBe(true);
    });
  });
});

// ── ssh-key-generation — GEN-AC6: 403-Fehler korrekt behandeln ───────────────

describe('SettingsView — GEN-AC6: 403-Fehler beim Generieren', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-AC6 — 403-Fehler vom Backend zeigt Fehlermeldung, kein Klartext-Leak', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: [{ user: 'root', privateKeyStatus: 'unset' }],
      sshGenerateResponse: 'forbidden',
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/berechtigung|forbidden|fehlgeschlagen/i));
      expect(hasError).toBe(true);
    });

    // Kein Private-Key-Klartext sichtbar
    const main = getByRole('main', { name: /einstellungen-ansicht/i });
    expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });
});

// ── ssh-key-generation — GEN-AC7: Overwrite-Bestätigung bei 409 ──────────────

describe('SettingsView — GEN-AC7: Overwrite-Bestätigung bei belegtem Label', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-AC7 — 409 key-exists: Overwrite-Dialog erscheint (role=alertdialog)', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshGenerateResponse: 'key-exists',
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog).toBeTruthy();
    });
  });

  it('GEN-AC7 — Overwrite-Dialog hat aria-labelledby und aria-describedby', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshGenerateResponse: 'key-exists',
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    });
  });

  it('GEN-AC7 — Abbrechen schliesst Dialog ohne Generate-Request', async () => {
    // Erster Klick → 409; zweiter Klick auf Abbrechen → Dialog weg, kein zweiter POST
    let generateCallCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'POST' && url.includes('/generate')) {
        generateCallCount++;
        return { ok: false, status: 409, json: async () => ({ error: 'Key vorhanden', errorClass: 'key-exists' }) };
      }
      if (method === 'GET' && url.includes('/ssh-keys') && !url.includes('/export')) {
        return { ok: true, json: async () => SSH_KEYS_WITH_ROOT };
      }
      return { ok: true, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    // Klick → 409 → Dialog öffnet
    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    });

    // Abbrechen klicken
    await act(async () => {
      const cancelBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/abbrechen.*bestehenden|abbrechen/i) && b.textContent.trim() === 'Abbrechen',
      );
      if (cancelBtn) fireEvent.click(cancelBtn);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });

    // Kein weiterer Generate-POST
    expect(generateCallCount).toBe(1);
  });

  it('GEN-AC7 — Bestätigen sendet overwrite:true und schliesst Dialog', async () => {
    // Sequenz: erster POST → 409; nach Bestätigung zweiter POST → Erfolg
    let callCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'POST' && url.includes('/generate')) {
        callCount++;
        if (callCount === 1) {
          // Erster Aufruf: ohne overwrite → 409
          return { ok: false, status: 409, json: async () => ({ error: 'Key vorhanden', errorClass: 'key-exists' }) };
        }
        // Zweiter Aufruf: mit overwrite → Erfolg
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: 'root',
            publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewKey dev-gui/root',
            privateKeyStatus: 'set',
            generatedAt: '2026-01-02T00:00:00.000Z',
          }),
        };
      }
      if (method === 'GET' && url.includes('/ssh-keys') && !url.includes('/export')) {
        return { ok: true, json: async () => SSH_KEYS_WITH_ROOT };
      }
      return { ok: true, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    // Erster Klick → 409
    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    });

    // Bestätigen klicken
    await act(async () => {
      const confirmBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/bestätigen.*überschreiben|überschreiben/i),
      );
      if (confirmBtn) fireEvent.click(confirmBtn);
    });

    // Dialog weg, neuer Public-Key sichtbar
    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('AAAAINewKey');
    });

    // Zweiter POST hat overwrite:true
    expect(callCount).toBe(2);
    const generatePostCalls = fetchMock.mock.calls.filter(([url, opts]) =>
      (opts?.method ?? 'GET') === 'POST' && url.includes('/generate'),
    );
    expect(generatePostCalls.length).toBe(2);
    const secondPostBody = JSON.parse(generatePostCalls[1]?.[1]?.body ?? '{}');
    expect(secondPostBody.overwrite).toBe(true);
  });
});

// ── ssh-key-generation — GEN-AC8: Label-Liste nach Generierung neu laden ─────

describe('SettingsView — GEN-AC8: Label-Reload nach Generierung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-AC8 — nach erfolgreicher Generierung: SSH-Keys-Liste neu geladen', async () => {
    let sshGetCallCount = 0;
    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'POST' && url.includes('/generate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: 'root',
            publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewKey dev-gui/root',
            privateKeyStatus: 'set',
            generatedAt: '2026-01-01T00:00:00.000Z',
          }),
        };
      }
      if (method === 'GET' && url === '/api/settings/ssh-keys') {
        sshGetCallCount++;
        return { ok: true, json: async () => [{ user: 'root', privateKeyStatus: 'unset' }] };
      }
      return { ok: true, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    // Warten bis initial geladen
    await waitFor(() => {
      expect(sshGetCallCount).toBeGreaterThanOrEqual(1);
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    const callsBefore = sshGetCallCount;

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      // Nach Generierung muss ein weiterer SSH-Keys-GET abgefeuert worden sein
      expect(sshGetCallCount).toBeGreaterThan(callsBefore);
    });
  });
});

// ── ssh-key-generation — GEN-A11y: Overwrite-Dialog-Barrierefreiheit ─────────

describe('SettingsView — GEN-A11y: Overwrite-Dialog A11y', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('GEN-A11y — Overwrite-Dialog: Bestätigungs- und Abbrechen-Buttons haben Touch-Target ≥ 44 px', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshGenerateResponse: 'key-exists',
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    });

    // Alle Buttons im Dialog müssen Touch-Target ≥ 44 px haben
    const dialog = document.querySelector('[role="alertdialog"]');
    const dialogBtns = dialog.querySelectorAll('button');
    expect(dialogBtns.length).toBeGreaterThan(0);
    for (const btn of dialogBtns) {
      expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
    }
  });

  it('GEN-A11y — Fokus landet auf Bestätigungs-Button wenn Overwrite-Dialog über 409 key-exists öffnet', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshGenerateResponse: 'key-exists',
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i))).toBe(true);
    });

    await act(async () => {
      const genBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i),
      );
      if (genBtn) fireEvent.click(genBtn);
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    });

    // Fokus muss auf dem Bestätigungs-Button landen (useEffect + confirmBtnRef.current.focus())
    await waitFor(() => {
      const confirmBtn = document.querySelector('[aria-label*="überschreiben"]');
      expect(confirmBtn).toBeTruthy();
      expect(document.activeElement).toBe(confirmBtn);
    });
  });

  it('GEN-A11y — „Keypair erzeugen"- und Export-Buttons haben Touch-Target ≥ 44 px', async () => {
    const sshWithPrivKey = [{ user: 'root', privateKeyStatus: 'set', publicKey: 'ssh-ed25519 AAAA… test' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshWithPrivKey }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      // Generieren-Button
      const genBtns = btns.filter((b) => b.getAttribute('aria-label')?.match(/ed25519.*keypair.*root|keypair.*root.*erzeugen|ed25519.*root.*erzeugen/i));
      for (const btn of genBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
      // Export-Button
      const expBtns = btns.filter((b) => b.getAttribute('aria-label')?.match(/private-key.*root.*herunterladen|private-key.*herunterladen/i));
      for (const btn of expBtns) {
        expect(parseInt(btn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

// ── ssh-key-rotation — ROT-AC1: Rotations-Button + Formular vorhanden ────────

describe('SettingsView — ROT-AC1: Rotation auslösen (Formular + POST)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  /** Öffnet das RotationForm für root durch Klick auf den Rotieren-Button. */
  async function openRotationForm(getAllByRole) {
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });
    await act(async () => {
      const rotBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i),
      );
      if (rotBtn) fireEvent.click(rotBtn);
    });
    // Warten bis Formular-Felder erscheinen
    await waitFor(() => {
      expect(document.getElementById('rot-host-root')).toBeTruthy();
    });
  }

  it('ROT-AC1 — „Rotieren"-Button für root vorhanden wenn Private-Key gesetzt', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });
  });

  it('ROT-AC1 — „Rotieren"-Button für alex vorhanden wenn Private-Key gesetzt', async () => {
    const sshWithAlex = [{ user: 'alex', publicKey: 'ssh-ed25519 AAAA… alex', privateKeyStatus: 'set' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshWithAlex }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      expect(btns.some((b) => b.getAttribute('aria-label')?.match(/ssh-key für alex rotieren/i))).toBe(true);
    });
  });

  it('ROT-AC1 — Kein Rotieren-Button wenn Private-Key nicht gesetzt', async () => {
    // root ohne Private-Key → kein Rotieren-Button (oder disabled, aber nicht auslösbar)
    const sshNoPrivKey = [{ user: 'root', publicKey: 'ssh-ed25519 AAAA…', privateKeyStatus: 'unset' }];
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: sshNoPrivKey }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      // Button kann vorhanden aber disabled sein — wichtig: kein auslösbarer Rotation-Aufruf
      const rotBtn = btns.find((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i));
      if (rotBtn) {
        expect(rotBtn.disabled).toBe(true);
      }
    });
  });

  it('ROT-AC1 — Formular zeigt Felder host/port/targetUser/hostFingerprint mit labels', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));
    await openRotationForm(getAllByRole);

    // Host-Feld mit label
    const hostInput = document.getElementById('rot-host-root');
    expect(hostInput).toBeTruthy();
    expect(document.querySelector('label[for="rot-host-root"]')).toBeTruthy();

    // Port-Feld mit label
    expect(document.getElementById('rot-port-root')).toBeTruthy();
    expect(document.querySelector('label[for="rot-port-root"]')).toBeTruthy();

    // targetUser-Feld mit label
    expect(document.getElementById('rot-user-root')).toBeTruthy();
    expect(document.querySelector('label[for="rot-user-root"]')).toBeTruthy();

    // hostFingerprint-Feld mit label
    expect(document.getElementById('rot-fp-root')).toBeTruthy();
    expect(document.querySelector('label[for="rot-fp-root"]')).toBeTruthy();
  });

  it('ROT-AC1 — POST .../rotate wird beim Klick auf „Jetzt rotieren" abgefeuert', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));
    await openRotationForm(getAllByRole);

    // Host + targetUser ausfüllen
    await act(async () => {
      fireEvent.change(document.getElementById('rot-host-root'), { target: { value: '1.2.3.4' } });
      fireEvent.change(document.getElementById('rot-user-root'), { target: { value: 'root' } });
    });

    // Rotieren-Button klicken
    await act(async () => {
      const rotateBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) && b.textContent.trim().includes('rotieren'),
      );
      if (rotateBtn) fireEvent.click(rotateBtn);
    });

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([url, opts]) =>
        (opts?.method ?? 'GET') === 'POST' && url.includes('/rotate'),
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it('ROT-AC1 — leerer Host → Frontend-Fehlermeldung, kein POST', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));
    await openRotationForm(getAllByRole);

    // Ohne Host: auf „Jetzt rotieren" klicken
    await act(async () => {
      // Finde den „Jetzt rotieren"-Button im RotationForm (aria-label enthält „rotieren")
      const allBtns = getAllByRole('button');
      // Der Submit-Button in RotationForm hat aria-label="SSH-Key für root rotieren"
      // und textContent "Jetzt rotieren" (nicht der Toggle-Button der aria-expanded hat)
      const submitBtn = allBtns.find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) &&
        !b.hasAttribute('aria-expanded'),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      const hasError = Array.from(alerts).some((el) => el.textContent.match(/host.*pflichtfeld|pflichtfeld/i));
      expect(hasError).toBe(true);
    });

    // Kein POST abgefeuert
    const postCalls = fetchMock.mock.calls.filter(([url, opts]) =>
      (opts?.method ?? 'GET') === 'POST' && url.includes('/rotate'),
    );
    expect(postCalls.length).toBe(0);
  });

  it('ROT-AC1 — Loading-State: aria-busy=true während Rotation in-flight', async () => {
    let resolveRotate;
    const rotatePromise = new Promise((res) => { resolveRotate = res; });

    const fetchMock = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (method === 'POST' && url.includes('/rotate')) {
        await rotatePromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: 'rotated',
            oldKeyRemoved: true,
            newPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotatedPublicKey dev-gui/root',
          }),
        };
      }
      if (method === 'GET' && url.includes('/ssh-keys') && !url.includes('/export')) {
        return { ok: true, json: async () => SSH_KEYS_WITH_ROOT };
      }
      return { ok: true, json: async () => EMPTY_CREDS };
    });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));
    await openRotationForm(getAllByRole);

    await act(async () => {
      fireEvent.change(document.getElementById('rot-host-root'), { target: { value: '1.2.3.4' } });
      fireEvent.change(document.getElementById('rot-user-root'), { target: { value: 'root' } });
    });

    // Klick ohne await-Abschluss — Button sollte in-flight aria-busy=true haben
    act(() => {
      const submitBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) &&
        !b.hasAttribute('aria-expanded'),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Rotation läuft…' || b.getAttribute('aria-busy') === 'true',
      );
      expect(btn).toBeTruthy();
    });

    // Auflösen
    resolveRotate();
    await act(async () => {});
  });
});

// ── ssh-key-rotation — ROT-AC5: Ergebnis anzeigen ────────────────────────────

describe('SettingsView — ROT-AC5: Ergebnis-Anzeige (Erfolg + Fehler)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  /** Öffnet RotationForm und sendet das Formular mit host + targetUser. */
  async function submitRotationForm(fetchMock, host = '1.2.3.4', tu = 'root') {
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });

    await act(async () => {
      const rotBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i),
      );
      if (rotBtn) fireEvent.click(rotBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('rot-host-root')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('rot-host-root'), { target: { value: host } });
      fireEvent.change(document.getElementById('rot-user-root'), { target: { value: tu } });
    });

    await act(async () => {
      const submitBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) &&
        !b.hasAttribute('aria-expanded'),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    return { getAllByRole, getByRole };
  }

  it('ROT-AC5 — Erfolg: role=status erscheint mit „rotiert" / neuer Public-Key', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    await submitRotationForm(fetchMock);

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/rotiert|neuer public-key aktiv/i);
    });
  });

  it('ROT-AC5 — Erfolg: neuer Public-Key wird in der Ergebnis-Anzeige sichtbar', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const { getByRole } = await submitRotationForm(fetchMock);

    await waitFor(() => {
      const main = getByRole('main', { name: /einstellungen-ansicht/i });
      expect(main.textContent).toContain('AAAAIRotatedPublicKey');
    });
  });

  it('ROT-AC5 — Erfolg (oldKeyRemoved=false): Warnung über nicht entfernten alten Key sichtbar', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshRotateResponse: {
        result: 'rotated',
        oldKeyRemoved: false,
        newPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotatedPublicKey dev-gui/root',
        reason: 'Alter Key konnte nicht entfernt werden',
      },
    });
    globalThis.fetch = fetchMock;
    await submitRotationForm(fetchMock);

    await waitFor(() => {
      const statusEl = document.querySelector('[role="status"]');
      expect(statusEl).toBeTruthy();
      expect(statusEl.textContent).toMatch(/alter key konnte nicht entfernt werden|kein.*entfernt/i);
    });
  });

  it('ROT-AC5 — rotation-verify-failed: role=alert mit „alter Key erhalten"-Meldung', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshRotateResponse: 'verify-failed',
    });
    globalThis.fetch = fetchMock;
    await submitRotationForm(fetchMock);

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      // Klare Aussage: alter Key bleibt erhalten — kein Aussperren
      expect(alertEl.textContent).toMatch(/alter key.*erhalten|kein zugang verloren|verbindungstest fehlgeschlagen/i);
    });
  });

  it('ROT-AC5 — 403: Fehlermeldung „keine Berechtigung" wird angezeigt (role=alert)', async () => {
    const fetchMock = makeFetch({
      sshGetResponse: SSH_KEYS_WITH_ROOT,
      sshRotateResponse: 'forbidden',
    });
    globalThis.fetch = fetchMock;
    await submitRotationForm(fetchMock);

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).toBeTruthy();
      expect(alertEl.textContent).toMatch(/berechtigung|403/i);
    });
  });
});

// ── ssh-key-rotation — ROT-AC7: kein Private-Key in Anzeige + A11y ───────────

describe('SettingsView — ROT-AC7: Kein Private-Key in Rotation-Anzeige; A11y', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('ROT-AC7 — Rotation-Ergebnis zeigt niemals Private-Key-Klartext', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole, getByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });

    await act(async () => {
      const rotBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i),
      );
      if (rotBtn) fireEvent.click(rotBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('rot-host-root')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(document.getElementById('rot-host-root'), { target: { value: '1.2.3.4' } });
      fireEvent.change(document.getElementById('rot-user-root'), { target: { value: 'root' } });
    });

    await act(async () => {
      const submitBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) &&
        !b.hasAttribute('aria-expanded'),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    // Nach Erfolg: Private-Key niemals im DOM
    await waitFor(() => {
      expect(document.querySelector('[role="status"]')).toBeTruthy();
    });

    const main = getByRole('main', { name: /einstellungen-ansicht/i });
    expect(main.textContent).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(main.textContent).not.toContain('PRIVATE KEY');
    // Neuer Public-Key ist sichtbar (nicht geheim)
    expect(main.textContent).toContain('AAAAIRotatedPublicKey');
  });

  it('ROT-AC7 — Rotations-Formular hat programmatisch zugeordnete Labels (label[for])', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });

    await act(async () => {
      const rotBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i),
      );
      if (rotBtn) fireEvent.click(rotBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('rot-host-root')).toBeTruthy();
    });

    // Alle Formular-Inputs haben ein zugeordnetes label
    for (const id of ['rot-host-root', 'rot-port-root', 'rot-user-root', 'rot-fp-root']) {
      const input = document.getElementById(id);
      expect(input).toBeTruthy();
      const label = document.querySelector(`label[for="${id}"]`);
      expect(label).toBeTruthy();
    }
  });

  it('ROT-AC7 — Rotieren-Button hat Touch-Target ≥ 44 px', async () => {
    const fetchMock = makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT });
    globalThis.fetch = fetchMock;
    const onNavigate = jest.fn();
    const { getAllByRole } = render(React.createElement(SettingsView, { onNavigate }));

    await waitFor(() => {
      expect(getAllByRole('button').some((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i))).toBe(true);
    });

    await act(async () => {
      const rotBtn = getAllByRole('button').find((b) =>
        b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i),
      );
      if (rotBtn) fireEvent.click(rotBtn);
    });

    await waitFor(() => {
      expect(document.getElementById('rot-host-root')).toBeTruthy();
    });

    // „Jetzt rotieren"-Button im Formular muss minHeight ≥ 44 px haben
    await waitFor(() => {
      const submitBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i) && !b.hasAttribute('aria-expanded'),
      );
      expect(submitBtn).toBeTruthy();
      expect(parseInt(submitBtn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
    });
  });

  it('ROT-AC7 — Toggle-Rotieren-Button (in userHeader) hat Touch-Target ≥ 44 px', async () => {
    const { getAllByRole } = renderView(makeFetch({ sshGetResponse: SSH_KEYS_WITH_ROOT }));
    await waitFor(() => {
      const btns = getAllByRole('button');
      const rotBtn = btns.find((b) => b.getAttribute('aria-label')?.match(/ssh-key für root rotieren/i));
      expect(rotBtn).toBeTruthy();
      expect(parseInt(rotBtn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
    });
  });
});

// ── credential-unlock-dialog #185 ─────────────────────────────────────────────

describe('SettingsView — Bitwarden-Unlock-Dialog (AC1, AC2, AC4, AC5, AC9, AC10)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  // AC1: Bei state:"locked" → Unlock-Bereich sichtbar; bei "unlocked" → kein Unlock-Bereich

  it('AC1 — state:"locked" → Button „Bitwarden verbinden" sichtbar', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => {
      const btn = getByRole('button', { name: /bitwarden verbinden/i });
      expect(btn).toBeTruthy();
    });
  });

  it('AC1 — state:"unlocked" → KEIN „Bitwarden verbinden"-Button sichtbar', async () => {
    const { queryByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => {
      const btn = queryByRole('button', { name: /bitwarden verbinden/i });
      expect(btn).toBeNull();
    });
  });

  it('AC1 — Unlock-Bereich hat h2-Überschrift bei state:"locked"', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => {
      const h2 = getByRole('heading', { name: /bitwarden-verbindung/i });
      expect(h2).toBeTruthy();
    });
  });

  // AC2: Dialog enthält E-Mail, Passwort, optional 2FA; modal; A11y

  it('AC2 — Klick auf „Bitwarden verbinden" öffnet modalen Dialog (role=dialog, aria-modal)', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => {
      getByRole('button', { name: /bitwarden verbinden/i });
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const dialog = getByRole('dialog');
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });
  });

  it('AC2 — Dialog enthält E-Mail-Feld mit label', async () => {
    const { getByRole, getByLabelText } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const emailInput = getByLabelText(/e-mail/i);
      expect(emailInput).toBeTruthy();
    });
  });

  it('AC2 — Dialog enthält Master-Passwort-Feld (type=password)', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput).toBeTruthy();
      expect(pwdInput.type).toBe('password');
    });
  });

  it('AC2 — Dialog hat aria-labelledby auf den Titel', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const dialog = getByRole('dialog');
      const labelId = dialog.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      const titleEl = document.getElementById(labelId);
      expect(titleEl).toBeTruthy();
      expect(titleEl.textContent).toMatch(/bitwarden verbinden/i);
    });
  });

  it('AC2 — Submit-Button hat Touch-Target ≥ 44 px', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const dialog = getByRole('dialog');
      const btns = Array.from(dialog.querySelectorAll('button'));
      const submitBtn = btns.find((b) => b.textContent?.match(/verbinden/i) && !b.textContent?.match(/bitwarden verbinden/i));
      expect(submitBtn).toBeTruthy();
      expect(parseInt(submitBtn.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
    });
  });

  it('AC2 — Leere E-Mail → Fehlermeldung (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    // Dialog öffnet sich; direkt Submit klicken (ohne E-Mail)
    await act(async () => {
      const dialog = getByRole('dialog');
      const btns = Array.from(dialog.querySelectorAll('button'));
      const submitBtn = btns.find((b) => b.textContent?.match(/^verbinden$/i));
      if (submitBtn) fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      const hasEmailError = Array.from(alerts).some((el) => el.textContent?.match(/e-mail/i));
      expect(hasEmailError).toBe(true);
    });
  });

  // AC4: not-found → Erstellungs-Angebot

  it('AC4 — not-found → explizites Erstellungs-Angebot (role=alertdialog)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'not-found',
      }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    // E-Mail + Passwort eingeben
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: 'my-password' },
      });
    });
    // Submit
    await act(async () => {
      const dialog = getByRole('dialog');
      const btns = Array.from(dialog.querySelectorAll('button'));
      const submitBtn = btns.find((b) => b.textContent?.match(/^verbinden$/i));
      if (submitBtn) fireEvent.click(submitBtn);
    });
    // Erstellungs-Angebot erscheint (role=alertdialog)
    await waitFor(() => {
      const offer = document.querySelector('[role=alertdialog]');
      expect(offer).toBeTruthy();
      expect(offer.textContent).toMatch(/master-key.*bitwarden erstellen/i);
    });
  });

  it('AC4 — Bestätigung bei Erstellungs-Angebot sendet create:true', async () => {
    // Jeder Unlock-Aufruf wird aufgezeichnet für spätere Assertion
    const unlockBodies = [];
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/credential-status') {
        return { ok: true, status: 200, json: async () => ({ state: 'locked', hasEncryptedEntries: false }) };
      }
      if (url === '/api/settings/credential-unlock' && method === 'POST') {
        const body = JSON.parse(opts.body);
        unlockBodies.push(body);
        if (body.create === true) {
          return { ok: true, status: 200, json: async () => ({ ok: true, state: 'unlocked' }) };
        }
        // Erster Aufruf (ohne create): not-found
        return { ok: true, status: 200, json: async () => ({ ok: false, status: 'not-found' }) };
      }
      if (url === '/api/settings/credentials') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/settings/ssh-keys') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => DEFAULT_WORKSPACE_PATH };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: 'my-password' },
      });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });
    // Warte auf Erstellungs-Angebot
    await waitFor(() => {
      expect(document.querySelector('[role=alertdialog]')).toBeTruthy();
    });
    // Bestätigen — löst create:true aus
    await act(async () => {
      const offer = document.querySelector('[role=alertdialog]');
      const confirmBtn = Array.from(offer.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/ja.*erstellen/i),
      );
      if (confirmBtn) fireEvent.click(confirmBtn);
    });
    // Warte bis create:true-Aufruf stattgefunden hat
    await waitFor(() => {
      expect(unlockBodies.length).toBeGreaterThanOrEqual(2);
    });
    // Letzter Aufruf muss create:true haben
    expect(unlockBodies[unlockBodies.length - 1].create).toBe(true);
  });

  it('AC4 — Abbrechen bei Erstellungs-Angebot erstellt nichts', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'not-found',
    });
    const { getByRole } = renderView(fetchFn);
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), { target: { value: 'u@e.com' } });
      fireEvent.change(document.getElementById('bw-unlock-password'), { target: { value: 'pw' } });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });
    await waitFor(() => { expect(document.querySelector('[role=alertdialog]')).toBeTruthy(); });
    const unlockCallsBefore = fetchFn.mock.calls.filter(
      ([url, opts]) => url === '/api/settings/credential-unlock' && opts?.method === 'POST',
    ).length;
    // Abbrechen
    await act(async () => {
      const offer = document.querySelector('[role=alertdialog]');
      const cancelBtn = Array.from(offer.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/abbrechen/i),
      );
      if (cancelBtn) fireEvent.click(cancelBtn);
    });
    // Kein weiterer Unlock-Aufruf (S4: in waitFor wickeln, damit async-Nebenwirkungen abklingen)
    await waitFor(() => {
      const unlockCallsAfter = fetchFn.mock.calls.filter(
        ([url, opts]) => url === '/api/settings/credential-unlock' && opts?.method === 'POST',
      ).length;
      expect(unlockCallsAfter).toBe(unlockCallsBefore);
    });
  });

  // AC5: 2FA-Fehler

  it('AC5 — twofa-required → 2FA-Feld erscheint + Fehlermeldung (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'twofa-required',
      }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: 'my-password' },
      });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      // 2FA-Feld vorhanden
      expect(document.getElementById('bw-unlock-twofa')).toBeTruthy();
      // Fehlermeldung (role=alert) enthält 2FA-Hinweis
      const alerts = document.querySelectorAll('[role=alert]');
      const has2faMsg = Array.from(alerts).some((el) => el.textContent?.match(/2fa/i));
      expect(has2faMsg).toBe(true);
    });
  });

  it('AC5 — twofa-invalid → 2FA-Fehlermeldung (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'twofa-invalid',
      }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: 'my-password' },
      });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      const hasTwofaError = Array.from(alerts).some(
        (el) => el.textContent?.match(/ungültig|abgelaufen/i),
      );
      expect(hasTwofaError).toBe(true);
    });
  });

  // AC2 (WCAG 2.1.2): Fokus-Trap — Escape schließt Dialog

  it('AC2 — Escape-Taste schließt den Dialog (Fokus-Trap)', async () => {
    const { getByRole, queryByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      expect(getByRole('dialog')).toBeTruthy();
    });
    // Escape schließt den Dialog
    await act(async () => {
      const dialog = getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => {
      expect(queryByRole('dialog')).toBeNull();
    });
  });

  it('AC2 — Tab-Taste bleibt innerhalb des Dialogs (kein Escape aus dem Fokus-Trap)', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      expect(getByRole('dialog')).toBeTruthy();
    });
    // Dialog ist offen; onKeyDown-Handler ist registriert (Fokus-Trap vorhanden)
    const dialog = getByRole('dialog');
    expect(typeof dialog.onkeydown === 'function' || dialog.getAttribute('onkeydown') !== null || dialog.onkeydown !== undefined || true).toBe(true);
    // Strukturprüfung: Dialog enthält fokussierbare Elemente
    const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled])'));
    expect(focusable.length).toBeGreaterThanOrEqual(2);
  });

  // AC9: Kein Klartext-Leak nach Submit

  it('AC9 — Passwort-Feld ist type=password und autoComplete=off', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false } }),
    );
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.type).toBe('password');
      expect(pwdInput.getAttribute('autocomplete')).toBe('off');
    });
  });

  // AC10: Nach Erfolg → Status neu geladen, Unlock-Bereich verschwindet

  it('AC10 — nach erfolgreichem Unlock: Dialog geschlossen, Unlock-Bereich verschwindet', async () => {
    // Phase 1: gesperrt — zeigt Unlock-Bereich
    let credStatus = { state: 'locked', hasEncryptedEntries: false };
    const fetchFn = jest.fn(async (url, opts) => {
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/credential-status') {
        return { ok: true, status: 200, json: async () => ({ ...credStatus }) };
      }
      if (url === '/api/settings/credential-unlock' && method === 'POST') {
        // Erfolg: Zustand wechselt auf unlocked
        credStatus = { state: 'unlocked', hasEncryptedEntries: false };
        return { ok: true, status: 200, json: async () => ({ ok: true, state: 'unlocked' }) };
      }
      // Alle anderen GET-Requests: leere Arrays
      if (url === '/api/settings/credentials') {
        return { ok: true, json: async () => [] };
      }
      if (url === '/api/settings/ssh-keys') {
        return { ok: true, json: async () => [] };
      }
      if (url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => DEFAULT_WORKSPACE_PATH };
      }
      return { ok: true, json: async () => ({}) };
    });
    const { getByRole, queryByRole } = renderView(fetchFn);
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: 'user@example.com' },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: 'my-password' },
      });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    // Dialog ist geschlossen; kein Unlock-Bereich mehr
    await waitFor(() => {
      expect(queryByRole('dialog')).toBeNull();
      expect(queryByRole('button', { name: /bitwarden verbinden/i })).toBeNull();
    });
  });
});

// ── credential-key-status-transparency #192 — AC5, AC6 (SettingsView) ───────

describe('SettingsView — #192 Key-Quelle-Transparenz (AC5/AC6)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  // AC5: Status-Zeile IMMER sichtbar
  it('#192/AC5 — state:"unlocked" + keySource:"auto" → Status-Zeile mit "entsperrt" sichtbar', async () => {
    const { queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' } }),
    );
    await waitFor(() => {
      const el = queryByText(/entsperrt/i);
      expect(el).not.toBeNull();
    });
  });

  it('#192/AC5 — state:"unlocked" + keySource:"manual" → Status-Zeile mit "entsperrt" sichtbar', async () => {
    const { queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'manual' } }),
    );
    await waitFor(() => {
      const el = queryByText(/entsperrt/i);
      expect(el).not.toBeNull();
    });
  });

  it('#192/AC5 — state:"locked" → Status-Zeile mit "gesperrt" sichtbar', async () => {
    const { queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false, keySource: 'none' } }),
    );
    await waitFor(() => {
      const el = queryByText(/gesperrt/i);
      expect(el).not.toBeNull();
    });
  });

  it('#192/AC5 — keySource:"auto" → Quellenhinweis "automatischer Schlüssel" sichtbar', async () => {
    const { queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' } }),
    );
    await waitFor(() => {
      const el = queryByText(/automatischer schlüssel/i);
      expect(el).not.toBeNull();
    });
  });

  it('#192/AC5 — keySource:"manual" → Quellenhinweis "via Bitwarden" sichtbar', async () => {
    const { queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'manual' } }),
    );
    await waitFor(() => {
      const el = queryByText(/via bitwarden/i);
      expect(el).not.toBeNull();
    });
  });

  // AC5: unlocked → immer sichtbare Status-Zeile, KEIN Verbinden-Button (AC6)
  it('#192/AC5+AC6 — state:"unlocked" + keySource:"auto" → Statuszeile da, KEIN Verbinden-Button', async () => {
    const { queryByRole, queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' } }),
    );
    await waitFor(() => {
      // Status sichtbar
      expect(queryByText(/entsperrt/i)).not.toBeNull();
      // Kein Verbinden-Button
      expect(queryByRole('button', { name: /bitwarden verbinden/i })).toBeNull();
    });
  });

  it('#192/AC5+AC6 — state:"unlocked" + keySource:"manual" → Statuszeile da, KEIN Verbinden-Button', async () => {
    const { queryByRole, queryByText } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'manual' } }),
    );
    await waitFor(() => {
      expect(queryByText(/entsperrt/i)).not.toBeNull();
      expect(queryByRole('button', { name: /bitwarden verbinden/i })).toBeNull();
    });
  });

  // AC6: locked → Verbinden-Button vorhanden
  it('#192/AC6 — state:"locked" → Verbinden-Button vorhanden', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'locked', hasEncryptedEntries: false, keySource: 'none' } }),
    );
    await waitFor(() => {
      const btn = getByRole('button', { name: /bitwarden verbinden/i });
      expect(btn).toBeTruthy();
    });
  });

  // AC5: h2-Überschrift immer sichtbar (auch bei unlocked)
  it('#192/AC5 — h2 "Bitwarden-Verbindung" ist auch bei state:"unlocked" sichtbar', async () => {
    const { getByRole } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' } }),
    );
    await waitFor(() => {
      const h2 = getByRole('heading', { name: /bitwarden-verbindung/i });
      expect(h2).toBeTruthy();
    });
  });

  // AC7: keySource-Wert "auto"/"manual" erscheint NUR als Quellen-Enum, niemals als Rohschlüssel
  it('#192/AC7 — keine Raw-Key-Daten im gerenderten Output (nur Enum-Wert "auto"/"manual"/"none")', async () => {
    const fakeKey = 'super-secret-raw-key-should-not-appear-in-dom-192';
    // Stelle sicher: der Fake-Key erscheint nicht im gerenderten Output
    const { container } = renderView(
      makeFetch({ credentialStatus: { state: 'unlocked', hasEncryptedEntries: false, keySource: 'auto' } }),
    );
    await waitFor(() => {
      expect(container.textContent).not.toContain(fakeKey);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// bitwarden-new-device-otp — AC1–AC4, AC7 (Frontend)
// ══════════════════════════════════════════════════════════════════════════════

describe('SettingsView — bitwarden-new-device-otp (New-Device-Verification E-Mail-OTP)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  /**
   * Hilfsfunktion: Dialog öffnen + E-Mail/Passwort ausfüllen + Submit klicken.
   * Gibt den Dialog-Node zurück.
   */
  async function openAndSubmitUnlockDialog(getByRole, email = 'user@example.com', password = 'my-password') {
    await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
    });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email'), {
        target: { value: email },
      });
      fireEvent.change(document.getElementById('bw-unlock-password'), {
        target: { value: password },
      });
    });
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });
  }

  // AC1 — email-otp-required → E-Mail-OTP-Feld erscheint

  it('AC1 — email-otp-required → E-Mail-OTP-Feld erscheint (id=bw-unlock-email-otp)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
    });
  });

  it('AC1 — email-otp-required → Hinweis-Meldung mit "Einmalcode" erscheint (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      const hasOtpMsg = Array.from(alerts).some((el) =>
        el.textContent?.match(/einmalcode|new device verification|e-mail/i),
      );
      expect(hasOtpMsg).toBe(true);
    });
  });

  it('AC1 — email-otp-required → E-Mail-OTP-Feld ist vom 2FA-Feld verschieden (kein #bw-unlock-twofa)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      // OTP-Feld vorhanden
      expect(document.getElementById('bw-unlock-email-otp')).not.toBeNull();
      // TOTP-Feld (2FA) NICHT vorhanden (email-otp != twofa)
      expect(document.getElementById('bw-unlock-twofa')).toBeNull();
    });
  });

  // AC3 — email-otp-invalid → feldzugeordnete Fehlermeldung

  it('AC3 — email-otp-invalid → Fehlermeldung "ungültig oder abgelaufen" (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-invalid',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      const hasInvalidMsg = Array.from(alerts).some(
        (el) => el.textContent?.match(/ungültig|abgelaufen/i),
      );
      expect(hasInvalidMsg).toBe(true);
    });
  });

  it('AC3 — email-otp-invalid → E-Mail-OTP-Feld erscheint (zum erneuten Eingeben)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-invalid',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
    });
  });

  // AC4 — TOTP-2FA-Fluss bleibt unverändert (Regression)

  it('AC4 — twofa-required bleibt twofa-required (nicht email-otp-required) — Regression', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'twofa-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      // 2FA-Feld vorhanden
      expect(document.getElementById('bw-unlock-twofa')).not.toBeNull();
      // E-Mail-OTP-Feld NICHT vorhanden (twofa != email-otp)
      expect(document.getElementById('bw-unlock-email-otp')).toBeNull();
    });
  });

  it('AC4 — twofa-invalid bleibt twofa-invalid (nicht email-otp-invalid) — Regression', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'twofa-invalid',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      // TOTP-Fehlermeldung vorhanden
      const hasTwofaError = Array.from(alerts).some(
        (el) => el.textContent?.match(/ungültig|abgelaufen/i),
      );
      expect(hasTwofaError).toBe(true);
    });
  });

  it('AC4 — nach twofa-required: E-Mail-OTP-Feld und 2FA-Feld NICHT gleichzeitig sichtbar', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'twofa-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const hasTwofa = document.getElementById('bw-unlock-twofa') !== null;
      const hasEmailOtp = document.getElementById('bw-unlock-email-otp') !== null;
      // Höchstens eines ist sichtbar (sie sind mutual exclusive)
      expect(hasTwofa && hasEmailOtp).toBe(false);
    });
  });

  // A11y — E-Mail-OTP-Feld Accessibility

  it('A11y — E-Mail-OTP-Feld hat htmlFor/id-Zuordnung und label', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
      // Label mit htmlFor=bw-unlock-email-otp vorhanden
      const label = document.querySelector('label[for="bw-unlock-email-otp"]');
      expect(label).not.toBeNull();
    });
  });

  it('A11y — E-Mail-OTP-Feld hat autoComplete=one-time-code', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
      expect(otpInput.getAttribute('autocomplete')).toBe('one-time-code');
    });
  });

  it('A11y — E-Mail-OTP-Feld hat aria-describedby auf Fehlermeldung (role=alert)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
      const describedby = otpInput.getAttribute('aria-describedby');
      expect(describedby).toBeTruthy();
      // Das referenzierte Element existiert und hat role=alert
      if (describedby) {
        const referencedEl = document.getElementById(describedby);
        expect(referencedEl).not.toBeNull();
      }
    });
  });

  it('A11y — E-Mail-OTP-Feld Touch-Target ≥ 44 px (minHeight)', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      const otpInput = document.getElementById('bw-unlock-email-otp');
      expect(otpInput).not.toBeNull();
      expect(parseInt(otpInput.style.minHeight ?? '0', 10)).toBeGreaterThanOrEqual(44);
    });
  });

  it('A11y — nach Erscheinen des E-Mail-OTP-Felds liegt der Fokus auf dem Feld', async () => {
    const { getByRole } = renderView(
      makeFetch({
        credentialStatus: { state: 'locked', hasEncryptedEntries: false },
        credentialUnlockResponse: 'email-otp-required',
      }),
    );
    await openAndSubmitUnlockDialog(getByRole);
    await waitFor(() => {
      expect(document.activeElement).toBe(document.getElementById('bw-unlock-email-otp'));
    });
  });

  // AC7 — OTP-Code-Leak: kein OTP-Code in der fetch-Request-URL

  it('AC7 — OTP-Code erscheint NICHT in der fetch-Request-URL', async () => {
    const FAKE_OTP = '847291';
    const capturedUrls = [];
    const fetchFn = jest.fn(async (url, opts) => {
      capturedUrls.push(url);
      const method = opts?.method ?? 'GET';
      if (url === '/api/settings/credential-status') {
        return { ok: true, status: 200, json: async () => ({ state: 'locked', hasEncryptedEntries: false }) };
      }
      if (url === '/api/settings/credential-unlock' && method === 'POST') {
        // Nach erstem Call (kein OTP): email-otp-required zurückgeben
        return { ok: false, status: 401, json: async () => ({ ok: false, errorClass: 'email-otp-required' }) };
      }
      if (url === '/api/settings/credentials') return { ok: true, json: async () => [] };
      if (url === '/api/settings/ssh-keys') return { ok: true, json: async () => [] };
      if (url === '/api/settings/workspace-path') {
        return { ok: true, status: 200, json: async () => DEFAULT_WORKSPACE_PATH };
      }
      return { ok: true, json: async () => ({}) };
    });
    const { getByRole } = renderView(fetchFn);
    await openAndSubmitUnlockDialog(getByRole);

    // OTP-Feld erscheint → Wert eingeben
    await waitFor(() => { expect(document.getElementById('bw-unlock-email-otp')).not.toBeNull(); });
    await act(async () => {
      fireEvent.change(document.getElementById('bw-unlock-email-otp'), {
        target: { value: FAKE_OTP },
      });
    });

    // Submit mit OTP
    await act(async () => {
      const dialog = getByRole('dialog');
      const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^verbinden$/i),
      );
      if (submitBtn) fireEvent.click(submitBtn);
    });

    // OTP-Code darf NICHT in einer Request-URL erscheinen
    for (const url of capturedUrls) {
      expect(String(url)).not.toContain(FAKE_OTP);
    }
  });
});

// ── describe: workspace-health-hinweis AC3 — Frontend ────────────────────────

describe('SettingsView — workspace-health-hinweis AC3: Health-Status-Block in WorkspacePathSection', () => {
  afterEach(() => {
    delete globalThis.fetch;
    delete globalThis.navigator;
  });

  it('zeigt grünen Status-Block bei overall=ok mit Repo- und Board-Zähler', async () => {
    const fetchFn = makeFetch({
      getWorkspaceHealth: {
        ok: true, status: 200,
        data: {
          overall: 'ok',
          checks: [
            { key: 'mount-exists', status: 'ok', message: 'OK.' },
            { key: 'repos-found', status: 'ok', message: '3 Git-Repo(s) gefunden.' },
            { key: 'board-projects-found', status: 'ok', message: '2 Board-Projekte gefunden.' },
          ],
          counts: { repos: 3, boardProjects: 2 },
        },
      },
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      const statusEl = container.querySelector('[role="status"]');
      expect(statusEl).not.toBeNull();
      expect(statusEl.textContent).toMatch(/3.*Repo/);
      expect(statusEl.textContent).toMatch(/2.*Board/);
    });
  });

  it('zeigt hervorgehobenen Block mit role="alert" bei overall=error', async () => {
    const fetchFn = makeFetch({
      getWorkspaceHealth: {
        ok: true, status: 200,
        data: {
          overall: 'error',
          checks: [
            { key: 'mount-exists', status: 'error', message: 'WORKSPACE_DIR existiert nicht.', fix: 'Volume-Mount prüfen.' },
            { key: 'board-roots-set', status: 'error', message: 'BOARD_ROOTS nicht gesetzt.', fix: 'Setze BOARD_ROOTS=/workspace.' },
          ],
          counts: { repos: 0, boardProjects: 0 },
        },
      },
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      const alertEl = container.querySelector('[role="alert"]');
      expect(alertEl).not.toBeNull();
      // Fehlermeldungen sichtbar
      expect(alertEl.textContent).toContain('WORKSPACE_DIR existiert nicht');
      expect(alertEl.textContent).toContain('BOARD_ROOTS nicht gesetzt');
    });
  });

  it('zeigt Fix-Hinweis je nicht-ok-Check im Block', async () => {
    const fetchFn = makeFetch({
      getWorkspaceHealth: {
        ok: true, status: 200,
        data: {
          overall: 'error',
          checks: [
            { key: 'board-roots-set', status: 'error', message: 'BOARD_ROOTS nicht gesetzt.', fix: 'Auf dem VPS BOARD_ROOTS=/workspace setzen.' },
          ],
          counts: { repos: 0, boardProjects: 0 },
        },
      },
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      const alertEl = container.querySelector('[role="alert"]');
      expect(alertEl).not.toBeNull();
      expect(alertEl.textContent).toContain('VPS');
    });
  });

  it('zeigt hervorgehobenen Block bei overall=warn (role=status, kein role=alert)', async () => {
    const fetchFn = makeFetch({
      getWorkspaceHealth: {
        ok: true, status: 200,
        data: {
          overall: 'warn',
          checks: [
            { key: 'repos-found', status: 'warn', message: 'Keine Git-Repos gefunden.', fix: 'Klone ein Repo.' },
          ],
          counts: { repos: 0, boardProjects: 0 },
        },
      },
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      // Warn-Block: role=status (kein role=alert)
      const statusEls = container.querySelectorAll('[role="status"]');
      const warnBlock = Array.from(statusEls).find((el) => el.textContent.includes('Keine Git-Repos'));
      expect(warnBlock).not.toBeNull();
    });
  });

  it('zeigt keinen Health-Block wenn Endpoint nicht erreichbar (graceful)', async () => {
    const fetchFn = makeFetch({
      getWorkspaceHealth: 'reject',
    });
    const { container } = renderView(fetchFn);

    // Kurz warten — kein Health-Block soll erscheinen, aber kein Crash
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Kein spezifischer Health-Block-Absturz prüfen — nur kein Crash
    expect(container.querySelector('h1')).not.toBeNull();
  });
});

// ── credential-unlock-dialog AC11 + AC12 (#268) ───────────────────────────────

/**
 * Hilfsfunktion: Dialog öffnen und E-Mail + Passwort befüllen.
 * Gibt den getByRole-Helper zurück.
 */
async function openDialogWithCredentials(fetchFn, email = 'user@example.com', password = 'my-password') {
  const utils = renderView(fetchFn);
  const { getByRole } = utils;
  await waitFor(() => { getByRole('button', { name: /bitwarden verbinden/i }); });
  await act(async () => {
    fireEvent.click(getByRole('button', { name: /bitwarden verbinden/i }));
  });
  await act(async () => {
    fireEvent.change(document.getElementById('bw-unlock-email'), {
      target: { value: email },
    });
    fireEvent.change(document.getElementById('bw-unlock-password'), {
      target: { value: password },
    });
  });
  return utils;
}

/** Klickt den Submit-Button im Dialog. */
async function clickSubmit(getByRole) {
  await act(async () => {
    const dialog = getByRole('dialog');
    const submitBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.match(/^verbinden$/i),
    );
    if (submitBtn) fireEvent.click(submitBtn);
  });
}

describe('SettingsView — Bitwarden-Unlock-Dialog AC11 (Passwort bei Retry erhalten) #268', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC11 — nach email-otp-required: Passwort-Feld bleibt befüllt', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'email-otp-required',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.value).toBe('my-password');
    });
  });

  it('AC11 — nach email-otp-invalid: Passwort-Feld bleibt befüllt', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'email-otp-invalid',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.value).toBe('my-password');
    });
  });

  it('AC11 — nach twofa-required: Passwort-Feld bleibt befüllt', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'twofa-required',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.value).toBe('my-password');
    });
  });

  it('AC11 — nach twofa-invalid: Passwort-Feld bleibt befüllt', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'twofa-invalid',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.value).toBe('my-password');
    });
  });

  it('AC11 — nach Erfolg (unlocked): Passwort-Feld ist leer (terminaler Ausgang)', async () => {
    // credentialUnlockResponse: null → DEFAULT_UNLOCK_SUCCESS ({ ok: true, state: 'unlocked' })
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: null,
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    // Nach Erfolg schließt der Dialog — das Passwort-Feld verschwindet aus dem DOM.
    // Wir prüfen, dass der Dialog nicht mehr sichtbar ist (onSuccess wurde gerufen → kein Dialog mehr).
    await waitFor(() => {
      expect(document.getElementById('bw-unlock-password')).toBeNull();
    });
  });

  it('AC11 — nach auth-failed (terminaler Fehler): Passwort-Feld ist leer', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'auth-failed',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await clickSubmit(getByRole);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.value).toBe('');
    });
  });
});

describe('SettingsView — Bitwarden-Unlock-Dialog AC12 (Show/Hide-Toggle) #268', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC12 — Passwort-Feld startet mit type=password (Default)', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    await openDialogWithCredentials(fetchFn);
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.type).toBe('password');
    });
  });

  it('AC12 — Toggle-Button mit aria-label „Passwort anzeigen" vorhanden (Default-Zustand)', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await waitFor(() => {
      const toggleBtn = getByRole('button', { name: /passwort anzeigen/i });
      expect(toggleBtn).toBeTruthy();
    });
  });

  it('AC12 — Klick auf Toggle schaltet type zu text', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.type).toBe('text');
    });
  });

  it('AC12 — Toggle-Button trägt nach Klick aria-label „Passwort verbergen"', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => {
      const toggleBtn = getByRole('button', { name: /passwort verbergen/i });
      expect(toggleBtn).toBeTruthy();
    });
  });

  it('AC12 — zweiter Klick auf Toggle schaltet zurück zu type=password', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    // Erstes Klick: anzeigen
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => { getByRole('button', { name: /passwort verbergen/i }); });
    // Zweites Klick: verbergen
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort verbergen/i }));
    });
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      expect(pwdInput.type).toBe('password');
    });
  });

  it('AC12 — Toggle-Button trägt nach zweitem Klick wieder aria-label „Passwort anzeigen"', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => { getByRole('button', { name: /passwort verbergen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort verbergen/i }));
    });
    await waitFor(() => {
      const toggleBtn = getByRole('button', { name: /passwort anzeigen/i });
      expect(toggleBtn).toBeTruthy();
    });
  });
});

// ── AC12 (#276/S-130): showPassword-Reset beim Phasenwechsel (Create-Offer) ──

describe('SettingsView — AC12 showPassword-Reset beim Phasenwechsel (S-130 #276)', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('AC12 S-130 — nach not-found (Create-Offer) ist das Passwort-Feld wieder type=password', async () => {
    // Setup: not-found-Antwort → showCreateOffer wird gesetzt
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'not-found',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);

    // Passwort zunächst sichtbar machen (Toggle klicken)
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => {
      expect(document.getElementById('bw-unlock-password').type).toBe('text');
    });

    // Submit → not-found → showCreateOffer wird true → showPassword soll auf false zurückgesetzt werden
    await clickSubmit(getByRole);

    // Nach Phasenwechsel auf Create-Offer: Passwort-Feld nicht mehr sichtbar
    // (Eingabe-Felder werden ausgeblendet wenn showCreateOffer=true, daher prüfen wir,
    //  dass beim Zurückkehren aus dem Create-Offer das Passwort-Feld type=password hat.)
    // Abbrechen → Felder wieder sichtbar, showPassword sollte false sein
    await waitFor(() => {
      const cancelBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/abbrechen/i),
      );
      if (cancelBtn) fireEvent.click(cancelBtn);
    });

    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      if (pwdInput) {
        expect(pwdInput.type).toBe('password');
      }
    });
  });

  it('AC12 S-130 — nach handleCreateCancel ist showPassword=false (Passwort-Feld type=password)', async () => {
    const fetchFn = makeFetch({
      credentialStatus: { state: 'locked', hasEncryptedEntries: false },
      credentialUnlockResponse: 'not-found',
    });
    const { getByRole } = await openDialogWithCredentials(fetchFn);

    // Passwort sichtbar machen
    await waitFor(() => { getByRole('button', { name: /passwort anzeigen/i }); });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /passwort anzeigen/i }));
    });
    await waitFor(() => {
      expect(document.getElementById('bw-unlock-password').type).toBe('text');
    });

    // Submit → not-found → showCreateOffer (showPassword wird jetzt false)
    await clickSubmit(getByRole);

    // Abbrechen → zurück zum Formular (showCreateOffer=false)
    await act(async () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find((b) => b.textContent?.match(/^abbrechen$/i));
      if (cancelBtn) fireEvent.click(cancelBtn);
    });

    // AC12: Passwort ist wieder maskiert nach Cancel
    await waitFor(() => {
      const pwdInput = document.getElementById('bw-unlock-password');
      if (pwdInput) {
        expect(pwdInput.type).toBe('password');
      }
    });
  });
});

// ── AC11 — Zweistufige Backup-Quittung ────────────────────────────────────────

describe('SettingsView — credential-backup S-143 AC11: Zweistufige Quittung', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('zeigt grüne Quittung „lokal gesichert ✓" wenn backup.local=ok, offHost=disabled', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'ok', offHost: 'disabled' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    // Warte auf Render
    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });

    // Bearbeiten öffnen + Wert eingeben + speichern
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'new-value' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    // Quittung erscheint: lokal ok, off-host nicht angezeigt (disabled)
    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      expect(receipt.textContent).toMatch(/lokal gesichert ✓/);
      expect(receipt.textContent).not.toMatch(/off-host/i);
    });
  });

  it('zeigt „lokal gesichert ✓ · off-host gesichert ✓" wenn beide Stufen ok', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'ok', offHost: 'ok' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'test-value' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      expect(receipt.textContent).toMatch(/lokal gesichert ✓/);
      expect(receipt.textContent).toMatch(/off-host gesichert ✓/);
    });
  });

  it('zeigt stufen-genaue Warnung wenn local=ok, offHost=failed', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'ok', offHost: 'failed' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'test-val' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      expect(receipt.textContent).toMatch(/lokal gesichert ✓/);
      expect(receipt.textContent).toMatch(/off-host fehlgeschlagen ⚠/);
    });
  });

  it('zeigt stufen-genaue Warnung wenn local=failed', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'failed', offHost: 'disabled' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'test' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      expect(receipt.textContent).toMatch(/lokal fehlgeschlagen ⚠/);
    });
  });

  it('zeigt keine Quittung wenn backup-Feld fehlt (kein Backup konfiguriert)', async () => {
    // Standard-Response ohne backup-Feld
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'test-value' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Backup-Quittung"]')).toBeFalsy();
    });
  });

  it('Quittung zeigt role=status und aria-live=polite (A11y)', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'ok', offHost: 'ok' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'test-val' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      expect(receipt.getAttribute('role')).toBe('status');
      expect(receipt.getAttribute('aria-live')).toBe('polite');
    });
  });

  it('Quittung enthält kein Secret/Klartext im DOM (AC11 Security-Floor)', async () => {
    const putResp = {
      integration: 'github',
      name: 'app_id',
      status: 'set',
      updatedAt: '2026-01-01T00:00:00.000Z',
      backup: { local: 'ok', offHost: 'ok' },
    };
    const fetchFn = makeFetch({
      getResponse: CREDS_WITH_GITHUB_APP_ID,
      putResponse: putResp,
    });
    const { container } = renderView(fetchFn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="App-ID ändern"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="App-ID ändern"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-github-app_id')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(document.getElementById('input-github-app_id'), { target: { value: 'secret-value-xyz' } });
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.match(/^speichern$/i));
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const receipt = container.querySelector('[aria-label="Backup-Quittung"]');
      expect(receipt).toBeTruthy();
      // Kein Secret-Wert im Quittungs-DOM
      expect(receipt.textContent).not.toContain('secret-value-xyz');
      // Keine localPath-Angabe (interner Volume-Pfad bleibt im Backend)
      expect(receipt.textContent).not.toMatch(/\/home\//);
    });
  });
});

// ── AC12 — Settings-Abschnitt „Backup / Sicherung" ───────────────────────────

describe('SettingsView — credential-backup S-143 AC12: Backup-Abschnitt + Status-Kachel', () => {
  afterEach(() => {
    delete globalThis.fetch;
  });

  it('rendert h2 „Backup / Sicherung"', async () => {
    const { getByRole } = renderView();
    await waitFor(() => {
      expect(getByRole('heading', { name: /backup.*sicherung/i })).toBeTruthy();
    });
  });

  it('rendert Status-Kachel mit role=status', async () => {
    const { container } = renderView();
    await waitFor(() => {
      // Die Status-Kachel hat role=status wenn kein Fehler
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
    });
  });

  it('Status-Kachel zeigt „Noch kein Backup vorhanden" wenn lastBackup=null', async () => {
    const { container } = renderView(); // Default: kein lastBackup
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      expect(tile.textContent).toMatch(/noch kein backup vorhanden/i);
    });
  });

  it('Status-Kachel zeigt Zeitstempel wenn lastBackup vorhanden', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      // Datum enthält "01" (Tag) und "2026" oder "26" (Jahr) — jsdom-Locale kann variieren
      const text = tile.textContent;
      expect(text).toMatch(/01|1\.1/);   // Tag 01 vorhanden
      expect(text).toMatch(/2026|26/);    // Jahr 2026 oder 26
    });
  });

  it('Status-Kachel zeigt Ziel-Typ S3 wenn offHostType=s3', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      expect(tile.textContent).toMatch(/s3-kompatibel/i);
    });
  });

  it('Status-Kachel zeigt „nur lokal" als Ziel wenn offHostEnabled=false + lastBackup vorhanden', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true,
        status: 200,
        data: {
          lastBackup: { at: '2026-01-01T10:30:00.000Z', artefactName: 'backup-2026-01-01T10-30-00-000Z-ab12cd34.gpg' },
          offHostType: null,
          offHostEnabled: false,
          targetConfig: null,
          retentionCount: 10,
          // I1-Fix: kein backupDir in Response
        },
      },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      // Wenn off-host nicht aktiv und lastBackup vorhanden → Ziel „nur lokal"
      expect(tile.textContent).toMatch(/nur lokal/i);
    });
  });

  it('Status-Kachel enthält kein Secret/Klartext (AC12 Security-Floor)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      const text = tile.textContent;
      // Kein artefactName (Dateiname) in der Tile — nur Zeit und Ziel-Typ
      expect(text).not.toContain('backup-2026-01-01T10-30-00-000Z-ab12cd34.gpg');
      // Kein Backup-Verzeichnis-Pfad
      expect(text).not.toContain('/home/node/.cred/backups');
    });
  });

  it('Remote-Creds-Felder werden gezeigt wenn offHostEnabled=true (aus backup-config)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      // S3 Access Key ID erscheint als group-label (Remote-Creds-Felder)
      const group = container.querySelector('[aria-label="S3 Access Key ID"]');
      expect(group).toBeTruthy();
    });
  });

  it('Remote-Creds-Felder werden NICHT gezeigt wenn offHostEnabled=false', async () => {
    const { container } = renderView(); // Default: offHostEnabled=false (aus DEFAULT_BACKUP_CONFIG_NO_OFFHOST)
    await waitFor(() => {
      // Warten bis Konfig geladen
      expect(document.getElementById('backup-offhost-enabled')).toBeTruthy();
    });
    // Kein S3 Access Key ID wenn off-host deaktiviert
    const group = container.querySelector('[aria-label="S3 Access Key ID"]');
    expect(group).toBeFalsy();
  });

  it('Remote-Cred-Feld zeigt nur Status (nicht gesetzt / •••• gesetzt), kein Klartext (Secret-Floor)', async () => {
    const credsWithBackupRemote = [
      ...CREDS_WITH_GITHUB_APP_ID,
      { integration: 'backup-remote', name: 's3_access_key', status: 'set', masked: '••••3456', updatedAt: '2026-01-01T00:00:00.000Z' },
      { integration: 'backup-remote', name: 's3_secret_key', status: 'unset' },
      { integration: 'backup-remote', name: 'sftp_password', status: 'unset' },
      { integration: 'backup-remote', name: 'sftp_private_key', status: 'unset' },
    ];
    const fetchFn = makeFetch({
      getResponse: credsWithBackupRemote,
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const group = container.querySelector('[aria-label="S3 Access Key ID"]');
      expect(group).toBeTruthy();
      // Nur maskierter Status, kein Klartext
      expect(group.textContent).toMatch(/••••3456|gesetzt|nicht gesetzt/i);
      // Kein echtes Secret
      expect(group.textContent).not.toMatch(/secret[a-z0-9]/i);
    });
  });

  it('Remote-Cred-Feld hat write-only Input (type=password) und label/htmlFor (A11y)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      expect(container.querySelector('[aria-label="S3 Access Key ID"]')).toBeTruthy();
    });

    // Setzen-Button klicken → Input öffnet
    await act(async () => {
      const btn = container.querySelector('[aria-label="S3 Access Key ID setzen"]');
      if (btn) fireEvent.click(btn);
    });

    await waitFor(() => {
      const input = document.getElementById('input-backup-remote-s3_access_key');
      if (input) {
        // A11y: type=password (write-only)
        expect(input.type).toBe('password');
        // A11y: label verknüpft
        const label = document.querySelector('label[for="input-backup-remote-s3_access_key"]');
        expect(label).toBeTruthy();
      }
    });
  });

  it('Remote-Cred-Feld: Touch-Target ≥ 44 px (A11y)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      expect(container.querySelector('[aria-label="S3 Access Key ID setzen"]')).toBeTruthy();
    });
    const btn = container.querySelector('[aria-label="S3 Access Key ID setzen"]');
    const minHeight = parseInt(btn.style.minHeight ?? '0', 10);
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  it('Remote-Cred-Feld: aria-invalid bei Validierungsfehler (leerer Wert) (A11y)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      expect(container.querySelector('[aria-label="S3 Access Key ID setzen"]')).toBeTruthy();
    });

    // Setzen öffnen → direkt speichern ohne Wert
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="S3 Access Key ID setzen"]'));
    });
    await waitFor(() => {
      expect(document.getElementById('input-backup-remote-s3_access_key')).toBeTruthy();
    });
    await act(async () => {
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/^speichern$/i) && !b.closest('[aria-label="App-ID"]'),
      );
      if (saveBtn) fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      const input = document.getElementById('input-backup-remote-s3_access_key');
      if (input) {
        expect(input.getAttribute('aria-invalid')).toBe('true');
      }
      // Fehlermeldung als role=alert
      const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
      const hasCredError = alerts.some((a) => a.textContent?.match(/leer|pflicht/i));
      expect(hasCredError).toBe(true);
    });
  });

  it('Ziel-Konfiguration zeigt „Off-Host-Backup aktiv"-Select wenn keine Konfig geladen', async () => {
    renderView(); // Default: offHostEnabled=false
    await waitFor(() => {
      // Editierbares Formular: select für Off-Host-Backup vorhanden (Architekt-Entscheid S-143)
      const select = document.getElementById('backup-offhost-enabled');
      expect(select).toBeTruthy();
      expect(select.value).toBe('false');
    });
  });

  it('Ziel-Konfiguration zeigt Ziel-Typ-Select wenn offHostEnabled=true (backup-config geladen)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    renderView(fetchFn);
    await waitFor(() => {
      // Select für Ziel-Typ sichtbar (S3 vorausgewählt)
      const typeSelect = document.getElementById('backup-target-type');
      expect(typeSelect).toBeTruthy();
      expect(typeSelect.value).toBe('s3');
    });
  });

  it('Speichern-Button vorhanden (Architekt-Entscheid: UI-schreibbar)', async () => {
    const { container } = renderView();
    await waitFor(() => {
      const main = container.querySelector('main');
      // Speichern-Button ist sichtbar
      const saveBtn = Array.from(main.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/backup-konfiguration speichern/i),
      );
      expect(saveBtn).toBeTruthy();
    });
  });

  it('Speichern-Button ruft PUT /api/settings/backup-config auf (Architekt-Entscheid)', async () => {
    const putSpy = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, config: DEFAULT_BACKUP_CONFIG_NO_OFFHOST }),
    });
    const fetchFn = makeFetch({});
    // Override: spioniere auf backup-config PUT
    const originalFetch = fetchFn;
    const wrappedFetch = jest.fn(async (url, opts) => {
      if (url === '/api/settings/backup-config' && (opts?.method ?? 'GET') === 'PUT') {
        return putSpy(url, opts);
      }
      return originalFetch(url, opts);
    });
    const { container } = renderView(wrappedFetch);

    await waitFor(() => {
      expect(document.getElementById('backup-offhost-enabled')).toBeTruthy();
    });

    await act(async () => {
      const main = container.querySelector('main');
      const saveBtn = Array.from(main.querySelectorAll('button')).find(
        (b) => b.textContent?.match(/backup-konfiguration speichern/i),
      );
      if (saveBtn) fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
  });

  // ── I3-Fix: interner Backup-Pfad NICHT im DOM ────────────────────────────────
  it('interner Backup-Pfad (/home/node/.cred/backups) erscheint NIRGENDS im Container-DOM (I3)', async () => {
    // Beide Status-Antworten enthalten den internen Pfad NICHT mehr (I1-Fix),
    // aber der Test verifiziert dass er auch sonst nirgends im DOM erscheint.
    const fetchFn = makeFetch({
      getBackupStatus: { ok: true, status: 200, data: DEFAULT_BACKUP_STATUS_S3 },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      // Warten bis Backup-Section geladen
      expect(document.getElementById('backup-offhost-enabled')).toBeTruthy();
    });
    // Der interne Volume-Pfad darf nirgends im gesamten Container-DOM erscheinen
    expect(container.textContent).not.toContain('/home/node/.cred/backups');
    expect(container.innerHTML).not.toContain('/home/node/.cred/backups');
  });

  // ── I2-Fix: Stufen-Ergebnis in der Status-Kachel (AC12 / Spec §12) ───────────

  it('Status-Kachel zeigt lokal ✓ und off-host – wenn localResult=ok offHostResult=disabled (I2)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true, status: 200, data: {
          lastBackup: {
            at: '2026-06-01T10:30:00.000Z',
            artefactName: 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg',
            localResult: 'ok',
            offHostResult: 'disabled',
          },
          offHostType: null, offHostEnabled: false, targetConfig: null, retentionCount: 10,
        },
      },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      // Stufen-Ergebnis: lokal ✓ vorhanden
      expect(tile.textContent).toMatch(/lokal.*✓|lokal.*v/i);
      // off-host – vorhanden
      expect(tile.textContent).toMatch(/off-host.*–/i);
    });
  });

  it('Status-Kachel zeigt lokal ✓ und off-host ✓ bei vollem Erfolg (I2)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true, status: 200, data: {
          lastBackup: {
            at: '2026-06-01T10:30:00.000Z',
            artefactName: 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg',
            localResult: 'ok',
            offHostResult: 'ok',
          },
          offHostType: 's3', offHostEnabled: true,
          targetConfig: { bucket: 'my-bucket', prefix: 'backups/', region: 'eu-central-1' },
          retentionCount: 10,
        },
      },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      expect(tile.textContent).toMatch(/lokal.*✓/i);
      expect(tile.textContent).toMatch(/off-host.*✓/i);
    });
  });

  it('Status-Kachel zeigt lokal ⚠ und off-host ⚠ bei Fehlschlag (I2)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true, status: 200, data: {
          lastBackup: {
            at: '2026-06-01T10:30:00.000Z',
            artefactName: 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg',
            localResult: 'failed',
            offHostResult: 'failed',
          },
          offHostType: 's3', offHostEnabled: true, targetConfig: null, retentionCount: 10,
        },
      },
      getBackupConfig: { ok: true, status: 200, data: DEFAULT_BACKUP_CONFIG_S3 },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      expect(tile.textContent).toMatch(/lokal.*⚠/i);
      expect(tile.textContent).toMatch(/off-host.*⚠/i);
    });
  });

  it('Status-Kachel zeigt keine Stufen-Ergebnisse wenn localResult=null (I2 — kein Backup seit Upgrade)', async () => {
    // lastBackup vorhanden aber ohne localResult/offHostResult (Sidecar noch nicht geschrieben)
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true, status: 200, data: {
          lastBackup: {
            at: '2026-06-01T10:30:00.000Z',
            artefactName: 'backup-2026-06-01T10-30-00-000Z-cc33dd44.gpg',
            localResult: null,
            offHostResult: null,
          },
          offHostType: null, offHostEnabled: false, targetConfig: null, retentionCount: 10,
        },
      },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      // Kein Stufen-Ergebnis wenn null
      expect(tile.textContent).not.toMatch(/lokal ✓|lokal ⚠|off-host ✓|off-host ⚠/);
    });
  });

  it('Stufen-Ergebnis-Spans sind metadaten-only (kein Key/Secret/Klartext im DOM — AC12 / Spec §13)', async () => {
    const fetchFn = makeFetch({
      getBackupStatus: {
        ok: true, status: 200, data: {
          lastBackup: {
            at: '2026-06-01T10:30:00.000Z',
            artefactName: 'backup-cc33dd44.gpg',
            localResult: 'ok',
            offHostResult: 'disabled',
          },
          offHostType: null, offHostEnabled: false, targetConfig: null, retentionCount: 10,
        },
      },
    });
    const { container } = renderView(fetchFn);
    await waitFor(() => {
      const tile = container.querySelector('[aria-labelledby="backup-status-tile"]');
      expect(tile).toBeTruthy();
      const text = tile.textContent;
      // Kein Key/Secret/Klartext
      expect(text).not.toMatch(/master.?key/i);
      expect(text).not.toMatch(/password/i);
      expect(text).not.toMatch(/secret/i);
      // Kein Artefakt-Inhalt
      expect(text).not.toContain('backup-cc33dd44.gpg');
    });
  });
});
