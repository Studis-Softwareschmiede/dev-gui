/**
 * DeployOrchestrator — atomare Container+Route-Einheit (ADR-012, Capability B).
 *
 * Architecture boundary: the ONLY place that couples the Container-step
 * (via VpsDockerControl) and the Route-step (via CloudflareApi) into one
 * atomic unit. No other module orchestrates both steps.
 *
 * Design:
 *   - Deploy saga: (1) LockoutGuard-Check → (2) Tunnel-Mismatch/Missing-Gate
 *     (vps-tunnel-existence-gate AC5/AC6) → (3) Readiness-Probe (vps-readiness-gate AC4) →
 *     (4) Tunnel-Existenz-Gate via listTunnels (vps-tunnel-existence-gate AC1) →
 *     (5) pull image (AC18 v3 — pull-vor-remove, fail-closed: a failed pull leaves the
 *     existing container running untouched — no rm/run/route step) →
 *     (6) re-deploy replace: remove ALL existing containers matching the hostname label,
 *     running and stopped (AC14/AC17), best-effort — runs AFTER pull (AC18) so a failed
 *     pull never removes the existing container, and BEFORE host-port selection so the
 *     old container's host port is free again for reuse (AC19) →
 *     (7) run container with label cloudflare.tunnel-hostname=<hostname>
 *     (inkl. optionalem persistentem read-write config-Verzeichnis-Mount + idempotentem
 *     `mkdir -p`, beides IN run() selbst, deploy-config-volume-mount AC1/AC2, F-079-Korrektur
 *     — kein separates Guard-/Seed-Gate mehr im Orchestrator) →
 *     (8) add tunnel route + DNS CNAME. On failure at step 8 → rollback container (rm).
 *     On failure at step 7 → no route step. (AC3, AC4)
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

/** Default container port when no ExposedPorts found (AC13 fallback). */
const DEFAULT_CONTAINER_PORT = 8080;

// ── DeployOrchestrator ────────────────────────────────────────────────────────

export class DeployOrchestrator {
  /** @type {import('./VpsDockerControl.js').VpsDockerControl} */
  #dockerControl;

  /** @type {import('../cloudflare/CloudflareApi.js').CloudflareApi} */
  #cloudflareApi;

  /** @type {import('../cloudflare/LockoutGuard.js').LockoutGuard} */
  #lockoutGuard;

  /**
   * Optional VpsProviderRegistry reference for tunnel-mismatch + tunnel-missing checks
   * (vps-tunnel-existence-gate AC5/AC6). When null/undefined, both checks are skipped
   * (graceful degradation — e.g. legacy setups without VpsProviderRegistry).
   *
   * @type {import('../vps/VpsProviderRegistry.js').VpsProviderRegistry|null}
   */
  #vpsRegistry;

  /**
   * @param {object} opts
   * @param {import('./VpsDockerControl.js').VpsDockerControl} opts.dockerControl
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('../cloudflare/LockoutGuard.js').LockoutGuard} opts.lockoutGuard
   * @param {import('../vps/VpsProviderRegistry.js').VpsProviderRegistry} [opts.vpsRegistry]
   *   Optional — enables tunnel-mismatch + tunnel-missing pre-flight checks (AC5/AC6).
   *   When omitted, only the listTunnels-based existence probe runs (AC1–AC4).
   */
  constructor({ dockerControl, cloudflareApi, lockoutGuard, vpsRegistry }) {
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
    this.#vpsRegistry = vpsRegistry ?? null;
  }

  // ── Deploy ──────────────────────────────────────────────────────────────────

