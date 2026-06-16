/**
 * Router-Wrapper: Restore-Endpunkt (S-142, AC13–AC16).
 *
 * POST /api/settings/backup-restore
 *   Lädt ein verschlüsseltes Backup-Artefakt hoch, entschlüsselt es mit dem geladenen
 *   Master-Key (GPG-decrypt, Passphrase via stdin — Floor AC7) und stellt das
 *   wiederhergestellte secrets.enc.json atomar ans Volume zurück.
 *
 *   Schutz (AC16):
 *     - AccessGuard (via server.js /api-Middleware)
 *     - CRED_ADMIN_EMAILS-Rollencheck → 403 bei nicht-berechtigt
 *     - Audit-First: Audit-Eintrag (Identität, Aktion `credential-restore`, Zeit)
 *       OHNE Secret-Werte VOR Ausführung
 *
 *   Überschreib-Bestätigung (AC14):
 *     - Body-Feld `confirm: true` erforderlich; ohne Flag → 400 confirm-required
 *
 *   Fehlerklassen (AC15 — geheimnisfrei):
 *     - `confirm-required`   — kein Confirm-Flag
 *     - `no-master-key`      — Store gesperrt (kein Master-Key geladen)
 *     - `gpg-decrypt-failed` — falscher Key oder korruptes Artefakt
 *     - `restore-invalid`    — ungültiges Artefakt-Format / inkompatible Schema-Version
 *     - `restore-write-failed` — Schreib-Fehler (atomares Rename)
 *
 *   Atomares Zurückschreiben (AC15):
 *     - tmp + fsync + rename: alter Store bleibt intakt bei Fehler/Crash
 *     - Schreiben ERST nach erfolgreichem Decrypt
 *
 *   Body: multipart/form-data (Feld `artefact`) ODER application/octet-stream (raw binary)
 *   Größenlimit: 10 MiB (Floor: keine unbeschränkten Uploads)
 *
 *   Response 200: { ok: true, manifest: { schemaVersion, backupVersion, createdAt, storeSize } }
 *   Response 400: { ok: false, errorClass: string, error: string }
 *   Response 403: { error: string }
 *   Response 500: { error: string }
 *
 * Security-Floor:
 *   - Master-Key / Passphrase NICHT in Logs/Response/Audit (AC7/Floor).
 *   - Entschlüsselter Klartext bleibt NICHT als Datei liegen (atomares rename).
 *   - Hochgeladenes Artefakt wird nur in-memory gehalten; kein temp-File für Klartext.
 *   - Audit-First: Eintrag VOR Ausführung, ohne Werte (nur Identität + Aktion + Zeit).
 *
 * Factory-Signatur: create(deps) → Express Router
 *
 * @module backupRestore
 */

import express, { Router } from 'express';

export const order = 53;

/** Maximale Upload-Größe für ein Backup-Artefakt (10 MiB). */
const MAX_ARTEFACT_BYTES = 10 * 1024 * 1024;

/**
 * Prüft ob die anfragende Identität den Restore durchführen darf.
 * Analoges Muster zu checkMutationAuthz() in backupConfig.js / credentialsRouter.js.
 *
 * @param {object|null} identity - req.identity (AccessGuard-Ergebnis)
 * @returns {{ allowed: boolean }}
 */
function checkRestoreAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    // Keine Allowlist → jede gültige Identität darf restoren
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
 * Liest den Request-Body als Buffer (mit Größenlimit).
 * Unterstützt application/octet-stream (raw binary, bereits geparst von express.raw)
 * sowie multipart/form-data (liest den raw-Buffer direkt vom Stream wenn nötig).
 *
 * @param {import('express').Request} req
 * @returns {Promise<Buffer|null>} - Buffer oder null wenn kein Artefakt
 */
async function readArtefactBuffer(req) {
  // express.raw() hat den Body bereits als Buffer geladen (application/octet-stream)
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    return req.body;
  }

  // Fallback: multipart/form-data — manuelles Parsen via stream
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    return _parseMultipart(req, contentType);
  }

  return null;
}

