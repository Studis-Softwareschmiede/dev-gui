/**
 * credentialUnlockRouter — Express-Router für den Bitwarden-Unlock-Endpunkt
 * (credential-unlock-dialog AC1–AC10).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   POST /api/settings/credential-unlock
 *     Body: { email, password, twofa?, create? }
 *     → 200 { ok: true, state: "unlocked" }          — Erfolg
 *     → 200 { ok: false, status: "not-found" }        — Item nicht vorhanden (→ create-Angebot)
 *     → 401 { ok: false, errorClass }                 — 2FA-Fehler
 *     → 4xx/5xx { ok: false, errorClass }             — andere Fehler
 *
 * Security (ADR-007 / credential-unlock-dialog):
 *   AC7  — Hinter Access-Mauer + CRED_ADMIN_EMAILS-Rollencheck (kein Access → 403; nicht gelistet → 403).
 *   AC8  — Audit-First: vor Aktion ein Eintrag ohne Werte; Audit-Fehler → Aktion unterbleibt.
 *   AC9  — Login-Daten + Master-Key erscheinen NIEMALS in Response, Log, Audit oder URL.
 *   AC3  — Response meldet nur { ok, state } — NIEMALS den Key.
 *   AC5  — Fehlerklassen klassifiziert: auth-failed/twofa-required/twofa-invalid/bw-unreachable/error.
 *   AC6  — Falscher Key → unlock lehnt ab, Store bleibt locked, .env unverändert.
 *
 * @module credentialUnlockRouter
 */

import { Router } from 'express';

/**
 * Prüft ob die anfragende Identität den Unlock-Endpunkt nutzen darf (AC7/ADR-007).
 * Wenn CRED_ADMIN_EMAILS gesetzt: nur gelistete E-Mails.
 * Wenn nicht gesetzt: jede gültige Access-Identität.
 *
 * @param {import('./AccessGuard.js').Identity} identity
 * @returns {{ allowed: boolean }}
 */
