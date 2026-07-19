/**
 * settingsApi.js — Geteilte API-Helfer + Konstanten für die Settings-Kategorie-Wrapper.
 *
 * Extrahiert aus SettingsView.jsx (S-266, settings-panel-navigation AC15) — reine
 * Umverpackung, KEINE Logik-Änderung. Einzige Quelle für Credential-, Workspace-Pfad-,
 * SSH-Key-, Backup- und Notification-API-Helfer, damit mehrere Kategorie-Wrapper
 * dieselbe Implementierung teilen (kein doppelt gepflegter Code).
 *
 * Security (Floor): kein Secret im Frontend-Bundle; Credential-Werte werden nie im
 * Klartext geloggt; alle Schreib-Endpunkte bleiben hinter der Access-Mauer (Backend).
 */

export const MAX_VALUE_LEN = 65536;

/** Maximale Länge eines misc-Schlüsselnamens. */
export const MAX_MISC_NAME_LEN = 128;

/** Bekannte Felder je Integration (muss mit CREDENTIAL_CATALOG im Backend übereinstimmen). */
export const KNOWN_FIELDS = {
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
  // anthropic-oauth-vault AC10 (S-368): Abo-OAuth-Credentials für die offizielle
  // Nutzungsanzeige (GET /api/usage) — write-only, gleiches CredentialField-Muster.
  'anthropic-oauth': [
    { name: 'access_token', label: 'Access-Token' },
    { name: 'refresh_token', label: 'Refresh-Token' },
  ],
};

/**
 * Gültige OpenSSH-Public-Key-Typen (Frontend-Validierung, sync mit Backend).
 * AC4: verhindert das Absenden offensichtlich ungültiger Formate.
 */