  /**
   * Deploy: pull image → replace existing container(s) → run new container → add
   * tunnel route + DNS CNAME.
   * Rollback: if route-step fails → rm container. No rollback for the replace step
   * itself — AC18 (pull-vor-remove) protects it instead: a failed pull never removes
   * the existing container in the first place.
   *
   * AC3:  success → { result: "ok", deployment: Deployment }
   * AC4:  route-step fails → container rolled back → { result: "error", reason }
   * AC7:  protected hostname → { result: "error", reason: "protected-resource" }, no step
   * AC18: pull fails → { result: "error", reason, errorClass }, no rm/run/route step —
   *       the existing container keeps running unchanged (fail-closed, no outage)
   * AC19: replace step stays BEFORE host-port selection — a re-deploy on the same
   *       hostname reuses the old container's host port instead of drifting upward
   *
   * Preflight gates (all before any Docker/Cloudflare mutation step, incl. pull/re-deploy rm):
   *   (a) LockoutGuard (AC7)
   *   (b) hostname validation
   *   (c) resolveZoneForHostname — zone-not-found / cloudflare-unavailable
   *   (d) Tunnel-Mismatch/-Missing via VpsProviderRegistry (AC5/AC6, when vpsId + vpsRegistry set)
   *   (e) Tunnel-Existenz via CloudflareApi.listTunnels() (AC1–AC4)
   *   (f) Readiness-Probe via VpsDockerControl.probe() (vps-readiness-gate)
   *
   * After the gates (v3, AC18/AC19 — kanonische Reihenfolge):
   *   (g) pull image — fail-closed: pull error → early return before any rm/run/
   *       Cloudflare step, existing container + route stay untouched
   *   (h) Re-deploy: psAll() → rm() ALL existing containers with matching hostname
   *       label, running or stopped (AC14/AC17) — placed AFTER (g) so a failed pull
   *       never removes the existing container (AC18), and BEFORE #selectFreeHostPort
   *       so the old container's host port is free again for reuse (AC19)
   *
   * Gates (a)–(f) run BEFORE (g)/(h) so that a missing/mismatched tunnel or a failed
   * pull both abort the deploy without removing the existing container first
   * (AC1/AC3/AC5/AC6/AC18: "no step before the gate").
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
   * @param {string} [params.vpsId]  - Sanitized VPS name used for tunnel-mismatch check (AC5/AC6)
   * @param {object} [params.containerEnv] - zusätzliche Container-Env (z.B. { GPG_PASSPHRASE })
   *   wird NUR beim run-Schritt gesetzt; erscheint nicht im Log/reason (F-072/S-334).
   * @param {boolean} [params.requiresConfig]  - deploy-config-volume-mount D1/AC1 (F-079-Korrektur):
   *   persistenter, read-write config-Verzeichnis-Mount aktiv; wird unverändert an run()
   *   durchgereicht (kein separates Guard-/Seed-Gate mehr im Orchestrator).
   * @param {string}  [params.configApp]       - deploy-config-volume-mount AC2/AC3: config-App-Slug
   *   (Host-Pfad `$HOME/apps/<configApp>/config`, Verzeichnis); wird an run() durchgereicht.
   * @param {string}  [params.configMountPath] - deploy-config-volume-mount D3: optionaler Container-
   *   Mount-Pfad (Default `/app/config`); wird an run() durchgereicht.
   * @param {object} [params.dockerOpts] - additional VpsDockerControl options
   * @returns {Promise<DeployResult>}
   */
  async deploy({ image, vps, hostname, tunnelId, vpsId, containerEnv, requiresConfig, configApp, configMountPath, dockerOpts = {} }) {
    // (a) AC7: LockoutGuard-Hard-Block — before any step
    if (this.#lockoutGuard.isProtected(hostname)) {
      return {
        result: 'error',
        reason: 'protected-resource',
        errorClass: 'protected-resource',
      };
    }

    // (b) Validate hostname (security: untrusted input before SSH sink)
    if (!isValidHostname(hostname)) {
      return {
        result: 'error',
        reason: 'Ungültiger Hostname',
        errorClass: 'validation-error',
      };
    }

    // (c) Resolve zoneId server-side via longest-suffix match (Spec-Gap-Resolution, O3 analogy)
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

    // (d) Tunnel-Mismatch/-Missing-Gate (vps-tunnel-existence-gate AC5/AC6):
    // Prüft ob die im Request mitgegebene tunnelId mit der für den VPS registrierten
    // Tunnel-Id übereinstimmt — VOR dem Re-Deploy-Replace-Schritt (AC1/AC3/AC5/AC6:
    // kein Schritt vor dem Gate).
    // Erfordert: vpsId (sanitisierter VPS-Name) + vpsRegistry (optional dependency).
    // Ohne vpsRegistry oder vpsId → Gate wird übersprungen (Graceful Degradation für
    // Legacy-Setups und Tests ohne VpsProviderRegistry).
    if (this.#vpsRegistry && vpsId && typeof this.#vpsRegistry.getTargetRecord === 'function') {
      // Registrierte Tunnel-Id aus dem CredentialStore lesen (store-intern, kein Secret-Leak)
      // Wir nutzen getTargetRecord (das tunnelId-Feld im Target-Record) — identisch zu TUNNEL_ID_KEY-Lookup,
      // da VpsProviderRegistry.#persistTargetMetadata() tunnelId im Record speichert.
      let registeredTunnelId;
      try {
        const record = await this.#vpsRegistry.getTargetRecord(vpsId);
        registeredTunnelId = record?.tunnelId ?? null;
      } catch {
        // Store-Fehler → defensiv: kein Tunnel registriert → tunnel-missing
        registeredTunnelId = null;
      }

      if (!registeredTunnelId) {
        // AC6: Kein Tunnel dem VPS zugeordnet → tunnel-missing, kein Schritt
        return {
          result: 'error',
          errorClass: 'tunnel-missing',
          reason: 'Kein Tunnel für diesen VPS registriert – bitte Tunnel neu anlegen & bestücken',
        };
      }

      if (registeredTunnelId !== tunnelId) {
        // AC5: Mitgegebene tunnelId stimmt nicht mit registrierter überein → tunnel-mismatch, kein Schritt
        return {
          result: 'error',
          errorClass: 'tunnel-mismatch',
          reason: 'Tunnel-ID stimmt nicht mit dem für diesen VPS registrierten Tunnel überein (Fehlverdrahtungs-Schutz)',
        };
      }
    }

    // (e) Tunnel-Existenz-Gate (vps-tunnel-existence-gate AC1–AC4):
    // Prüft via CloudflareApi.listTunnels(), ob die mitgegebene tunnelId in Cloudflare existiert.
    // Fail-closed: Cloudflare nicht erreichbar → kein Deploy (AC4).
    // Läuft VOR dem Re-Deploy-Replace-Schritt und VOR dem docker-pull (AC1/AC3).
    {
      let tunnels;
      try {
        // listTunnels() wirft CloudflareApiError bei fehlender Konfiguration / Auth / Netz (AC4)
        tunnels = await this.#cloudflareApi.listTunnels(tunnelId);
      } catch (cfErr) {
        // AC4: Fail-closed — Cloudflare-Fehler → kein Docker-Schritt, bestehende Fehlerklasse weitergeben
        return {
          result: 'error',
          errorClass: cfErr?.errorClass ?? 'cloudflare-unavailable',
          reason: 'Cloudflare konnte nicht konsultiert werden – Tunnel-Existenz nicht prüfbar (fail-closed)',
        };
      }
      // AC1: Tunnel existiert nicht → tunnel-missing, kein Schritt
      const tunnelExists = Array.isArray(tunnels) && tunnels.some((t) => t.id === tunnelId);
      if (!tunnelExists) {
        return {
          result: 'error',
          errorClass: 'tunnel-missing',
          reason: 'Tunnel existiert nicht in Cloudflare (extern gelöscht?) – bitte Tunnel neu anlegen & bestücken',
        };
      }
      // AC2: Tunnel existiert → Gate ist No-op, Saga läuft unverändert weiter
    }

    // (f) Deploy-Gate (vps-readiness-gate AC4/AC5): Probe VOR dem docker-pull-Schritt.
    // state != ready → kein pull/run, kein Cloudflare-Schritt.
    // state == ready → bestehende Saga unverändert (Gate ist ein No-op-Vorschritt).
    // Graceful Degradation: Ältere/Stub-DockerControl-Instanzen (z.B. in Tests ohne probe-Methode)
    // haben probe() noch nicht implementiert — typeof-Guard überspringt das Gate in diesem Fall.
    if (typeof this.#dockerControl.probe === 'function') {
      const probeResult = await this.#dockerControl.probe(vps, dockerOpts);
      if (probeResult.state !== 'ready') {
        // AC6: freundliche Meldung ohne rohen Docker-/SSH-Fehlertext, Host, Key oder Token
        return {
          result: 'error',
          errorClass: 'vps-provisioning',
          reason: 'VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen',
        };
      }
    }

    // (g) Pull image (AC3, AC18 v3 — pull-vor-remove, fail-closed). Gates (a)–(f) have
    // all passed; the image is pulled BEFORE the existing container is touched. A failed
    // pull returns early — no rm, no run, no Cloudflare step — so the existing container
    // (and its route) stays exactly as it was (no outage). This early return is
    // deliberately placed BEFORE the re-deploy replacement step (h) below.
    const pullResult = await this.#dockerControl.pull(vps, image, dockerOpts);
    if (pullResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(pullResult.reason ?? 'Image-Pull fehlgeschlagen'),
        errorClass: pullResult.errorClass ?? 'error',
      };
    }

