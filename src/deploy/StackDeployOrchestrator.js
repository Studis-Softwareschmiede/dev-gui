/**
 * StackDeployOrchestrator — Deploy/Undeploy/Status-Saga für Compose-Stacks (ADR-012-Linie).
 *
 * Architecture boundary: der EINZIGE Ort, der die Stack-Schritte (syncRepo → ensureEnv →
 * composeUp → Route je öffentlichem Container) und Rollback-Kompensation koordiniert.
 * Kein duplizierter Cloudflare-Mutationscode — Route-Anlage läuft ausschliesslich über
 * DeployOrchestrator.addRouteOnly() (geteilter ADR-012-Anlege-Pfad).
 *
 * Design (stack-deploy-orchestration.md AC6–AC10):
 *   Stack-Deploy-Saga:
 *     (a) LockoutGuard-Hard-Block für JEDEN öffentlichen Hostname (AC10)
 *     (b) VpsComposeControl.syncRepo (git clone/pull)
 *     (c) VpsComposeControl.ensureEnv (.env-Materialisierung / Erst-Deploy-Generierung)
 *     (d) VpsComposeControl.composeUp (--project-name <stackName>)
 *     (e) je öffentlichem Service (publicServices): addRouteOnly (ADR-012-Pfad)
 *         → Rollback best-effort wenn Route-Schritt fehlschlägt (AC7)
 *
 *   Stack-Undeploy:
 *     (a) LockoutGuard-Hard-Block je Hostname (AC10)
 *     (b) type-to-confirm (confirm === stackName) (AC8)
 *     (c) Alle Stack-Routen + DNS-CNAMEs entfernen (CloudflareApi)
 *     (d) VpsComposeControl.composeDown (Volumes behalten; AC8)
 *
 *   Stack-Status (AC9):
 *     composePs ⊕ listRoutes je öffentlichem Hostname; Drift-Flags sichtbar.
 *
 * Security:
 *   - LockoutGuard-Hard-Block VOR jedem Schritt (AC10, ADR-011).
 *   - Kein Secret (SSH-Key, CF-Token, generierte App-Boot-Werte) in result/reason (AC11).
 *   - sanitizeReason() entfernt Token-ähnliche Muster aus Fehlermeldungen (security/R01).
 *   - Audit-First ist Pflicht des Callers (stacksRouter).
 *
 * @module deploy/StackDeployOrchestrator
 */

import { isValidHostname } from './hostnameSanitizer.js';

// ── StackDeployOrchestrator ───────────────────────────────────────────────────

export class StackDeployOrchestrator {
  /** @type {import('./VpsComposeControl.js').VpsComposeControl} */
  #composeControl;

  /** @type {import('./DeployOrchestrator.js').DeployOrchestrator} */
  #orchestrator;

  /** @type {import('../cloudflare/CloudflareApi.js').CloudflareApi} */
  #cloudflareApi;

  /** @type {import('../cloudflare/LockoutGuard.js').LockoutGuard} */
  #lockoutGuard;

  /**
   * @param {object} opts
   * @param {import('./VpsComposeControl.js').VpsComposeControl} opts.composeControl
   * @param {import('./DeployOrchestrator.js').DeployOrchestrator} opts.orchestrator
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('../cloudflare/LockoutGuard.js').LockoutGuard} opts.lockoutGuard
   */
  constructor({ composeControl, orchestrator, cloudflareApi, lockoutGuard }) {
    if (!composeControl || typeof composeControl.syncRepo !== 'function') {
      throw new Error('[StackDeployOrchestrator] composeControl ist Pflicht');
    }
    if (!orchestrator || typeof orchestrator.addRouteOnly !== 'function') {
      throw new Error('[StackDeployOrchestrator] orchestrator ist Pflicht (addRouteOnly benötigt)');
    }
    if (!cloudflareApi || typeof cloudflareApi.removeRoute !== 'function') {
      throw new Error('[StackDeployOrchestrator] cloudflareApi ist Pflicht');
    }
    if (!lockoutGuard || typeof lockoutGuard.isProtected !== 'function') {
      throw new Error('[StackDeployOrchestrator] lockoutGuard ist Pflicht');
    }
    this.#composeControl = composeControl;
    this.#orchestrator = orchestrator;
    this.#cloudflareApi = cloudflareApi;
    this.#lockoutGuard = lockoutGuard;
  }