export const SSH_PUBKEY_PREFIXES = [
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
export function validatePublicKeyFormat(key) {
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
export async function fetchCredentialStatus(fetchImpl) {
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
export async function postCredentialUnlock({ email, password, twofa, emailOtp, create }, fetchImpl) {
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

// ── Master-Key-Rotation (credential-key-rotation v2, S-342) ──────────────────

/**
 * POST /api/settings/credential-rotate
 * Body: { newKey, bwEmail?, bwPassword?, bwTwofa?, bwEmailOtp? }
 * Stufe 1 (Re-Encryption + Round-trip-Verifikation + Swap) läuft immer; Stufe 2
 * (Bitwarden-Archivierung, AC4/AC11) nur wenn bwEmail+bwPassword mitgeliefert werden.
 * Weder Key- noch Bitwarden-Login-Werte erscheinen in der Response (AC9).
 *
 * @param {{ newKey: string, bwEmail?: string, bwPassword?: string, bwTwofa?: string, bwEmailOtp?: string }} params
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, swapped?: boolean, reason?: string, backup?: object, archive?: { ok: boolean, errorClass?: string }, httpStatus: number }>}
 */
export async function postCredentialRotate({ newKey, bwEmail, bwPassword, bwTwofa, bwEmailOtp }, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const body = { newKey };
  if (bwEmail && bwEmail.trim()) body.bwEmail = bwEmail.trim();
  if (bwPassword) body.bwPassword = bwPassword;
  if (bwTwofa && bwTwofa.trim()) body.bwTwofa = bwTwofa.trim();
  if (bwEmailOtp && bwEmailOtp.trim()) body.bwEmailOtp = bwEmailOtp.trim();
  const res = await fn('/api/settings/credential-rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ...data, httpStatus: res.status };
}

/**
 * POST /api/settings/credential-key-archive-discard
 * Body: { bwEmail, bwPassword, bwTwofa?, bwEmailOtp?, confirm: true }
 * Entsorgt PERMANENT das gesamte „Schlüssel-Archiv"-Feld — GETRENNTE, explizit
 * bestätigte Aktion (AC5/AC13), niemals Teil des normalen Rotations-Flows.
 *
 * @param {{ bwEmail: string, bwPassword: string, bwTwofa?: string, bwEmailOtp?: string }} params
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, reason?: string, httpStatus: number }>}
 */
export async function postCredentialKeyArchiveDiscard({ bwEmail, bwPassword, bwTwofa, bwEmailOtp }, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const body = { bwEmail, bwPassword, confirm: true };
  if (bwTwofa && bwTwofa.trim()) body.bwTwofa = bwTwofa.trim();
  if (bwEmailOtp && bwEmailOtp.trim()) body.bwEmailOtp = bwEmailOtp.trim();
  const res = await fn('/api/settings/credential-key-archive-discard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ...data, httpStatus: res.status };
}

// ── API-Helfer ────────────────────────────────────────────────────────────────

export async function fetchCredentials() {
  const res = await fetch('/api/settings/credentials');
  if (!res.ok) throw new Error(`Laden fehlgeschlagen (${res.status})`);
  return res.json();
}

export async function putCredential(integration, name, value) {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(integration)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

export async function deleteCredential(integration, name) {
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
export async function fetchWorkspacePath(fetchImpl) {
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
export async function putWorkspacePath(path, fetchImpl) {
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
export async function deleteWorkspacePath(fetchImpl) {
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
export async function fetchWorkspaceHealth(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/workspace-health');
  if (!res.ok) throw new Error(`Workspace-Health laden fehlgeschlagen (${res.status})`);
  return res.json();
}

// ── Obsidian-Vault-Path-API-Helfer (obsidian-vault-config AC1 — UI-Anteil, S-247) ──

/**
 * GET /api/settings/obsidian-vault-path
 * `mountStatus` additiv (obsidian-vault-folder-browser AC1, S-378).
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ vaultPath: string|null, configured: boolean, mountStatus: 'ok'|'unusable'|'unconfigured', mountRoot?: string }>}
 */
export async function fetchObsidianVaultPath(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-vault-path');
  if (!res.ok) throw new Error(`Obsidian-Vault-Pfad laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * GET /api/settings/obsidian-vault/browse (obsidian-vault-folder-browser AC2–AC4, S-378/S-379)
 * Read-only Ordner-Browser innerhalb der Mount-Schranke `OBSIDIAN_VAULT_DIR`.
 *
 * @param {string|null|undefined} path  Container-Pfad (optional; ohne Angabe = Mount-Root).
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ root: string, path: string, parent: string|null, breadcrumb: Array<{name:string,path:string}>, entries: Array<{name:string,path:string}> }>}
 * @throws {Error & { status: number, mountStatus?: 'unusable'|'unconfigured' }}
 *   `status` trägt den HTTP-Status (409 = mountStatus nicht nutzbar, 400/404 = Traversal/Race).
 */
export async function fetchObsidianVaultBrowse(path, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fn(`/api/settings/obsidian-vault/browse${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Ordner-Auflistung fehlgeschlagen (${res.status})`);
    err.status = res.status;
    if (data.mountStatus) err.mountStatus = data.mountStatus;
    throw err;
  }
  return data;
}

/**
 * PUT /api/settings/obsidian-vault-path
 * @param {string} path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ vaultPath: string, configured: true }>}
 */
export async function putObsidianVaultPath(path, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-vault-path', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * DELETE /api/settings/obsidian-vault-path
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ vaultPath: null, configured: false }>}
 */
export async function deleteObsidianVaultPath(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-vault-path', { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Zurücksetzen fehlgeschlagen (${res.status})`);
  return data;
}

// ── Obsidian-Projekt-Unterordner-API-Helfer (obsidian-vault-config v3 AC8, S-381) ──

/**
 * GET /api/settings/obsidian-projekte-subdir
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effective: string, source: 'persisted'|'env'|'default', persisted: string|null }>}
 */
export async function fetchObsidianProjekteSubdir(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-projekte-subdir');
  if (!res.ok) throw new Error(`Obsidian-Projekt-Unterordner laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * PUT /api/settings/obsidian-projekte-subdir
 * @param {string} subdir  Vault-relatives Segment (AC9, Mehrebenen erlaubt).
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effective: string, source: 'persisted', persisted: string }>}
 */
export async function putObsidianProjekteSubdir(subdir, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-projekte-subdir', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subdir }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * DELETE /api/settings/obsidian-projekte-subdir
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ effective: string, source: 'env'|'default', persisted: null }>}
 */
export async function deleteObsidianProjekteSubdir(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/obsidian-projekte-subdir', { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Zurücksetzen fehlgeschlagen (${res.status})`);
  return data;
}

// ── SSH-Key-API-Helfer ────────────────────────────────────────────────────────

export async function fetchSshKeys() {
  const res = await fetch('/api/settings/ssh-keys');
  if (!res.ok) throw new Error(`SSH-Keys laden fehlgeschlagen (${res.status})`);
  return res.json();
}

export async function putSshKey(user, body) {
  const res = await fetch(`/api/settings/ssh-keys/${encodeURIComponent(user)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

export async function deleteSshKey(user, target = 'both') {
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
export async function provisionSshKey(user, { host, port, targetUser, hostFingerprint }) {
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
export async function generateSshKeypair(user, { overwrite = false } = {}) {
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
export async function rotateSshKey(user, { host, port, targetUser, hostFingerprint }) {
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
export async function exportAndDownloadPrivateKey(user) {
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
export async function fetchBackupStatus(fetchImpl) {
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
export async function fetchBackupConfig(fetchImpl) {
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
export async function saveBackupConfig(config, fetchImpl) {
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
 * @param {string} name  - Feldname (s3_access_key|s3_secret_key)
 * @param {string} value
 * @returns {Promise<object>}
 */
export async function putBackupRemoteCred(name, value) {
  return putCredential('backup-remote', name, value);
}

/**
 * DELETE /api/settings/credentials/backup-remote/:name
 * Löscht einen Remote-Credential-Wert.
 *
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function deleteBackupRemoteCred(name) {
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
export async function postBackupRestore(artefactBuffer, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/backup-restore?confirm=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: artefactBuffer,
  });
  const data = await res.json();
  return { ...data, httpStatus: res.status };
}
// ── Benachrichtigungen-API-Helfer (S-183 AC2/AC3) ────────────────────────────

/**
 * GET /api/settings/notifications
 * Liefert Settings inkl. has_token; NIE Token-Klartext (AC10).
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ enabled: boolean, server: string, topic: string, priority: number|null, events: string[], has_token: boolean }>}
 */
export async function fetchNotificationSettings(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/notifications');
  if (!res.ok) throw new Error(`Notification-Settings laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * PUT /api/settings/notifications
 * Speichert nicht-geheime Settings.
 *
 * @param {object} settings - { enabled, server, topic, priority, events }
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object>}
 */
export async function putNotificationSettings(settings, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/notifications', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message ?? `Speichern fehlgeschlagen (${res.status})`), { field: data.field });
  return data;
}

/**
 * POST /api/settings/notifications/test
 * Sendet eine Probe-Benachrichtigung mit der aktuellen Config.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error?: string, status?: number }>}
 */
export async function postNotificationTest(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/notifications/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.json();
}

// ── Deploy-Zugang (Bitwarden Variante B) API-Helfer (F-072, S-333) ────────────

/** Felder des Deploy-Zugangs (muss mit ACCESS_FIELDS im Backend übereinstimmen). */
export const DEPLOY_ACCESS_FIELDS = [
  { name: 'server_url', label: 'Bitwarden Server-URL', optional: true, placeholder: 'https://vault.bitwarden.com (Standard)' },
  { name: 'client_id', label: 'API Client-ID', placeholder: 'user.xxxxxxxx' },
  { name: 'client_secret', label: 'API Client-Secret' },
  { name: 'master_password', label: 'Master-Passwort' },
];

/**
 * GET /api/settings/deploy-access
 * Write-only Status: je Feld { set, updatedAt } + ready + persisted. KEIN Klartext.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ persisted: boolean, ready: boolean, fields: Record<string, { set: boolean, updatedAt: string|null }> }>}
 */
export async function fetchDeployAccessStatus(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/deploy-access');
  if (!res.ok) throw new Error(`Deploy-Zugang laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * PUT /api/settings/deploy-access/:field   Body: { value }
 * @param {string} field
 * @param {string} value
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ field: string, set: boolean, updatedAt: string|null }>}
 */
export async function putDeployAccessField(field, value, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn(`/api/settings/deploy-access/${encodeURIComponent(field)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Speichern fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * DELETE /api/settings/deploy-access/:field
 * @param {string} field
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ field: string, set: boolean, updatedAt: null }>}
 */
export async function deleteDeployAccessField(field, fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn(`/api/settings/deploy-access/${encodeURIComponent(field)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Löschen fehlgeschlagen (${res.status})`);
  return data;
}

/**
 * POST /api/settings/deploy-access/validate
 * Prüft den hinterlegten Zugang (Probe-Login). Kein Secret in Response.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, errorClass?: string, error?: string, httpStatus: number }>}
 */
export async function validateDeployAccess(fetchImpl) {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/deploy-access/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  return { ...data, httpStatus: res.status };
}