    // (h) AC14/AC17: Re-deploy = replace. Runs AFTER the pull step (g) — a successful
    // pull means a replacement image is available, so it is now safe to remove the
    // existing container(s). Find ALL existing containers with this hostname label —
    // running AND stopped (AC17 zombie fix) — and remove them before starting the new
    // one. This is best-effort — if a removal fails, we still attempt the new deploy.
    // Placed AFTER pull (AC18: a failed pull never removes the existing container) and
    // BEFORE #selectFreeHostPort (AC19: the old container's host port becomes free again
    // and is reused instead of drifting to a higher port on every re-deploy).
    //
    // AC17 (v2, zombie fix): uses psAll() (docker ps -a, state-complete read) instead of
    // ps() (running-only) — a stopped legacy container with the same hostname label used
    // to survive re-deploy undetected (v1 zombie). ALL matching containers are removed
    // (not just the first) to also clean up pre-fix zombie accumulation.
    let replacingExisting = false;
    {
      const existingPs = await this.#dockerControl.psAll(vps, dockerOpts);
      if (existingPs.result === 'ok') {
        const existingMatches = (existingPs.containers ?? []).filter((c) => c.hostname === hostname);
        for (const existing of existingMatches) {
          replacingExisting = true;
          // Best-effort: remove old container(s) before starting new one
          await this.#rollbackContainer(vps, existing.containerId, dockerOpts);
        }
      }
    }

