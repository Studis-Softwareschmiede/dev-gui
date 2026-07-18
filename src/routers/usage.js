/**
 * Router-Wrapper: Token-Nutzungs-Anzeige (Owner-Ko-Design 2026-07-03/05, S-Q14
 * "goldene Münze"). Factory-Signatur: create(deps) → Express Router.
 * Montiert: GET /api/usage.
 *
 * Primärpfad (docs/specs/usage-official-values.md AC1–AC8, ADR-022; erweitert
 * um docs/specs/anthropic-oauth-vault.md AC3–AC7, S-367): ruft den offiziellen
 * Anthropic-Usage-Endpunkt ab (`src/AnthropicUsageClient.js` — einziger Ort,
 * der das Upstream-Schema kennt) und liefert `source: "official"` mit
 * Prozent-/Reset-/Spend-Werten (1:1 durchgereicht, keine eigene Berechnung).
 * Token-Auflösung (S-367 AC3): (a) Tresor-`access_token` aus dem CredentialStore
 * (gültig oder nach genau einem On-demand-Refresh via `refresh_token`,
 * `src/AnthropicOAuthClient.js`) → (b) Env-`CLAUDE_CODE_OAUTH_TOKEN` (Bestand)
 * → (c) Fallback-Kette.
 *
 * Fallback (AC5/AC9, unverändert aus usage-official-values): scheitert der
 * Abruf (Netz/Timeout/HTTP-Fehler) oder liefert der Adapter kein brauchbares
 * Payload (AC7), degradiert die Route auf den bestehenden `TokenUsageMeter`-
 * Schätzpfad (`source: "estimated"`, rohe Output-Token-Zahlen — heutiges
 * Verhalten, unverändert). Scheitert AUCH der Schätzpfad, antwortet die Route
 * ehrlich mit `source: "unavailable"` (AC6) — nie ein Crash, nie erfundene Zahlen.
 *
 * Security (AC8, Floor): OAuth-Token-Werte werden ausschließlich als ausgehender
 * Authorization-Header (Usage) bzw. Refresh-Request-Body verwendet — nie in
 * Code-Literalen, Logs, Audit oder im Antwort-Body. Kein Polling, höchstens
 * ein Refresh-Versuch je Request (S-367 AC7, kein Refresh-Loop).
 */
import { Router } from 'express';
import { TokenUsageMeter } from '../TokenUsageMeter.js';
import { fetchAnthropicUsageDetailed, mapAnthropicUsagePayload } from '../AnthropicUsageClient.js';
import { refreshAnthropicOAuthToken } from '../AnthropicOAuthClient.js';

export const order = 400;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sicherheitsspanne vor `expires_at`, ab der ein Tresor-Access-Token bereits als
 * abgelaufen gilt (anthropic-oauth-vault AC4, Resolution R6 — Richtwert 60s).
 */
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

/**
 * Schreibt einen secret-freien Audit-Eintrag für einen gescheiterten Refresh-
 * Versuch (anthropic-oauth-vault AC6). Best-effort — ein Audit-Fehler darf die
 * Route nie crashen lassen.
 * @param {import('../AuditStore.js').AuditStore} [auditStore]
 */
function auditRefreshFailure(auditStore) {
  if (!auditStore) return;
  try {
    auditStore.record({ identity: null, command: 'anthropic-oauth:token-refresh-failed' });
  } catch {
    // best-effort — kein Crash (AC6)
  }
}

/**
 * Mappt ein rohes Upstream-Payload defensiv; wirft nie (AC7).
 * @param {*} raw
 * @param {number} now
 * @returns {object|null}
 */
function safeMap(raw, now) {
  if (!raw) return null;
  try {
    return mapAnthropicUsagePayload(raw, { now: new Date(now) });
  } catch {
    return null;
  }
}

/**
 * Versucht den offiziellen Usage-Abruf über das Tresor-`access_token` (S-367
 * AC3–AC7). Liefert das gemappte `official`-Objekt oder `null` — dann ist der
 * Tresor-Pfad ausgeschöpft (kein Tresor-Token, Store gesperrt, Refresh
 * gescheitert oder Payload unbrauchbar) und der Aufrufer versucht (b) Env.
 *
 * Höchstens EIN Refresh-Versuch je Request (AC7): ausgelöst entweder VOR dem
 * ersten Abruf (Token bereits abgelaufen, AC4/AC5) oder NACH einem 401/403 auf
 * das noch gültige Token (AC5); ein erneutes 401/403 nach dem Refresh löst
 * keinen zweiten Versuch aus, sondern degradiert (AC7).
 *
 * @param {object} opts
 * @param {import('../CredentialStore.js').CredentialStore} [opts.credentialStore]
 * @param {import('../AuditStore.js').AuditStore} [opts.auditStore]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {number} opts.now
 * @returns {Promise<object|null>}
 */
