/**
 * sshKeysRouter — Express-Router für SSH-Key-Verwaltung (settings-ssh-keys AC1–AC10).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/ssh-keys                → Liste aller SSH-Benutzer (kein Private-Key-Klartext)
 *   PUT    /api/settings/ssh-keys/:user          → Public- und/oder Private-Key setzen/überschreiben
 *   DELETE /api/settings/ssh-keys/:user          → Public- und/oder Private-Key löschen
 *   POST   /api/settings/ssh-keys/:user/provision → Stufe B: Public-Key idempotent in authorized_keys (AC7–AC10)
 *
 * Security (ADR-007/008):
 *   - Private-Key-Klartext verlässt den Store NIE Richtung HTTP/Log/Audit/WS-Stream.
 *   - Public-Keys sind nicht geheim und dürfen vollständig angezeigt werden.
 *   - Jede Mutation → AuditStore-Eintrag (Identität, Benutzer-Label, Aktion) OHNE Klartext.
 *   - Optionale Admin-Allowlist via CRED_ADMIN_EMAILS (analog credentialsRouter).
 *   - Eingabe-Validierung: Benutzer-Label + Public-Key-Format (OpenSSH) + VPS-Ziel-Parameter.
 *   - Provisionierung: hoch-privilegiert → Identitäts-/Rollencheck + Audit-First.
 *
 * @module sshKeysRouter
 */

import { Router } from 'express';
import { VpsProvisioner } from './VpsProvisioner.js';

// Erlaubte Zeichen für Benutzer-Labels (z.B. "root", "alex", "deploy-user")
const USER_LABEL_RE = /^[a-zA-Z0-9_\-.:@]+$/;

/** Maximale Länge eines Benutzer-Labels. */
const MAX_USER_LABEL_LEN = 64;

/** Maximale Länge eines Key-Werts (Bytes) — sync mit CredentialStore. */
const MAX_VALUE_BYTES = 65536;

/**
 * Gültige OpenSSH-Public-Key-Typen (Präfixe).
 * Erweiterbar ohne Spec-Änderung (nur neue Typen ergänzen).
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
 * Format: <type> <base64-key> [optional-comment]
 *
 * @param {string} key
 * @returns {{ ok: boolean, error?: string }}
 */
function validatePublicKey(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, error: 'Public-Key darf nicht leer sein' };
  }
  const trimmed = key.trim();
  // I1: Newline-Injection-Vorsorge (authorized_keys-Injection, Stufe B)
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: 'Public-Key darf keine Zeilenumbrüche enthalten' };
  }
  const isKnownType = SSH_PUBKEY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  if (!isKnownType) {
    return {
      ok: false,
      error: 'Unbekanntes Public-Key-Format. Erwartet: OpenSSH-Format (z.B. ssh-ed25519 …, ssh-rsa …)',
    };
  }
  // Zweiter Teil muss Base64 sein (mindestens 20 Zeichen)
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts[1].length < 20) {
    return { ok: false, error: 'Public-Key unvollständig (fehlender Base64-Teil)' };
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_VALUE_BYTES) {
    return { ok: false, error: `Public-Key überschreitet Längenlimit (${MAX_VALUE_BYTES} Bytes)` };
  }
  return { ok: true };
}

/**
 * Validiert ein Benutzer-Label.
 *
 * @param {string} user
 * @returns {{ ok: boolean, error?: string }}
 */
function validateUserLabel(user) {
  if (!user || typeof user !== 'string') {
    return { ok: false, error: 'Benutzer-Label ist ein Pflichtfeld' };
  }
  if (user.length > MAX_USER_LABEL_LEN) {
    return { ok: false, error: `Benutzer-Label überschreitet Limit (${MAX_USER_LABEL_LEN} Zeichen)` };
  }
  if (!USER_LABEL_RE.test(user)) {
    return { ok: false, error: 'Benutzer-Label enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ - . : @)' };
  }
  return { ok: true };
}

