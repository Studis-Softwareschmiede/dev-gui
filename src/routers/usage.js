/**
 * Router-Wrapper: Token-Nutzungs-Anzeige (Owner-Ko-Design 2026-07-03/05, S-Q14
 * "goldene Münze"). Factory-Signatur: create() → Express Router.
 * Montiert: GET /api/usage — Output-Token-Verbrauch der aktuellen 5h-Session
 * und der laufenden Woche, geschätzt aus den lokalen Claude-Session-Transcripts
 * via TokenUsageMeter (bereits vorhanden, night-budget-guard S-271).
 *
 * Bewusst NUR der Transcript-Schätzpfad (kein OAuth-Usage-Endpunkt-Abruf):
 * der inoffizielle Anthropic-Endpunkt ist außerhalb dieser Session nicht
 * zuverlässig/dokumentiert verifizierbar — ein Fehlgriff dort wäre teurer
 * (Token-/Zeitkosten für Trial-and-Error) als der Nutzen des exakten
 * Prozentwerts. Diese Route liefert deshalb ausschließlich `estimated: true`
 * mit rohen Token-Zahlen; keine %/Reset-Zeit-Behauptung. Nachrüstbar als
 * Folge-Story, sobald der Endpunkt-Vertrag bewusst verifiziert wurde.
 */
import { Router } from 'express';
import { TokenUsageMeter } from '../TokenUsageMeter.js';

export const order = 400;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function create() {
  const router = Router();
  const meter = new TokenUsageMeter();

  router.get('/api/usage', async (_req, res) => {
    const now = Date.now();
    const [session, week] = await Promise.all([
      meter.getUsage({ sinceMs: now - FIVE_HOURS_MS }),
      meter.getUsage({ sinceMs: now - SEVEN_DAYS_MS }),
    ]);
    res.status(200).json({
      estimated: true,
      generatedAt: new Date(now).toISOString(),
      session: { outputTokens: session.outputTokens, windowHours: 5 },
      week: { outputTokens: week.outputTokens, windowDays: 7 },
    });
  });

  return router;
}