async function tryVaultUsage({ credentialStore, auditStore, fetchFn, now }) {
  if (!credentialStore) return null;

  let vault;
  try {
    vault = await credentialStore.getAnthropicOAuthCredentials();
  } catch {
    return null; // Store gesperrt/Lesefehler (Edge-Case) → (b) Env-Fallback
  }
  if (!vault?.accessToken) return null;

  const isExpired = typeof vault.expiresAt !== 'number' || now >= vault.expiresAt - EXPIRY_SAFETY_MARGIN_MS;

  let refreshedOnce = false;
  const doRefresh = async () => {
    if (!vault.refreshToken || refreshedOnce) return null;
    refreshedOnce = true;
    const result = await refreshAnthropicOAuthToken({ refreshToken: vault.refreshToken, fetchFn });
    if (!result.ok) {
      auditRefreshFailure(auditStore);
      return null;
    }
    try {
      await credentialStore.setAnthropicOAuthCredentials({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });
    } catch {
      // Rückschreiben fehlgeschlagen — das frisch erhaltene Token trotzdem für
      // DIESEN Request nutzen (best-effort, kein Blockieren des Usage-Abrufs).
    }
    return result.accessToken;
  };

  // AC4: ein bereits als abgelaufen erkanntes Token wird NICHT direkt gesendet.
  const token = isExpired ? await doRefresh() : vault.accessToken;
  if (!token) return null; // kein Refresh möglich/erfolgreich → (b) Env-Fallback

  const first = await fetchAnthropicUsageDetailed({ token, fetchFn });
  const status = first.status;
  let raw = first.raw;

  // AC5/AC7: 401/403 auf ein (noch) nicht per Refresh erneuertes Token → genau
  // ein Refresh-Versuch, dann einmaliger Retry.
  if ((status === 401 || status === 403) && !refreshedOnce) {
    const refreshedToken = await doRefresh();
    if (refreshedToken) {
      ({ raw } = await fetchAnthropicUsageDetailed({ token: refreshedToken, fetchFn }));
    }
  }

  return safeMap(raw, now);
}

/**
 * Versucht den offiziellen Usage-Pfad (S-367 AC3: Tresor vor Env). Liefert das
 * gemappte `official`-Antwort-Objekt oder `null` (Fallback fällig) — wirft nie (AC7).
 * @param {{ credentialStore?: object, auditStore?: object, fetchFn?: typeof fetch, now: number }} opts
 * @returns {Promise<object|null>}
 */
async function tryOfficialUsage({ credentialStore, auditStore, fetchFn, now }) {
  const vaultResult = await tryVaultUsage({ credentialStore, auditStore, fetchFn, now });
  if (vaultResult) return vaultResult;

  // (b) Env-Token (Bestandsverhalten, AC12)
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!envToken) return null; // kein Abruf-Versuch mit leerem Header (Edge-Case, AC5)

  const { raw } = await fetchAnthropicUsageDetailed({ token: envToken, fetchFn });
  return safeMap(raw, now);
}

/**
 * @param {{ fetchFn?: typeof fetch, credentialStore?: import('../CredentialStore.js').CredentialStore, auditStore?: import('../AuditStore.js').AuditStore }} [deps]
 *   `fetchFn` injizierbar für Tests (Stub statt echtem HTTP-Call); Produktion
 *   nutzt den Default (globaler `fetch`). `credentialStore`/`auditStore` optional
 *   (fehlen sie, verhält sich die Route exakt wie vor S-367 — AC12).
 * @returns {import('express').Router}
 */
export function create({ fetchFn, credentialStore, auditStore } = {}) {
  const router = Router();
  const meter = new TokenUsageMeter();

  router.get('/api/usage', async (_req, res) => {
    const now = Date.now();

    const official = await tryOfficialUsage({ credentialStore, auditStore, fetchFn, now });
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