/**
 * Validiert einen Hostnamen oder eine IP-Adresse (für VPS-Ziel).
 * Erlaubt: RFC-1123-Hostnamen und IPv4/IPv6-Adressen.
 *
 * @param {string} host
 * @returns {{ ok: boolean, error?: string }}
 */
function validateHost(host) {
  if (!host || typeof host !== 'string' || !host.trim()) {
    return { ok: false, error: 'host ist ein Pflichtfeld' };
  }
  const h = host.trim();
  if (h.length > 253) {
    return { ok: false, error: 'Hostname überschreitet Länge (max. 253 Zeichen)' };
  }
  // IPv4: einfache Form (1.2.3.4)
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6: minimale Plausibilitätsprüfung — Regex akzeptiert bewusst ein breites Format
  // (z.B. ':::' würde durchkommen), aber ssh2 übernimmt die finale Validierung beim Connect.
  // Mindestens zwei ':' und ausschliesslich Hex-Zeichen müssen vorhanden sein.
  const ipv6 = /^[0-9a-fA-F:]+$/;
  const ipv6HasMinColons = (h.match(/:/g) ?? []).length >= 2;
  // RFC-1123-Hostname: Labels aus Buchstaben, Ziffern, Bindestrichen (keine führenden/abschliessenden Bindestriche)
  const hostname = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const isIPv6 = ipv6.test(h) && ipv6HasMinColons;
  if (!ipv4.test(h) && !isIPv6 && !hostname.test(h)) {
    return { ok: false, error: 'host ist kein gültiger Hostname oder IP-Adresse' };
  }
  return { ok: true };
}

/**
 * Validiert ein hostFingerprint-Feld (SHA256-Base64-Format).
 * SHA256 → 32 Bytes → Base64 → 43 oder 44 Zeichen (mit/ohne Padding-'=').
 * Zeichensatz: A-Z a-z 0-9 + / = (standard Base64).
 *
 * @param {string} fp
 * @returns {{ ok: boolean, error?: string }}
 */
function validateHostFingerprint(fp) {
  if (typeof fp !== 'string' || !fp.trim()) {
    return { ok: false, error: 'hostFingerprint muss ein nicht-leerer String sein (SHA256-Base64)' };
  }
  const trimmed = fp.trim();
  // SHA256 → 32 Bytes → Base64: 43 Zeichen ohne Padding, 44 mit '='
  if (trimmed.length < 43 || trimmed.length > 44) {
    return { ok: false, error: 'hostFingerprint hat ungültige Länge (erwartet 43–44 Zeichen für SHA256-Base64)' };
  }
  if (!/^[A-Za-z0-9+/]+=?$/.test(trimmed)) {
    return { ok: false, error: 'hostFingerprint enthält ungültige Zeichen (erwartet Base64-Zeichensatz)' };
  }
  return { ok: true };
}

/**
 * Validiert einen TCP-Port (1–65535).
 *
 * @param {number|string|undefined} port
 * @returns {{ ok: boolean, error?: string }}
 */
function validatePort(port) {
  if (port === undefined || port === null || port === '') {
    return { ok: true }; // optional, Default 22
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return { ok: false, error: 'port muss eine ganze Zahl zwischen 1 und 65535 sein' };
  }
  return { ok: true };
}

/**
 * Prüft ob die anfragende Identität mutieren darf (analog credentialsRouter / ADR-007 OA3).
 * Wenn CRED_ADMIN_EMAILS gesetzt: nur gelistete E-Mails.
 * Wenn nicht gesetzt: jede gültige Access-Identität.
 *
 * @param {import('./AccessGuard.js').Identity} identity
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    return { allowed: true };
  }
  const allowed = adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = (identity?.email ?? '').toLowerCase();
  if (!email || !allowed.includes(email)) {
    return { allowed: false };
  }
  return { allowed: true };
}

/**
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {import('./VpsProvisioner.js').VpsProvisioner} [vpsProvisioner] - optional injizierbar (für Tests)
 * @returns {import('express').Router}
 */