/**
 * Minimales multipart/form-data-Parsing für ein einzelnes binäres Feld `artefact`.
 * Nur für das Restore-Feld — kein allgemeines multipart-Framework.
 *
 * @param {import('express').Request} req
 * @param {string} contentType
 * @returns {Promise<Buffer|null>}
 */
async function _parseMultipart(req, contentType) {
  // Boundary aus Content-Type extrahieren
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return null;
  const boundary = Buffer.from('--' + boundaryMatch[1]);

  // Body einlesen mit Größenlimit
  const chunks = [];
  let totalBytes = 0;

  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_ARTEFACT_BYTES) {
        reject(new Error('Upload-Größe überschreitet Limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  const body = Buffer.concat(chunks);

  // Einfaches multipart-Parsing: findet den ersten Part mit name="artefact"
  // und gibt seine binären Daten zurück.
  let searchPos = 0;
  while (searchPos < body.length) {
    const boundaryPos = indexOf(body, boundary, searchPos);
    if (boundaryPos === -1) break;

    // Ende-Boundary prüfen
    const afterBoundary = boundaryPos + boundary.length;
    if (body.slice(afterBoundary, afterBoundary + 2).equals(Buffer.from('--'))) break;

    // Header-Ende finden (doppeltes CRLF \r\n\r\n)
    const headerStart = afterBoundary + 2; // nach CRLF
    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = body.slice(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4; // nach \r\n\r\n

    // Nächste Boundary suchen (Daten enden davor)
    const nextBoundaryPos = indexOf(body, boundary, dataStart);
    if (nextBoundaryPos === -1) break;

    // Daten: von dataStart bis nextBoundary - 2 (CRLF vor Boundary)
    const dataEnd = nextBoundaryPos - 2;
    if (dataEnd <= dataStart) {
      searchPos = nextBoundaryPos;
      continue;
    }

    // Prüfen ob dieses Part das Feld `artefact` ist
    if (/name="artefact"/i.test(headerStr)) {
      return body.slice(dataStart, dataEnd);
    }

    searchPos = nextBoundaryPos;
  }

  return null;
}

/**
 * indexOf-Hilfsfunktion: Sucht needle in haystack ab fromIndex.
 *
 * @param {Buffer} haystack
 * @param {Buffer} needle
 * @param {number} fromIndex
 * @returns {number} Index oder -1
 */
function indexOf(haystack, needle, fromIndex = 0) {
  for (let i = fromIndex; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

/**
 * @param {{ auditStore: import('../AuditStore.js').AuditStore, credentialStore: import('../CredentialStore.js').CredentialStore }} deps
 * @returns {import('express').Router}
 */
export function create({ auditStore, credentialStore }) {
  const router = Router();

  // express.raw() für application/octet-stream (direkter Binary-Upload)
  // Vor dem Route-Handler eingehängt — nur für diesen Router.
  // Limit: MAX_ARTEFACT_BYTES (Floor: keine unbeschränkten Uploads).
  // Statischer Import aus 'express' (ESM-Cache — keine neue Express-Instanz).
  const rawBodyParser = express.raw({ type: 'application/octet-stream', limit: MAX_ARTEFACT_BYTES });
  router.use(
    '/api/settings/backup-restore',
    (req, _res, next) => {
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.startsWith('application/octet-stream')) {
        rawBodyParser(req, _res, next);
      } else {
        next();
      }
    },
  );

  /**
   * POST /api/settings/backup-restore
   *
   * Body (multipart/form-data):  Feld `artefact` = verschlüsselte GPG-Datei
   * Body (application/octet-stream): Raw-Binary des Artefakts
   * Query: confirm=true ODER Body-JSON-Feld confirm=true
   *
   * Schutz: AccessGuard (global) + CRED_ADMIN_EMAILS + Audit-First (AC16).
   */
  router.post('/api/settings/backup-restore', async (req, res) => {
    // AC16: CRED_ADMIN_EMAILS-Rollencheck ZUERST (vor Audit)
    const identity = req.identity ?? null;
    const authz = checkRestoreAuthz(identity);
    if (!authz.allowed) {
      // AC16: 403 ohne Audit-Wertinhalt (kein Audit bei Nicht-Berechtigung)
      return res.status(403).json({ error: 'Keine Berechtigung zum Restore.' });
    }

    // AC16: Audit-First — Eintrag mit Identität, Aktion `credential-restore`, Zeit
    // OHNE Werte (kein Master-Key, kein Artefakt-Inhalt, kein Secret)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'credential-restore',
      });
    } catch (auditErr) {
      console.error('[backupRestore] Audit-Schreiben fehlgeschlagen:', auditErr.message);
      return res.status(500).json({ error: 'Audit-Schreiben fehlgeschlagen — Restore nicht ausgeführt.' });
    }

    // Confirm-Flag lesen (aus Query oder Body)
    // Unterstützt: ?confirm=true oder { confirm: true } im JSON-Body
    // oder multipart-Feld. Für multipart lesen wir confirm aus req.query.
    const confirmRaw = req.query?.confirm ?? (typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body?.confirm : undefined);
    const confirm = confirmRaw === true || confirmRaw === 'true' || confirmRaw === '1';

    // AC14: Ohne Bestätigung sofort ablehnen
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        errorClass: 'confirm-required',
        error: 'Überschreib-Bestätigung fehlt (?confirm=true erforderlich).',
      });
    }

    // Artefakt-Buffer lesen
    let artefactBuffer;
    try {
      artefactBuffer = await readArtefactBuffer(req);
    } catch (err) {
      return res.status(400).json({
        ok: false,
        errorClass: 'restore-invalid',
        error: `Upload-Fehler: ${err.message}`,
      });
    }

    if (!artefactBuffer || artefactBuffer.length === 0) {
      return res.status(400).json({
        ok: false,
        errorClass: 'restore-invalid',
        error: 'Kein Artefakt hochgeladen (Feld `artefact` fehlt oder leer).',
      });
    }

    // Größenlimit (Floor: Defense gegen überdimensionale Uploads)
    if (artefactBuffer.length > MAX_ARTEFACT_BYTES) {
      return res.status(400).json({
        ok: false,
        errorClass: 'restore-invalid',
        error: `Upload-Größe überschreitet Limit (${MAX_ARTEFACT_BYTES} Bytes).`,
      });
    }

    // AC13: Restore durchführen (GPG-decrypt + atomares Zurückschreiben)
    // AC15: Fehler → alter Store intakt, Fehler ohne Secret
    let result;
    try {
      result = await credentialStore.restore(artefactBuffer, { confirm: true });
    } catch (err) {
      // Unerwarteter Fehler (sollte nicht vorkommen — restore() fängt intern ab)
      console.error('[backupRestore] Unerwarteter Fehler beim Restore:', err.message);
      return res.status(500).json({
        ok: false,
        errorClass: 'error',
        error: 'Unerwarteter Fehler beim Restore.',
      });
    }

    if (!result.ok) {
      // AC15: Geheimnisfreier Fehler (errorClass + error ohne Key/Klartext)
      const status = result.errorClass === 'confirm-required' ? 400
        : result.errorClass === 'no-master-key' ? 503
        : result.errorClass === 'gpg-decrypt-failed' ? 422
        : result.errorClass === 'restore-invalid' ? 422
        : result.errorClass === 'restore-write-failed' ? 500
        : 500;
      return res.status(status).json({
        ok: false,
        errorClass: result.errorClass,
        error: result.error,
      });
    }

    // AC13: Erfolg — nur Metadaten zurückgeben (kein Key/Klartext in Response)
    return res.json({
      ok: true,
      manifest: result.manifest,
    });
  });

  return router;
}
