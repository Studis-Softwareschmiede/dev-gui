/**
 * BoardEventHub.js — In-process Pub/Sub für SSE-Verbindungen (board-live-sse AC1–AC7)
 *
 * Verwaltet die Menge der offenen SSE-Verbindungen und sendet Invalidierungs-Events
 * via Server-Sent-Events. Der Hub hält KEINEN Board-Zustand — nur offene Connections.
 *
 * Heartbeat: periodisch (Richtwert ~25 s) einen SSE-Kommentar-Frame
 * (`: ping\n\n`) an jede Verbindung senden, um Proxy-Idle-Timeouts zu vermeiden.
 *
 * Cleanup: bei Request-`close` oder Schreibfehler die Verbindung
 * aus dem Set entfernen (best-effort).
 *
 * @module BoardEventHub
 */

/**
 * In-process Pub/Sub für SSE-Invalidierungs-Events.
 *
 * Invarianten:
 *   - Der Hub hält nur Verbindungen, keine Board-Daten.
 *   - `subscribe(res)` registriert; `broadcast({ slug })` sendet an alle.
 *   - Broadcast und Cleanup sind idempotent und best-effort.
 *   - Heartbeat läuft bei Bedarf (mind. eine Verbindung offen).
 */
export class BoardEventHub {
  constructor() {
    /**
     * Set von offenen Response-Objekten (Express res).
     * @type {Set<any>}
     */
    this.connections = new Set();

    /**
     * Heartbeat-Interval-ID (null wenn inaktiv).
     * @type {NodeJS.Timeout|null}
     */
    this.heartbeatTimer = null;

    /**
     * Heartbeat-Intervall in Millisekunden (< 100 s, Richtwert ~25 s).
     * @type {number}
     */
    this.HEARTBEAT_INTERVAL_MS = 25000; // 25 Sekunden
  }

  /**
   * Registriert eine SSE-Response und gibt eine Unsubscribe-Funktion zurück.
   *
   * AC3: Der Hub registriert die Verbindung; AC5: cleanup bei Request-`close`.
   *
   * @param {any} res — Express Response-Objekt (SSE-Connection)
   * @returns {() => void} — Unsubscribe-Funktion (entfernt die Verbindung)
   */
  subscribe(res) {
    this.connections.add(res);

    // Cleanup: wenn der Client die Verbindung schließt
    const closeHandler = () => {
      this.connections.delete(res);
      this._ensureHeartbeatTimer();
    };

    res.on('close', closeHandler);

    // Heartbeat starten, falls noch nicht aktiv
    this._ensureHeartbeatTimer();

    // Unsubscribe-Funktion zurückgeben (AC3)
    return () => {
      res.removeListener('close', closeHandler);
      this.connections.delete(res);
      this._ensureHeartbeatTimer();
    };
  }

  /**
   * Broadcast eines Invalidierungs-Events an alle offenen Verbindungen.
   *
   * AC4: Format `data: {"slug":"<slug>"}\n\n` (Standard-Event-Typ, EventSource-kompatibel).
   * AC5: Schreibfehler fangen, betroffene Verbindung entfernen, kein Crash.
   *
   * @param {{ slug: string }} payload — Invalidierungs-Signal mit Projekt-Slug
   */
  broadcast(payload) {
    if (!payload || typeof payload.slug !== 'string') {
      // Ungültiger Payload ignorieren — best-effort, kein Error
      return;
    }

    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const deadConnections = [];

    for (const res of this.connections) {
      try {
        res.write(frame);
      } catch {
        // AC5: Schreibfehler → Verbindung merken für Cleanup
        deadConnections.push(res);
      }
    }

    // Tote Verbindungen entfernen
    for (const res of deadConnections) {
      this.connections.delete(res);
    }

    // Heartbeat anpassen (ggf. stoppen, wenn alle Verbindungen weg)
    this._ensureHeartbeatTimer();
  }

  /**
   * Sendet einen Heartbeat-Kommentar-Frame an alle Verbindungen.
   *
   * AC6: Kommentar-Frame (kein `data:`) — wird clientseitig ignoriert,
   * löst keinen Re-Fetch aus.
   *
   * @private
   */
  _sendHeartbeat() {
    const heartbeatFrame = ': ping\n\n';
    const deadConnections = [];

    for (const res of this.connections) {
      try {
        res.write(heartbeatFrame);
      } catch {
        // Fehler → Verbindung zum Löschen merken
        deadConnections.push(res);
      }
    }

    // Tote Verbindungen entfernen
    for (const res of deadConnections) {
      this.connections.delete(res);
    }

    // Timer erneut evaluieren (ggf. stoppen, wenn keine Verbindungen mehr)
    this._ensureHeartbeatTimer();
  }

  /**
   * Stellt sicher, dass der Heartbeat-Timer läuft, wenn Verbindungen offen sind,
   * und stoppt ihn, wenn keine Verbindungen mehr existieren.
   *
   * @private
   */
  _ensureHeartbeatTimer() {
    if (this.connections.size > 0) {
      // Verbindungen offen → Timer sicherstellen
      if (this.heartbeatTimer === null) {
        this.heartbeatTimer = setInterval(() => {
          this._sendHeartbeat();
        }, this.HEARTBEAT_INTERVAL_MS);
      }
    } else {
      // Keine Verbindungen → Timer stoppen
      if (this.heartbeatTimer !== null) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }
  }

  /**
   * Cleanup: stellt sicher, dass alle Timer gestoppt sind (z.B. beim Server-Shutdown).
   *
   * @public
   */
  shutdown() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.connections.clear();
  }
}
