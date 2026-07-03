/**
 * vpsContainerRouter — Express-Router für Container-Übersicht + Aktionen pro VPS.
 *
 * Implements: vps-container-overview AC8–AC12
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/vps/machines/:provider/*splat/containers
 *             → { result:'ok', containers: ContainerEntry[] } | { result:'error', errorClass, reason }
 *             [read-only, hinter Access ohne Rollencheck]
 *   GET    /api/vps/machines/:provider/*splat/containers/:containerId/logs?tail=N
 *             → { result:'ok', lines: string[] } | { result:'error', errorClass, reason }
 *             [read-only, hinter Access ohne Rollencheck]
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/start
 *             → { result:'ok'|'error', reason?, errorClass? }   [MUTATION — Rollenschutz + Audit-First]
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/stop
 *             → { result, reason?, errorClass? }               [MUTATION]
 *   POST   /api/vps/machines/:provider/*splat/containers/:containerId/restart
 *             → { result, reason?, errorClass? }               [MUTATION]
 *   DELETE /api/vps/machines/:provider/*splat/containers/:containerId
 *             Body: { confirm: "<hostname-oder-name>" }
 *             → { result:'ok'|'error', reason?, errorClass? }  [MUTATION]
 *             Managed → DeployOrchestrator.undeploy (Route+DNS+Container, LockoutGuard)
 *             Unmanaged → VpsDockerControl.rm
 *             Protected → 422 protected-resource
 *             Fehlender/falscher confirm → 422 confirmation-required
 *
 * ServerId-Routing (IONOS composite IDs):
 *   Express 5 *splat captures path-segments between :provider and /containers as array.
 *   Joined with "/" to reconstruct composite IDs (analog vpsRouter.js).
 *   containerId folgt NACH /containers/ als eigener :containerId-Parameter.
 *
 * VPS-Target-Auflösung:
 *   provider + serverId → SSH-Ziel { host, port, targetUser }.
 *   Registry.getMachineTarget(provider, serverId) liefert host+ipv4 aus Provider-API;
 *   targetUser + port aus vpsTargets-Map (VPS_TARGETS-Konvention, analog deploymentsRouter).
 *   Fallback: vpsTargets.values() nach host matchen.
 *
 * Security (AC12/AC13):
 *   - Alle Endpunkte hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (start/stop/restart/remove) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie ADR-007/vpsRouter).
 *   - Audit-First: Audit-Eintrag VOR der Mutation; Audit-Fail → Aktion unterbleibt.
 *   - SSH-Private-Key + Cloudflare-Token erscheinen NIEMALS in Response/Log/Audit/URL.
 *   - Container-ID-Validierung + Shell-Escaping via VpsDockerControl (AC9).
 *   - managed-Remove mit LockoutGuard-Hard-Block (via DeployOrchestrator.undeploy).
 *
 * @module vpsContainerRouter
 */

import { Router } from 'express';
import { LockoutGuard } from './cloudflare/LockoutGuard.js';

/** Erlaubte Provider-IDs (sync mit vpsRouter.js). */
const KNOWN_PROVIDERS = ['hetzner', 'ionos', 'hostinger'];

/** Max Länge für serverId (sync mit vpsRouter.js). */
const MAX_SERVER_ID_LEN = 128;

/** Max tail-Zeilen für Logs. */
const MAX_LOG_TAIL = 1000;

/** Default tail-Zeilen. */
const DEFAULT_LOG_TAIL = 100;

// ── Authz-Helper (gleiche Logik wie vpsRouter / deploymentsRouter) ─────────────

/**
 * Prüft ob die anfragende Identität mutieren darf (CRED_ADMIN_EMAILS-Logik, AC12).
 *
 * @param {object|null} identity - req.identity from AccessGuard
 * @returns {{ allowed: boolean }}
 */
