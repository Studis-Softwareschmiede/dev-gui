/**
 * sshKeysRouter — Express-Router für SSH-Key-Verwaltung (settings-ssh-keys AC1–AC10,
 *                 ssh-key-generation AC1–AC8).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/settings/ssh-keys                         → Liste aller SSH-Benutzer (kein Private-Key-Klartext)
 *   PUT    /api/settings/ssh-keys/:user                   → Public- und/oder Private-Key setzen/überschreiben
 *   DELETE /api/settings/ssh-keys/:user                   → Public- und/oder Private-Key löschen
 *   POST   /api/settings/ssh-keys/:user/provision         → Stufe B: Public-Key idempotent in authorized_keys (AC7–AC10)
 *   POST   /api/settings/ssh-keys/:user/generate          → ed25519-Keypair erzeugen (ssh-key-generation AC1–AC7)
 *   GET    /api/settings/ssh-keys/:user/private-key/export → Private-Key-Export (ssh-key-generation AC4/AC5/AC6)
 *   POST   /api/settings/ssh-keys/:user/rotate            → vollautomatische additive Rotation (ssh-key-rotation AC1–AC8)
 *
 * Security (ADR-007/008, ssh-key-generation Sicherheits-Tradeoff):
 *   - Private-Key-Klartext verlässt den Store NIE Richtung HTTP/Log/Audit/WS-Stream —
 *     AUSNAHME: der explizite Export-Endpunkt (bewusster ADR-007-Bruch, dauerhaft, eng eingehegt).
 *   - Public-Keys sind nicht geheim und dürfen vollständig angezeigt werden.
 *   - Jede Mutation → AuditStore-Eintrag (Identität, Benutzer-Label, Aktion) OHNE Klartext.
 *   - Optionale Admin-Allowlist via CRED_ADMIN_EMAILS (analog credentialsRouter).
 *   - Eingabe-Validierung: Benutzer-Label + Public-Key-Format (OpenSSH) + VPS-Ziel-Parameter.
 *   - Provisionierung: hoch-privilegiert → Identitäts-/Rollencheck + Audit-First.
 *   - Generate + Export: hoch-privilegiert → Identitäts-/Rollencheck + Audit-First.
 *
 * @module sshKeysRouter
 */

import { createRequire } from 'node:module';
import { Router } from 'express';
import { VpsProvisioner } from './VpsProvisioner.js';

// ssh2.utils.generateKeyPair liefert ed25519-Keypairs direkt im OpenSSH-Format.
// CJS-Import über createRequire (ssh2 ist CommonJS).
const _require = createRequire(import.meta.url);
const { utils: { generateKeyPair: _ssh2GenerateKeyPair } } = _require('ssh2');

/**
 * Erzeugt ein ed25519-Keypair im OpenSSH-Format.
 * Gibt { publicKey, privateKey } zurück (beide Strings).
 * Injizierbar für Tests via sshKeygenFn-Parameter.
 *
 * @param {string} comment  - Kommentar-Feld im Public-Key (z.B. "dev-gui/root")
 * @param {Function} [keygenFn]  - Optionale Überschreibung (für Tests)
 * @returns {Promise<{ publicKey: string, privateKey: string }>}
 */
function generateEd25519Keypair(comment, keygenFn) {
  const fn = keygenFn ?? _ssh2GenerateKeyPair;
  return new Promise((resolve, reject) => {
    fn('ed25519', { comment: comment ?? '' }, (err, keys) => {
      if (err) return reject(err);
      resolve({
        publicKey: keys.public.toString().trim(),
        privateKey: keys.private.toString(),
      });
    });
  });
}

/**
 * Erlaubte Rollen-Labels für die Rotation (AC1 — subset von root|alex).
 * Spiegelung von ALLOWED_GENERATE_USERS — Rotation setzt einen vorhandenen Ausgangs-Key voraus.
 */
const ALLOWED_ROTATE_USERS = ['root', 'alex'];

// Erlaubte Zeichen für Benutzer-Labels (z.B. "root", "alex", "deploy-user")
const USER_LABEL_RE = /^[a-zA-Z0-9_\-.:@]+$/;