  // ── Stack-Deploy ──────────────────────────────────────────────────────────────

  /**
   * Stack-Deploy-Saga (AC6, AC7, AC10).
   *
   * Schritte: (a) LockoutGuard-Check alle Hostnames → (b) syncRepo →
   * (c) ensureEnv → (d) composeUp → (e) Route je öffentlichem Container.
   * Rollback: schlägt Route-Schritt fehl → bereits angelegte Routen best-effort
   * zurückrollen; Rest-Drift → Reconciliation (AC7).
   *
   * @param {object} opts
   * @param {import('./VpsComposeControl.js').VpsTarget} opts.vps
   * @param {object} opts.stackDef - StackDefinition aus der Registry
   * @param {object} [opts.sshClientFactory] - Testbare SSH-Client-Fabrik
   * @returns {Promise<StackDeployResult>}
   */
  async deploy({ vps, stackDef, _sshClientFactory } = {}) {
    const { stackName, repoUrl, branch, composeFile, overrideFile, tunnelId, publicServices, secretsSpec } = stackDef;

    // (a) AC10: LockoutGuard-Hard-Block für JEDEN öffentlichen Hostname — VOR jedem Schritt
    for (const ps of (publicServices ?? [])) {
      if (!isValidHostname(ps.hostname)) {
        return { result: 'error', reason: `Ungültiger Hostname: ${ps.hostname}`, errorClass: 'validation-error' };
      }
      if (this.#lockoutGuard.isProtected(ps.hostname)) {
        return { result: 'error', reason: 'protected-resource', errorClass: 'protected-resource' };
      }
    }

    // (b) syncRepo — git clone/pull
    const syncResult = await this.#composeControl.syncRepo({
      vps,
      repoUrl,
      branch,
      stackName,
      _sshClientFactory,
    });
    if (syncResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(syncResult.reason ?? 'syncRepo fehlgeschlagen'),
        errorClass: syncResult.errorClass ?? 'error',
      };
    }

    // (c) ensureEnv — .env-Materialisierung (Erst-Deploy: Generierung; Re-Deploy: unveränderter Pass)
    const envResult = await this.#composeControl.ensureEnv({
      vps,
      stackName,
      generateKeys: secretsSpec?.generate ?? [],
      requiredKeys: secretsSpec?.required ?? [],
      _sshClientFactory,
    });
    if (envResult.result === 'error') {
      return {
        result: 'error',
        reason: sanitizeReason(envResult.reason ?? 'ensureEnv fehlgeschlagen'),
        errorClass: envResult.errorClass ?? 'error',
      };
    }

    // (d) composeUp (--project-name <stackName>)
    const upResult = await this.#composeControl.composeUp({
      vps,
      stackName,
      composeFile,
      overrideFile,
      project: stackName,
      _sshClientFactory,
    });
    if (upResult.result !== 'ok') {
      // AC7: schlägt composeUp fehl → kein Route-Schritt
      return {
        result: 'error',
        reason: sanitizeReason(upResult.reason ?? 'composeUp fehlgeschlagen'),
        errorClass: upResult.errorClass ?? 'error',
      };
    }

    // (e) Route je öffentlichem Service (ADR-012-Anlege-Pfad via addRouteOnly)
    // AC7: Rollback best-effort für bereits angelegte Routen bei Fehler
    const addedRoutes = []; // hostname[], für Rollback

    for (const ps of (publicServices ?? [])) {
      const routeResult = await this.#orchestrator.addRouteOnly({
        tunnelId,
        hostname: ps.hostname,
        // hostPort: Stack-interne Services lauschen auf ihren Compose-internen Port;
        // der Cloudflare-Tunnel greift über den Compose-Servicenamen.
        // Default 8080 — Compose-Services exponieren typischerweise 8080 intern.
        hostPort: 8080,
      });

      if (routeResult.result !== 'ok') {
        // AC7: Rollback — alle in DIESEM Lauf bereits angelegten Routen best-effort entfernen
        await this.#rollbackRoutes(tunnelId, addedRoutes);

        return {
          result: 'error',
          reason: sanitizeReason(routeResult.reason ?? `Route für ${ps.hostname} fehlgeschlagen`),
          errorClass: routeResult.errorClass ?? 'error',
        };
      }

      addedRoutes.push(ps.hostname);
    }

    // Erfolg: alle öffentlichen Hostnames geroutet (AC6)
    return {
      result: 'ok',
      stack: {
        stackName,
        routedHostnames: addedRoutes,
        envStatus: envResult.result, // 'generated' | 'exists'
      },
    };
  }

  // ── Stack-Undeploy ────────────────────────────────────────────────────────────

  /**
   * Stack-Undeploy (AC8, AC10).
   *
   * (a) LockoutGuard-Check je Hostname → (b) type-to-confirm →
   * (c) Alle Routen + DNS-CNAMEs entfernen → (d) composeDown (Volumes behalten).
   * Reihenfolge: Routen-zuerst (kein Traffic auf gestoppten Stack).
   *
   * @param {object} opts
   * @param {import('./VpsComposeControl.js').VpsTarget} opts.vps
   * @param {object} opts.stackDef - StackDefinition aus der Registry
   * @param {string} opts.confirm  - muss stackName entsprechen (type-to-confirm)
   * @param {object} [opts._sshClientFactory]
   * @returns {Promise<StackUndeployResult>}
   */
  async undeploy({ vps, stackDef, confirm, _sshClientFactory } = {}) {
    const { stackName, tunnelId, publicServices } = stackDef;

    // (a) AC10: LockoutGuard-Hard-Block je Hostname — VOR jedem Schritt
    for (const ps of (publicServices ?? [])) {
      if (this.#lockoutGuard.isProtected(ps.hostname)) {
        return { result: 'error', reason: 'protected-resource', errorClass: 'protected-resource' };
      }
    }

    // (b) AC8: type-to-confirm — confirm muss stackName entsprechen; VOR jeder Mutation
    if (!confirm || confirm !== stackName) {
      return { result: 'error', reason: 'confirmation-required', errorClass: 'confirmation-required' };
    }

    // (c) Alle Stack-Routen + DNS-CNAMEs entfernen (Routen-zuerst, kein Traffic auf gestoppten Stack)
    const routeErrors = [];
    for (const ps of (publicServices ?? [])) {
      try {
        await this.#cloudflareApi.removeRoute(tunnelId, ps.hostname);
      } catch (err) {
        // Best-effort: Route-Fehler loggen, aber weitermachen mit verbleibendem Drift
        routeErrors.push({ hostname: ps.hostname, errorClass: err?.errorClass ?? 'error' });
      }

      // DNS-CNAME best-effort entfernen
      try {
        const zoneId = await this.#cloudflareApi.resolveZoneForHostname(ps.hostname);
        if (zoneId) {
          await this.#cloudflareApi.deleteDnsRecord(zoneId, ps.hostname);
        }
      } catch {
        // Best-effort DNS-Cleanup — Drift fängt die Reconciliation
      }
    }

    // (d) composeDown (Volumes behalten — AC8: removeVolumes default false)
    const downResult = await this.#composeControl.composeDown({
      vps,
      stackName,
      project: stackName,
      removeVolumes: false,
      _sshClientFactory,
    });
    if (downResult.result !== 'ok') {
      return {
        result: 'error',
        reason: sanitizeReason(downResult.reason ?? 'composeDown fehlgeschlagen'),
        errorClass: downResult.errorClass ?? 'error',
      };
    }

    const response = { result: 'ok' };
    if (routeErrors.length > 0) {
      // Partielle Route-Fehler: Drift → Reconciliation; Undeploy gilt trotzdem als erfolgt
      response.routeDriftWarning = 'Einige Routen konnten nicht entfernt werden — Drift erwartet, Reconciliation greift';
    }
    return response;
  }

  // ── Stack-Status ──────────────────────────────────────────────────────────────

  /**
   * Stack-Status (AC9): composePs ⊕ Routen je öffentlichem Hostname; Drift-Flags.
   *
   * Live-Status ohne State-Store (ADR-005).
   * Degrades per Fehler: Fehler in ps oder routes werden in errors[] gemeldet.
   *
   * @param {object} opts
   * @param {import('./VpsComposeControl.js').VpsTarget} opts.vps
   * @param {object} opts.stackDef - StackDefinition aus der Registry
   * @param {object} [opts._sshClientFactory]
   * @returns {Promise<StackStatusResult>}
   */
  async status({ vps, stackDef, _sshClientFactory } = {}) {
    const { stackName, tunnelId, publicServices } = stackDef;
    const errors = [];

    // composePs — Liste laufender Container im Stack
    const psResult = await this.#composeControl.composePs({
      vps,
      stackName,
      project: stackName,
      _sshClientFactory,
    });

    // Map von service-name → ps-Eintrag
    const runningByService = new Map();
    if (psResult.result === 'ok') {
      for (const c of (psResult.containers ?? [])) {
        runningByService.set(c.service, c);
      }
    } else {
      errors.push({ scope: `composePs:${stackName}`, errorClass: psResult.errorClass ?? 'error' });
    }

    // listRoutes — aktuelle Cloudflare-Routen für diesen Tunnel
    let routes = [];
    try {
      routes = await this.#cloudflareApi.listRoutes(tunnelId);
    } catch (err) {
      errors.push({ scope: `tunnel:${tunnelId}`, errorClass: err?.errorClass ?? 'cloudflare-unavailable' });
    }
    const routeByHostname = new Map(routes.map((r) => [r.hostname, r]));

    // Drift-Join: je öffentlichem Service (publicServices) → containerPresent + routePresent
    const services = [];
    for (const ps of (publicServices ?? [])) {
      const container = runningByService.get(ps.service);
      const route = routeByHostname.get(ps.hostname);
      services.push({
        service: ps.service,
        hostname: ps.hostname,
        status: container?.status ?? null,
        containerPresent: !!container,
        routePresent: !!route,
        // Drift-Flag: Service läuft aber Route fehlt, oder Route vorhanden aber Service nicht
        drift: (!!container !== !!route),
      });
    }

    const statusObj = {
      stackName,
      project: stackName,
      services,
    };
    if (errors.length > 0) statusObj.errors = errors;

    return statusObj;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────────

  /**
   * Best-effort Rollback bereits angelegter Routen (AC7).
   * Fehler werden nicht geworfen — Drift fängt die Reconciliation.
   *
   * @param {string} tunnelId
   * @param {string[]} hostnames
   */
  async #rollbackRoutes(tunnelId, hostnames) {
    for (const hostname of hostnames) {
      try {
        await this.#cloudflareApi.removeRoute(tunnelId, hostname);
      } catch {
        // Best-effort Rollback — Drift → Reconciliation
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Entfernt Token-ähnliche Muster aus Fehlermeldungen.
 * Tokens/Keys dürfen NICHT in result.reason erscheinen (security/R01, AC11).
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
 * @typedef {object} StackDeployResult
 * @property {'ok'|'error'} result
 * @property {object}  [stack]      - Stack-Status auf Erfolg
 * @property {string}  [reason]     - Fehlergrund (keine Secrets)
 * @property {string}  [errorClass] - Maschinenlesbare Fehlerklasse
 */

/**
 * @typedef {object} StackUndeployResult
 * @property {'ok'|'error'} result
 * @property {string}  [reason]
 * @property {string}  [errorClass]
 * @property {string}  [routeDriftWarning]
 */

/**
 * @typedef {object} StackStatusResult
 * @property {string}   stackName
 * @property {string}   project
 * @property {object[]} services  - [{ service, hostname, status, containerPresent, routePresent, drift }]
 * @property {object[]} [errors]  - [{ scope, errorClass }]
 */