function checkMutationAuthz(identity) {
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

// ── Input-Validierung ─────────────────────────────────────────────────────────

/**
 * Validiert einen Provider-Param (security/R02).
 * @param {unknown} provider
 * @returns {{ ok: boolean, error?: string }}
 */
function validateProvider(provider) {
  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider ist ein Pflichtfeld' };
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Unbekannter Provider: ${provider}` };
  }
  return { ok: true };
}

/**
 * Validiert eine serverId (security/R02/R03).
 * Slashes sind für IONOS composite IDs erlaubt; ".." ist verboten.
 *
 * @param {unknown} serverId
 * @returns {{ ok: boolean, error?: string }}
 */
function validateServerId(serverId) {
  if (typeof serverId !== 'string' || !serverId.trim()) {
    return { ok: false, error: 'serverId ist ein Pflichtfeld' };
  }
  const s = serverId.trim();
  if (s.length > MAX_SERVER_ID_LEN) {
    return { ok: false, error: 'serverId überschreitet Längenlimit' };
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(s)) {
    return { ok: false, error: 'serverId enthält ungültige Zeichen' };
  }
  if (/\.\./.test(s)) {
    return { ok: false, error: 'serverId enthält ungültige Zeichen' };
  }
  return { ok: true };
}

/**
 * Validiert eine containerId (security/R02).
 * Nur alphanumerische Zeichen, Unterstriche und Bindestriche erlaubt.
 *
 * @param {unknown} containerId
 * @returns {{ ok: boolean, error?: string }}
 */
function validateContainerId(containerId) {
  if (typeof containerId !== 'string' || !containerId.trim()) {
    return { ok: false, error: 'containerId ist ein Pflichtfeld' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(containerId.trim())) {
    return { ok: false, error: 'containerId enthält ungültige Zeichen' };
  }
  return { ok: true };
}

/**
 * Extrahiert und validiert die ServerId aus dem *splat-Param (Express 5).
 * IONOS composite IDs ("<datacenterId>/<serverId>") werden via Array-Join rekonstruiert.
 *
 * @param {string|string[]} splatRaw - req.params.splat
 * @returns {{ ok: true, serverId: string } | { ok: false, error: string }}
 */
function extractServerId(splatRaw) {
  const rawServerId = Array.isArray(splatRaw) ? splatRaw.join('/') : String(splatRaw ?? '');
  const val = validateServerId(rawServerId);
  if (!val.ok) return { ok: false, error: val.error };
  return { ok: true, serverId: rawServerId.trim() };
}

/**
 * Entfernt Token-ähnliche Muster aus Fehlermeldungen (security/R01).
 * @param {string} msg
 * @returns {string}
 */
function sanitizeMsg(msg) {
  if (typeof msg !== 'string') return 'unbekannter Fehler';
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 200);
}

// ── VPS-Target-Auflösung ─────────────────────────────────────────────────────

/**
 * Löst das SSH-Ziel { host, port, targetUser } für ein provider+serverId-Paar auf.
 *
 * Strategie (drei Quellen, S-167 AC4):
 *   1. Dynamische Quelle: vpsRegistry.listTargetRecords() → exakter {provider, serverId}-Match.
 *      Ist host null/veraltet, wird er über getMachineIp aufgefrischt.
 *      Env-Eintrag (falls vorhanden) hat Vorrang vor dem dynamischen Datensatz.
 *   2. Env-Quelle (vpsTargets): vpsRegistry.getMachineIp(provider, serverId) → IPv4;
 *      matcht gegen vpsTargets-Hosts.
 *   3. Fallback: erster vpsTargets-Eintrag (Single-VPS-Setup).
 *
 * Rückgabe: null nur wenn weder dynamisch noch Env ein Ziel ergibt (AC4 garantiert
 * non-null für rein-dynamischen VPS bei leerem vpsTargets).
 *
 * Security: kein SSH-Key/Token erscheint in der Rückgabe (nur host/port/targetUser).
 *
 * @param {string} provider
 * @param {string} serverId
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry} vpsRegistry
 * @param {Map<string, { host: string, port?: number, targetUser: string }>} vpsTargets
 * @returns {Promise<{ host: string, port: number, targetUser: string } | null>}
 */
// Exportiert (statt module-private): SshPtyManager (vps-ssh-terminal AC7/AC8/AC10, S-262)
// nutzt dieselbe Auflösung als injizierten `resolveTarget`-Adapter (server.js-Wiring) —
// keine zweite Ziel-Auflösungs-Wahrheit (docs/specs/vps-dynamic-ssh-targets.md).
export async function resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets) {
  // ── 1. Dynamische Quelle: exakter {provider, serverId}-Match (S-167 AC4) ──
  // Suche zuerst im persistierten Target-Record-Speicher.
  // Env-Override: wenn vpsTargets einen Eintrag mit passender IP enthält, gewinnt die Env.
  let dynamicTarget = null;
  if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
    try {
      const records = await vpsRegistry.listTargetRecords();
      const match = records.find(
        (r) => r.provider === provider && String(r.serverId) === String(serverId),
      );
      if (match) {
        // Host aus Record; bei null/leer über getMachineIp auffrischen (AC2/AC4)
        let host = match.host ?? null;
        if (!host && typeof vpsRegistry.getMachineIp === 'function') {
          try {
            host = await vpsRegistry.getMachineIp(provider, serverId);
          } catch {
            // Degradierend — kein Host via Provider-API
          }
        }
        if (host) {
          dynamicTarget = { host, port: match.port ?? 22, targetUser: match.targetUser ?? 'root' };
        }
      }
    } catch {
      // Degradierend — dynamische Auflösung nicht kritisch; fällt auf Env-Strategie zurück
    }
  }

  // ── 2. Env-Quelle (vpsTargets) mit IP-Match (bestehende Strategie) ──
  // Versuche Machine-IP über Registry (Provider-API) für Env-Host-Match
  let machineIp = null;
  if (vpsRegistry && typeof vpsRegistry.getMachineIp === 'function') {
    try {
      machineIp = await vpsRegistry.getMachineIp(provider, serverId);
    } catch {
      // Degradierend — IP-Auflösung nicht kritisch; fällt auf Host-Match-Strategie zurück
    }
  }

  // Mit Machine-IP: exakter Treffer in vpsTargets (Env)
  if (machineIp) {
    for (const target of vpsTargets.values()) {
      if (target.host === machineIp) {
        // Env-Treffer gewinnt über dynamischen Datensatz (Override, Spec §Vereinigungs-Regel)
        return { host: target.host, port: target.port ?? 22, targetUser: target.targetUser };
      }
    }
  }

  // Env hatte keinen IP-Match → dynamischer Datensatz (falls vorhanden) greift jetzt
  if (dynamicTarget) {
    return dynamicTarget;
  }

  // ── 3. Fallback: erster vpsTargets-Eintrag (Single-VPS-Setup) ──
  // Nur wenn vpsTargets nicht leer ist (bestehende Semantik erhalten).
  const first = vpsTargets.values().next().value;
  if (first) {
    return { host: first.host, port: first.port ?? 22, targetUser: first.targetUser };
  }

  return null;
}

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * Erstellt den Container-Router.
 *
 * @param {object} opts
 * @param {import('./deploy/VpsDockerControl.js').VpsDockerControl}     opts.vpsDockerControl
 * @param {import('./deploy/DeployOrchestrator.js').DeployOrchestrator} opts.deployOrchestrator
 * @param {import('./AuditStore.js').AuditStore}                         opts.auditStore
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry}  opts.vpsRegistry
 * @param {Map<string, { host: string, port?: number, targetUser: string }>} opts.vpsTargets
 * @param {import('./cloudflare/LockoutGuard.js').LockoutGuard}         [opts.lockoutGuard]
 * @returns {import('express').Router}
 */
export function vpsContainerRouter({ vpsDockerControl, deployOrchestrator, auditStore, vpsRegistry, vpsTargets, lockoutGuard }) {
  // AC11: LockoutGuard — instanziieren wenn nicht injiziert (nutzt DEVGUI_HOSTNAME aus env)
  const guard = lockoutGuard ?? new LockoutGuard();
  const router = Router();

  // ── GET /api/vps/machines/:provider/*splat/containers ──────────────────────

  /**
   * GET /api/vps/machines/:provider/*splat/containers
   * Container-Listing via VpsDockerControl.psAll (managed + unmanaged).
   * Read-only — kein Rollencheck, hinter Access.
   *
   * Responses:
   *   200 { result:'ok', containers: ContainerEntry[] }
   *   200 { result:'error', errorClass, reason }  — SSH/Docker-Fehler (degradierend)
   *   422 { error }  — Validierungsfehler
   */
  router.get('/api/vps/machines/:provider/*splat/containers', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(422).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.json({ result: 'error', errorClass: 'no-target', reason: 'VPS-Ziel nicht konfiguriert' });
    }

    const result = await vpsDockerControl.psAll(vpsTarget);
    if (result.result !== 'ok') {
      return res.json({ result: 'error', errorClass: result.errorClass ?? 'error', reason: result.reason ?? 'Container-Listing fehlgeschlagen' });
    }

    // ContainerEntry-Mapping (Spec §64): managed === (hostname !== null)
    const containers = (result.containers ?? []).map((c) => ({
      containerId: c.containerId,
      name: c.name ?? c.containerId, // I1: lesbarer Container-Name aus {{.Names}}, Fallback auf ID
      image: c.image,
      hostname: c.hostname,
      status: c.status,
      hostPort: c.hostPort,
      managed: c.hostname !== null,
    }));

    return res.json({ result: 'ok', containers });
  });

  // ── GET /api/vps/machines/:provider/*splat/containers/:containerId/logs ────

  /**
   * GET /api/vps/machines/:provider/*splat/containers/:containerId/logs?tail=N
   * Liest die letzten N Zeilen Container-Logs read-only.
   * Kein Secret-Leak (SSH-Key/Token erscheint NICHT in der Antwort — AC13).
   *
   * Responses:
   *   200 { result:'ok', lines: string[] }
   *   200 { result:'error', errorClass, reason }
   *   422 { error }
   */
  router.get('/api/vps/machines/:provider/*splat/containers/:containerId/logs', async (req, res) => {
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(422).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    const containerIdVal = validateContainerId(req.params.containerId);
    if (!containerIdVal.ok) {
      return res.status(422).json({ error: containerIdVal.error });
    }
    const containerId = req.params.containerId.trim();

    const tailRaw = parseInt(req.query.tail ?? String(DEFAULT_LOG_TAIL), 10);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(tailRaw, MAX_LOG_TAIL) : DEFAULT_LOG_TAIL;

    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.json({ result: 'error', errorClass: 'no-target', reason: 'VPS-Ziel nicht konfiguriert' });
    }

    const result = await vpsDockerControl.logs(vpsTarget, containerId, { tail });
    if (result.result !== 'ok') {
      return res.json({ result: 'error', errorClass: result.errorClass ?? 'error', reason: result.reason ?? 'Logs-Abruf fehlgeschlagen' });
    }

    return res.json({ result: 'ok', lines: result.lines ?? [] });
  });

  // ── POST .../containers/:containerId/start|stop|restart ────────────────────

  /**
   * POST /api/vps/machines/:provider/*splat/containers/:containerId/start
   * Startet einen Container.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC12).
   */
  router.post('/api/vps/machines/:provider/*splat/containers/:containerId/start', async (req, res) => {
    return handleContainerMutation(req, res, 'start');
  });

  /**
   * POST /api/vps/machines/:provider/*splat/containers/:containerId/stop
   * Stoppt einen Container.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC12).
   */
  router.post('/api/vps/machines/:provider/*splat/containers/:containerId/stop', async (req, res) => {
    return handleContainerMutation(req, res, 'stop');
  });

  /**
   * POST /api/vps/machines/:provider/*splat/containers/:containerId/restart
   * Startet einen Container neu.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC12).
   */
  router.post('/api/vps/machines/:provider/*splat/containers/:containerId/restart', async (req, res) => {
    return handleContainerMutation(req, res, 'restart');
  });

  // ── DELETE .../containers/:containerId ────────────────────────────────────

  /**
   * DELETE /api/vps/machines/:provider/*splat/containers/:containerId
   * Entfernt einen Container.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC12).
   *
   * Body: { confirm: "<hostname-oder-name>" }
   *   Managed → DeployOrchestrator.undeploy (Route+DNS+Container, LockoutGuard)
   *   Unmanaged → VpsDockerControl.rm
   *   Protected → 422 protected-resource
   *   Fehlender/falscher confirm → 422 confirmation-required
   */
  router.delete('/api/vps/machines/:provider/*splat/containers/:containerId', async (req, res) => {
    const identity = req.identity ?? null;

    // AC12: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Provider validieren
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    // ServerId aus *splat
    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(422).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    // ContainerId validieren
    const containerIdVal = validateContainerId(req.params.containerId);
    if (!containerIdVal.ok) {
      return res.status(422).json({ error: containerIdVal.error });
    }
    const containerId = req.params.containerId.trim();

    // confirm aus Body (type-to-confirm)
    const confirm = req.body?.confirm;

    // AC12: Audit-First — vor jeder Mutation
    // I2: serverId kann slash-haltige IONOS composite-ID enthalten → slash durch ':' ersetzen
    const auditServerId = serverId.replace(/\//g, ':');
    const auditAction = `vps:container:remove:${provider}:${auditServerId}:${containerId}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[vpsContainerRouter] Audit-Write fehlgeschlagen (remove):', sanitizeMsg(auditErr.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // VPS-Target auflösen
    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.status(422).json({ result: 'error', errorClass: 'no-target', reason: 'VPS-Ziel nicht konfiguriert' });
    }

    // Ermittle ob Container managed ist: Container-Info via psAll holen
    const psResult = await vpsDockerControl.psAll(vpsTarget);
    if (psResult.result !== 'ok') {
      return res.status(502).json({
        result: 'error',
        errorClass: psResult.errorClass ?? 'error',
        reason: psResult.reason ?? 'Container-Liste konnte nicht geladen werden',
      });
    }

    const container = (psResult.containers ?? []).find((c) => c.containerId === containerId);
    if (!container) {
      // Container nicht mehr vorhanden — als Erfolg werten (bereits weg)
      return res.json({ result: 'ok' });
    }

    const isManaged = container.hostname !== null;
    const expectedConfirm = isManaged ? container.hostname : containerId;

    // AC11: confirm-Prüfung — type-to-confirm
    if (!confirm || confirm !== expectedConfirm) {
      return res.status(422).json({ result: 'error', errorClass: 'confirmation-required', reason: 'confirmation-required' });
    }

    if (isManaged) {
      // AC11 (C1-Fix): LockoutGuard-Check auf den Container-Hostname — IMMER, bedingungslos,
      // BEVOR jeglicher Docker- oder Cloudflare-Schritt ausgeführt wird.
      // Dies gilt unabhängig davon, ob eine tunnelId vorhanden ist.
      if (guard.isProtected(container.hostname)) {
        return res.status(422).json({
          result: 'error',
          errorClass: 'protected-resource',
          reason: 'protected-resource',
        });
      }

      // Managed: vollständiger Undeploy über DeployOrchestrator
      // tunnelId muss bekannt sein — aus vpsTargets oder Registry-Konvention.
      // Da tunnelId nicht per *splat mitkommt, nutzen wir psAll-Hostname als Bestätigung;
      // DeployOrchestrator.undeploy benötigt tunnelId für removeRoute.
      // Wir laden tunnelId aus dem CredentialStore (analog deploymentsRouter).
      // Wenn kein tunnelId gefunden: Fallback auf reines rm (LockoutGuard wurde oben bereits geprüft).
      const tunnelId = await resolveTunnelId(vpsTarget, vpsRegistry, vpsTargets);

      let undeployResult;
      if (tunnelId) {
        undeployResult = await deployOrchestrator.undeploy({
          vps: vpsTarget,
          hostname: container.hostname,
          confirm,
          tunnelId,
        });
      } else {
        // Kein Tunnel konfiguriert — nur Container entfernen (best-effort).
        // LockoutGuard wurde bereits oben (vor diesem Block) geprüft — kein Bypass möglich.
        undeployResult = await vpsDockerControl.rm(vpsTarget, containerId);
      }

      if (undeployResult.result !== 'ok') {
        const httpStatus = undeployResult.errorClass === 'protected-resource' ? 422 : 502;
        return res.status(httpStatus).json({
          result: 'error',
          errorClass: undeployResult.errorClass ?? 'error',
          reason: undeployResult.reason ?? 'Undeploy fehlgeschlagen',
        });
      }
      return res.json({ result: 'ok' });
    } else {
      // Unmanaged: nur docker rm via VpsDockerControl
      const rmResult = await vpsDockerControl.rm(vpsTarget, containerId);
      if (rmResult.result !== 'ok') {
        return res.status(502).json({
          result: 'error',
          errorClass: rmResult.errorClass ?? 'error',
          reason: rmResult.reason ?? 'Entfernen fehlgeschlagen',
        });
      }
      return res.json({ result: 'ok' });
    }
  });

  // ── Shared Handler: start/stop/restart ────────────────────────────────────

  /**
   * Führt eine Container-Mutation (start/stop/restart) mit Authz + Audit-First durch.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   * @param {'start'|'stop'|'restart'}   action
   */
  async function handleContainerMutation(req, res, action) {
    const identity = req.identity ?? null;

    // AC12: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Provider validieren
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    // ServerId aus *splat
    const serverIdResult = extractServerId(req.params.splat);
    if (!serverIdResult.ok) {
      return res.status(422).json({ error: serverIdResult.error });
    }
    const serverId = serverIdResult.serverId;

    // ContainerId validieren
    const containerIdVal = validateContainerId(req.params.containerId);
    if (!containerIdVal.ok) {
      return res.status(422).json({ error: containerIdVal.error });
    }
    const containerId = req.params.containerId.trim();

    // AC12: Audit-First — vor der Mutation
    // I2: serverId kann slash-haltige IONOS composite-ID enthalten → slash durch ':' ersetzen
    const auditServerId = serverId.replace(/\//g, ':');
    const auditAction = `vps:container:${action}:${provider}:${auditServerId}:${containerId}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error(`[vpsContainerRouter] Audit-Write fehlgeschlagen (${action}):`, sanitizeMsg(auditErr.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // VPS-Target auflösen
    const vpsTarget = await resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets);
    if (!vpsTarget) {
      return res.status(422).json({ result: 'error', errorClass: 'no-target', reason: 'VPS-Ziel nicht konfiguriert' });
    }

    // Docker-Aktion ausführen
    let result;
    try {
      result = await vpsDockerControl[action](vpsTarget, containerId);
    } catch (err) {
      console.error(`[vpsContainerRouter] ${action} Fehler:`, sanitizeMsg(err?.message ?? ''));
      return res.status(502).json({ result: 'error', errorClass: 'error', reason: `Container-${action} fehlgeschlagen` });
    }

    if (result.result !== 'ok') {
      return res.status(502).json({
        result: 'error',
        errorClass: result.errorClass ?? 'error',
        reason: result.reason ?? `Container-${action} fehlgeschlagen`,
      });
    }

    return res.json({ result: 'ok' });
  }

  return router;
}

// ── Hilfsfunktion: TunnelId aus CredentialStore-Konvention ────────────────────

/**
 * Versucht eine tunnelId aus dem CredentialStore oder Registry-Metadaten zu laden.
 * Gibt null zurück wenn kein Tunnel konfiguriert (best-effort).
 *
 * Konvention (VpsProviderRegistry.js TUNNEL_ID_KEY):
 *   `credentials/misc/vps-<sanitized-vpsname>-tunnel-id`
 *
 * Da wir hier nur host/targetUser haben aber nicht den vpsName, iterieren wir
 * über die Registry-interne Methode — falls nicht verfügbar: null.
 *
 * @param {{ host: string, port: number, targetUser: string }} vpsTarget
 * @param {object} vpsRegistry
 * @param {Map} vpsTargets
 * @returns {Promise<string|null>}
 */
async function resolveTunnelId(vpsTarget, vpsRegistry, _vpsTargets) {
  // Versuche über Registry-Methode (falls vorhanden)
  if (vpsRegistry && typeof vpsRegistry.getTunnelIdForHost === 'function') {
    try {
      const tid = await vpsRegistry.getTunnelIdForHost(vpsTarget.host);
      if (tid) return tid;
    } catch {
      // best-effort
    }
  }
  // Fallback: kein Tunnel — Caller muss ohne undeploy-Route auskommen
  return null;
}
