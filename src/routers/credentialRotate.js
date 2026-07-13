/**
 * Router-Wrapper: Master-Key-Rotation-Endpunkte (credential-key-rotation, S-083 Kern
 * + v2 S-342 — docs/specs/credential-key-rotation.md).
 *
 * POST /api/settings/credential-rotate
 *   Body: { newKey: string, bwEmail?, bwPassword?, bwTwofa?, bwEmailOtp? }
 *
 *   Stufe 1 (S-083 Kern, unverändert): re-verschlüsselt secrets.enc.json vom
 *   aktuell aktiven auf den neuen Key (CredentialStore#rotate — atomare
 *   Re-Encryption + Round-trip-Verifikation + atomarer Swap, AC1-AC3), persistiert
 *   den neuen Key danach in `.env` (AC7). Enthält seit v2 (AC6/AC12) zusätzlich
 *   IMMER ein `backup`-Feld (frisches, mit dem neuen Key lesbares Store-Backup —
 *   CredentialStore#rotate() triggert das intern, additiv zum Kern-Vertrag).
 *
 *   Stufe 2 (v2, S-342, AC4/AC11 — NUR wenn Stufe 1 den Store bereits geswappt hat,
 *   d.h. `result.swapped === true` — das gilt SOWOHL für `ok:true` ALS AUCH für
 *   den `persist-failed`-Fall (`ok:false, swapped:true`): das ist genau der Fall,
 *   in dem Bitwarden der einzige Recovery-Pfad für den neuen Key ist, Stufe 2
 *   darf dort NICHT übersprungen werden — Review-Finding, Iteration 2): wird
 *   `bwEmail`+`bwPassword` mitgeliefert, archiviert dieser Endpunkt zusätzlich
 *   den BISHERIGEN Bitwarden-Item-Wert datiert im Custom-Feld „Schlüssel-Archiv"
 *   und schaltet den neuen Key als aktiven Item-Wert um
 *   (`BitwardenMasterKeyService#archiveRotatedKey`, mit dem GETRIMMTEN `newKey`
 *   — identisch zu dem Wert, den `CredentialStore#rotate()` intern aktiviert,
 *   sonst archiviert Bitwarden einen anderen String als den tatsächlich aktiven
 *   Key — Review-Finding, Iteration 2). Fehlt `bwEmail`/`bwPassword`, wird
 *   Stufe 2 übersprungen (kein Fehler — reiner Kern-Aufruf bleibt weiterhin ein
 *   gültiger, abwärtskompatibler Anwendungsfall, z.B. Notfall-Rotation ohne
 *   Bitwarden-Zugriff). Ein Fehlschlag von Stufe 2 rollt Stufe 1 NICHT zurück
 *   (best-effort, stufen-genaue Warnung — AC13) — der lokale Store bleibt mit
 *   dem neuen Key aktiv, egal wie Stufe 2 ausgeht.
 *
 *   Schutz (AC8):
 *     - AccessGuard (server.js /api-Middleware)
 *     - CRED_ADMIN_EMAILS-Rollencheck → 403 bei nicht-berechtigt (kein Audit bei 403)
 *     - Audit-First: Audit-Eintrag (Identität, Aktion `credential-rotate`, Zeit)
 *       OHNE Key-Werte VOR Ausführung; ein fehlgeschlagener Audit-Write verhindert
 *       die Aktion. Die Bitwarden-Archivierung (Stufe 2) hat ihren EIGENEN
 *       Audit-First-Eintrag (`bitwarden:key-archive:<item>`, in
 *       BitwardenMasterKeyService#archiveRotatedKey).
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
 *   Response 200: { ok: true, swapped: true, backup, archive? }
 *     - `backup`: `{local, offHost, errorClass?, message?}` (toExternalBackup — kein
 *       interner Volume-Pfad, S-1-Konvention wie credentialsRouter.js)
 *     - `archive` (nur wenn bwEmail+bwPassword mitgeliefert): `{ ok: boolean,
 *       errorClass?: string }` — geheimnisfrei, Stufe-2-Ergebnis (AC13)
 *   Response 4xx/5xx: { ok: false, reason: string, swapped: boolean, backup? }
 *   Response 403: { ok: false, reason: 'forbidden', error: string }
 *
 * POST /api/settings/credential-key-archive-discard (v2, S-342, AC5)
 *   Body: { bwEmail, bwPassword, bwTwofa?, bwEmailOtp?, confirm: true }
 *   Entsorgt PERMANENT den gesamten Inhalt des Custom-Felds „Schlüssel-Archiv" —
 *   eine GETRENNTE, explizit bestätigte Aktion (Pflichtfeld `confirm: true`, sonst
 *   400), NIEMALS Bestandteil des normalen Rotations-Flows oben. Gedacht als
 *   bewusster, expliziter Kompromittierungs-Schritt (AC5).
 *   Schutz identisch zu oben (Access + CRED_ADMIN_EMAILS + Audit-First — der
 *   Audit-Eintrag `bitwarden:key-archive-discard:<item>` liegt in
 *   BitwardenMasterKeyService#discardArchivedKeys).
 *   Response 200: { ok: true }
 *   Response 4xx/5xx: { ok: false, reason: string, errorClass?: string }
 *
 * Security-Floor (AC9/AC10 Spec):
 *   - Weder alter noch neuer Key erscheint in Log/Audit/Response/WS/Argv/Bundle
 *     (weder hier noch in CredentialStore#rotate/BitwardenMasterKeyService — `reason`
 *     ist ein sanitisiertes Enum). Bitwarden-Login-Daten (bwEmail/bwPassword/
 *     bwTwofa/bwEmailOtp) verlassen den Prozess NIE Richtung Log/Audit/Response —
 *     sie werden ausschließlich an BitwardenMasterKeyService durchgereicht (Env/
 *     PTY-Write-Übergabe, siehe dortige Doku).
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
import { toExternalBackup } from '../CredentialStore.js';

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
 * @param {{
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 *   auditStore: import('../AuditStore.js').AuditStore,
 *   bitwardenMasterKeyService?: import('../BitwardenMasterKeyService.js').BitwardenMasterKeyService,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore, bitwardenMasterKeyService }) {
  const router = Router();

  /**
   * POST /api/settings/credential-rotate
   *
   * Body: { newKey: string, bwEmail?, bwPassword?, bwTwofa?, bwEmailOtp? }
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

    const { newKey, bwEmail, bwPassword, bwTwofa, bwEmailOtp } = req.body ?? {};
    // Finding 2 (Review-Iteration 2): CredentialStore#rotate() trimmt newKey INTERN
    // (trimmedNew), bevor es den Key aktiviert — archiveRotatedKey() muss GENAU
    // DENSELBEN getrimmten Wert erhalten, sonst archiviert Bitwarden einen anderen
    // String als den tatsächlich aktiven Key (bricht "Bitwarden bleibt Source of
    // Truth des Keys"). rotate() bleibt mit dem rohen newKey aufgerufen (Kern-Vertrag
    // unverändert, eigene Validierung/Trim intern) — nur für Stufe 2 wird hier
    // vorab derselbe getrimmte Wert berechnet.
    const trimmedNewKey = typeof newKey === 'string' ? newKey.trim() : newKey;

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

    // Stufe 2 (v2, AC4/AC11): läuft, sobald der Store bereits geswappt ist
    // (`result.swapped === true`) — UNABHÄNGIG von `result.ok`. Finding 1
    // (Review-Iteration 2): der persist-failed-Fall hat `ok:false, swapped:true`
    // (Swap bereits durchgelaufen, nur die `.env`-Persistenz ist gescheitert —
    // Reboot-Risiko) und ist genau der Fall, in dem Bitwarden der einzige
    // Recovery-Pfad für den neuen Key ist — Stufe 2 darf hier NICHT übersprungen
    // werden. Fehlende bwEmail/bwPassword ⇒ Stufe 2 übersprungen (kein Fehler,
    // S-083-Kern bleibt ein gültiger, abwärtskompatibler Anwendungsfall).
    let archive;
    if (result.swapped && bwEmail && bwPassword && bitwardenMasterKeyService) {
      try {
        const archiveResult = await bitwardenMasterKeyService.archiveRotatedKey({
          email: bwEmail,
          password: bwPassword,
          twofa: bwTwofa,
          emailOtp: bwEmailOtp,
          newKey: trimmedNewKey,
          identity: identity?.email ?? null,
        });
        archive = archiveResult.status === 'archived'
          ? { ok: true }
          : { ok: false, errorClass: archiveResult.errorClass };
      } catch (err) {
        console.error('[credentialRotate] Unerwarteter Fehler bei der Bitwarden-Archivierung:', err.constructor?.name ?? 'Error');
        archive = { ok: false, errorClass: 'error' };
      }
    }

    if (!result.ok) {
      // AC9: geheimnisfreier Fehler (reason + swapped ohne Key/Klartext)
      return res.status(mapReasonToStatus(result.reason)).json({
        ok: false,
        reason: result.reason,
        swapped: !!result.swapped,
        ...(result.backup ? { backup: toExternalBackup(result.backup) } : {}),
        ...(archive ? { archive } : {}),
      });
    }

    // AC9: Erfolg — niemals einen Key/Klartext in der Response
    return res.status(200).json({
      ok: true,
      swapped: true,
      backup: toExternalBackup(result.backup),
      ...(archive ? { archive } : {}),
    });
  });

  /**
   * POST /api/settings/credential-key-archive-discard (v2, S-342, AC5)
   *
   * Body: { bwEmail, bwPassword, bwTwofa?, bwEmailOtp?, confirm: true }
   *
   * Permanente Entsorgung des Archiv-Felds — GETRENNTE, explizit bestätigte Aktion
   * (`confirm:true` Pflicht, sonst 400), NIE Bestandteil des normalen Rotations-Flows.
   */
  router.post('/api/settings/credential-key-archive-discard', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: CRED_ADMIN_EMAILS-Rollencheck ZUERST (vor Audit — kein Audit bei 403)
    const authz = checkRotateAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ ok: false, reason: 'forbidden', error: 'Keine Berechtigung.' });
    }

    if (!bitwardenMasterKeyService) {
      return res.status(503).json({ ok: false, reason: 'error', error: 'Bitwarden-Dienst nicht verfügbar.' });
    }

    const { bwEmail, bwPassword, bwTwofa, bwEmailOtp, confirm } = req.body ?? {};

    // AC5/AC13: explizite Bestätigung ist Pflicht — sonst KEIN Zugriff auf Bitwarden.
    if (confirm !== true) {
      return res.status(400).json({ ok: false, reason: 'confirm-required', error: 'Explizite Bestätigung (confirm:true) erforderlich.' });
    }
    if (!bwEmail || !bwPassword) {
      return res.status(400).json({ ok: false, reason: 'bw-credentials-required', error: 'Bitwarden-E-Mail und -Passwort erforderlich.' });
    }

    let result;
    try {
      result = await bitwardenMasterKeyService.discardArchivedKeys({
        email: bwEmail,
        password: bwPassword,
        twofa: bwTwofa,
        emailOtp: bwEmailOtp,
        identity: identity?.email ?? null,
      });
    } catch (err) {
      console.error('[credentialRotate] Unerwarteter Fehler bei der Archiv-Entsorgung:', err.constructor?.name ?? 'Error');
      return res.status(500).json({ ok: false, reason: 'error' });
    }

    if (result.status !== 'discarded') {
      return res.status(500).json({ ok: false, reason: result.errorClass ?? 'error' });
    }

    return res.status(200).json({ ok: true });
  });

  return router;
}
