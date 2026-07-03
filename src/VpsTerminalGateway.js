/**
 * VpsTerminalGateway — WebSocket /ws/vps-terminal bridge (docs/specs/vps-ssh-terminal.md
 * AC5, AC6, AC9, S-263).
 *
 * Wires the WS-level Open-Handshake/message-protocol to the existing `SshPtyManager`
 * boundary (`src/SshPtyManager.js`, ADR-019, S-262) — this module owns NONE of the SSH
 * mechanics (key handling/host-key policy/cap/idle-timeout, all inside SshPtyManager);
 * it only translates the WS message protocol into `SshPtyManager.open()` calls and routes
 * output/state/error callbacks back onto the socket, plus enforces the audit-first
 * discipline for the privileged "open a session" action (AC9).
 *
 * Client → Server (docs/specs/vps-ssh-terminal.md Verträge):
 *   { type:"open",   provider:string, serverId:string, user:"root"|"alex" }  (einmalig, erste Nachricht)
 *   { type:"input",  data:string }
 *   { type:"resize", cols:int>0, rows:int>0 }
 * Server → Client:
 *   { type:"output", data:string }                              — byteweise, ANSI erhalten
 *   { type:"state",  state:"connecting"|"connected"|"disconnected" }
 *   { type:"error",  errorClass, reason }                        — geheimnisfrei (AC9/AC10)
 *
 * Unlike WsGateway (Claude-Terminal, broadcast-Muster [[terminal-bridge]]), jede WS-
 * Verbindung hier entspricht GENAU EINER SSH-Sitzung (AC5/AC7 — kein geteilter Broadcast,
 * kein Scrollback-Replay über mehrere Clients — Nicht-Ziel).
 *
 * Sicherheit (Floor, hart):
 *   - AC6: `user`/`provider`/`serverId` sind reine WS-Payload-Strings — die eigentliche
 *     User-Allowlist-Prüfung (`{root,alex}`), Ziel-Auflösung und Key-Vorhandensein-Prüfung
 *     laufen INNERHALB von `SshPtyManager.open()` (AC6-Vorgriff, S-262) — kein doppelter,
 *     abweichender Validierungspfad hier. Diese Gateway-Ebene validiert nur die
 *     WS-Nachrichtenform (Typen/Nicht-Leerheit) BEVOR überhaupt ein Audit-Eintrag/Open-
 *     Versuch entsteht — ein strukturell kaputtes `open` (fehlende/falsch typisierte
 *     Felder) erzeugt KEINEN Audit-Eintrag und KEINEN `SshPtyManager.open()`-Aufruf.
 *   - AC9: das Öffnen einer Sitzung ist AUDIT-FIRST — der Audit-Eintrag wird geschrieben,
 *     BEVOR `sshPtyManager.open()` (und damit potentiell ein `ssh`-Spawn) aufgerufen wird.
 *     Schlägt der Audit-Write fehl, wird `sshPtyManager.open()` NICHT aufgerufen (keine
 *     Sitzung) — analog zur AuditStore-Modul-Doku-Konvention ("audit write fails → command
 *     not executed"). Der Audit-Eintrag enthält KEIN Key-/Host-Secret (nur
 *     identity/provider/serverId/user/Zeit — die Zeit stammt aus `AuditStore.record()`
 *     selbst).
 *   - AC9 (Rollenschutz, `CRED_ADMIN_EMAILS`/ADR-007-Linie): NICHT hier geprüft — der
 *     Rollencheck läuft bereits VOR dem WS-Handshake im `createWsAccessGuard`-Upgrade-
 *     Interceptor (`postAuthCheck`-Option, `src/AccessGuard.js`) mittels der in diesem
 *     Modul exportierten `checkVpsTerminalAuthz()` — eine Verbindung, die hier ankommt,
 *     hat den Rollencheck bereits bestanden (server.js-Composition-Root).
 *   - Doppeltes `open` auf derselben WS → geheimnisfreier Fehler, KEIN zweiter
 *     `sshPtyManager.open()`-Aufruf (AC5/AC7 „jede WS = genau eine SSH-Sitzung").
 *   - `input`/`resize` VOR erfolgreichem `open` → ignoriert (kein Crash, keine Aktion).
 *
 * @module VpsTerminalGateway
 */

import { WebSocket } from 'ws';

/** Erlaubte Provider-IDs — nur für die WS-Nachrichtenform-Prüfung, sync mit vpsRouter.js. */
const KNOWN_PROVIDERS = ['hetzner', 'ionos', 'hostinger'];

export class VpsTerminalGateway {
  /** @type {import('ws').WebSocketServer} */
  #wss;

  /** @type {import('./SshPtyManager.js').SshPtyManager} */
  #sshPtyManager;

  /** @type {import('./AuditStore.js').AuditStore} */
  #auditStore;

