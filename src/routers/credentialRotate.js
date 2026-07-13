/**
 * Router-Wrapper: Master-Key-Rotation-Endpunkt (credential-key-rotation, S-083 Kern
 * — AC1-AC3/AC7-AC10 von docs/specs/credential-key-rotation.md).
 *
 * POST /api/settings/credential-rotate
 *   Body: { newKey: string }
 *   Re-verschlüsselt secrets.enc.json vom aktuell aktiven auf den neuen Key
 *   (CredentialStore#rotate — atomare Re-Encryption + Round-trip-Verifikation +
 *   atomarer Swap, AC1-AC3), persistiert den neuen Key danach in `.env` (AC7).
 *
 *   Request-Body (S-083 Kern-Scope): der Endpunkt nimmt den neuen Key direkt aus
 *   dem Body entgegen. Eine Beschaffung/Ablage des Keys über Bitwarden
 *   ([[bitwarden-master-key-unlock]], AC4/AC5/AC11) ist NICHT Teil dieses Endpunkts
 *   — das ist eine spätere Folge-Story (S-342), die auf `swapped` andockt.
 *
 *   Schutz (AC8):
 *     - AccessGuard (server.js /api-Middleware)
 *     - CRED_ADMIN_EMAILS-Rollencheck → 403 bei nicht-berechtigt (kein Audit bei 403)
 *     - Audit-First: Audit-Eintrag (Identität, Aktion `credential-rotate`, Zeit)
 *       OHNE Key-Werte VOR Ausführung; ein fehlgeschlagener Audit-Write verhindert
 *       die Aktion.
 *
 *   Fehlerklassen (AC9 — geheimnisfrei, kein Key-Wert in reason/error):
 *     - `empty-key` / `invalid-key-format` — Eingabe ungültig (400)
 *     - `same-key`             — neuer Key == alter Key, keine sinnlose Re-Encryption (400)
 *     - `no-master-key`        — Store gesperrt, keine Rotation ohne aktiven Key (503)
 *     - `decrypt-failed`       — alter Key kann bestehende Einträge nicht entschlüsseln
 *                                 (manipuliertes Store / GCM-Tag) — kein Swap (500)
 *     - `encrypt-failed`       — Fehler beim Aufbau der neuen Rotations-Datei — kein Swap (500)
 *     - `verification-failed`  — Round-trip-Verifikation der neuen Datei schlug fehl
 *                                 — kein Swap (500)
 *     - `swap-failed`          — atomarer rename() fehlgeschlagen — kein Swap (500)
 *     - `persist-failed`       — Swap erfolgreich, `.env`-Persistenz fehlgeschlagen;
 *                                 neuer Key ist bereits in-memory aktiv (Reboot-Risiko) (500)
 *
 *   Response 200: { ok: true, swapped: true }
 *   Response 4xx/5xx: { ok: false, reason: string, swapped: boolean }
 *   Response 403: { ok: false, reason: 'forbidden', error: string }
 *
 * Security-Floor (AC9/AC10 Spec):
 *   - Weder alter noch neuer Key erscheint in Log/Audit/Response/WS/Argv/Bundle
 *     (weder hier noch in CredentialStore#rotate — `reason` ist ein sanitisiertes Enum).
 *   - AC10: rotiert AUSSCHLIESSLICH DEVGUI_CRED_MASTER_KEY; GPG_PASSPHRASE/.env.gpg
 *     werden von diesem Endpunkt/CredentialStore#rotate nicht berührt.
 *
 * Factory-Signatur: create(deps) → Express Router (routerLoader-Konvention).
 *
 * AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater Middleware-Test
 * (Muster analog backupRestore.js).
 *
 * @module credentialRotate
 */

import { Router } from 'express';

export const order = 56;

/**
 * Prüft ob die anfragende Identität die Rotation durchführen darf.
 * Analoges Muster zu checkRestoreAuthz() in backupRestore.js / checkMutationAuthz()
 * in credentialsRouter.js.
 *
 * @param {object|null} identity - req.identity (AccessGuard-Ergebnis)
 * @returns {{ allowed: boolean }}
 */
function checkRotateAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
    // Keine Allowlist gesetzt → jede gültige Identität darf
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
 * Bildet CredentialStore#rotate()-reason-Werte auf HTTP-Statuscodes ab
 * (AC9 — geheimnisfrei, kein Key-Wert in der Response).
 *
 * @param {string} reason
 * @returns {number}
 */
function mapReasonToStatus(reason) {
  switch (reason) {
    case 'empty-key':
    case 'invalid-key-format':
    case 'same-key':
      return 400;
    case 'no-master-key':
      return 503;
    case 'decrypt-failed':
    case 'encrypt-failed':
    case 'verification-failed':
    case 'swap-failed':
    case 'persist-failed':
      return 500;
    default:
      return 500;
  }
}

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore }) {
  const router = Router();

  /**
   * POST /api/settings/credential-rotate
   *
   * Body: { newKey: string }
   *
   * Schutz: AccessGuard (global) + CRED_ADMIN_EMAILS + Audit-First (AC8).
   */
  router.post('/api/settings/credential-rotate', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: CRED_ADMIN_EMAILS-Rollencheck ZUERST (vor Audit — kein Audit bei 403)
    const authz = checkRotateAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ ok: false, reason: 'forbidden', error: 'Keine Berechtigung zur Rotation.' });
    }

    const { newKey } = req.body ?? {};

    // AC8: Audit-First — VOR der Aktion, ohne Werte (nur Identität + Aktion + Zeit).
    // Ein fehlgeschlagener Audit-Write verhindert die Aktion (auch bei ungültigem Body —
    // CredentialStore#rotate() validiert die Eingabe intern und liefert einen
    // sanitisierten reason zurück, ohne dass die Rotation selbst versucht wird).
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'credential-rotate',
      });
    } catch (auditErr) {
      console.error('[credentialRotate] Audit-Write fehlgeschlagen:', auditErr.constructor?.name ?? 'Error');
      return res.status(500).json({ ok: false, reason: 'audit-failed', error: 'Audit-Write fehlgeschlagen — Rotation abgebrochen.' });
    }

    let result;
    try {
      result = await credentialStore.rotate(newKey);
    } catch (err) {
      // Unerwarteter Fehler (sollte nicht vorkommen — rotate() fängt intern ab)
      console.error('[credentialRotate] Unerwarteter Fehler bei der Rotation:', err.constructor?.name ?? 'Error');
      return res.status(500).json({ ok: false, reason: 'error', swapped: false });
    }

    if (!result.ok) {
      // AC9: geheimnisfreier Fehler (reason + swapped ohne Key/Klartext)
      return res.status(mapReasonToStatus(result.reason)).json({
        ok: false,
        reason: result.reason,
        swapped: !!result.swapped,
      });
    }

    // AC9: Erfolg — niemals einen Key/Klartext in der Response
    return res.status(200).json({ ok: true, swapped: true });
  });

  return router;
}
