/**
 * DeployOrchestrator — atomare Container+Route-Einheit (ADR-012, Capability B).
 *
 * Architecture boundary: the ONLY place that couples the Container-step
 * (via VpsDockerControl) and the Route-step (via CloudflareApi) into one
 * atomic unit. No other module orchestrates both steps.
 *
 * Design:
 *   - Deploy saga: (1) LockoutGuard-Check → (2) pull image → (3) run container
 *     with label cloudflare.tunnel-hostname=<hostname> → (4) add tunnel route +
 *     DNS CNAME. On failure at step 4 → rollback container (rm). On failure at
 *     step 3 → no route step. (AC3, AC4)
 *   - Undeploy: (1) LockoutGuard-Check → (2) confirm-token check → (3) remove
 *     route + DNS → (4) container rm. Route-first to prevent traffic on removed
 *     container. (AC5, AC6)
 *   - listDeployments: live from VpsDockerControl.ps + CloudflareApi.listRoutes;
 *     no Deploy-State-Store (ADR-005-line). (AC3)
 *   - LockoutGuard-Hard-Block before any step (AC7).
 *   - No secrets in result/reason (SSH key and CF token stay in their boundaries).
 *
 * Host-Port selection (O3 resolution):
 *   Free port starting from 8080, found by inspecting ps() output.
 *   Caller (deploymentsRouter) does not need to provide a port.
 *
 * @module deploy/DeployOrchestrator
 */

import { isValidHostname } from './hostnameSanitizer.js';

/** First host-port to try (preview-Konvention). */
const HOST_PORT_START = 8080;

/** Max host-ports to try before giving up. */
const HOST_PORT_MAX = 200;

// ── DeployOrchestrator ────────────────────────────────────────────────────────

export class DeployOrchestrator {
  /** @type {import('./VpsDockerControl.js').VpsDockerControl} */
  #dockerControl;

  /** @type {import('../cloudflare/CloudflareApi.js').CloudflareApi} */
  #cloudflareApi;

  /** @type {import('../cloudflare/LockoutGuard.js').LockoutGuard} */
  #lockoutGuard;

  /**
   * @param {object} opts
   * @param {import('./VpsDockerControl.js').VpsDockerControl} opts.dockerControl
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('../cloudflare/LockoutGuard.js').LockoutGuard} opts.lockoutGuard
   */
  constructor({ dockerControl, cloudflareApi, lockoutGuard }) {
    if (!dockerControl || typeof dockerControl.pull !== 'function') {
      throw new Error('[DeployOrchestrator] dockerControl ist Pflicht');
    }
    if (!cloudflareApi || typeof cloudflareApi.addRoute !== 'function') {
      throw new Error('[DeployOrchestrator] cloudflareApi ist Pflicht');
    }
    if (!lockoutGuard || typeof lockoutGuard.isProtected !== 'function') {
      throw new Error('[DeployOrchestrator] lockoutGuard ist Pflicht');
    }
    this.#dockerControl = dockerControl;
    this.#cloudflareApi = cloudflareApi;
    this.#lockoutGuard = lockoutGuard;
  }

  // ── Deploy ──────────────────────────────────────────────────────────────────

  /**
   * Deploy: pull image → run container → add tunnel route + DNS CNAME.
   * Rollback: if route-step fails → rm container.
   *
   * AC3: success → { result: "ok", deployment: Deployment }
   * AC4: route-step fails → container rolled back → { result: "error", reason }
   * AC7: protected hostname → { result: "error", reason: "protected-resource" }, no step
   *
   * zoneId is NOT a parameter — it is resolved server-side from the hostname via
   * CloudflareApi.resolveZoneForHostname() (longest-suffix match). No zone-not-found
   * is leaked to the caller (400/422 zone-not-found reason only).
   *
   * @param {object} params
   * @param {string} params.image    - ghcr image reference (e.g. "ghcr.io/org/app:v1")
   * @param {object} params.vps      - VpsTarget { host, port?, targetUser }
   * @param {string} params.hostname - target hostname (cloudflare tunnel route)
   * @param {string} params.tunnelId - Cloudflare tunnel ID to add the route to
   * @param {object} [params.dockerOpts] - additional VpsDockerControl options
   * @returns {Promise<DeployResult>}
   */
  async deploy({ image, vps, hostname, tunnelId, dockerOpts = {} }) {
    // AC7: LockoutGuard-Hard-Block — before any step
    if (this.#lockoutGuard.isProtected(hostname)) {
      return {
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      };
    }

    // Validate hostname (security: untrusted input before SSH sink)
    if (!isValidHostname(hostname)) {
      return {
        result: 'error',
        reason: 'Ungültiger Hostname',
        errorClass: 'validation-error',
      };
    }

    // Resolve zoneId server-side via longest-suffix match (Spec-Gap-Resolution, O3 analogy)
    let zoneId;
    try {
      zoneId = await this.#cloudflareApi.resolveZoneForHostname(hostname);
    } catch (err) {
      return {
        result: 'error',
        reason: 'Cloudflare nicht erreichbar — Zone konnte nicht aufgelöst werden',
        errorClass: err?.errorClass ?? 'cloudflare-unavailable',
      };
    }
    if (!zoneId) {
      return {
        result: 'error',
        reason: 'zone-not-found',
        errorClass: 'zone-not-found',
      };
    }

    // Step 1: Pull image (AC3)
    const pullResult = await this.#dockerControl.pull(vps, image, dockerOpts);
    if (pullResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(pullResult.reason ?? 'Image-Pull fehlgeschlagen'),
        errorClass: pullResult.errorClass ?? 'error',
      };
    }