export function sshKeysRouter(credentialStore, auditStore, vpsProvisioner) {
  // Wenn kein externer Provisioner injiziert wird, eigenen erstellen (Production-Default)
  const provisioner = vpsProvisioner ?? new VpsProvisioner(credentialStore);
  const router = Router();

  /**
   * GET /api/settings/ssh-keys
   * Listet alle SSH-Benutzer mit Public-Key (Klartext — nicht geheim) und
   * Private-Key-Status (set/unset). Private-Key-Klartext wird NIEMALS zurückgegeben.
   *
   * Response: 200 [{ user, publicKey?, publicKeyUpdatedAt?, privateKeyStatus, privateKeyUpdatedAt? }]
   * Response: 500 { error } — Store nicht lesbar
   */
  router.get('/api/settings/ssh-keys', async (req, res) => {
    try {
      const items = await credentialStore.listSshKeys();
      return res.json(items);
    } catch (err) {
      console.error('[sshKeysRouter] GET list failed:', err.message);
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }
  });

  /**
   * PUT /api/settings/ssh-keys/:user
   * Setzt oder überschreibt Public- und/oder Private-Key für einen Benutzer.
   * Body: { publicKey?: string, privateKey?: string }
   *
   * Response: 200 { user, publicKey?, privateKeyStatus }
   * Response: 400 { error } — Validierungsfehler
   * Response: 403 { error } — keine Berechtigung
   * Response: 422 { error } — ungültiges Public-Key-Format
   * Response: 500 { error } — Store nicht schreibbar
   */
  router.put('/api/settings/ssh-keys/:user', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // Benutzer-Label validieren
    const userValid = validateUserLabel(user);
    if (!userValid.ok) {
      return res.status(400).json({ error: userValid.error });
    }

    const { publicKey, privateKey } = req.body ?? {};

    // Mindestens ein Feld muss gesetzt sein
    if (publicKey === undefined && privateKey === undefined) {
      return res.status(400).json({ error: 'Mindestens "publicKey" oder "privateKey" muss im Body angegeben sein' });
    }

    // AC4: Public-Key-Format validieren (wenn angegeben)
    if (publicKey !== undefined) {
      const pkValid = validatePublicKey(publicKey);
      if (!pkValid.ok) {
        return res.status(422).json({ error: pkValid.error });
      }
    }

    // Private-Key: nicht leer wenn angegeben
    if (privateKey !== undefined) {
      if (typeof privateKey !== 'string' || privateKey.trim() === '') {
        return res.status(400).json({ error: 'Private-Key darf nicht leer sein' });
      }
      if (Buffer.byteLength(privateKey, 'utf8') > MAX_VALUE_BYTES) {
        return res.status(422).json({ error: `Private-Key überschreitet Längenlimit (${MAX_VALUE_BYTES} Bytes)` });
      }
    }

    // AC5: Audit ZUERST (ohne Klartext — Private-Key nie im Audit)
    const auditParts = [];
    if (publicKey !== undefined) auditParts.push('public_key');
    if (privateKey !== undefined) auditParts.push('private_key');
    const auditAction = `ssh-key:set:${user}:${auditParts.join('+')}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[sshKeysRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      // Public-Key setzen (Klartext-Meta)
      if (publicKey !== undefined) {
        await credentialStore.setPublicKey(user, publicKey.trim());
      }

      // Private-Key setzen (verschlüsselt in entries)
      if (privateKey !== undefined) {
        await credentialStore.set(`ssh/${user}/private_key`, privateKey.trim());
      }

      // Antwort zusammenstellen — kein Private-Key-Klartext
      const storedPublicKey = await credentialStore.getPublicKey(user);
      const privMeta = await credentialStore.getMeta(`ssh/${user}/private_key`);

      return res.json({
        user,
        ...(storedPublicKey ? { publicKey: storedPublicKey } : {}),
        privateKeyStatus: privMeta.status,
      });
    } catch (err) {
      if (err.message.includes('Längenlimit')) {
        return res.status(422).json({ error: 'Wert überschreitet das zulässige Längenlimit' });
      }
      if (err.message.includes('leer')) {
        return res.status(400).json({ error: 'Wert darf nicht leer sein' });
      }
      if (err.message.includes('Master-Key') || err.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      console.error('[sshKeysRouter] PUT set failed:', err.message);
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }
  });

  /**
   * DELETE /api/settings/ssh-keys/:user
   * Löscht Public- und/oder Private-Key für einen Benutzer.
   * Query-Parameter: ?target=public|private|both (Default: both)
   *
   * Response: 200 { user, publicKey?, privateKeyStatus }
   * Response: 400 { error } — Validierungsfehler
   * Response: 403 { error } — keine Berechtigung
   * Response: 500 { error } — Store nicht schreibbar
   */
  router.delete('/api/settings/ssh-keys/:user', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // Benutzer-Label validieren
    const userValid = validateUserLabel(user);
    if (!userValid.ok) {
      return res.status(400).json({ error: userValid.error });
    }

    // target: 'public' | 'private' | 'both' (Default: 'both')
    const target = req.query.target ?? 'both';
    if (!['public', 'private', 'both'].includes(target)) {
      return res.status(400).json({ error: 'Ungültiger target-Parameter. Erlaubt: public, private, both' });
    }

    const deletePublic = target === 'public' || target === 'both';
    const deletePrivate = target === 'private' || target === 'both';

    // AC5: Audit ZUERST
    const auditParts = [];
    if (deletePublic) auditParts.push('public_key');
    if (deletePrivate) auditParts.push('private_key');
    const auditAction = `ssh-key:delete:${user}:${auditParts.join('+')}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[sshKeysRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      if (deletePublic) {
        await credentialStore.deletePublicKey(user);
      }
      if (deletePrivate) {
        await credentialStore.delete(`ssh/${user}/private_key`);
      }

      // Aktuellen Status zurückgeben
      const storedPublicKey = await credentialStore.getPublicKey(user);
      const privMeta = await credentialStore.getMeta(`ssh/${user}/private_key`);

      return res.json({
        user,
        ...(storedPublicKey ? { publicKey: storedPublicKey } : {}),
        privateKeyStatus: privMeta.status,
      });
    } catch (err) {
      if (err.message.includes('Master-Key') || err.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      console.error('[sshKeysRouter] DELETE failed:', err.message);
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }
  });

  /**
   * POST /api/settings/ssh-keys/:user/provision
   * Stufe B — VPS-Provisionierung (ADR-008, AC7–AC10).
   *
   * Trägt den hinterlegten Public-Key idempotent in authorized_keys des VPS-Benutzers ein.
   * Body: { host: string, port?: number, targetUser: string, hostFingerprint?: string }
   *
   * Response: 200 { result: 'added'|'already-present' }
   * Response: 400 { error } — Validierungsfehler (fehlende/ungültige Parameter)
   * Response: 403 { error } — keine Berechtigung (AC10)
   * Response: 422 { error } — kein Public-Key / kein Private-Key für diesen Benutzer
   * Response: 502 { error, result: 'error', reason } — VPS nicht erreichbar / Auth fehlgeschlagen
   * Response: 500 { error, result: 'error' } — unerwarteter interner Fehler
   */
  router.post('/api/settings/ssh-keys/:user/provision', async (req, res) => {
    const identity = req.identity ?? null;

    // AC10: Mutations-Autorisierung (analog zu PUT/DELETE — hoch-privilegiert)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // Benutzer-Label validieren
    const userValid = validateUserLabel(user);
    if (!userValid.ok) {
      return res.status(400).json({ error: userValid.error });
    }

    // Body: VPS-Ziel-Parameter
    const { host, port, targetUser, hostFingerprint } = req.body ?? {};

    // host: Pflicht
    const hostValid = validateHost(host);
    if (!hostValid.ok) {
      return res.status(400).json({ error: hostValid.error });
    }

    // port: optional (1–65535)
    const portValid = validatePort(port);
    if (!portValid.ok) {
      return res.status(400).json({ error: portValid.error });
    }

    // targetUser: Pflicht, gleiche Regeln wie Benutzer-Label
    const targetUserValid = validateUserLabel(targetUser);
    if (!targetUserValid.ok) {
      return res.status(400).json({ error: `targetUser ungültig: ${targetUserValid.error}` });
    }

    // hostFingerprint: optional — wenn angegeben muss es ein gültiges SHA256-Base64-Format sein (S2)
    if (hostFingerprint !== undefined) {
      const fpValid = validateHostFingerprint(hostFingerprint);
      if (!fpValid.ok) {
        return res.status(422).json({ error: fpValid.error });
      }
    }

    // AC9: Audit ZUERST (Audit-First — ohne Geheim-Leak)
    // Private-Key und Public-Key erscheinen NICHT im Audit-Eintrag
    const auditAction = `ssh-key:provision:${user}:${host}:${targetUser}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[sshKeysRouter] Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // VPS-Provisionierung ausführen
    let result;
    try {
      result = await provisioner.provision(user, {
        host: host.trim(),
        port: port !== undefined ? Number(port) : undefined,
        targetUser: targetUser.trim(),
      }, {
        hostFingerprint: hostFingerprint ? hostFingerprint.trim() : undefined,
      });
    } catch (err) {
      // Unerwarteter Fehler aus dem Provisioner (sollte nie auftreten — Provisioner fängt selbst)
      console.error('[sshKeysRouter] Provision unerwarteter Fehler:', err.message);
      return res.status(500).json({
        result: 'error',
        error: 'Provisionierung fehlgeschlagen (unerwarteter interner Fehler)',
      });
    }

    // Ergebnis auf HTTP-Status mappen
    if (result.result === 'added' || result.result === 'already-present') {
      // I1/OA2: TOFU-Hash nachträglich auditieren (zweiter Eintrag, kein Klartext)
      if (result.hostKeyHash) {
        try {
          auditStore.record({
            identity: identity?.email ?? null,
            command: `ssh-key:provision:tofu-accepted:${user}:${host.trim()}:${result.hostKeyHash}`,
          });
        } catch (auditErr) {
          console.error('[sshKeysRouter] TOFU-Audit-Write fehlgeschlagen:', auditErr.message);
          // Nicht-blockierend: Provision war erfolgreich — Audit-Fehler darf Response nicht stören
        }
      }
      return res.json({
        result: result.result,
        ...(result.hostKeyHash ? { hostKeyHash: result.hostKeyHash } : {}),
      });
    }

    // result: 'error' — Fehlerklasse auf HTTP-Status mappen
    const errorClass = result.errorClass ?? 'error';

    if (errorClass === 'no-public-key' || errorClass === 'no-private-key') {
      return res.status(422).json({
        result: 'error',
        error: result.reason ?? 'Key nicht hinterlegt',
        reason: result.reason,
      });
    }

    if (errorClass === 'unreachable' || errorClass === 'auth-failed' || errorClass === 'host-key-mismatch') {
      return res.status(502).json({
        result: 'error',
        error: result.reason ?? 'VPS-Provisionierung fehlgeschlagen',
        reason: result.reason,
      });
    }

    // Generischer Fehler
    return res.status(500).json({
      result: 'error',
      error: result.reason ?? 'Provisionierung fehlgeschlagen (unerwarteter Fehler)',
      reason: result.reason,
    });
  });

  return router;
}
