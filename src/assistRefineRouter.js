/**
 * assistRefineRouter — POST /api/assist/refine (AC5, AC7, AC10).
 *
 * Headless Proof-Helfer: nimmt Freitext entgegen, schickt ihn via
 * AssistService (claude -p, zustandslos) und liefert strukturiert zurück.
 *
 * Vertrag (docs/specs/fabric-intake-dialog.md):
 *   POST /api/assist/refine
 *   Body: { text: string, kind: "idea"|"change", repoContext?: string }
 *   200: { refinedText, openQuestions[], notes? }
 *   400: leerer/ungültiger text oder unbekanntes kind (kein claude-Aufruf, kein Audit)
 *   502: claude -p fehlt / Fehler / Timeout (kein Secret-/Pfad-Leak)
 *
 * Security:
 *   - Hinter AccessGuard (server.js, AC7): req.identity gesetzt.
 *   - Genau EIN AuditStore.record() je akzeptiertem Aufruf (AC7).
 *   - text wird via STDIN an claude übergeben (AssistService), NICHT als argv (AC7).
 *   - Keine Secrets in Logs/Audit/Response (security/R01).
 *   - Kein JobLock — unabhängig von laufendem Flow-Command (AC5).
 *
 * Reihenfolge (Audit-First-Konvention, analog CommandService):
 *   1. Validierung (400 bei leerem text / unbekanntem kind — kein claude, kein Audit).
 *   2. Audit-Eintrag schreiben (schlägt record() fehl → 500, claude wird NICHT aufgerufen).
 *   3. assistService.refine() → claude -p.
 *
 * @module assistRefineRouter
 */

import { Router } from 'express';
import { VALID_KINDS } from './AssistService.js';

/**
 * @param {import('./AssistService.js').AssistService} assistService
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function assistRefineRouter(assistService, auditStore) {
  const router = Router();

  /**
   * POST /api/assist/refine
   * Body: { text: string, kind: "idea"|"change", repoContext?: string }
   */
  router.post('/api/assist/refine', async (req, res) => {
    const { text, kind, repoContext } = req.body ?? {};
    const identity = req.identity ?? null;

    // ── Schritt 1: Validierung VOR Audit + claude-Aufruf ─────────────────────
    // 400 bei leerem/ungültigem text (kein Audit, kein claude-Aufruf, AC10)
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    // 400 bei unbekanntem kind (kein Audit, kein claude-Aufruf, AC10)
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: idea, change` });
    }

    // ── Schritt 2: Audit-First (AC7 + Audit-First-Konvention) ────────────────
    // Schlägt record() fehl → 500, claude wird NICHT aufgerufen.
    const identityStr = resolveIdentity(identity);
    try {
      auditStore.record({ identity: identityStr, command: 'assist/refine' });
    } catch {
      // Audit-Fehler → 500 (fail-safe, Audit-First: claude läuft nicht)
      return res.status(500).json({ error: 'Audit failure' });
    }

    // ── Schritt 3: claude -p über AssistService (AC5 — zustandslos, one-shot) ─
    // Validierung wurde bereits im Router durchgeführt; AssistService wiederholt
    // sie intern (Defense in Depth), aber der Audit ist bereits geschrieben.
    const result = await assistService.refine({ text, kind, repoContext });

    if (!result.ok) {
      // 502 — claude nicht verfügbar oder Fehler (AC10, kein Secret-/Pfad-Leak)
      return res.status(502).json({ error: result.message ?? 'claude -p unavailable or failed' });
    }

    return res.status(200).json({
      refinedText: result.refinedText,
      openQuestions: result.openQuestions,
      ...(result.notes !== undefined ? { notes: result.notes } : {}),
    });
  });

  return router;
}

/**
 * Extrahiert identity-String aus req.identity (wie CommandService).
 * @param {unknown} identity
 * @returns {string|null}
 */
function resolveIdentity(identity) {
  if (identity === null || identity === undefined) return null;
  if (typeof identity === 'string') return identity;
  if (typeof identity === 'object' && 'email' in identity) {
    const email = identity.email;
    return typeof email === 'string' ? email : null;
  }
  return null;
}
