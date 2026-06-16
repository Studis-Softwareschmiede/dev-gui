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
 * SSH-Keypair-Generierung + Export (ssh-key-generation AC1/AC3/AC4/AC6/AC7/AC8 — #116):
 *   GEN-AC1  — „Keypair erzeugen" je Rollen-Label (root|alex): POST .../generate, ed25519.
 *   GEN-AC3  — Public-Key in Antwort angezeigt + kopierbar; Private-Key NIE in normaler Anzeige.
 *   GEN-AC4  — „Private-Key herunterladen"-Button ruft Export-Endpunkt (dauerhaft wiederholbar).
 *   GEN-AC6  — Generate/Export hinter Access-Mauer + CRED_ADMIN_EMAILS (403 → Fehlermeldung).
 *   GEN-AC7  — 409 key-exists: Overwrite-Bestätigung zeigen; mit { overwrite:true } wiederholen.
 *   GEN-AC8  — Nach Generierung Label-Liste neu laden (Refetch) für VPS-Create-Zuordnung.
 *
 * SSH-Key-Rotation (ssh-key-rotation AC1/AC5/AC7 — #119):
 *   ROT-AC1  — „Rotation auslösen" je Rollen-Label (root|alex): POST .../rotate mit Zielfeldern
 *              {host, port?, targetUser, hostFingerprint?}. Vollautomatischer Ablauf ohne Halt.
 *   ROT-AC5  — Ergebnis anzeigen: „rotiert" (Erfolg, neuer Public-Key aktiv, oldKeyRemoved-Status)
 *              oder Fehlergrund (rotation-verify-failed → klare Aussage „alter Key erhalten",
 *              403 → keine Berechtigung). Ergebnis programmatisch zugeordnet (role=status/alert).
 *   ROT-AC7  — Kein Private-Key in Rotation-Anzeige; nur Public-Key/Status sichtbar.
 *              Loading-State während der Rotation. Labels + Ergebnis programmatisch zugeordnet.
 *
 * A11y: WCAG 2.1 AA — Überschriften-Struktur, sichtbarer Fokus, Touch-Target ≥ 44 px,
 *       Kontrast ≥ 4.5:1, Fehler programmatisch zugeordnet (aria-describedby).
 *       Overwrite-Bestätigung programmatisch zugeordnet (role=alertdialog, aria-labelledby,
 *       aria-describedby).
 *
 * Security (Floor):
 *   - Kein Secret im Frontend-Bundle.
 *   - Private-Key-Klartext wird nach erfolgreichem Speichern sofort verworfen (nur State).
 *   - Kein Klartext-Wert in irgendwelchen Logs oder Konsolen-Ausgaben.
 *   - Private-Key-Klartext wird NUR über den expliziten Export-Endpunkt bezogen (nie in normaler
 *     Sektion-Anzeige, nicht im State der Sektion-Komponente).
 *   - Rotation-Response enthält NUR newPublicKey + Status; nie den neuen oder alten Private-Key.
 *   - E-Mail-OTP-Code (bitwarden-new-device-otp #204) wird nach Submit aus React-State verworfen;
 *     kein console.log; autoComplete=one-time-code; nur via Request-Body an Backend.
 *
 * Bitwarden New-Device-Verification (bitwarden-new-device-otp #204 — AC5/AC6/AC7/AC9):
 *   AC5  — email-otp-required/email-otp-invalid → EIGENES E-Mail-OTP-Feld (showEmailOtp-State),
 *           textlich UNTERSCHIEDLICH vom TOTP-2FA-Fall; Fokusführung beim Erscheinen (AC9).
 *   AC6  — email-otp-invalid → feldzugeordnete Fehlermeldung (aria-describedby/role=alert).
 *   AC7  — OTP-Code nach Submit verworfen; autoComplete=one-time-code; kein Argv/Log/Audit-Leak.
 *   AC9  — label/htmlFor, Fokusführung, type=text, autoComplete=one-time-code, Touch-Target ≥ 44 px.
 *
 * Backup-Settings-UI (credential-backup S-143 — AC11/AC12):
 *   AC11 — Zweistufige Quittung: nach jeder Credential-Schreib-Operation zeigt CredentialField
 *           „lokal gesichert ✓" (backup.local='ok') und „off-host gesichert ✓" (backup.offHost='ok');
 *           bei failed → stufen-genaue Warnung; offHost='disabled' → nur lokale Stufe angezeigt.
 *           Gilt für CredentialField (alle Integrationen) + BackupRemoteCredField.
 *   AC12 — Abschnitt „Backup / Sicherung": Status-Kachel (letztes Backup: Zeit, Ergebnis je Stufe,
 *           Ziel — leak-frei), Ziel-Konfiguration (UI-schreibbar, Architekt-Entscheid S-143),
 *           Remote-Creds write-only (backup-remote Catalog).
 *           Stufen-Ergebnis (lokal ✓/⚠, off-host ✓/⚠/–) aus Sidecar (backup-last-result.json).
 *           A11y: Labels mit htmlFor, aria-invalid bei Fehler, Touch-Targets ≥ 44 px,
 *           aria-describedby, role=status / role=alert, role=img auf Stufen-Icons.
 *           Status-Kachel zeigt NUR Metadaten — kein Key/Secret/Klartext.
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

// ── Bitwarden-Unlock-API-Helfer (credential-unlock-dialog #185) ───────────────

/**
 * GET /api/settings/credential-status
 * Liefert { state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }.
 * AC1: Sichtbarkeits- und Quellen-Quelle für den Store-Status-Bereich.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }>}
 */
async function fetchCredentialStatus(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/credential-status');
  if (!res.ok) throw new Error(`Credential-Status laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * POST /api/settings/credential-unlock
 * Body: { email, password, twofa?, emailOtp?, create? }
 * AC3/AC4/AC5/AC5a: Beschaffung / Erstellung / 2FA-Flow / E-Mail-OTP-Flow.
 * AC9 (credential-unlock-dialog) + AC7 (bitwarden-new-device-otp):
 *   Login-Daten + Key + E-Mail-OTP erscheinen NICHT in Logs/Bundle/URL.
 *
 * @param {{ email: string, password: string, twofa?: string, emailOtp?: string, create?: boolean }} params
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, state?: string, status?: string, errorClass?: string, error?: string, httpStatus: number }>}
 */
async function postCredentialUnlock({ email, password, twofa, emailOtp, create }, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  // AC9: Credentials nur im Request-Body (nie in URL/Query)
  const body = { email, password };
  if (twofa && twofa.trim()) body.twofa = twofa.trim();
  // AC7 (new-device-otp): emailOtp nur im Body, nie in URL/Query/Logs
  if (emailOtp && emailOtp.trim()) body.emailOtp = emailOtp.trim();
  if (create === true) body.create = true;
  const res = await fn('/api/settings/credential-unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // AC9: httpStatus für Frontend-Logik; Credentials werden NICHT zurückgegeben
  return { ...data, httpStatus: res.status };
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

/**
 * GET /api/settings/workspace-health
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ overall: string, checks: Array, counts: { repos: number, boardProjects: number } }>}
 */
async function fetchWorkspaceHealth(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/workspace-health');
  if (!res.ok) throw new Error(`Workspace-Health laden fehlgeschlagen (${res.status})`);
  return res.json();
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

/**
 * Generiert ein neues ed25519-Keypair für das Rollen-Label {user} (GEN-AC1).
 * Body: { overwrite?: boolean, comment?: string }
 *
 * @returns {Promise<{ user, publicKey, privateKeyStatus, generatedAt } | { error, errorClass? }>}
 */
async function generateSshKeypair(user, { overwrite = false } = {}) {
  const body = {};
  if (overwrite) body.overwrite = true;
  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // Fehler-Shape: { error, errorClass? }; Erfolg-Shape: { user, publicKey, privateKeyStatus, generatedAt }
  return { ...data, httpStatus: res.status };
}

/**
 * Löst eine vollautomatische SSH-Key-Rotation für {user} aus (ROT-AC1).
 * Body: { host, port?, targetUser, hostFingerprint? }
 *
 * Erfolg-Shape:  { result: 'rotated', oldKeyRemoved: boolean, newPublicKey: string, reason? }
 * Fehler-Shape:  { result: 'error', errorClass: string, error: string, reason? }
 *
 * @returns {Promise<object>} — immer JSON; httpStatus für Fehler-Behandlung
 */
async function rotateSshKey(user, { host, port, targetUser, hostFingerprint }) {
  const body = { host, targetUser };
  if (port !== undefined && port !== '') body.port = Number(port);
  if (hostFingerprint && hostFingerprint.trim()) body.hostFingerprint = hostFingerprint.trim();

  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ...data, httpStatus: res.status };
}

/**
 * Exportiert den Private-Key für {user} als Blob und löst einen Browser-Download aus (GEN-AC4).
 * DAUERHAFT wiederholbar — solange ein Private-Key für das Label gesetzt ist.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function exportAndDownloadPrivateKey(user) {
  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}/private-key/export`);
  if (!res.ok) {
    let errMsg = `Export fehlgeschlagen (${res.status})`;
    try {
      const data = await res.json();
      errMsg = data.error ?? errMsg;
    } catch { /* ignore */ }
    return { ok: false, error: errMsg };
  }
  // Private-Key als text/plain → Download ohne in State zu laden (Security-Floor: kein Klartext im State)
  const text = await res.text();
  const blob = new globalThis.Blob([text], { type: 'text/plain' });
  const url = globalThis.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${user}_ed25519`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  globalThis.URL.revokeObjectURL(url);
  return { ok: true };
}

// ── Backup-API-Helfer (S-143, AC12) ──────────────────────────────────────────

/**
 * GET /api/settings/backup-status
 * Liefert Metadaten des letzten Backups (metadaten-only — kein Secret).
 * Kein backupDir in der Response (I1-Fix: interner Volume-Pfad).
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ lastBackup: { at: string, artefactName: string, localResult: 'ok'|'failed'|null, offHostResult: 'ok'|'failed'|'disabled'|null }|null, offHostType: string|null, offHostEnabled: boolean, targetConfig: object|null, retentionCount: number }>}
 */
async function fetchBackupStatus(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/backup-status');
  if (!res.ok) throw new Error(`Backup-Status laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * GET /api/settings/backup-config
 * Liefert die persistierte nicht-geheime Backup-Konfiguration
 * (Architekt-Entscheid S-143, Variante B: JSON-Datei > Env-Vars > Defaults).
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<import('../../../src/BackupConfigStore.js').BackupConfig>}
 */
async function fetchBackupConfig(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/backup-config');
  if (!res.ok) throw new Error(`Backup-Konfiguration laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * PUT /api/settings/backup-config
 * Schreibt die nicht-geheime Backup-Konfiguration (atomar, 0600 auf Credential-Volume).
 * Admin-geschützt (CRED_ADMIN_EMAILS) + Audit-First.
 *
 * @param {object} config - Zu speichernde Konfiguration (alle Felder optional)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, config: object }>}
 */
async function saveBackupConfig(config, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/backup-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `Speichern fehlgeschlagen (${res.status})`);
  }
  return res.json();
}

/**
 * PUT /api/settings/credentials/backup-remote/:name
 * Setzt einen Remote-Credential-Wert (write-only). Renutzt putCredential().
 *
 * @param {string} name  - Feldname (s3_access_key|s3_secret_key|sftp_password|sftp_private_key)
 * @param {string} value
 * @returns {Promise<object>}
 */
async function putBackupRemoteCred(name, value) {
  return putCredential('backup-remote', name, value);
}

/**
 * DELETE /api/settings/credentials/backup-remote/:name
 * Löscht einen Remote-Credential-Wert.
 *
 * @param {string} name
 * @returns {Promise<object>}
 */
async function deleteBackupRemoteCred(name) {
  return deleteCredential('backup-remote', name);
}

/**
 * POST /api/settings/backup-restore?confirm=true
 * Lädt ein verschlüsseltes Backup-Artefakt hoch und stellt den Store wieder her.
 * Admin-geschützt (CRED_ADMIN_EMAILS) + Audit-First (AC16).
 *
 * Sendet die Datei als application/octet-stream (raw binary).
 * Security-Floor: kein Master-Key / Klartext im Body/Response.
 *
 * @param {ArrayBuffer} artefactBuffer - Artefakt-Inhalt als ArrayBuffer
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, manifest?: object, errorClass?: string, error?: string, httpStatus: number }>}
 */
async function postBackupRestore(artefactBuffer, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/backup-restore?confirm=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: artefactBuffer,
  });
  const data = await res.json();
  return { ...data, httpStatus: res.status };
}

// ── RestoreSection (S-142 AC13–AC16) ─────────────────────────────────────────

/**
 * UI-Abschnitt „Restore" (S-142, AC13–AC16).
 *
 * Erlaubt das Hochladen eines verschlüsselten Backup-Artefakts, das mit dem
 * geladenen Master-Key GPG-entschlüsselt und als wiederhergestelltes
 * secrets.enc.json atomar ans Volume zurückgeschrieben wird.
 *
 * AC13 — Restore-Flow: Upload → GPG-decrypt → atomares Zurückschreiben → Store nutzbar.
 * AC14 — Überschreib-Bestätigung: Checkbox muss aktiv sein; ohne → Fehler.
 * AC15 — Sicherheit: Falscher Key/korruptes Artefakt → klassifizierter, geheimnisfreier Fehler;
 *         alter Store bleibt intakt (Backend: Schreiben erst nach erfolgreichem Decrypt).
 * AC16 — Schutz + Audit: Admin-Gate (CRED_ADMIN_EMAILS) + Audit-First im Backend.
 *         403 → Fehlermeldung; kein Master-Key/Klartext in Response.
 *
 * Security-Floor:
 *   - Kein Master-Key / Artefakt-Klartext in Response/DOM/Log.
 *   - Datei-Inhalt wird als ArrayBuffer nur in-memory gehalten.
 *   - Nach Abschluss (Erfolg oder Fehler) wird der ArrayBuffer-Verweis verworfen.
 *
 * A11y (NFR §96):
 *   - label/htmlFor auf file-Input und Confirm-Checkbox.
 *   - aria-describedby für Fehler (role=alert) und Erfolg (role=status).
 *   - aria-busy auf Restore-Button während der Operation.
 *   - Touch-Targets ≥ 44 px.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */
function RestoreSection({ fetchFn }) {
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

/** Styles für RestoreSection (S-142). */
const restoreStyles = {
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

/** Remote-Creds-Felder für backup-remote (write-only, analog Credential-Catalog). */
const BACKUP_REMOTE_FIELDS = [
  { name: 's3_access_key',    label: 'S3 Access Key ID' },
  { name: 's3_secret_key',    label: 'S3 Secret Access Key' },
  { name: 'sftp_password',    label: 'SFTP Passwort' },
  { name: 'sftp_private_key', label: 'SFTP Private Key (PEM)' },
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
    ? (status.offHostType === 's3' ? 'S3-kompatibel' : status.offHostType === 'sftp' ? 'SFTP' : status.offHostType ?? 'unbekannt')
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
function BackupSection({ credentials, onSaved, fetchFn }) {
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
  const [targetType, setTargetType] = useState('local');
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('backups/');
  const [region, setRegion] = useState('us-east-1');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
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
      setOffHostEnabled(Boolean(data.offHostEnabled));
      setTargetType(data.targetType ?? 'local');
      setEndpoint(data.endpoint ?? '');
      setBucket(data.bucket ?? '');
      setPrefix(data.prefix ?? 'backups/');
      setRegion(data.region ?? 'us-east-1');
      setHost(data.host ?? '');
      setPort(data.port ?? '22');
      setUser(data.user ?? '');
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
        prefix: prefix.trim(),
        region: region.trim(),
        host: host.trim(),
        port: port.trim(),
        user: user.trim(),
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
  }, [offHostEnabled, targetType, endpoint, bucket, prefix, region, host, port, user, retentionCount, fetchFn, loadStatus]);

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
                  <option value="sftp">SFTP</option>
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
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="backups/"
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

            {/* SFTP-Felder */}
            {offHostEnabled && targetType === 'sftp' && (
              <>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-sftp-host" style={backupStyles.configFormLabel}>
                    SFTP-Host:
                  </label>
                  <input
                    id="backup-sftp-host"
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="sftp.example.com"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-sftp-port" style={backupStyles.configFormLabel}>
                    SFTP-Port:
                  </label>
                  <input
                    id="backup-sftp-port"
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                    style={backupStyles.configInput}
                    autoComplete="off"
                    inputMode="numeric"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-sftp-user" style={backupStyles.configFormLabel}>
                    SFTP-Benutzer:
                  </label>
                  <input
                    id="backup-sftp-user"
                    type="text"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    placeholder="backupuser"
                    style={backupStyles.configInput}
                    autoComplete="off"
                  />
                </div>
                <div style={backupStyles.configFormRow}>
                  <label htmlFor="backup-sftp-prefix" style={backupStyles.configFormLabel}>
                    Pfad-Präfix:
                  </label>
                  <input
                    id="backup-sftp-prefix"
                    type="text"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="/backups"
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

// ── Backup-Styles (AC12) ──────────────────────────────────────────────────────

const backupStyles = {
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

// ── WorkspacePathSection ──────────────────────────────────────────────────────

/**
 * Sektion „Workspace-Pfad" — zeigt den wirksamen Workspace-Root inkl. Quelle und erlaubt
 * setzen/ändern (PUT) und zurücksetzen (DELETE) auf den Env-Default.
 * Platziert in der GitHub-Sektion der Einstellungen, unter den GitHub-App-Credentials.
 *
 * WS-AC1: Anzeige wirksamer Pfad + Quelle; Setzen/Ändern/Zurücksetzen.
 * WS-AC3 (UI): 4xx/422 → feldzugeordnete Fehlermeldung; alter Wert bleibt sichtbar.
 * AC3 (workspace-health-hinweis): Health-Status-Block; grün bei ok, hervorgehoben bei warn/error.
 * A11y: label/htmlFor, aria-describedby, role=status/alert, aria-busy, Fokusführung.
 *
 * @param {{
 *   effectivePath: string|null,
 *   source: "configured"|"env-default",
 *   mountRoot: string,
 *   onReload: () => Promise<void>,
 *   fetchFn?: typeof fetch,
 *   health?: { overall: string, checks: Array, counts: { repos: number, boardProjects: number } }|null,
 * }} props
 */
function WorkspacePathSection({ effectivePath, source, mountRoot, onReload, fetchFn, health }) {
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

      {/* AC3 (workspace-health-hinweis): Health-Status-Block */}
      {health && typeof health.overall === 'string' && health.overall === 'ok' && (
        <div style={healthStyles.ok} role="status" aria-live="polite">
          <span style={healthStyles.okIcon} aria-hidden="true">✓</span>
          {' '}Workspace korrekt konfiguriert — {health.counts.repos} Repo(s), {health.counts.boardProjects} Board-Projekt(e)
        </div>
      )}
      {health && typeof health.overall === 'string' && health.overall !== 'ok' && Array.isArray(health.checks) && (
        <div
          style={health.overall === 'error' ? healthStyles.error : healthStyles.warn}
          role={health.overall === 'error' ? 'alert' : 'status'}
          aria-live={health.overall === 'error' ? 'assertive' : 'polite'}
        >
          <p style={healthStyles.alertTitle}>
            {health.overall === 'error' ? 'Workspace-Fehlkonfiguration erkannt' : 'Workspace-Hinweis'}
          </p>
          <ul style={healthStyles.checkList} aria-label="Health-Checks">
            {health.checks.filter((c) => c.status !== 'ok').map((c) => (
              <li key={c.key} style={healthStyles.checkItem}>
                <span style={c.status === 'error' ? healthStyles.checkIconError : healthStyles.checkIconWarn} aria-hidden="true">
                  {c.status === 'error' ? '✗' : '⚠'}
                </span>
                {' '}<strong>{c.key}:</strong> {c.message}
                {c.fix && (
                  <span style={healthStyles.fixHint}>
                    {' → '}{c.fix}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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
/**
 * Rendert die zweistufige Backup-Quittung (AC11).
 * local: 'ok'|'failed', offHost: 'ok'|'failed'|'disabled'
 * Kein Secret, keine Pfadangabe — nur Stufen-Ergebnis.
 *
 * @param {{ local: string, offHost: string }} backup
 */
function BackupReceipt({ backup }) {
  if (!backup) return null;
  const { local, offHost } = backup;
  return (
    <div style={backupReceiptStyles.wrapper} role="status" aria-live="polite" aria-label="Backup-Quittung">
      {/* Lokale Stufe */}
      <span
        style={local === 'ok' ? backupReceiptStyles.ok : backupReceiptStyles.warn}
        aria-label={local === 'ok' ? 'lokal gesichert' : 'lokale Sicherung fehlgeschlagen'}
      >
        {local === 'ok' ? 'lokal gesichert ✓' : 'lokal fehlgeschlagen ⚠'}
      </span>
      {/* Off-Host-Stufe: nur anzeigen wenn nicht disabled */}
      {offHost !== 'disabled' && (
        <>
          <span style={backupReceiptStyles.separator} aria-hidden="true">{' · '}</span>
          <span
            style={offHost === 'ok' ? backupReceiptStyles.ok : backupReceiptStyles.warn}
            aria-label={offHost === 'ok' ? 'off-host gesichert' : 'off-host Sicherung fehlgeschlagen'}
          >
            {offHost === 'ok' ? 'off-host gesichert ✓' : 'off-host fehlgeschlagen ⚠'}
          </span>
        </>
      )}
    </div>
  );
}

const backupReceiptStyles = {
  wrapper: {
    marginTop: 6,
    fontSize: 12,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
  },
  ok: {
    color: '#86efac',   // Grün — Kontrast ≥ 4.5:1 auf #111
    fontFamily: 'monospace',
  },
  warn: {
    color: '#fca5a5',   // Rot — Kontrast ≥ 4.5:1 auf #111
    fontFamily: 'monospace',
  },
  separator: {
    color: '#6b7280',
    userSelect: 'none',
  },
};

function CredentialField({ integration, name, label, meta, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  // AC11: Backup-Quittung nach Credential-Schreib-Operation
  const [backupResult, setBackupResult] = useState(null);
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
      const data = await putCredential(integration, name, trimmed);
      // AC4/AC2: Klartext sofort verwerfen nach Speichern
      setInputVal('');
      setEditing(false);
      // AC11: Backup-Quittung anzeigen (falls Backup-Ergebnis in der Antwort vorhanden)
      if (data?.backup) setBackupResult(data.backup);
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
      const data = await deleteCredential(integration, name);
      // AC11: Backup-Quittung anzeigen (falls Backup-Ergebnis in der Antwort vorhanden)
      if (data?.backup) setBackupResult(data.backup);
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

      {/* AC11: Zweistufige Backup-Quittung nach Schreib-Operation */}
      {backupResult && <BackupReceipt backup={backupResult} />}
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
  // credential-unlock-dialog #185: Bitwarden-Unlock-Status + Dialog
  const [credentialStatus, setCredentialStatus] = useState(null); // null = noch nicht geladen
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);

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

  useEffect(() => {
    load();
    reloadWorkspacePath();
    reloadWorkspaceHealth();
    reloadCredentialStatus();
  }, [load, reloadWorkspacePath, reloadWorkspaceHealth, reloadCredentialStatus]);

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
        <h1 style={styles.title}>Einstellungen</h1>

        {/* AC5/AC6 (credential-key-status-transparency): Store-Status immer anzeigen — auch bei unlocked */}
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
                onReload={async () => { await reloadWorkspacePath(); await reloadWorkspaceHealth(); }}
                fetchFn={fetchFn}
                health={workspaceHealth}
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

        {/* Backup / Sicherung (AC12) */}
        <section aria-labelledby="settings-section-backup" style={styles.section}>
          <h2 id="settings-section-backup" style={styles.sectionHeading}>Backup / Sicherung</h2>
          <p style={styles.sectionDesc}>
            Automatische Sicherung des Credential-Stores nach jedem Schreib-Vorgang.
            Remote-Zugangsdaten werden write-only im Credential-Store hinterlegt.
          </p>
          <BackupSection credentials={credentials} onSaved={load} fetchFn={fetchFn} />
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

// ── Health-Status-Block styles (workspace-health-hinweis AC3) ────────────────

/** Styles für den Workspace-Health-Status-Block in WorkspacePathSection. */
const healthStyles = {
  ok: {
    marginTop: 10,
    padding: '8px 12px',
    background: '#052e16',
    border: '1px solid #166534',
    borderRadius: 4,
    color: '#86efac',   // Grün, Kontrast auf #052e16 ≥ 4.5:1
    fontSize: 13,
    lineHeight: 1.5,
  },
  okIcon: {
    fontWeight: 700,
  },
  warn: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#1c1200',
    border: '1px solid #854d0e',
    borderRadius: 4,
    color: '#fef08a',   // Gelb, Kontrast auf #1c1200 ≥ 4.5:1
    fontSize: 13,
  },
  error: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#2d0f0f',
    border: '1px solid #991b1b',
    borderRadius: 4,
    color: '#fca5a5',   // Rot, Kontrast auf #2d0f0f ≥ 4.5:1
    fontSize: 13,
  },
  alertTitle: {
    margin: '0 0 8px',
    fontWeight: 700,
    fontSize: 13,
  },
  checkList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  checkItem: {
    fontSize: 13,
    lineHeight: 1.5,
  },
  checkIconError: {
    fontWeight: 700,
    color: '#f87171',
  },
  checkIconWarn: {
    fontWeight: 700,
    color: '#fbbf24',
  },
  fixHint: {
    fontSize: 12,
    color: '#d4d4d4',
    fontStyle: 'italic',
  },
};

// ── RotationForm styles (ssh-key-rotation #119) ───────────────────────────────

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

// ── BitwardenUnlockDialog styles (credential-unlock-dialog #185) ──────────────

/** Styles für den Unlock-Button/-Bereich im gesperrten Zustand (AC1). */
const unlockStyles = {
  section: {
    marginBottom: 24,
    padding: '20px 24px',
    background: '#0d1a0d',
    border: '1px solid #166534',
    borderRadius: 8,
  },
  heading: {
    margin: '0 0 8px',
    fontSize: 18,
    fontWeight: 700,
    color: '#86efac',   // Kontrast auf #0d1a0d ≥ 4.5:1
  },
  desc: {
    margin: '0 0 16px',
    fontSize: 13,
    color: '#9ca3af',   // Kontrast ≥ 4.5:1 auf #0d1a0d
    lineHeight: 1.5,
  },
  btnConnect: {
    padding: '10px 20px',
    background: '#065f46',    // Grün — Verbindungs-Aktion
    color: '#d1fae5',         // Kontrast auf #065f46 ≥ 4.5:1
    border: '1px solid #047857',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: 700,
    minHeight: 44,
  },
};

/** Styles für den BitwardenUnlockDialog (AC2: modal, A11y). */
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

// ── KeygenPanel styles (ssh-key-generation #116) ──────────────────────────────

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