    // AC13: Auto-Port — nach docker pull via docker inspect ExposedPorts ermitteln.
    // Genau ein exponierter Port → diesen verwenden; mehrere → kleinsten + ambiguous-Flag;
    // kein Port → Fallback auf DEFAULT_CONTAINER_PORT (8080).
    let containerPort = DEFAULT_CONTAINER_PORT;
    let portAmbiguous = false;
    let portFallback = false;
    if (typeof this.#dockerControl.inspect === 'function') {
      const inspectResult = await this.#dockerControl.inspect(vps, image, dockerOpts);
      if (inspectResult.result === 'ok' && Array.isArray(inspectResult.ports)) {
        const numericPorts = inspectResult.ports
          .map((p) => parseInt(p, 10))
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b);
        if (numericPorts.length === 1) {
          containerPort = numericPorts[0];
        } else if (numericPorts.length > 1) {
          containerPort = numericPorts[0]; // smallest
          portAmbiguous = true;
        } else {
          portFallback = true; // no exposed ports — use default
        }
      }
    }

    // Determine a free host port from currently running managed containers
    const hostPort = await this.#selectFreeHostPort(vps, dockerOpts);

    // Step 2: Run container with label cloudflare.tunnel-hostname=<hostname> (AC2, AC3)
    const runResult = await this.#dockerControl.run(vps, image, hostname, {
      ...dockerOpts,
      hostPort,
      containerPort,
      // F-072/S-334: per-App-GPG-Passphrase o.ä. nur beim run-Schritt in die Container-Env
      ...(containerEnv ? { containerEnv } : {}),
      // deploy-config-volume-mount AC1/AC2 (F-079-Korrektur): Mount-Parameter durchreichen
      // (nur wenn aktiv, sonst bleibt run()-Aufruf byte-identisch zum heutigen Verhalten).
      ...(requiresConfig ? { requiresConfig, configApp, configMountPath } : {}),
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
      containerPort,
      status: 'running',
      routePresent: true,
      containerPresent: true,
      // AC13: Port-Auflösungs-Metadaten
      portAmbiguous,   // true wenn mehrere ExposedPorts → erster/kleinster gewählt
      portFallback,    // true wenn kein ExposedPort → Default 8080
      // AC14: Re-Deploy = Ersetzen
      replaced: replacingExisting,
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