  /**
   * @param {import('ws').WebSocketServer} wss - Pre-created WebSocketServer (noServer mode).
   * @param {import('./SshPtyManager.js').SshPtyManager} sshPtyManager
   * @param {object} deps
   * @param {import('./AuditStore.js').AuditStore} deps.auditStore
   */
  constructor(wss, sshPtyManager, { auditStore }) {
    if (!sshPtyManager || typeof sshPtyManager.open !== 'function') {
      throw new Error('[VpsTerminalGateway] sshPtyManager ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[VpsTerminalGateway] auditStore ist Pflicht');
    }
    this.#wss = wss;
    this.#sshPtyManager = sshPtyManager;
    this.#auditStore = auditStore;

    // Server-level error handler — prevents an unhandled 'error' from crashing the
    // process (analog WsGateway/coder.md Lesson 2026-05-26 „EventEmitter-Server-Level").
    this.#wss.on('error', (err) => {
      console.error('[VpsTerminalGateway] server error:', err.code ?? err.name);
    });

    this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
  }

  /**
   * Handles a new WS connection. Per-connection state: at most one SSH session.
   * @param {import('ws').WebSocket} ws
   * @param {import('http').IncomingMessage} req
   */
  #onConnection(ws, req) {
    ws.on('error', (err) => {
      console.error('[VpsTerminalGateway] socket error:', err.code ?? err.name);
    });

    const identity = req.identity ?? null;

    /** @type {{write:(d:string)=>void, resize:(c:number,r:number)=>void, close:()=>Promise<void>}|null} */
    let session = null;
    /** Set to true on the FIRST syntactically valid `open` message — a second `open` is rejected. */
    let openAttempted = false;
    /**
     * Set to true as soon as the WS 'close' event fires — checked in the pending
     * `sshPtyManager.open()`-Promise's `.then()` callback (race-fix, Review-Fund #S-263
     * Iteration 2): the WS-Close event can fire WHILE `open()` is still resolving (SSH-
     * Connect dauert bis zu 15s, `SSH_CONNECT_TIMEOUT_S`) — the close handler at that
     * point sees `session === null` (nichts zu schließen) and never fires again once
     * `open()` later resolves. Ohne diesen Flag bliebe die dann erst NACH dem WS-Close
     * entstehende Sitzung (ssh-PTY + transiente Key-Datei) bis zum Idle-Timeout offen
     * (verwaister Prozess/Key — verletzt den Edge-Case „WS bricht ab → kein verwaister
     * Prozess/Key").
     */
    let wsClosed = false;

    const send = (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };
    const sendError = (errorClass, reason) => send({ type: 'error', errorClass, reason });

    ws.on('close', () => {
      wsClosed = true;
      if (session) {
        // Best-effort — SshPtyManager.close() is idempotent + always cleans up
        // (kill + transient key-file removal), even if the socket vanished mid-close.
        session.close().catch((err) => {
          console.error('[VpsTerminalGateway] session close error:', err?.code ?? err?.message ?? 'unknown');
        });
      }
      // If open() is still pending, its own .then() callback (below) observes
      // `wsClosed === true` once it resolves and closes the just-opened session itself
      // — no session exists yet at THIS point in time to close here.
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // Malformed JSON — ignore (security/R02, analog WsGateway).
        return;
      }
      if (msg === null || typeof msg !== 'object') return;

      if (msg.type === 'open') {
        if (openAttempted) {
          // AC5/AC7: jede WS = genau eine SSH-Sitzung — doppeltes open ist ein Fehler,
          // kein zweiter sshPtyManager.open()-Aufruf.
          sendError('error', 'Sitzung bereits geöffnet');
          return;
        }

        const shape = validateOpenShape(msg);
        if (!shape.ok) {
          // Strukturell kaputtes open → kein Audit-Eintrag, kein Spawn-Versuch.
          sendError('error', shape.error);
          return;
        }

        // Erst AB HIER gilt "erste Nachricht" als verbraucht — jede weitere open()
        // auf dieser WS wird abgelehnt, unabhängig vom Ausgang dieses Versuchs.
        openAttempted = true;

        const { provider, serverId, user } = shape;

        // AC9: Audit-First — VOR jedem sshPtyManager.open()-Aufruf (der intern ggf.
        // spawnt). Schlägt der Audit-Write fehl → keine Sitzung (kein open()-Aufruf).
        const auditServerId = serverId.replace(/\//g, ':');
        try {
          this.#auditStore.record({
            identity: identity?.email ?? null,
            command: `vps:terminal:open:${provider}:${auditServerId}:${user}`,
          });
        } catch (auditErr) {
          console.error('[VpsTerminalGateway] Audit-Write fehlgeschlagen (open):', auditErr?.message ?? 'unknown');
          sendError('error', 'Audit-Write fehlgeschlagen — Sitzung abgebrochen');
          return;
        }

        // sshPtyManager.open() ist async; Ausgang kommt über die onState/onError-
        // Callbacks — hier nur den Rückgabewert (Session-Handle oder null) merken.
        this.#sshPtyManager
          .open({
            provider,
            serverId,
            user,
            onOutput: (data) => send({ type: 'output', data }),
            onState: (state) => send({ type: 'state', state }),
            onError: (errorClass, reason) => sendError(errorClass, reason),
          })
          .then((openedSession) => {
            if (!openedSession) {
              // openedSession === null → bereits via onError gemeldet, kein Session-Handle.
              return;
            }
            if (wsClosed) {
              // Race-Fix (Review-Fund #S-263 Iteration 2): die WS wurde WÄHREND open()
              // noch lief geschlossen — der 'close'-Handler sah zu dem Zeitpunkt
              // `session === null` und hat nichts geschlossen. Die soeben erst fertig
              // gewordene Sitzung sofort wieder schließen, statt sie zu behalten —
              // sonst bleibt der ssh-PTY + die transiente Key-Datei bis zum
              // Idle-Timeout verwaist.
              openedSession.close().catch((err) => {
                console.error(
                  '[VpsTerminalGateway] post-close session cleanup error:',
                  err?.code ?? err?.message ?? 'unknown',
                );
              });
              return;
            }
            session = openedSession;
          })
          .catch((err) => {
            console.error('[VpsTerminalGateway] open() unerwarteter Fehler:', err?.message ?? 'unknown');
            sendError('error', 'SSH-Sitzung konnte nicht gestartet werden');
          });
        return;
      }

      if (msg.type === 'input') {
        // AC5/Edge-Case: input vor erfolgreichem open → ignorieren (kein Crash).
        if (!session || typeof msg.data !== 'string') return;
        session.write(msg.data);
        return;
      }

      if (msg.type === 'resize') {
        // AC5/Edge-Case: resize vor erfolgreichem open → ignorieren.
        // Positive-Integer-Validierung ist bereits SshPtyManager-Session-intern (no-op bei
        // ungültigen Werten) — kein zweiter, abweichender Validierungspfad hier.
        if (!session) return;
        session.resize(msg.cols, msg.rows);
        return;
      }

      // Unbekannter type → ignorieren (security/R02, kein Crash).
    });
  }
}