/** Maximale Länge eines Benutzer-Labels. */
const MAX_USER_LABEL_LEN = 64;

/**
 * Erlaubte Rollen-Labels für die Keypair-Generierung (ssh-key-generation AC1).
 * Spezifikation: genau "root" | "alex" — kein anderes Label.
 */
const ALLOWED_GENERATE_USERS = ['root', 'alex'];

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
 * @param {Function} [keygenFn] - optional: ed25519-Keygen-Funktion injizierbar (für Tests)
 * @returns {import('express').Router}
 */
export function sshKeysRouter(credentialStore, auditStore, vpsProvisioner, keygenFn) {
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

  // ── ssh-key-generation AC1–AC7 ───────────────────────────────────────────────

  /**
   * POST /api/settings/ssh-keys/:user/generate
   * Erzeugt ein neues ed25519-Keypair für das Rollen-Label {user} (root|alex).
   * Private-Key wird verschlüsselt im CredentialStore abgelegt;
   * Public-Key als Klartext-Metadatum. Response enthält NIE den Private-Key-Klartext.
   *
   * Body: { overwrite?: boolean, comment?: string }
   *
   * Response: 200 { user, publicKey, privateKeyStatus: "set", generatedAt }
   * Response: 400 { error } — ungültiger User oder Body
   * Response: 403 { error } — keine Berechtigung
   * Response: 404 { error } — unbekanntes Rollen-Label (nicht root|alex)
   * Response: 409 { error, errorClass: "key-exists" } — bereits gesetzt, kein overwrite
   * Response: 500 { error } — Store-Fehler oder Audit-Fehler
   *
   * Security: Access-Mauer (AccessGuard in server.js) + CRED_ADMIN_EMAILS + Audit-First (AC5/AC6).
   * Private-Key-Klartext erscheint NIEMALS in Response, Logs, Audit oder WS (AC3).
   */
  router.post('/api/settings/ssh-keys/:user/generate', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Mutations-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // AC1/Edge-Case: Nur root|alex erlaubt (ssh-key-generation Spec)
    if (!ALLOWED_GENERATE_USERS.includes(user)) {
      return res.status(404).json({ error: `Unbekanntes Rollen-Label: ${user}. Erlaubt: ${ALLOWED_GENERATE_USERS.join(', ')}` });
    }

    // Body-Parameter: overwrite (optional, boolean), comment (optional, string)
    const body = req.body ?? {};
    const overwrite = body.overwrite === true;
    const rawComment = typeof body.comment === 'string' ? body.comment : `dev-gui/${user}`;

    // S2: Kommentar-Länge begrenzen (max. 256 Zeichen)
    if (rawComment.length > 256) {
      return res.status(400).json({ error: 'comment überschreitet Maximallänge (256 Zeichen)' });
    }

    // IMPORTANT 1 (Layer 1): Newline-Injection-Vorsorge im comment-Input (authorized_keys-Injection)
    if (/[\r\n]/.test(rawComment)) {
      return res.status(400).json({ error: 'comment darf keine Zeilenumbrüche enthalten' });
    }

    const comment = rawComment.trim();

    // AC5: Audit-First — BEVOR irgendeine Aktion ausgeführt wird
    const auditAction = 'ssh-key-generate';
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[sshKeysRouter] generate: Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // AC7: Overwrite-Schutz — belegtes Label nur mit explizitem overwrite: true überschreiben
    if (!overwrite) {
      try {
        const existingPrivMeta = await credentialStore.getMeta(`ssh/${user}/private_key`);
        if (existingPrivMeta.status === 'set') {
          return res.status(409).json({
            error: `Für Rollen-Label "${user}" ist bereits ein Key gesetzt. Sende { overwrite: true } um zu überschreiben.`,
            errorClass: 'key-exists',
          });
        }
      } catch (err) {
        console.error('[sshKeysRouter] generate: Store-Lesefehler bei Overwrite-Check:', err.message);
        return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
      }
    }

    // Keypair erzeugen (ed25519, OpenSSH-Format)
    let publicKey, privateKey;
    try {
      ({ publicKey, privateKey } = await generateEd25519Keypair(comment, keygenFn));
    } catch (genErr) {
      console.error('[sshKeysRouter] generate: Keypair-Erzeugung fehlgeschlagen:', genErr.message);
      return res.status(500).json({ error: 'Keypair-Erzeugung fehlgeschlagen' });
    }

    // AC2: Sicherstellen dass Public-Key mit "ssh-ed25519 " beginnt
    if (!publicKey.startsWith('ssh-ed25519 ')) {
      console.error('[sshKeysRouter] generate: Erzeugter Public-Key ist kein ed25519-Key');
      return res.status(500).json({ error: 'Interner Fehler: Keypair-Format ungültig' });
    }

    // IMPORTANT 1 (Layer 2): Den resultierenden Public-Key durch validatePublicKey() leiten —
    // schützt gegen Newline-Injection durch erzeugte Keypair-Daten (z.B. comment mit \r\n).
    const pubKeyValid = validatePublicKey(publicKey);
    if (!pubKeyValid.ok) {
      console.error('[sshKeysRouter] generate: Erzeugter Public-Key ungültig:', pubKeyValid.error);
      return res.status(500).json({ error: 'Interner Fehler: Erzeugter Public-Key ungültig' });
    }

    // Private-Key verschlüsselt im Store ablegen + Public-Key als Metadatum
    // AC3: privateKey verlässt den Store NICHT Richtung HTTP/Log/Audit
    // S1: Partial-Write-Rollback — wenn setPublicKey fehlschlägt, Private-Key-Eintrag wieder löschen
    try {
      await credentialStore.set(`ssh/${user}/private_key`, privateKey);
      try {
        await credentialStore.setPublicKey(user, publicKey);
      } catch (pubKeyErr) {
        // Rollback: verwaisten Private-Key-Eintrag best-effort wieder entfernen
        try {
          await credentialStore.delete(`ssh/${user}/private_key`);
        } catch (rollbackErr) {
          console.error('[sshKeysRouter] generate: Rollback des Private-Key fehlgeschlagen:', rollbackErr.message);
        }
        throw pubKeyErr;
      }
    } catch (storeErr) {
      if (storeErr.message.includes('Master-Key') || storeErr.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      console.error('[sshKeysRouter] generate: Store-Schreibfehler:', storeErr.message);
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }

    const generatedAt = new Date().toISOString();

    // AC3: Response enthält KEINEN Private-Key-Klartext
    return res.json({
      user,
      publicKey,
      privateKeyStatus: 'set',
      generatedAt,
    });
  });

  /**
   * GET /api/settings/ssh-keys/:user/private-key/export
   * Liefert den Private-Key-Klartext für das Rollen-Label {user} (DAUERHAFT wiederholbar).
   * Dies ist der EINZIGE Pfad, über den der Private-Key-Klartext das Backend verlässt
   * (bewusster ADR-007-Tradeoff, dauerhaft — s. Spec Abschnitt "Sicherheits-Tradeoff").
   *
   * Response: 200 text/plain — OpenSSH-Private-Key (-----BEGIN OPENSSH PRIVATE KEY-----)
   * Response: 403 { error } — keine Berechtigung
   * Response: 404 { error, errorClass: "no-private-key" } — kein Private-Key gesetzt
   * Response: 500 { error } — Store-Fehler oder Audit-Fehler
   *
   * Security: Access-Mauer + CRED_ADMIN_EMAILS + Audit-First (AC5/AC6).
   * Private-Key-Klartext erscheint NUR in dieser Response — nie in Logs, Audit, WS (AC4).
   */
  router.get('/api/settings/ssh-keys/:user/private-key/export', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Mutations-/Privileged-Autorisierung
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // Nur root|alex erlaubt
    if (!ALLOWED_GENERATE_USERS.includes(user)) {
      return res.status(404).json({ error: `Unbekanntes Rollen-Label: ${user}. Erlaubt: ${ALLOWED_GENERATE_USERS.join(', ')}` });
    }

    // AC5: Audit-First — BEVOR der Private-Key ausgeliefert wird
    // Audit-Eintrag OHNE Key-Klartext (Identität + Rollen-Label + Aktion + Zeit)
    const auditAction = 'ssh-key-export';
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[sshKeysRouter] export: Audit-Write fehlgeschlagen:', auditErr.message);
      // AC5: schlägt der Audit-Write fehl → unterbleibt der Export (keine nicht-auditierte Key-Preisgabe)
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Export abgebrochen' });
    }

    // Private-Key aus Store lesen (getPlaintext → Klartext store-intern)
    let privateKeyPlaintext;
    try {
      privateKeyPlaintext = await credentialStore.getPlaintext(`ssh/${user}/private_key`);
    } catch (storeErr) {
      if (storeErr.message.includes('Master-Key') || storeErr.message.includes('CRED_MASTER_KEY')) {
        return res.status(500).json({ error: 'Credential-Store nicht konfiguriert' });
      }
      // AC5/Security: kein Klartext-Leak im Fehlerfall
      console.error('[sshKeysRouter] export: Store-Lesefehler (kein Klartext geloggt)');
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }

    // AC4/Edge-Case: kein Private-Key gesetzt → 404 errorClass: "no-private-key"
    if (!privateKeyPlaintext) {
      return res.status(404).json({
        error: `Kein Private-Key für Rollen-Label "${user}" gesetzt.`,
        errorClass: 'no-private-key',
      });
    }

    // AC4: Export-Response liefert den OpenSSH-Private-Key-Klartext als text/plain
    // Dies ist der EINZIGE Pfad, über den der Private-Key-Klartext das Backend verlässt.
    return res
      .setHeader('Content-Type', 'text/plain; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${user}_ed25519"`)
      .send(privateKeyPlaintext);
  });

  // ── ssh-key-rotation AC1–AC8 ────────────────────────────────────────────────

  /**
   * POST /api/settings/ssh-keys/:user/rotate
   * Vollautomatische, additive SSH-Key-Rotation auf einem laufenden VPS.
   * Ablauf: gen → additiv einspielen → Verbindungstest → bei Erfolg alten Key entfernen.
   * Body: { host: string, port?: number, targetUser: string, hostFingerprint?: string }
   *
   * Response: 200 { result: "rotated", oldKeyRemoved: boolean, newPublicKey, reason? }
   * Response: 400 { error } — Validierungsfehler
   * Response: 403 { error } — keine Berechtigung
   * Response: 404 { error } — unbekanntes Rollen-Label
   * Response: 422 { error, errorClass } — kein Ausgangs-Key vorhanden / VPS-Ziel fehlt
   * Response: 502 { result: "error", errorClass, reason } — VPS-/Verify-Fehler
   * Response: 500 { error } — interner Fehler oder Audit-Fehler
   *
   * Security: Access-Mauer (AccessGuard in server.js) + CRED_ADMIN_EMAILS + Audit-First (AC7/AC8).
   * Private-Key-Klartext erscheint NIEMALS in Response, Logs, Audit oder WS (AC8).
   */
  router.post('/api/settings/ssh-keys/:user/rotate', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: Mutations-Autorisierung (CRED_ADMIN_EMAILS, analog den anderen mutierten Endpunkten)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { user } = req.params;

    // AC1/Edge-Case: Nur root|alex erlaubt
    if (!ALLOWED_ROTATE_USERS.includes(user)) {
      return res.status(404).json({ error: `Unbekanntes Rollen-Label: ${user}. Erlaubt: ${ALLOWED_ROTATE_USERS.join(', ')}` });
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

    // targetUser: Pflicht
    const targetUserValid = validateUserLabel(targetUser);
    if (!targetUserValid.ok) {
      return res.status(400).json({ error: `targetUser ungültig: ${targetUserValid.error}` });
    }

    // hostFingerprint: optional — wenn angegeben muss es ein gültiges SHA256-Base64-Format sein
    if (hostFingerprint !== undefined) {
      const fpValid = validateHostFingerprint(hostFingerprint);
      if (!fpValid.ok) {
        return res.status(422).json({ error: fpValid.error });
      }
    }

    const vpsTarget = {
      host: host.trim(),
      port: port !== undefined ? Number(port) : undefined,
      targetUser: targetUser.trim(),
    };
    const fpOpt = hostFingerprint ? hostFingerprint.trim() : undefined;

    // AC7: Audit-First — Rotation-Start auditieren BEVOR irgendeine Aktion ausgeführt wird
    // Ohne Private-Key oder Public-Key-Material im Audit-Eintrag (AC8)
    const auditStart = `ssh-key-rotate:start:${user}:${vpsTarget.host}:${vpsTarget.targetUser}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditStart });
    } catch (auditErr) {
      console.error('[sshKeysRouter] rotate: Audit-Write fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Schritt 0: Prüfen ob alter Key vorhanden ist (Rotation setzt Ausgangs-Key voraus)
    let oldPrivateKey, oldPublicKey;
    try {
      oldPrivateKey = await credentialStore.getPlaintext(`ssh/${user}/private_key`);
      oldPublicKey = await credentialStore.getPublicKey(user);
    } catch {
      console.error('[sshKeysRouter] rotate: Store-Lesefehler (kein Klartext geloggt)');
      return res.status(500).json({ error: 'SSH-Key-Store nicht erreichbar' });
    }

    if (!oldPrivateKey || !oldPublicKey) {
      return res.status(422).json({
        error: `Kein bestehender Key für Rollen-Label "${user}" — Rotation setzt einen Ausgangs-Key voraus. Erst ein Keypair erzeugen.`,
        errorClass: 'no-existing-key',
      });
    }

    // Schritt 1: Neues ed25519-Keypair erzeugen (Keygen-Logik aus #115 wiederverwenden)
    // Noch NICHT den aktiven Store-Key ersetzen.
    let newPublicKey, newPrivateKey;
    try {
      const comment = `dev-gui/${user}`;
      ({ publicKey: newPublicKey, privateKey: newPrivateKey } = await generateEd25519Keypair(comment, keygenFn));
    } catch (genErr) {
      console.error('[sshKeysRouter] rotate: Keypair-Erzeugung fehlgeschlagen:', genErr.message);
      return res.status(500).json({ error: 'Keypair-Erzeugung fehlgeschlagen' });
    }

    // Sicherstellen dass der erzeugte Key ein ed25519-Key ist (analog generate)
    const newPubKeyValid = validatePublicKey(newPublicKey);
    if (!newPubKeyValid.ok || !newPublicKey.startsWith('ssh-ed25519 ')) {
      console.error('[sshKeysRouter] rotate: Erzeugter Public-Key ungültig oder kein ed25519');
      return res.status(500).json({ error: 'Interner Fehler: Keypair-Format ungültig' });
    }

    // Schritt 2: Neuen Public-Key ADDITIV einspielen (AC2 — alter Key bleibt gültig)
    let addResult;
    try {
      addResult = await provisioner.addAuthorizedKey({
        host: vpsTarget.host,
        port: vpsTarget.port,
        targetUser: vpsTarget.targetUser,
        publicKey: newPublicKey,
        privateKey: oldPrivateKey,  // Mit altem Private-Key einloggen um neuen Public-Key einzutragen
        hostFingerprint: fpOpt,
      });
    } catch {
      console.error('[sshKeysRouter] rotate: addAuthorizedKey fehlgeschlagen (kein Key-Material geloggt)');
      return res.status(502).json({
        result: 'error',
        errorClass: 'error',
        error: 'Additives Einspielen des neuen Keys fehlgeschlagen',
      });
    }

    if (addResult.result === 'error') {
      // Einspielen gescheitert → abbrechen, alter Key unangetastet, kein Store-Wechsel
      const ec = addResult.errorClass ?? 'error';
      return res.status(502).json({
        result: 'error',
        errorClass: ec,
        error: addResult.reason ?? 'Additives Einspielen des neuen Public-Keys fehlgeschlagen',
        reason: addResult.reason,
      });
    }

    // Schritt 3: Verbindungstest mit dem NEUEN Private-Key (AC3 — Aussperr-Schutz)
    let testResult;
    try {
      testResult = await provisioner.testConnection({
        host: vpsTarget.host,
        port: vpsTarget.port,
        targetUser: vpsTarget.targetUser,
        privateKey: newPrivateKey,  // AC8: neuer Private-Key verlässt Store nur intern, nie in Response/Log
        hostFingerprint: fpOpt,
      });
    } catch {
      console.error('[sshKeysRouter] rotate: testConnection fehlgeschlagen (kein Key-Material geloggt)');
      // Verbindungstest ausgefallen — best-effort Rollback des additiv eingespielen neuen Keys
      // Rollback nutzt den alten Private-Key, da dieser nachweislich funktioniert (Schritt 2 war ok).
      await _rollbackNewKey({ provisioner, vpsTarget, newPublicKey, connectPrivateKey: oldPrivateKey, fpOpt });
      // AC7: Audit-Fehlschlag
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `ssh-key-rotate:failed:${user}:${vpsTarget.host}:${vpsTarget.targetUser}:rotation-verify-failed`,
        });
      } catch { /* Audit-Fehler im Fehlerfall — nicht blockierend */ }
      return res.status(502).json({
        result: 'error',
        errorClass: 'rotation-verify-failed',
        error: 'Verbindungstest mit neuem Key fehlgeschlagen — alter Key bleibt aktiv',
        reason: 'Verbindungstest fehlgeschlagen (unerwarteter Fehler)',
      });
    }

    if (!testResult.ok) {
      // AC5: Roter Test → alter Key NICHT entfernen, neuen additiven Key best-effort zurückrollen
      // Rollback nutzt den alten Private-Key, da dieser nachweislich funktioniert (Schritt 2 war ok).
      await _rollbackNewKey({ provisioner, vpsTarget, newPublicKey, connectPrivateKey: oldPrivateKey, fpOpt });

      // AC7: Audit-Fehlschlag ohne Key-Material
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `ssh-key-rotate:failed:${user}:${vpsTarget.host}:${vpsTarget.targetUser}:rotation-verify-failed`,
        });
      } catch { /* Audit-Fehler im Fehlerfall — nicht blockierend */ }

      return res.status(502).json({
        result: 'error',
        errorClass: 'rotation-verify-failed',
        error: 'Verbindungstest mit neuem Key fehlgeschlagen — alter Key bleibt aktiv (Aussperr-Schutz)',
        reason: testResult.reason ?? 'SSH-Verbindungstest mit neuem Key fehlgeschlagen',
      });
    }

    // Schritt 4: Grüner Test — alten Public-Key entfernen + neuen Key im Store aktivieren (AC4)
    // Neuen Private-Key + Public-Key im Store aktivieren (ersetzt den alten Eintrag)
    // Store-Aktivierung vor Remove — selbst wenn Remove fehlschlägt, ist Login mit neuem Key gesichert.
    try {
      await credentialStore.set(`ssh/${user}/private_key`, newPrivateKey);
      await credentialStore.setPublicKey(user, newPublicKey);
    } catch {
      // Store-Schreibfehler nach grünem Test — kritischer Zustand:
      // neuer Key eingetragen aber nicht im Store aktiviert.
      // Logging ohne Klartext — nur Fehlermeldung.
      console.error('[sshKeysRouter] rotate: Store-Aktivierung fehlgeschlagen (kein Key-Material geloggt)');
      // Rollback des neuen Keys (best-effort), damit kein verwaister Key bleibt.
      // Test war grün → neuer Key kann sich einloggen → newPrivateKey als connectPrivateKey.
      await _rollbackNewKey({ provisioner, vpsTarget, newPublicKey, connectPrivateKey: newPrivateKey, fpOpt });
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `ssh-key-rotate:failed:${user}:${vpsTarget.host}:${vpsTarget.targetUser}:store-activation-failed`,
        });
      } catch { /* Audit-Fehler — nicht blockierend */ }
      return res.status(500).json({ error: 'Store-Aktivierung fehlgeschlagen — Rotation abgebrochen' });
    }

    // Alten Public-Key aus authorized_keys entfernen (AC4 — best-effort nach grünem Test)
    let oldKeyRemoved = false;
    let oldKeyRemoveReason;
    try {
      const removeResult = await provisioner.removeAuthorizedKey({
        host: vpsTarget.host,
        port: vpsTarget.port,
        targetUser: vpsTarget.targetUser,
        publicKey: oldPublicKey,
        privateKey: newPrivateKey,  // Mit neuem (bereits aktivierten) Private-Key
        hostFingerprint: fpOpt,
      });
      // "removed" oder "already-absent" beide sind als Erfolg zu werten
      oldKeyRemoved = removeResult.result === 'removed' || removeResult.result === 'already-absent';
      if (!oldKeyRemoved) {
        // result: 'error' — alten Key nicht entfernt, aber neuer Key ist aktiv (kein Lockout)
        oldKeyRemoveReason = removeResult.reason ?? 'Alter Key konnte nicht entfernt werden';
      }
    } catch {
      // Entfernen gescheitert — neuer Key aktiv, Login gesichert, aber alter Key noch vorhanden
      console.error('[sshKeysRouter] rotate: removeAuthorizedKey fehlgeschlagen (kein Key-Material geloggt)');
      oldKeyRemoveReason = 'Alter Key konnte nicht aus authorized_keys entfernt werden (interner Fehler)';
    }

    // AC7: Audit-Erfolg (ohne Key-Material)
    const auditResultCmd = oldKeyRemoved
      ? `ssh-key-rotate:success:${user}:${vpsTarget.host}:${vpsTarget.targetUser}`
      : `ssh-key-rotate:partial:${user}:${vpsTarget.host}:${vpsTarget.targetUser}:old-key-not-removed`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditResultCmd });
    } catch { /* Audit-Fehler nach erfolgreicher Rotation — nicht blockierend */ }

    // AC4: GET /api/settings/ssh-keys zeigt den neuen Public-Key (Store ist schon aktiviert)
    // AC8: newPrivateKey erscheint NIEMALS in Response
    return res.json({
      result: 'rotated',
      oldKeyRemoved,
      newPublicKey,
      ...(oldKeyRemoveReason ? { reason: oldKeyRemoveReason } : {}),
    });
  });

  return router;
}

// ── Interne Hilfsfunktion: best-effort Rollback des neuen additiven Keys ────────

/**
 * Versucht den additiv eingetragenen neuen Public-Key best-effort zu entfernen.
 * AC5: bei fehlgeschlagenem Test — neuer additiver Key soll nicht dauerhaft verwaist bleiben.
 * Fehler werden geloggt aber nicht propagiert (best-effort).
 *
 * @param {object}   params
 * @param {object}   params.provisioner          - VpsProvisioner-Instanz
 * @param {object}   params.vpsTarget            - { host, port?, targetUser }
 * @param {string}   params.newPublicKey          - Neuer (noch nicht aktivierter) Public-Key (zum Entfernen)
 * @param {string}   params.connectPrivateKey     - Private-Key für die SSH-Verbindung beim Rollback
 *                                                  (store-intern, nie loggen); typischerweise der alte
 *                                                  Private-Key, der nachweislich funktioniert.
 * @param {string|undefined} params.fpOpt        - hostFingerprint oder undefined
 */
async function _rollbackNewKey({ provisioner, vpsTarget, newPublicKey, connectPrivateKey, fpOpt }) {
  try {
    await provisioner.removeAuthorizedKey({
      host: vpsTarget.host,
      port: vpsTarget.port,
      targetUser: vpsTarget.targetUser,
      publicKey: newPublicKey,
      privateKey: connectPrivateKey,
      hostFingerprint: fpOpt,
    });
  } catch {
    // Best-effort — Fehler im Rollback werden ignoriert (alter Key bleibt aktiv, kein Lockout)
    console.error('[sshKeysRouter] rotate: Rollback des neuen Keys fehlgeschlagen (best-effort — kein Lockout)');
  }
}
