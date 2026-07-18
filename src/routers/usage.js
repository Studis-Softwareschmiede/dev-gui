/**
 * Router-Wrapper: Token-Nutzungs-Anzeige (Owner-Ko-Design 2026-07-03/05, S-Q14
 * "goldene Münze"). Factory-Signatur: create(deps) → Express Router.
 * Montiert: GET /api/usage.
 *
 * Primärpfad (docs/specs/usage-official-values.md AC1–AC8, ADR-022): ruft bei
 * verfügbarem Abo-OAuth-Token (`CLAUDE_CODE_OAUTH_TOKEN`) den offiziellen
 * Anthropic-Usage-Endpunkt ab (`src/AnthropicUsageClient.js` — einziger Ort,
 * der das Upstream-Schema kennt) und liefert `source: "official"` mit
 * Prozent-/Reset-/Spend-Werten (1:1 durchgereicht, keine eigene Berechnung).
 *
 * Fallback (AC5/AC9): ist kein Token gesetzt, scheitert der Abruf (Netz/Timeout/
 * HTTP-Fehler) oder liefert der Adapter kein brauchbares Payload (AC7),
 * degradiert die Route auf den bestehenden `TokenUsageMeter`-Schätzpfad
 * (`source: "estimated"`, rohe Output-Token-Zahlen — heutiges Verhalten,
 * unverändert). Scheitert AUCH der Schätzpfad, antwortet die Route ehrlich
 * mit `source: "unavailable"` (AC6) — nie ein Crash, nie erfundene Zahlen.
 *
 * Security (AC8, Floor): das OAuth-Token wird ausschließlich als ausgehender
 * Authorization-Header verwendet — nie in Code-Literalen, Logs, Audit oder
 * im Antwort-Body. Kein Polling, ein Upstream-Aufruf je Request.
 */
import { Router } from 'express';
import { TokenUsageMeter } from '../TokenUsageMeter.js';
import { fetchAnthropicUsage, mapAnthropicUsagePayload } from '../AnthropicUsageClient.js';

export const order = 400;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Versucht den offiziellen Usage-Pfad. Liefert das gemappte `official`-Antwort-
 * Objekt oder `null` (Fallback fällig) — wirft nie (AC7).
 * @param {{ fetchFn?: typeof fetch, now: number }} opts
 * @returns {Promise<object|null>}
 */
async function tryOfficialUsage({ fetchFn, now }) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null; // kein Abruf-Versuch mit leerem Header (Edge-Case, AC5)

  let raw;
  try {
    raw = await fetchAnthropicUsage({ token, fetchFn });
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    return mapAnthropicUsagePayload(raw, { now: new Date(now) });
  } catch {
    return null; // Adapter-Fehler darf die Route nie werfen lassen (AC7)
  }
}

/**
 * @param {{ fetchFn?: typeof fetch }} [deps] - `fetchFn` injizierbar für Tests
 *   (Stub statt echtem HTTP-Call); Produktion nutzt den Default (globaler `fetch`).
 * @returns {import('express').Router}
 */
export function create({ fetchFn } = {}) {
  const router = Router();
  const meter = new TokenUsageMeter();

  router.get('/api/usage', async (_req, res) => {
    const now = Date.now();

    const official = await tryOfficialUsage({ fetchFn, now });
    if (official) {
      res.status(200).json(official);
      return;
    }

    try {
      const [session, week] = await Promise.all([
        meter.getUsage({ sinceMs: now - FIVE_HOURS_MS }),
        meter.getUsage({ sinceMs: now - SEVEN_DAYS_MS }),
      ]);
      res.status(200).json({
        source: 'estimated',
        generatedAt: new Date(now).toISOString(),
        session: { outputTokens: session.outputTokens, windowHours: 5 },
        week: { outputTokens: week.outputTokens, windowDays: 7 },
      });
    } catch {
      res.status(200).json({ source: 'unavailable', generatedAt: new Date(now).toISOString() });
    }
  });

  return router;
}