// ── Hilfsfunktionen (module-private) ────────────────────────────────────────────

/**
 * Validiert die WS-Nachrichtenform eines `open`-Handshakes (reine Form-/Typ-Prüfung —
 * die eigentliche User-Allowlist/Ziel-Auflösung/Key-Prüfung läuft in SshPtyManager.open()).
 *
 * @param {object} msg
 * @returns {{ok: true, provider: string, serverId: string, user: string} | {ok: false, error: string}}
 */
function validateOpenShape(msg) {
  const provider = msg.provider;
  const serverId = msg.serverId;
  const user = msg.user;

  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider ist ein Pflichtfeld' };
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return { ok: false, error: 'Unbekannter Provider' };
  }
  if (typeof serverId !== 'string' || !serverId.trim()) {
    return { ok: false, error: 'serverId ist ein Pflichtfeld' };
  }
  if (typeof user !== 'string' || !user.trim()) {
    return { ok: false, error: 'user ist ein Pflichtfeld' };
  }

  return { ok: true, provider, serverId: serverId.trim(), user };
}

// ── Rollenschutz (AC9, CRED_ADMIN_EMAILS-Logik wie ADR-007) ─────────────────────
// Duplicated-by-convention (nicht geteilt) — analog vpsRouter.js/vpsContainerRouter.js/
// deploymentsRouter.js/sshKeysRouter.js `checkMutationAuthz` (coder.md-Konvention:
// jeder mutierende Endpunkt trägt seine eigene Kopie, kein geteiltes Authz-Modul).

/**
 * Prüft ob die anfragende Identität eine SSH-Terminal-Sitzung öffnen darf
 * (CRED_ADMIN_EMAILS-Logik, AC9/ADR-007). Wird vom Upgrade-Interceptor
 * (`createWsAccessGuard`s `postAuthCheck`, server.js) VOR dem WS-Handshake aufgerufen —
 * eine Ablehnung führt zu einem 403 auf HTTP-Ebene, bevor der Upgrade abgeschlossen wird.
 *
 * @param {{email?: string|null}|null} identity - req.identity (von AccessGuard gesetzt)
 * @returns {{ allowed: boolean }}
 */
export function checkVpsTerminalAuthz(identity) {
  const adminEmails = process.env.CRED_ADMIN_EMAILS;
  if (!adminEmails || !adminEmails.trim()) {
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
