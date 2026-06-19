/**
 * NotifyService — serverseitiger ntfy-Versand-Service (S-182 AC4).
 *
 * Sendet eine Benachrichtigung via `POST <server>/<topic>` an einen ntfy-Server.
 * Unterstützt optionalen Bearer-Token für geschützte Topics (aus CredentialStore).
 *
 * Sicherheits-Invarianten (AC10 / security/R01):
 *   - Token erscheint NIEMALS in Logs.
 *   - Netz-/Non-2xx-Fehler werden strukturiert geloggt und NICHT nach außen geworfen.
 *   - Rückgabe: { ok: boolean, status?: number, error?: string }
 *
 * @module NotifyService
 */

/** Default-Timeout für ntfy-Requests in Millisekunden. */
const NTFY_TIMEOUT_MS = 10_000;

/**
 * Sendet eine ntfy-Benachrichtigung.
 *
 * @param {object} config - Notification-Konfiguration
 * @param {string} config.server - ntfy-Server-URL (z.B. "https://ntfy.sh")
 * @param {string} config.topic  - ntfy-Topic
 * @param {number} [config.priority] - ntfy-Priorität (1–5)
 * @param {string|null} [config.token] - Bearer-Token (optional, NIE geloggt)
 * @param {object} payload - Nachrichten-Payload
 * @param {string} payload.title   - Nachrichten-Titel (ntfy `Title`-Header)
 * @param {string} payload.message - Nachrichten-Text (HTTP-Body)
 * @param {string[]} [payload.tags] - ntfy-Tags (optionale Liste)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Timeout in ms (default: 10 000)
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function sendNotification(config, payload, options = {}) {
  const { server, topic, priority, token } = config;
  const { title, message, tags = [] } = payload;
  const timeoutMs = options.timeoutMs ?? NTFY_TIMEOUT_MS;

  // URL-Aufbau: <server>/<topic>
  // server enthält trailing slash? Normalisieren.
  const base = server.replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(topic)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Headers aufbauen — Token NIE in Logs oder Responses
    const headers = {
      'Title': title,
      'Content-Type': 'text/plain; charset=utf-8',
    };

    if (priority !== undefined && priority !== null) {
      headers['Priority'] = String(priority);
    }

    if (tags && tags.length > 0) {
      headers['Tags'] = tags.join(',');
    }

    if (token) {
      // AC10: Token nur im Authorization-Header, niemals geloggt
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: message,
      signal: controller.signal,
    });

    if (!res.ok) {
      // Non-2xx: strukturiert loggen (ohne Token), nicht werfen
      const errText = await res.text().catch(() => '');
      // AC10: Token NIEMALS loggen — URL enthält nur server+topic (kein Token)
      console.error(
        `[NotifyService] ntfy Non-2xx: ${res.status} ${res.statusText} url=${url} body=${errText.slice(0, 200)}`,
      );
      return { ok: false, status: res.status, error: `ntfy antwortete mit ${res.status}: ${res.statusText}` };
    }

    return { ok: true, status: res.status };
  } catch (err) {
    // Netzfehler / Timeout — strukturiert loggen, NICHT werfen (best-effort)
    const isAbort = err.name === 'AbortError';
    const errMsg = isAbort ? `Timeout nach ${timeoutMs}ms` : err.message;
    // AC10: Token NIE im Log — nur URL (ohne Credentials) und Fehlertext
    console.error(`[NotifyService] Netzfehler url=${url}: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timer);
  }
}