    // Determine a free host port from currently running managed containers
    const hostPort = await this.#selectFreeHostPort(vps, dockerOpts);

    // Step 2: Run container with label cloudflare.tunnel-hostname=<hostname> (AC2, AC3)
    const runResult = await this.#dockerControl.run(vps, image, hostname, {
      ...dockerOpts,
      hostPort,
    });
    if (runResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(runResult.reason ?? 'Container-Start fehlgeschlagen'),
        errorClass: runResult.errorClass ?? 'error',
      };
    }
    const { containerId } = runResult;

    // Step 3: Add tunnel route + DNS CNAME (AC3)
    // On failure → rollback container (AC4)
    try {
      await this.#cloudflareApi.addRoute(tunnelId, hostname, `http://localhost:${hostPort}`);
      try {
        await this.#cloudflareApi.createDnsRecord(zoneId, hostname, tunnelId);
      } catch (dnsErr) {
        // DNS record creation failure: rollback container and route (AC4)
        const containerRollbackOk = await this.#rollbackContainer(vps, containerId, dockerOpts);
        let routeRollbackOk = true;
        try {
          await this.#cloudflareApi.removeRoute(tunnelId, hostname);
        } catch {
          routeRollbackOk = false;
        }
        const rollbackDetail = (!containerRollbackOk || !routeRollbackOk)
          ? ' — Rollback fehlgeschlagen, Drift erwartet, Reconciliation greift'
          : ' — Container und Route zurückgerollt';
        return {
          result: 'error',
          reason: `DNS-CNAME-Anlage fehlgeschlagen${rollbackDetail}`,
          errorClass: dnsErr?.errorClass ?? 'error',
        };
      }
    } catch (routeErr) {
      // Route-step failed → rollback container (AC4)
      const containerRollbackOk = await this.#rollbackContainer(vps, containerId, dockerOpts);
      const rollbackDetail = containerRollbackOk
        ? ' — Container zurückgerollt'
        : ' — Container-Rollback fehlgeschlagen, Drift erwartet, Reconciliation greift';
      return {
        result: 'error',
        reason: routeErr?.message
          ? `${sanitizeReason(routeErr.message)}${rollbackDetail}`
          : `Tunnel-Route-Anlage fehlgeschlagen${rollbackDetail}`,
        errorClass: routeErr?.errorClass ?? 'error',
      };
    }

    const deployment = {
      vps: vps.host,
      hostname,
      image,
      containerId,
      hostPort,
      status: 'running',
      routePresent: true,
      containerPresent: true,
    };

    return { result: 'ok', deployment };
  }

  // ── Undeploy ────────────────────────────────────────────────────────────────

  /**
   * Undeploy: remove route + DNS → rm container.
   * Route-first to prevent traffic on removed container (AC5).
   *
   * AC5: success → { result: "ok" }
   * AC6: missing/wrong confirm → { result: "error", reason: "confirmation-required" }
   * AC7: protected hostname → { result: "error", reason: "protected-resource" }
   *
   * zoneId is resolved server-side via CloudflareApi.resolveZoneForHostname()
   * (longest-suffix match). Not a caller parameter.
   *
   * @param {object} params
   * @param {object} params.vps       - VpsTarget { host, port?, targetUser }
   * @param {string} params.hostname  - hostname to undeploy
   * @param {string} params.confirm   - must equal hostname (type-to-confirm)
   * @param {string} params.tunnelId  - Cloudflare tunnel ID
   * @param {object} [params.dockerOpts]
   * @returns {Promise<UndeployResult>}
   */
  async undeploy({ vps, hostname, confirm, tunnelId, dockerOpts = {} }) {
    // AC7: LockoutGuard-Hard-Block — before any step
    if (this.#lockoutGuard.isProtected(hostname)) {
      return {
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      };
    }

    // AC6: type-to-confirm check — before any step
    if (!confirm || confirm !== hostname) {
      return {
        result: 'error',
        reason: 'confirmation-required',
        errorClass: 'confirmation-required',
      };
    }

    // Resolve zoneId server-side (best-effort — DNS cleanup is non-critical)
    let zoneId = null;
    try {
      zoneId = await this.#cloudflareApi.resolveZoneForHostname(hostname);
    } catch {
      // DNS cleanup is best-effort — continue without zone
    }

    // Step 1: Remove route (route-first, AC5)
    try {
      await this.#cloudflareApi.removeRoute(tunnelId, hostname);
    } catch (err) {
      return {
        result: 'error',
        reason: sanitizeReason(err?.message ?? 'Route-Entfernung fehlgeschlagen'),
        errorClass: err?.errorClass ?? 'error',
      };
    }

    // Step 2: Remove DNS CNAME (best-effort — requires resolved zoneId)
    if (zoneId) {
      try {
        await this.#cloudflareApi.deleteDnsRecord(zoneId, hostname);
      } catch {
        // Best-effort DNS cleanup — continue to container removal
      }
    }

    // Step 3: Find container by label and rm it
    const psResult = await this.#dockerControl.ps(vps, dockerOpts);
    if (psResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(psResult.reason ?? 'Container-Liste konnte nicht abgerufen werden'),
        errorClass: psResult.errorClass ?? 'error',
      };
    }

    const container = (psResult.containers ?? []).find((c) => c.hostname === hostname);
    if (container) {
      const rmResult = await this.#dockerControl.rm(vps, container.containerId, dockerOpts);
      if (rmResult.result !== 'ok') {
        return {
          result: 'error',
          reason: sanitizeReason(rmResult.reason ?? 'Container-Removal fehlgeschlagen'),
          errorClass: rmResult.errorClass ?? 'error',
        };
      }
    }

    return { result: 'ok' };
  }

  // ── addRouteOnly ───────────────────────────────────────────────────────────

  /**
   * Adds a tunnel route for an already-running container (Route-healing path, AC5).
   * This is the shared ADR-012 atomic route-add path — called by ReconciliationJob
   * for self-healing (managed container without route). Does NOT docker pull/run.
   *
   * LockoutGuard-Hard-Block is checked first (AC5b, AC9).
   * Audit-First is the responsibility of the caller (ReconciliationJob).
   *
   * @param {object} params
   * @param {object} params.vps       - VpsTarget { host, port?, targetUser }
   * @param {string} params.tunnelId  - Cloudflare tunnel ID
   * @param {string} params.hostname  - target hostname (cloudflare tunnel route)
   * @param {number} [params.hostPort] - host port the container is listening on (default 8080)
   * @returns {Promise<{ result: 'ok'|'error', reason?: string, errorClass?: string }>}
   */
  async addRouteOnly({ tunnelId, hostname, hostPort = 8080 }) {
    // AC5b / AC9: LockoutGuard-Hard-Block — before any step
    if (this.#lockoutGuard.isProtected(hostname)) {
      return {
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      };
    }

    // Validate hostname (security: untrusted input before Cloudflare API sink)
    if (!isValidHostname(hostname)) {
      return {
        result: 'error',
        reason: 'Ungültiger Hostname',
        errorClass: 'validation-error',
      };
    }

    // Add tunnel route (same as deploy step 3, ADR-012)
    try {
      await this.#cloudflareApi.addRoute(tunnelId, hostname, `http://localhost:${hostPort}`);
    } catch (routeErr) {
      return {
        result: 'error',
        reason: sanitizeReason(routeErr?.message ?? 'Tunnel-Route-Anlage fehlgeschlagen'),
        errorClass: routeErr?.errorClass ?? 'error',
      };
    }

    // DNS CNAME is best-effort (zone may not be resolvable, non-critical)
    try {
      const zoneId = await this.#cloudflareApi.resolveZoneForHostname(hostname);
      if (zoneId) {
        await this.#cloudflareApi.createDnsRecord(zoneId, hostname, tunnelId);
      }
    } catch {
      // Best-effort DNS — route is already added; don't abort healing
    }

    return { result: 'ok' };
  }

  // ── listDeployments ────────────────────────────────────────────────────────

  /**
   * List live deployments: Container ⊕ Route per VPS.
   * No Deploy-State-Store — live from docker ps + cloudflare routes (ADR-005).
   *
   * @param {object} params
   * @param {object} params.vps       - VpsTarget { host, port?, targetUser }
   * @param {string} params.tunnelId  - Cloudflare tunnel ID to read routes from
   * @param {object} [params.dockerOpts]
   * @returns {Promise<ListResult>}
   */
  async listDeployments({ vps, tunnelId, dockerOpts = {} }) {
    const errors = [];
    let containers = [];
    let routes = [];

    // Fetch containers
    const psResult = await this.#dockerControl.ps(vps, dockerOpts);
    if (psResult.result === 'ok') {
      containers = psResult.containers ?? [];
    } else {
      errors.push({ scope: `vps:${vps.host}`, errorClass: psResult.errorClass ?? 'error' });
    }

    // Fetch routes (degrading)
    try {
      routes = await this.#cloudflareApi.listRoutes(tunnelId);
    } catch (err) {
      errors.push({ scope: `tunnel:${tunnelId}`, errorClass: err?.errorClass ?? 'cloudflare-unavailable' });
    }

    // Build Deployment read-models — join by hostname
    const routeMap = new Map(routes.map((r) => [r.hostname, r]));
    const containerMap = new Map(containers.map((c) => [c.hostname, c]));

    const allHostnames = new Set([...routeMap.keys(), ...containerMap.keys()]);
    const deployments = [];

    for (const hostname of allHostnames) {
      const container = containerMap.get(hostname);
      const route = routeMap.get(hostname);
      deployments.push({
        vps: vps.host,
        hostname,
        image: container?.image ?? null,
        containerId: container?.containerId ?? null,
        hostPort: container?.hostPort ?? null,
        status: container?.status ?? null,
        routePresent: !!route,
        containerPresent: !!container,
      });
    }

    const result = { deployments };
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Select a free host port starting from HOST_PORT_START.
   * Inspects ps() output to find ports already in use.
   *
   * @param {object} vps
   * @param {object} dockerOpts
   * @returns {Promise<number>}
   */
  async #selectFreeHostPort(vps, dockerOpts) {
    const psResult = await this.#dockerControl.ps(vps, dockerOpts);
    const usedPorts = new Set();
    if (psResult.result === 'ok') {
      for (const c of (psResult.containers ?? [])) {
        if (c.hostPort !== null) usedPorts.add(c.hostPort);
      }
    }

    for (let port = HOST_PORT_START; port < HOST_PORT_START + HOST_PORT_MAX; port++) {
      if (!usedPorts.has(port)) return port;
    }

    // Fallback: use start port (very unlikely to exhaust 200 ports)
    return HOST_PORT_START;
  }

  /**
   * Best-effort container rollback (AC4).
   * Returns true if rollback succeeded, false if rm itself failed.
   * Errors are NOT re-thrown — rollback should not mask the original error,
   * but the caller may use the return value to compose an honest reason (S1).
   *
   * @param {object} vps
   * @param {string} containerId
   * @param {object} dockerOpts
   * @returns {Promise<boolean>} true on success, false on rollback failure
   */
  async #rollbackContainer(vps, containerId, dockerOpts) {
    try {
      const result = await this.#dockerControl.rm(vps, containerId, dockerOpts);
      return result.result === 'ok';
    } catch {
      return false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip any token-like patterns from error messages before they reach callers.
 * Tokens/keys MUST NOT appear in result.reason (security/R01).
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeReason(msg) {
  if (typeof msg !== 'string') return 'Unbekannter Fehler';
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY[\s\S]*?END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/gi, '[KEY REDACTED]')
    .slice(0, 300);
}

/**
 * @typedef {object} DeployResult
 * @property {'ok'|'error'} result
 * @property {object}  [deployment] - Deployment read-model on success
 * @property {string}  [reason]     - Error reason (no secrets)
 * @property {string}  [errorClass] - Machine-readable error class
 */

/**
 * @typedef {object} UndeployResult
 * @property {'ok'|'error'} result
 * @property {string}  [reason]
 * @property {string}  [errorClass]
 */

/**
 * @typedef {object} ListResult
 * @property {object[]} deployments
 * @property {object[]} [errors]
 */
