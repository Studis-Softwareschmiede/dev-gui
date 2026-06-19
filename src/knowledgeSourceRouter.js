/**
 * knowledgeSourceRouter — POST /api/assist/knowledge-sources (AC3, AC6, AC14, AC15).
 *
 * Headless Quellen-Such-Helfer: nimmt eine Beschreibung entgegen, sucht via
 * KnowledgeSourceService (claude -p --allowedTools WebSearch, zustandslos) und
 * liefert strukturiert zurück.
 *
 * Vertrag (docs/specs/team-knowledge-add.md):
 *   POST /api/assist/knowledge-sources
 *   Body: { description: string }
 *   200: { ok:true, suggestedPackId, suggestedType, sources:[{title,url,why}], notes? }
 *   400: leere/fehlende description (kein claude-Aufruf, kein Audit)
 *   502: claude -p fehlt / Fehler / Timeout (kein Secret-/Pfad-Leak)
 *
 * Architektur-Auflagen (A1–A7, bindend):
 *   A2 — eigener KnowledgeSourceService (AssistService bleibt unverändert).
 *   A3 — claude -p mit --allowedTools WebSearch exklusiv.
 *   A5 — URL-Validierung bei Auslösung (wird in der Frontend-Route POST /api/command geprüft;
 *         dieser Endpunkt liefert nur Vorschläge — keine URL-Validation nötig hier,
 *         da dev-gui die URLs nicht selbst fetcht, A4).
 *   A6 — Genau EIN Audit-Eintrag je akzeptiertem Aufruf (Audit-First-Konvention).
 *   A7 — Timeout 60 s + max. 1 Retry im Service; fail-safe, kein Crash.
 *
 * Security:
 *   - Hinter AccessGuard (server.js): req.identity gesetzt.
 *   - Genau EIN AuditStore.record() je akzeptiertem Aufruf (A6).
 *   - description wird via STDIN an claude übergeben (KnowledgeSourceService), NICHT als argv.
 *   - Keine Secrets in Logs/Audit/Response (security/R01).
 *   - Kein JobLock — unabhängig von laufendem Flow-Command (AC11).
 *
 * Reihenfolge (Audit-First-Konvention, analog assistRefineRouter):
 *   1. Validierung (400 bei leerer/fehlender description — kein claude, kein Audit).
 *   2. Audit-Eintrag schreiben (schlägt record() fehl → 500, claude wird NICHT aufgerufen).
 *   3. knowledgeSourceService.findSources() → claude -p.
 *
 * @module knowledgeSourceRouter
 */

import { Router } from 'express';

/**
 * @param {import('./KnowledgeSourceService.js').KnowledgeSourceService} knowledgeSourceService
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function knowledgeSourceRouter(knowledgeSourceService, auditStore) {
  const router = Router();

  /**
   * POST /api/assist/knowledge-sources
   * Body: { description: string }
   */
  router.post('/api/assist/knowledge-sources', async (req, res) => {
    const { description } = req.body ?? {};
    const identity = req.identity ?? null;

    // ── Schritt 1: Validierung VOR Audit + claude-Aufruf ─────────────────────
    // 400 bei leerer/fehlender description (kein Audit, kein claude-Aufruf)
    if (typeof description !== 'string' || description.trim() === '') {
      return res.status(400).json({ error: 'description must be a non-empty string' });
    }

    // ── Schritt 2: Audit-First (A6 + Audit-First-Konvention) ─────────────────
    // Schlägt record() fehl → 500, claude wird NICHT aufgerufen.
    const identityStr = resolveIdentity(identity);
    try {
      auditStore.record({ identity: identityStr, command: 'assist/knowledge-sources' });
    } catch {
      // Audit-Fehler → 500 (fail-safe, Audit-First: claude läuft nicht)
      return res.status(500).json({ error: 'Audit failure' });
    }

    // ── Schritt 3: claude -p über KnowledgeSourceService (zustandslos, kein JobLock) ─
    const result = await knowledgeSourceService.findSources({ description });

    if (!result.ok) {
      // 502 — claude nicht verfügbar oder Fehler (kein Secret-/Pfad-Leak)
      return res.status(502).json({ error: result.message ?? 'claude -p unavailable or failed' });
    }

    return res.status(200).json({
      ok: true,
      suggestedPackId: result.suggestedPackId,
      suggestedType: result.suggestedType,
      sources: result.sources,
      ...(result.notes !== undefined ? { notes: result.notes } : {}),
    });
  });

  return router;
}

/**
 * Extrahiert identity-String aus req.identity (wie assistRefineRouter).
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
