/**
 * AnthropicOAuthClient — einziger Ort, der den Abo-OAuth-Token-Refresh-Endpunkt
 * kennt (isolierte Bruchstelle, docs/specs/anthropic-oauth-vault.md AC5/AC9,
 * Resolution R4 — Refresh-Endpunkt ist nicht als Vertrag fixiert).
 *
 * Schema-Herkunft (2026-07-18, per `strings` gegen die lokal installierte
 * `@anthropic-ai/claude-code`-Binary verifiziert — analog S-365/AnthropicUsageClient.js):
 *   - Host + Pfad + `client_id` sind Teil desselben literalen Default-Config-
 *     Objekts in der Binary (u.a. `TOKEN_URL:"https://platform.claude.com/v1/oauth/token"`,
 *     `CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"`, neben
 *     `CONSOLE_AUTHORIZE_URL`/`MANUAL_REDIRECT_URL` desselben Objekts — kein
 *     Nutzer-Input, fest verdrahteter Default).
 *   - Die Refresh-Funktion selbst (Minified-Source, Funktionsname `cLe` in der
 *     verifizierten Version) baut den Request als:
 *       `POST <TOKEN_URL>` mit `Content-Type: application/json` und Body
 *       `{ grant_type: "refresh_token", refresh_token, client_id, scope }`.
 *     Dieser Adapter übernimmt `grant_type`/`refresh_token`/`client_id`, LÄSST
 *     `scope` aber bewusst weg: RFC 6749 §6 definiert `scope` im Refresh-Request
 *     als OPTIONAL — fehlt es, gilt der ursprünglich gewährte Scope unverändert.
 *     Da dieser Adapter die beim ursprünglichen Login gewährten Scopes nicht
 *     kennt/speichert (die Spec speichert nur access_token/refresh_token/
 *     expires_at, keine Scope-Liste), ist Weglassen der RFC-konforme, defensive
 *     Weg — kein Risiko, versehentlich eine andere/engere Scope-Liste anzufordern
 *     als die des tatsächlich aktiven Tokens.
 *   - Response (2xx): `{ access_token, refresh_token?, expires_in }` (Sekunden).
 *     Fehlt ein rotiertes `refresh_token`, bleibt der gesendete `refresh_token`
 *     gültig (Binary-Verhalten: `refresh_token: u = e` — Fallback auf den
 *     gesendeten Wert; dieser Adapter bildet das identisch nach).
 *
 * Security (Floor, AC8/AC9): Token-Werte NIE geloggt/in Fehlermeldungen
 * eingebettet; Ziel-Host ist fest verdrahtet (kein Nutzer-Input, kein SSRF-
 * Vektor, keine neue Env-Variable).
 *
 * @module AnthropicOAuthClient
 */

/** Fester Ziel-Host + Pfad (kein konfigurierbarer/Nutzer-Input, security/Floor, AC9). */
export const ANTHROPIC_OAUTH_TOKEN_HOST = 'https://platform.claude.com';
export const ANTHROPIC_OAUTH_TOKEN_PATH = '/v1/oauth/token';

/** Claude Codes öffentlicher OAuth-Client (PKCE, kein Client-Secret) — Default in der Binary. */
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow — öffentliche PKCE-Client-ID (kein Secret, in jeder Claude-Code-Binary enthalten)

/** Beschränktes Timeout gegen hängende Refresh-Aufrufe (Edge-Case "Refresh-Timeout", Richtwert wie Usage-Fetch). */
const REFRESH_TIMEOUT_MS = 8000;

/**
 * Fetch mit Timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Erneuert das Abo-OAuth-Access-Token per `refresh_token` (AC5). Wirft NIE
 * (AC6/Resilienz) — jeder Fehlerfall (Netz/Timeout/HTTP≥400/kaputtes JSON/
 * fehlende Pflichtfelder) liefert `{ ok: false, reason }`.
 *
 * @param {object} opts
 * @param {string} opts.refreshToken - Der aktuell im Tresor hinterlegte refresh_token.
 * @param {typeof fetch} [opts.fetchFn] - Injectable fetch (Tests). Default: fetch mit Timeout-Wrapper.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<
 *   { ok: true, accessToken: string, refreshToken: string, expiresAt: number } |
 *   { ok: false, reason: 'invalid-input'|'network'|'http-error'|'invalid-response' }
 * >}
 */
export async function refreshAnthropicOAuthToken({ refreshToken, fetchFn, timeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    return { ok: false, reason: 'invalid-input' };
  }

  const doFetch = fetchFn ?? ((url, init) => fetchWithTimeout(url, init, timeoutMs));
  const url = `${ANTHROPIC_OAUTH_TOKEN_HOST}${ANTHROPIC_OAUTH_TOKEN_PATH}`;

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }),
    });
  } catch {
    return { ok: false, reason: 'network' }; // Netzfehler/Timeout → AC6
  }

  if (!res || res.status >= 400) return { ok: false, reason: 'http-error' }; // AC6

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: 'invalid-response' };
  }

  const accessToken = payload?.access_token;
  const expiresIn = payload?.expires_in;
  if (typeof accessToken !== 'string' || !accessToken
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return { ok: false, reason: 'invalid-response' };
  }

  // Binary-Verhalten: fehlt ein rotiertes refresh_token in der Antwort, bleibt
  // der gesendete refresh_token gültig (kein Verlust des Refresh-Vermögens).
  const newRefreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token
    ? payload.refresh_token
    : refreshToken;

  return {
    ok: true,
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}
