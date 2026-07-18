/**
 * AnthropicUsageClient — einziger Ort, der den inoffiziellen Anthropic-Usage-Endpunkt
 * kennt (isolierte Bruchstelle, docs/specs/usage-official-values.md AC7).
 *
 * Ruft `GET https://api.anthropic.com/api/oauth/usage` mit dem Abo-OAuth-Token ab
 * und bildet das reale (NICHT vertraglich fixierte) Upstream-Payload defensiv auf
 * das interne Antwort-Modell ab (Vertrag der Spec, Abschnitt "Verträge").
 *
 * Schema-Herkunft (2026-07-18, best-effort — kein offizieller Vertrag):
 *   - Pfad + Host `api.anthropic.com/api/oauth/usage` sowie die Fenster-Schlüssel
 *     `five_hour` / `seven_day` / `seven_day_<model>` (z.B. `seven_day_opus`,
 *     `seven_day_sonnet`) wurden per `strings` gegen die lokal installierte
 *     `@anthropic-ai/claude-code`-Binary verifiziert (String-Literale
 *     "fetchUtilization: GET /api/oauth/usage", "five_hour", "seven_day_opus", …).
 *   - Die genauen Feldnamen JE Fenster (`utilization` vs. `used_percentage`,
 *     `resets_at` als Unix-Epoch-Sekunden) sind NICHT gegen einen echten
 *     HTTP-Response verifiziert — der Adapter probiert defensiv mehrere
 *     Kandidaten-Feldnamen und degradiert pro Fenster, wenn nichts Brauchbares
 *     dabei ist (AC7). Ändert Anthropic das Schema, bricht höchstens dieser
 *     Adapter — nie die Route (Fallback auf `estimated`).
 *
 * Sicherheit (AC8, Floor): der Token-Wert wird NIE geloggt, NIE in eine
 * Fehlermeldung eingebettet und ausschließlich als Authorization-Header
 * verwendet. Ziel-Host ist fest verdrahtet (keine Nutzer-Eingabe/SSRF).
 *
 * @module AnthropicUsageClient
 */

/** Fester Ziel-Host + Pfad (kein konfigurierbarer/Nutzer-Input, security/Floor). */
export const ANTHROPIC_USAGE_HOST = 'https://api.anthropic.com';
export const ANTHROPIC_USAGE_PATH = '/api/oauth/usage';

/** Beschränktes Timeout gegen hängende Upstream-Aufrufe (AC5/NFR Resilienz). */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch mit Timeout via AbortController. Wirft bei Timeout/Netzfehler (vom
 * Aufrufer abzufangen) — wird nie ungefangen bis zur Route durchgereicht.
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
 * Ruft den Anthropic-Usage-Endpunkt ab und liefert zusätzlich den rohen
 * HTTP-Status (anthropic-oauth-vault AC5/AC7: der Aufrufer muss 401/403 von
 * anderen Fehlern unterscheiden können, um GENAU EINEN Token-Refresh
 * auszulösen — reines `null` wie bei `fetchAnthropicUsage` würde das verwischen).
 * Wirft NIE (AC5/AC7).
 *
 * @param {object} opts
 * @param {string|undefined|null} opts.token - Abo-OAuth-Token (Bearer). Fehlt/leer → kein Abruf-Versuch.
 * @param {typeof fetch} [opts.fetchFn] - Injectable fetch (Tests). Default: fetch mit Timeout-Wrapper.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ status: number|null, raw: object|null }>} `status: null` bedeutet
 *   Netzfehler/Timeout/fehlendes Token (kein HTTP-Response vorhanden).
 */
export async function fetchAnthropicUsageDetailed({ token, fetchFn, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!token) return { status: null, raw: null }; // kein leerer Header-Versuch (Edge-Case, AC5)

  const doFetch = fetchFn ?? ((url, init) => fetchWithTimeout(url, init, timeoutMs));
  const url = `${ANTHROPIC_USAGE_HOST}${ANTHROPIC_USAGE_PATH}`;

  let res;
  try {
    res = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return { status: null, raw: null }; // Netzfehler/Timeout → Fallback (AC5)
  }

  if (!res) return { status: null, raw: null };
  if (res.status >= 400) return { status: res.status, raw: null }; // 401/403/5xx → Fallback (AC5)

  try {
    return { status: res.status, raw: await res.json() };
  } catch {
    return { status: res.status, raw: null }; // kein parsebares JSON → Fallback (AC7)
  }
}

