/**
 * sshKeysRouter — Express-Router für SSH-Key-Verwaltung (settings-ssh-keys AC1–AC6).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/ssh-keys                → Liste aller SSH-Benutzer (kein Private-Key-Klartext)
 *   PUT    /api/settings/ssh-keys/:user          → Public- und/oder Private-Key setzen/überschreiben
 *   DELETE /api/settings/ssh-keys/:user          → Public- und/oder Private-Key löschen
 *   POST   /api/settings/ssh-keys/:user/provision → 501 (Stufe B — nicht implementiert, folgt in #47)
 *
 * Security (ADR-007/008):
 *   - Private-Key-Klartext verlässt den Store NIE Richtung HTTP/Log/Audit/WS-Stream.
 *   - Public-Keys sind nicht geheim und dürfen vollständig angezeigt werden.
 *   - Jede Mutation → AuditStore-Eintrag (Identität, Benutzer-Label, Aktion) OHNE Klartext.
 *   - Optionale Admin-Allowlist via CRED_ADMIN_EMAILS (analog credentialsRouter).
 *   - Eingabe-Validierung: Benutzer-Label + Public-Key-Format (OpenSSH).
 *
 * @module sshKeysRouter
 */

import { Router } from 'express';

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
 * @returns {import('express').Router}
 */
export function sshKeysRouter(credentialStore, auditStore) {
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
   * Stufe B — nicht implementiert (folgt in #47 / ADR-008).
   *
   * Response: 501 { error: 'not yet implemented' }
   */
  router.post('/api/settings/ssh-keys/:user/provision', (_req, res) => {
    return res.status(501).json({ error: 'VPS-Provisionierung noch nicht implementiert (folgt in Stufe B / #47)' });
  });

  return router;
}