function checkUnlockAuthz(identity) {
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
 * Bildet BitwardenMasterKeyService-Fehlerklassen auf HTTP-Statuscodes ab (AC5/AC6).
 * Kein Secret-Leak — nur errorClass in der Response.
 *
 * @param {string} errorClass
 * @returns {{ status: number, body: { ok: false, errorClass: string } }}
 */
function mapErrorClassToResponse(errorClass) {
  switch (errorClass) {
    case 'twofa-required':
    case 'twofa-invalid':
      return { status: 401, body: { ok: false, errorClass } };
    case 'auth-failed':
      return { status: 401, body: { ok: false, errorClass } };
    case 'bw-unreachable':
      return { status: 503, body: { ok: false, errorClass } };
    case 'invalid-key':
      // AC6: Store-unlock hat den Key abgelehnt → Store bleibt locked
      return { status: 422, body: { ok: false, errorClass: 'invalid-key' } };
    case 'persist-failed':
      return { status: 500, body: { ok: false, errorClass: 'persist-failed' } };
    default:
      return { status: 500, body: { ok: false, errorClass: 'error' } };
  }
}

/**
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {import('./BitwardenMasterKeyService.js').BitwardenMasterKeyService} bitwardenService
 * @returns {import('express').Router}
 */
export function credentialUnlockRouter(credentialStore, auditStore, bitwardenService) {
  const router = Router();

  /**
   * POST /api/settings/credential-unlock
   *
   * Body: { email: string, password: string, twofa?: string, create?: boolean }
   *
   * Security:
   *   - AC7: Access-Mauer (server.js) + CRED_ADMIN_EMAILS-Rollencheck
   *   - AC8: Audit-First (vor Aktion) ohne Werte; Audit-Fehler → Aktion unterbleibt
   *   - AC9: Login-Daten + Key erscheinen NIEMALS in Response/Log/Audit
   *   - AC3: Response meldet nur { ok, state } — kein Key
   */
  router.post('/api/settings/credential-unlock', async (req, res) => {
    const identity = req.identity ?? null;

    // AC7: CRED_ADMIN_EMAILS-Rollencheck
    const authz = checkUnlockAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ ok: false, errorClass: 'forbidden', error: 'Keine Berechtigung für diese Aktion' });
    }

    // AC9: Eingabe-Validierung — Pflichtfelder prüfen (ohne Werte zu loggen)
    const { email, password, twofa, create } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ ok: false, errorClass: 'error', error: 'E-Mail ist ein Pflichtfeld' });
    }
    if (typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ ok: false, errorClass: 'error', error: 'Master-Passwort ist ein Pflichtfeld' });
    }

    // AC8: Audit-First — VOR der Aktion, ohne Werte (nur Identität + Aktion + Zeit)
    const auditAction = create === true
      ? 'credential-master-key-create'
      : 'credential-unlock';
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: auditAction,
      });
    } catch (auditErr) {
      // AC8: Audit-Write fehlgeschlagen → Aktion unterbleibt
      console.error('[credentialUnlockRouter] Audit-Write fehlgeschlagen:', auditErr.constructor?.name ?? 'Error');
      return res.status(500).json({ ok: false, errorClass: 'error', error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // ── Bitwarden-Beschaffung via BitwardenMasterKeyService ────────────────────
    // AC9: email + password + twofa werden NUR an den Service übergeben (nie geloggt/auditiert)
    let serviceResult;
    try {
      if (create === true) {
        // AC4: explizites Erstellen (nur nach Bestätigung)
        serviceResult = await bitwardenService.createMasterKey({
          email: email.trim(),
          password: password.trim(),
          twofa: twofa ?? undefined,
          identity: identity?.email ?? null,
        });
      } else {
        // AC3: Beschaffung (kein automatisches Erstellen)
        serviceResult = await bitwardenService.acquireMasterKey({
          email: email.trim(),
          password: password.trim(),
          twofa: twofa ?? undefined,
          identity: identity?.email ?? null,
        });
      }
    } catch (err) {
      // Unerwarteter Fehler — kein Secret-Leak (AC9)
      console.error('[credentialUnlockRouter] BitwardenMasterKeyService-Fehler:', err.constructor?.name ?? 'Error');
      return res.status(500).json({ ok: false, errorClass: 'error', error: 'Interner Fehler bei der Bitwarden-Beschaffung' });
    }

    // ── Ergebnis auswerten ─────────────────────────────────────────────────────

    // AC4: not-found → Frontend bietet Erstellungs-Angebot (200 mit status:'not-found')
    if (serviceResult.status === 'not-found') {
      return res.status(200).json({ ok: false, status: 'not-found' });
    }

    // AC3/AC4: Erfolg (found/created) → Lock-State laden + antworten (KEIN Key in Response)
    if (serviceResult.status === 'found' || serviceResult.status === 'created') {
      let lockState;
      try {
        lockState = await credentialStore.getLockState();
      } catch {
        // Store-Status nicht lesbar — trotzdem ok:true melden (unlock war erfolgreich)
        lockState = { state: 'unlocked' };
      }
      // AC3/AC9: Response enthält NUR ok + state — NIEMALS den Key
      return res.status(200).json({ ok: true, state: lockState.state });
    }

    // AC5/AC6: Fehler → klassifizierte Antwort ohne Secret-Leak
    if (serviceResult.status === 'error') {
      const { errorClass } = serviceResult;
      const mapped = mapErrorClassToResponse(errorClass);
      // AC9: kein Secret in Response (errorClass ist maschinenlesbar, kein Klartext-Leak)
      return res.status(mapped.status).json(mapped.body);
    }

    // Fallback (sollte nicht vorkommen)
    return res.status(500).json({ ok: false, errorClass: 'error', error: 'Unbekannter Service-Status' });
  });

  return router;
}