/**
 * Ruft den Anthropic-Usage-Endpunkt ab. Liefert das rohe, ungeprüfte JSON-Payload
 * bei HTTP 2xx, sonst `null` (kein Auth-Token, Netzfehler, Timeout, HTTP ≥ 400,
 * kein parsebares JSON) — wirft NIE (AC5/AC7).
 *
 * Dünner Wrapper um `fetchAnthropicUsageDetailed()` (verwirft den Status) —
 * unveränderter Vertrag/Bestandsverhalten für bestehende Konsumenten.
 *
 * @param {object} opts
 * @param {string|undefined|null} opts.token - Abo-OAuth-Token (Bearer). Fehlt/leer → kein Abruf-Versuch.
 * @param {typeof fetch} [opts.fetchFn] - Injectable fetch (Tests). Default: fetch mit Timeout-Wrapper.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>}
 */
export async function fetchAnthropicUsage(opts) {
  const { raw } = await fetchAnthropicUsageDetailed(opts);
  return raw;
}

/**
 * Extrahiert die erste finite Zahl aus den übergebenen Kandidaten (defensiv,
 * unbekannte/abweichende Upstream-Feldnamen je Fenster).
 * @param {...*} candidates
 * @returns {number|null}
 */
function firstFiniteNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Normalisiert einen Prozentwert: manche Upstream-Varianten liefern eine
 * Utilization als Bruch (0..1), andere bereits als Prozent (0..100). Werte
 * ≤ 1 werden als Bruch interpretiert und *100 skaliert; das Ergebnis wird auf
 * [0, 100] geklemmt (defensiv gegen kaputte Upstream-Werte).
 * @param {number} value
 * @returns {number}
 */
function normalizePercent(value) {
  const scaled = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, scaled));
}

/**
 * Mappt einen Reset-Zeitpunkt auf ISO-8601. Akzeptiert Unix-Epoch-Sekunden,
 * Unix-Epoch-Millisekunden (Heuristik: Werte > 1e12 gelten als ms) oder einen
 * bereits parsebaren Datums-String. Nicht parsebar → `null` (Fenster degradiert).
 * @param {number|string|undefined|null} value
 * @returns {string|null}
 */
function mapResetAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Mappt ein einzelnes Fenster-Objekt (`five_hour`/`seven_day`/`seven_day_<model>`)
 * auf `{ percentUsed, resetAt }`. Fehlt eine der beiden Kandidaten-Gruppen oder
 * ist der Wert kein brauchbarer Typ, liefert die Funktion `null` — das Fenster
 * fehlt dann in der Antwort (AC7, Edge-Case "Teil-Payload").
 * @param {*} window
 * @returns {{ percentUsed: number, resetAt: string }|null}
 */
function mapWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const rawPercent = firstFiniteNumber(
    window.utilization,
    window.used_percentage,
    window.percent,
    window.percentUsed
  );
  if (rawPercent === null) return null;
  const resetAt = mapResetAt(window.resets_at ?? window.resetAt ?? window.reset_at);
  if (resetAt === null) return null;
  return { percentUsed: normalizePercent(rawPercent), resetAt };
}

/** Bekannte non-Fenster-Flags unter `seven_day_*`, die niemals ein Modell sind. */
const SEVEN_DAY_NON_MODEL_SUFFIXES = new Set(['overage_included']);

/**
 * Bildet das rohe Upstream-Payload defensiv auf das interne Antwort-Modell ab
 * (Spec "Verträge"). Liefert `null`, wenn NICHTS Brauchbares im Payload steckt
 * (weder Session- noch Wochenfenster) — der Aufrufer degradiert dann auf den
 * `estimated`-Fallback (AC7).
 *
 * Wirft nie.
 *
 * @param {*} raw - Rohes JSON-Payload des Upstream-Endpunkts.
 * @param {{ now?: Date }} [opts]
 * @returns {{ source: 'official', generatedAt: string, session?: object, week?: object, spend?: * }|null}
 */
export function mapAnthropicUsagePayload(raw, { now = new Date() } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const session = mapWindow(raw.five_hour);
  const allModels = mapWindow(raw.seven_day);

  const perModel = [];
  for (const [key, value] of Object.entries(raw)) {
    const match = /^seven_day_(.+)$/.exec(key);
    if (!match) continue;
    const model = match[1];
    if (SEVEN_DAY_NON_MODEL_SUFFIXES.has(model)) continue;
    const mapped = mapWindow(value);
    if (mapped) perModel.push({ model, ...mapped });
  }

  const hasWeek = allModels !== null || perModel.length > 0;
  if (!session && !hasWeek) return null; // nichts Brauchbares → Fallback (AC7)

  const result = { source: 'official', generatedAt: now.toISOString() };
  if (session) result.session = session;
  if (hasWeek) {
    result.week = {};
    if (allModels) result.week.allModels = allModels;
    if (perModel.length > 0) result.week.perModel = perModel;
  }

  const spend = raw.spend;
  if (spend !== undefined && spend !== null) result.spend = spend; // nur falls vorhanden (AC4)

  return result;
}
