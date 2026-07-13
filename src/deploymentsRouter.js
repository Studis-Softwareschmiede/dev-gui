/**
 * deploymentsRouter — Express-Router für Deploy-Lifecycle (AC3–AC9, ADR-012)
 *                     + Reconciliation-Endpunkte (AC2/AC8/AC8b, ADR-013)
 *                     + Lokaler Image-Test (S-156, AC1–AC5)
 *                     + Readiness-Endpunkt (S-180, AC7–AC8)
 *                     + VPS-Tunnel-Read-Model (S-185 AC7).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET    /api/deployments/vps-targets              → { vpsIds, tunnelInfo? } [READ-ONLY, S-185 AC7]
 *   GET    /api/deployments/vps-tunnel-status        → [{ vpsId, tunnelId, tunnelPresent }] [READ-ONLY, S-185 AC7]
 *   GET    /api/deployments/readiness?vps=<vpsId>    → { state: "unreachable"|"provisioning"|"ready" } [READ-ONLY, S-180 AC7]
 *   GET    /api/deployments                          → { deployments: Deployment[], errors? }
 *   POST   /api/deployments                          → { result, deployment?, reason? }   [MUTATION]
 *   DELETE /api/deployments/:vps/:hostname           → { result, reason? }               [MUTATION]
 *   POST   /api/deployments/reconcile                → { result, report? }               [MUTATION]
 *   GET    /api/deployments/reconcile/last           → ReconcileReport | {}
 *   GET    /api/deployments/reconcile/reports        → ReconcileReport[]
 *   GET    /api/deployments/reconcile/notices        → ReconcileNotice[]
 *   POST   /api/deployments/local-test               → { result, report? }               [MUTATION, S-156]
 *   POST   /api/deployments/vps/:vpsId/tunnel/recreate → { result, report } [MUTATION, S-187 AC1–5,11,12 + S-188 AC6–8]
 *   POST   /api/deployments/:app/gpg-provision        → { result, reason? } [MUTATION, F-073/S-335 AC10]
 *   POST   /api/deployments/:app/gpg-rotate/start             → { ok, phase?, errorClass?, reason? } [MUTATION, F-073/S-338]
 *   POST   /api/deployments/:app/gpg-rotate/commit            → { ok, errorClass?, reason? }         [MUTATION, F-073/S-338]
 *   POST   /api/deployments/:app/gpg-rotate/discard-previous  → { ok, errorClass?, reason? }         [MUTATION, F-073/S-338]
 *
 * Security (AC7–AC9 / ADR-012):
 *   - Alle /api/deployments/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (POST, DELETE) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie ADR-007/vpsRouter).
 *   - Audit-First: Audit-Eintrag VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt.
 *   - LockoutGuard-Hard-Block: protected Hostname → 422 before any step (AC7).
 *   - Undeploy: type-to-confirm (confirm must equal hostname) (AC6).
 *   - SSH-Key + Cloudflare-Token erscheinen NIEMALS in Response, Log, Audit, WS oder URL.
 *   - Untrusted Input (vps, hostname, image, confirm) wird validiert (security/R02/R03).
 *   - Readiness-Endpunkt (S-180): read-only, kein Audit, keine Mutation, kein Secret in Response.
 *   - VPS-Tunnel-Read-Model (S-185 AC7): read-only, kein Audit, kein Tunnel-Token, nur tunnelId.
 *   - GPG-Provisionierung (F-073/S-335 AC10): hinter AccessGuard + CRED_ADMIN_EMAILS;
 *     Response geheimnisfrei ({ result, reason? }) — nie die Passphrase (AC8).
 *   - GPG-Rotation (F-073/S-338 AC7): hinter AccessGuard + CRED_ADMIN_EMAILS;
 *     Response geheimnisfrei ({ ok, phase?, errorClass?, reason? }) — nie alte/
 *     neue Passphrase, nie .env.gpg-Klartext.
 *
 * VPS configuration: The router receives a pre-configured vpsConfig map
 * (vpsId → VpsTarget) from server.js. The client sends a vpsId string;
 * the router resolves it to the target server-internally.
 *
 * @module deploymentsRouter
 */

import { Router } from 'express';
import { isValidHostname } from './deploy/hostnameSanitizer.js';

/** Maximum allowed length for free-text fields. */
const MAX_FIELD_LEN = 512;

/** Hostname param: only DNS chars, no shell metacharacters. */
const HOSTNAME_PARAM_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * App-Slug-Param (F-073/S-335 :app): analog zur repo-weiten PROJECT_SLUG_RE-Konvention
 * (DrainReportStore, DrainJobRegistry, RegressionResultStore, TickerSettingsStore).
 */
const APP_SLUG_PARAM_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_SLUG_LEN = 128;

// ── Local-Test Validation (S-156, AC5) ────────────────────────────────────────

/**
 * ghcr image reference: letters, digits, dots, underscores, forward slashes, colons, hyphens.
 * No shell metacharacters (AC5).
 */
const IMAGE_RE = /^[A-Za-z0-9._/:@-]+$/;

/** Maximum image reference length. */
const MAX_IMAGE_LEN = 512;

/**
 * Tag: letters, digits, dots, underscores, hyphens — no shell metacharacters (AC5).
 */
const TAG_RE = /^[A-Za-z0-9._-]+$/;

/** Maximum tag length. */
const MAX_TAG_LEN = 128;

/**
 * Validates POST /api/deployments/local-test body (AC5).
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: { image: string, tag: string }, error?: string }}
 */
function validateLocalTestBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }
  const { image, tag } = body;

  if (typeof image !== 'string' || !image.trim()) {
    return { ok: false, error: 'image ist ein Pflichtfeld' };
  }
  if (image.trim().length > MAX_IMAGE_LEN) {
    return { ok: false, error: `image überschreitet Längenlimit (max. ${MAX_IMAGE_LEN})` };
  }
  if (!IMAGE_RE.test(image.trim())) {
    return { ok: false, error: 'image enthält ungültige Zeichen (nur ghcr-Referenz-Zeichensatz erlaubt)' };
  }

  if (typeof tag !== 'string' || !tag.trim()) {
    return { ok: false, error: 'tag ist ein Pflichtfeld' };
  }
  if (tag.trim().length > MAX_TAG_LEN) {
    return { ok: false, error: `tag überschreitet Längenlimit (max. ${MAX_TAG_LEN})` };
  }
  if (!TAG_RE.test(tag.trim())) {
    return { ok: false, error: 'tag enthält ungültige Zeichen (nur alphanumerisch, Punkte, Bindestriche, Unterstriche)' };
  }

  return { ok: true, params: { image: image.trim(), tag: tag.trim() } };
}

// ── Authz-Helper (same pattern as vpsRouter / credentialsRouter) ──────────────

/**
 * Checks whether the requesting identity is allowed to mutate
 * (CRED_ADMIN_EMAILS-logic, AC8/ADR-007).
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

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validates the POST /api/deployments request body.
 * zoneId is NOT in the body — resolved server-side from hostname (Spec-Gap-Resolution).
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateDeployBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }

  const { image, vps, hostname, tunnelId, gpgBwItem } = body;

  if (typeof image !== 'string' || !image.trim()) {
    return { ok: false, error: 'image ist ein Pflichtfeld' };
  }
  if (image.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `image überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  if (typeof vps !== 'string' || !vps.trim()) {
    return { ok: false, error: 'vps ist ein Pflichtfeld' };
  }
  if (vps.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `vps überschreitet Längenlimit` };
  }

  if (typeof hostname !== 'string' || !hostname.trim()) {
    return { ok: false, error: 'hostname ist ein Pflichtfeld' };
  }
  if (!isValidHostname(hostname.trim())) {
    return { ok: false, error: 'hostname enthält ungültige Zeichen (nur DNS-Zeichensatz erlaubt)' };
  }

  if (typeof tunnelId !== 'string' || !tunnelId.trim()) {
    return { ok: false, error: 'tunnelId ist ein Pflichtfeld' };
  }
  if (tunnelId.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `tunnelId überschreitet Längenlimit` };
  }

  // F-072/S-334: optionaler Bitwarden-Item-Name für die per-App-GPG-Passphrase.
  // Gesetzt → dieser Deploy braucht die Passphrase (Guard + Injektion greifen).
  // Zeichensatz wie Bitwarden-Item-Namen: Buchstaben/Ziffern/._:- (kein Shell-Metazeichen).
  let gpgItem = null;
  if (gpgBwItem !== undefined && gpgBwItem !== null && gpgBwItem !== '') {
    if (typeof gpgBwItem !== 'string' || !gpgBwItem.trim()) {
      return { ok: false, error: 'gpgBwItem muss ein nicht-leerer String sein' };
    }
    const trimmed = gpgBwItem.trim();
    if (trimmed.length > MAX_FIELD_LEN) {
      return { ok: false, error: 'gpgBwItem überschreitet Längenlimit' };
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
      return { ok: false, error: 'gpgBwItem enthält ungültige Zeichen (nur A-Z a-z 0-9 . _ : -)' };
    }
    gpgItem = trimmed;
  }

  return {
    ok: true,
    params: {
      image: image.trim(),
      vps: vps.trim(),
      hostname: hostname.trim(),
      tunnelId: tunnelId.trim(),
      gpgBwItem: gpgItem,
    },
  };
}

/**
 * Validates the DELETE /api/deployments/:vps/:hostname request params and body.
 * zoneId is NOT required in the body — resolved server-side from hostname.
 *
 * @param {object} params - Express route params
 * @param {unknown} body  - Request body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateUndeployParams(params, body) {
  const { vps: vpsParam, hostname: hostnameParam } = params;

  if (!vpsParam || typeof vpsParam !== 'string' || !vpsParam.trim()) {
    return { ok: false, error: 'vps-Parameter fehlt' };
  }

  if (!hostnameParam || typeof hostnameParam !== 'string' || !hostnameParam.trim()) {
    return { ok: false, error: 'hostname-Parameter fehlt' };
  }

  if (!HOSTNAME_PARAM_RE.test(hostnameParam.trim())) {
    return { ok: false, error: 'hostname enthält ungültige Zeichen' };
  }

  const confirm = body?.confirm;
  const tunnelId = body?.tunnelId;

  if (typeof tunnelId !== 'string' || !tunnelId.trim()) {
    return { ok: false, error: 'tunnelId ist ein Pflichtfeld im Body' };
  }

  return {
    ok: true,
    params: {
      vps: vpsParam.trim(),
      hostname: hostnameParam.trim(),
      confirm: typeof confirm === 'string' ? confirm : '',
      tunnelId: tunnelId.trim(),
    },
  };
}

// ── Vereinigte VPS-Ziel-Auflösung (AC9) ──────────────────────────────────────

/**
 * Löst eine vpsId zur vereinigten VpsTarget-Quelle (Env-Map ⊕ dynamische Records) auf.
 *
 * Strategie (AC9, identisch zu vps-targets-Listing AC3 + resolveVpsTarget AC4):
 *   1. Env-Map (vpsTargets): direkter Key-Lookup → Env gewinnt bei Kollision.
 *   2. Dynamische Records (vpsRegistry.listTargetRecords()): exakter _vpsId-Match.
 *      Ist host null/veraltet, wird er über getMachineIp aufgefrischt (AC2-Analogie).
 *   3. Kein Treffer → undefined (→ 422 "Unbekannter VPS: <vpsId>").
 *
 * Security (AC8): kein SSH-Key, kein Tunnel-Token in der Rückgabe (nur host/port/targetUser).
 * Die 422-Fehlermeldung enthält nur die vpsId, kein host/targetUser/Key.
 *
 * @param {string} vpsId - sanitisierter VPS-Name aus Request
 * @param {Map<string, { host: string, port?: number, targetUser: string }>} vpsTargets
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry|undefined} vpsRegistry
 * @returns {Promise<{ host: string, port: number, targetUser: string } | undefined>}
 */
async function resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry) {
  // ── 1. Env-Map: Env gewinnt bei Kollision (Override/Fallback) ──
  const envTarget = vpsTargets.get(vpsId);
  if (envTarget) {
    return { host: envTarget.host, port: envTarget.port ?? 22, targetUser: envTarget.targetUser };
  }

  // ── 2. Dynamische Records (vpsRegistry) ──
  if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
    try {
      const records = await vpsRegistry.listTargetRecords();
      const match = records.find((r) => r._vpsId === vpsId);
      if (match) {
        // Host aus Record; bei null/leer über getMachineIp auffrischen (AC2-Analogie)
        let host = match.host ?? null;
        if (!host && typeof vpsRegistry.getMachineIp === 'function') {
          try {
            host = await vpsRegistry.getMachineIp(match.provider, match.serverId);
          } catch {
            // Degradierend — IP-Refresh fehlgeschlagen; host bleibt null
          }
        }
        if (host) {
          // Security-Floor (AC8): nur Verbindungs-Metadaten, kein Key/Token
          return { host, port: match.port ?? 22, targetUser: match.targetUser ?? 'root' };
        }
        // host nicht auflösbar (kein Host in Record und getMachineIp fehlgeschlagen):
        // kein Ziel lieferbar → undefined (→ 422), kein Crash
      }
    } catch {
      // Degradierend — Store-Fehler bei listTargetRecords → kein Ziel via dynamische Quelle
    }
  }

  // ── 3. Keine Quelle kennt die vpsId → undefined (→ 422) ──
  return undefined;
}

// ── Router Factory ─────────────────────────────────────────────────────────────

/**
 * Creates the deployments router.
 *
 * @param {import('./deploy/DeployOrchestrator.js').DeployOrchestrator} orchestrator
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @param {Map<string, object>} vpsTargets - map of vpsId → VpsTarget { host, port?, targetUser }
 * @param {import('./deploy/ReconciliationJob.js').ReconciliationJob} [reconciliationJob]
 * @param {import('./deploy/LocalDockerControl.js').LocalDockerControl} [localDockerControl]
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry} [vpsRegistry]
 *   Optionale Registry-Referenz für dynamische VPS-Ziel-Auflösung (S-167 AC3, S-169 AC9).
 *   Wenn gesetzt: dynamisch angelegte VPS erscheinen zusätzlich zur Env im Dropdown
 *   und sind über Deploy/Undeploy/Listing auflösbar.
 *   Env gewinnt bei Kollision (Override/Fallback).
 * @param {import('./deploy/VpsDockerControl.js').VpsDockerControl} [vpsDockerControl]
 *   Optional injected for the readiness endpoint (S-180 AC7–AC8).
 *   When provided, GET /api/deployments/readiness?vps=<vpsId> uses probe() read-only.
 * @param {import('./cloudflare/CloudflareApi.js').CloudflareApi} [cloudflareApi]
 *   Optional injected for the VPS-Tunnel-Read-Model (S-185 AC7).
 *   When provided, GET /api/deployments/vps-tunnel-status uses listTunnels() to check existence.
 *   When absent, tunnelPresent degrades to null/"unknown" (no crash).
 * @param {import('./deploy/TunnelHealService.js').TunnelHealService} [tunnelHealService]
 *   Optional injected for the Tunnel-Selbstheilung (S-187 AC1–AC5, AC11, AC12).
 *   When provided, POST /api/deployments/vps/:vpsId/tunnel/recreate is active.
 * @param {import('./PerAppGpgProvisioningService.js').PerAppGpgProvisioningService} [perAppGpgProvisioningService]
 *   Optional injected for the Nach-Provisionierungs-Endpunkt (F-073/S-335 AC10).
 *   When provided, POST /api/deployments/:app/gpg-provision is active.
 * @returns {import('express').Router}
 */
export function deploymentsRouter(orchestrator, auditStore, vpsTargets, reconciliationJob, localDockerControl, vpsRegistry, vpsDockerControl, cloudflareApi, tunnelHealService, deployAccessStore, deployLoginService, perAppGpgProvisioningService, perAppGpgRotationService) {
  const router = Router();

  // ── GET /api/deployments/vps-targets ────────────────────────────────────
  // Returns the unified list of VPS IDs (dynamisch ⊕ Env) for the frontend dropdown.
  // S-167 AC3: dynamisch angelegte VPS + VPS_TARGETS-Env; Env gewinnt bei Kollision.
  // S-185 AC7 (additiv): liefert zusätzlich tunnelId pro VPS-Eintrag (nicht-geheim, aus Target-Record).
  //   Kein Tunnel-Token, kein host/user/key.
  // Read-only — no mutation, no secrets (only IDs + tunnelId, no host/user/key exposed — AC8).
  router.get('/api/deployments/vps-targets', async (_req, res) => {
    // Env-IDs als Override-Menge (Env gewinnt bei Kollision)
    const envIds = new Set(vpsTargets.keys());

    // Dynamische Records aus persistierten Target-Records (S-167 AC3, S-185 AC7)
    // _vpsId = sanitisierter VPS-Name; tunnelId = registrierte Tunnel-Id (nicht-geheim)
    const dynamicIds = new Set();
    /** @type {Map<string, string|null>} vpsId → registrierte tunnelId (oder null) */
    const tunnelIdMap = new Map();

    // I2: Env-VPS werden mit null-tunnelId vorbelegt, damit das Read-Model vollständig ist
    // (konsistent mit /vps-tunnel-status, das Env-VPS ebenfalls mit tunnelId:null listet).
    for (const id of envIds) {
      tunnelIdMap.set(id, null);
    }

    if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
      try {
        const records = await vpsRegistry.listTargetRecords();
        for (const record of records) {
          if (record._vpsId) {
            dynamicIds.add(record._vpsId);
            // S-185 AC7: tunnelId aus Target-Record (nicht-geheim, AC12-konform)
            // Nur die ID, niemals das Token (store-intern)
            // Env-Kollision: dynamischer Record kann tunnelId überschreiben (Env hat bereits null)
            tunnelIdMap.set(record._vpsId, record.tunnelId ?? null);
          }
        }
      } catch {
        // Degradierend: Quell-Fehler → nur Env-IDs zurückliefern (kein Crash)
      }
    }

    // Vereinigung: Env-IDs zuerst, dann dynamische IDs die noch nicht vorhanden sind
    // (Env gewinnt bei Kollision bzgl. VPS-Auflösung; tunnelId kommt vom dynamischen Record)
    const ids = [...envIds];
    for (const id of dynamicIds) {
      if (!envIds.has(id)) ids.push(id);
    }

    // Security-Floor (AC8, AC12): nur IDs + tunnelId — kein host/user/key/token in der Response
    return res.json({ vpsIds: ids, tunnelIds: Object.fromEntries(tunnelIdMap) });
  });

  // ── GET /api/deployments/vps-tunnel-status ──────────────────────────────
  // VPS-Tunnel-Read-Model (S-185 AC7): read-only, kein Audit, kein Tunnel-Token.
  // Liefert je VPS: { vpsId, tunnelId: string|null, tunnelPresent: boolean|"unknown" }
  // Cloudflare nicht erreichbar → tunnelPresent: "unknown" (kein Crash, degradierend).
  // MUSS vor GET /api/deployments/readiness und GET /api/deployments stehen
  // (kein Pfadkonflikt, aber klare Reihenfolge — kein :vps-Match).
  router.get('/api/deployments/vps-tunnel-status', async (_req, res) => {
    // Alle bekannten vpsIds sammeln (Env ⊕ dynamisch)
    const envIds = new Set(vpsTargets.keys());
    /** @type {Map<string, string|null>} vpsId → registrierte tunnelId */
    const tunnelIdMap = new Map();

    // Env-VPS haben keine registrierte Tunnel-Id im Store (nur in dynamischen Records)
    for (const id of envIds) {
      tunnelIdMap.set(id, null);
    }

    if (vpsRegistry && typeof vpsRegistry.listTargetRecords === 'function') {
      try {
        const records = await vpsRegistry.listTargetRecords();
        for (const record of records) {
          if (record._vpsId) {
            // Security-Floor (AC12): nur tunnelId (nicht-geheim), niemals tunnelToken
            tunnelIdMap.set(record._vpsId, record.tunnelId ?? null);
          }
        }
      } catch {
        // Degradierend: Store-Fehler → tunnelIds bleiben null für dynamische VPS
      }
    }

    // Eindeutige tunnelIds für einen einzelnen listTunnels()-Call ermitteln
    const uniqueTunnelIds = new Set(
      [...tunnelIdMap.values()].filter((id) => typeof id === 'string' && id),
    );

    /** @type {Set<string>} Tunnel-Ids die in Cloudflare existieren */
    const existingTunnelIds = new Set();
    let cloudflareAvailable = true;

    if (cloudflareApi && typeof cloudflareApi.listTunnels === 'function' && uniqueTunnelIds.size > 0) {
      try {
        // Ein einziger listTunnels()-Call (AC7: kein Polling-Sturm)
        // listTunnels() nimmt einen zoneId-Parameter (für Annotation), wir übergeben einen
        // Platzhalter — die Existenz-Prüfung braucht nur die id-Felder (AC7 Spec-Kommentar).
        const tunnels = await cloudflareApi.listTunnels('');
        for (const t of tunnels ?? []) {
          if (t?.id) existingTunnelIds.add(t.id);
        }
      } catch {
        // AC7: Cloudflare nicht konsultierbar → tunnelPresent: "unknown" (kein Crash)
        cloudflareAvailable = false;
      }
    } else if (!cloudflareApi) {
      // AC7: Cloudflare nicht konfiguriert → tunnelPresent: "unknown"
      cloudflareAvailable = false;
    }

    // Read-Model aufbauen: { vpsId, tunnelId, tunnelPresent }
    // Security-Floor (AC12): kein Tunnel-Token, kein host/key in Response
    const result = [];
    for (const [vpsId, tunnelId] of tunnelIdMap) {
      let tunnelPresent;
      if (!tunnelId) {
        // Kein Tunnel registriert → kein Cloudflare-Check nötig
        tunnelPresent = false;
      } else if (!cloudflareAvailable) {
        // AC7: Cloudflare nicht erreichbar → degradiert sichtbar
        tunnelPresent = 'unknown';
      } else {
        tunnelPresent = existingTunnelIds.has(tunnelId);
      }
      result.push({ vpsId, tunnelId, tunnelPresent });
    }

    return res.json(result);
  });

  // ── GET /api/deployments/readiness ───────────────────────────────────────
  // S-180 AC7–AC8: Read-only Bereitschafts-Probe. Kein Audit, keine Mutation, kein Secret.
  // MUSS vor GET /api/deployments stehen (sonst würde "readiness" als tunnelId-Query-Param
  // interpretiert, da /api/deployments keine Pfad-Segmente hat — kein echtes Express-Konflikt,
  // aber semantisch klar vor dem allgemeinen Listing-Endpunkt).
  // Hinter AccessGuard: server.js setzt app.use('/api', accessGuard) vor mountRouters().

  /**
   * GET /api/deployments/readiness?vps=<vpsId>
   * Read-only Bereitschafts-Probe via VpsDockerControl.probe() (AC7).
   * Kein Audit-Eintrag, keine Mutation, kein Container, keine Route (AC8).
   *
   * Query params: vps (required)
   *
   * Responses:
   *   200 { state: "unreachable"|"provisioning"|"ready" }
   *   400 { error }  — vps-Parameter fehlt
   *   403            — kein gültiger Access (AccessGuard, server.js)
   *   422 { error }  — unbekannte vpsId ("Unbekannter VPS: <id>")
   *   503 { error }  — vpsDockerControl nicht konfiguriert
   */
  router.get('/api/deployments/readiness', async (req, res) => {
    const { vps: vpsId } = req.query;

    // AC7: vps Query-Parameter ist Pflicht
    if (!vpsId || typeof vpsId !== 'string' || !vpsId.trim()) {
      return res.status(400).json({ error: 'vps query-Parameter ist Pflicht' });
    }

    // AC7: Vereinigte VPS-Auflösung (Env-Map ⊕ dynamische Records) — analog Deploy-Pfad
    const vpsTarget = await resolveVpsIdToTarget(vpsId.trim(), vpsTargets, vpsRegistry);
    if (!vpsTarget) {
      // AC7: 422 mit vpsId — kein host/targetUser/key in Response (AC8, Security-Floor)
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId.trim()}` });
    }

    // Dependency-Guard: vpsDockerControl muss injiziert sein
    if (!vpsDockerControl || typeof vpsDockerControl.probe !== 'function') {
      return res.status(503).json({ error: 'Readiness-Probe nicht konfiguriert' });
    }

    // AC7: Probe ausführen — probe() wirft NIE (alle Fehler → definierter Zustand)
    // AC8: Kein Audit-Eintrag (read-only, kein Audit-First nötig)
    // Defensive try/catch: probe() ist per Spec NIE-werfend; schützt gegen künftige Umbauten.
    let probeResult;
    try {
      probeResult = await vpsDockerControl.probe(vpsTarget);
    } catch {
      // Unerwarteter Fehler in probe() — secret-freie Meldung, kein host/key/token
      return res.status(502).json({ error: 'Readiness-Probe fehlgeschlagen (interner Fehler)' });
    }

    // AC8: Nur state + optionale neutrale reason in Response — kein Host, Key, Token
    const response = { state: probeResult.state };
    // reason ist optional und muss secret-frei sein (probe() garantiert das per Spec)
    if (probeResult.reason) {
      response.reason = probeResult.reason;
    }
    return res.status(200).json(response);
  });

  // ── GET /api/deployments ──────────────────────────────────────────────────

  /**
   * GET /api/deployments
   * Live listing: container-labels ⊕ cloudflare-routes, no Deploy-State-Store.
   * Degrades per VPS/zone.
   *
   * Query params: vps (required), tunnelId (required)
   *
   * Response: { deployments: Deployment[], errors?: [{ scope, errorClass }] }
   */
  router.get('/api/deployments', async (req, res) => {
    const { vps: vpsId, tunnelId } = req.query;

    if (!vpsId || typeof vpsId !== 'string' || !vpsId.trim()) {
      return res.status(422).json({ error: 'vps query-Parameter ist Pflicht' });
    }
    if (!tunnelId || typeof tunnelId !== 'string' || !tunnelId.trim()) {
      return res.status(422).json({ error: 'tunnelId query-Parameter ist Pflicht' });
    }

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId.trim(), vpsTargets, vpsRegistry);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId.trim()}` });
    }

    try {
      const result = await orchestrator.listDeployments({
        vps: vpsTarget,
        tunnelId: tunnelId.trim(),
      });
      return res.json(result);
    } catch (err) {
      console.error('[deploymentsRouter] GET /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ error: 'Deployments konnten nicht geladen werden' });
    }
  });

  // ── POST /api/deployments ─────────────────────────────────────────────────

  /**
   * POST /api/deployments
   * Deploy: ghcr-Image → Container + Tunnel-Route + DNS-CNAME (atomare Saga).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC8/AC9).
   *
   * Body: { image, vps, hostname, tunnelId }
   *   — zoneId is resolved server-side from hostname (Spec-Gap-Resolution)
   *
   * Responses:
   *   200 { result: "ok", deployment }
   *   400 { error }           — Validierungsfehler
   *   403 { error }           — nicht in CRED_ADMIN_EMAILS
   *   422 { result: "error", reason: "protected-resource" }  — LockoutGuard (AC7)
   *   422 { result: "error", reason: "zone-not-found" }      — kein Zone-Match
   *   500 { error }           — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.post('/api/deployments', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Validate body
    const bodyVal = validateDeployBody(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { image, vps: vpsId, hostname, tunnelId, gpgBwItem } = bodyVal.params;

    // ── F-072/S-334: Deploy-Guard (VOR jeder Mutation, AC12) ──────────────────
    // Braucht dieser Deploy eine per-App-GPG-Passphrase (gpgBwItem gesetzt) und ist
    // der Bitwarden-Deploy-Zugang NICHT bereit → Abbruch mit klarem Hinweis, KEIN
    // docker run, KEIN Teil-Deploy. Braucht das Ziel keine Passphrase (gpgBwItem
    // fehlt) → Guard greift nicht, Deploy läuft unverändert (AC13).
    if (gpgBwItem) {
      if (!deployAccessStore || typeof deployAccessStore.getStatus !== 'function' ||
          !deployLoginService || typeof deployLoginService.fetchItemPassword !== 'function') {
        return res.status(503).json({ result: 'error', reason: 'deploy-access-unavailable' });
      }
      let accessStatus;
      try {
        accessStatus = await deployAccessStore.getStatus();
      } catch {
        accessStatus = { ready: false };
      }
      if (!accessStatus.ready) {
        return res.status(422).json({
          result: 'error',
          errorClass: 'bitwarden-access-missing',
          reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
        });
      }
    }

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId}` });
    }

    // AC9: Audit-First — Eintrag VOR der Mutation; Token/Key NICHT im Audit
    const auditAction = `deploy:create:${vpsId}:${hostname}:${image}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // ── F-072/S-334: per-App-GPG-Passphrase aus Bitwarden holen (AC14/AC15) ────
    // Erst NACH dem Audit-First, VOR dem eigentlichen Deploy. Der Wert wird NUR als
    // containerEnv weitergereicht — nie geloggt/auditiert/zurückgegeben (S1). Der
    // fetch-Audit (nur Item-Name, ohne Wert) erfolgt im Login-Dienst.
    let containerEnv;
    if (gpgBwItem) {
      try {
        const passphrase = await deployLoginService.fetchItemPassword(gpgBwItem, { identity: identity?.email ?? null });
        containerEnv = { GPG_PASSPHRASE: passphrase };
      } catch (err) {
        const cls = err?.deployErrorClass ?? 'error';
        if (cls === 'item-not-found') {
          return res.status(422).json({
            result: 'error',
            errorClass: 'gpg-item-not-found',
            reason: `Bitwarden-Item „${gpgBwItem}" nicht gefunden — bitte die per-App-Passphrase dort anlegen.`,
          });
        }
        if (cls === 'access-incomplete') {
          return res.status(422).json({
            result: 'error',
            errorClass: 'bitwarden-access-missing',
            reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
          });
        }
        // auth-failed | unlock-failed | bw-unreachable | error
        return res.status(502).json({
          result: 'error',
          errorClass: 'bitwarden-login-failed',
          reason: 'Bitwarden-Zugriff für die Deploy-Passphrase fehlgeschlagen — Zugang prüfen.',
        });
      }
    }

    // Execute deploy saga (zoneId resolved server-side in DeployOrchestrator)
    // vpsId is passed for tunnel-mismatch/-missing checks (S-185 AC5/AC6)
    let result;
    try {
      result = await orchestrator.deploy({
        image,
        vps: vpsTarget,
        hostname,
        tunnelId,
        vpsId,
        ...(containerEnv ? { containerEnv } : {}),
      });
    } catch (err) {
      const errorClass = err?.errorClass ?? 'error';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:create:${vpsId}:${hostname}:failed:${errorClass}`,
        });
      } catch { /* ignore outcome-audit failure */ }
      console.error('[deploymentsRouter] POST /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Deploy fehlgeschlagen' });
    }

    // Map errorClasses to HTTP status
    if (result.result !== 'ok') {
      const { errorClass, reason } = result;
      // Outcome-audit on failure
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:create:${vpsId}:${hostname}:failed:${errorClass ?? 'error'}`,
        });
      } catch { /* ignore */ }

      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'confirmation-required') {
        return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
      }
      if (errorClass === 'zone-not-found') {
        return res.status(422).json({ result: 'error', reason: 'zone-not-found' });
      }
      if (errorClass === 'vps-provisioning') {
        // AC4 (vps-readiness-gate): VPS noch nicht bereit — freundliche Meldung, kein 5xx
        return res.status(422).json({ result: 'error', errorClass: 'vps-provisioning', reason: sanitizeMsg(reason ?? 'VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen') });
      }
      if (errorClass === 'tunnel-missing') {
        // S-185 AC1/AC6: Tunnel fehlt in Cloudflare oder kein Tunnel dem VPS zugeordnet
        return res.status(422).json({ result: 'error', errorClass: 'tunnel-missing', reason: sanitizeMsg(reason ?? 'Tunnel für diesen VPS fehlt in Cloudflare – bitte über „Tunnel neu anlegen & bestücken" wiederherstellen') });
      }
      if (errorClass === 'tunnel-mismatch') {
        // S-185 AC5: Mitgegebene tunnelId stimmt nicht mit registrierter überein
        return res.status(422).json({ result: 'error', errorClass: 'tunnel-mismatch', reason: sanitizeMsg(reason ?? 'Tunnel-ID stimmt nicht mit dem für diesen VPS registrierten Tunnel überein (Fehlverdrahtungs-Schutz)') });
      }
      if (errorClass === 'cloudflare-not-configured') {
        return res.status(422).json({ result: 'error', errorClass: 'cloudflare-not-configured', reason: sanitizeMsg(reason ?? 'Cloudflare nicht konfiguriert – Tunnel-Existenz nicht prüfbar') });
      }
      if (errorClass === 'cloudflare-auth-failed') {
        return res.status(502).json({ result: 'error', errorClass: 'cloudflare-auth-failed', reason: sanitizeMsg(reason ?? 'Cloudflare-Authentifizierung fehlgeschlagen') });
      }
      if (errorClass === 'cloudflare-unavailable') {
        return res.status(502).json({ result: 'error', errorClass: 'cloudflare-unavailable', reason: sanitizeMsg(reason ?? 'Cloudflare nicht erreichbar') });
      }
      if (errorClass === 'validation-error') {
        return res.status(400).json({ result: 'error', reason });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(reason ?? 'Deploy fehlgeschlagen') });
    }

    // Outcome-audit on success
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `deploy:create:${vpsId}:${hostname}:success:${result.deployment?.containerId ?? ''}`,
      });
    } catch { /* ignore */ }

    return res.status(200).json(result);
  });

  // ── DELETE /api/deployments/:vps/:hostname ────────────────────────────────

  /**
   * DELETE /api/deployments/:vps/:hostname
   * Undeploy: remove Route+DNS → Container rm.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz + type-to-confirm (AC5/AC6/AC8/AC9).
   *
   * Body: { confirm: "<hostname>", tunnelId }
   *   — zoneId is resolved server-side from hostname (Spec-Gap-Resolution)
   *
   * Responses:
   *   200 { result: "ok" }
   *   400 { error }           — Validierungsfehler
   *   403 { error }           — nicht in CRED_ADMIN_EMAILS
   *   422 { result: "error", reason: "protected-resource" }   — LockoutGuard (AC7)
   *   422 { result: "error", reason: "confirmation-required" } — falsch/fehlendes confirm (AC6)
   *   500 { error }           — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — SSH/Cloudflare-Fehler
   */
  router.delete('/api/deployments/:vps/:hostname', async (req, res) => {
    const identity = req.identity ?? null;

    // AC8: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Validate params + body
    const paramsVal = validateUndeployParams(req.params, req.body);
    if (!paramsVal.ok) {
      return res.status(400).json({ error: paramsVal.error });
    }
    const { vps: vpsId, hostname, confirm, tunnelId } = paramsVal.params;

    // AC9: Vereinigte Auflösung (Env-Map ⊕ dynamische Records, Env gewinnt bei Kollision)
    const vpsTarget = await resolveVpsIdToTarget(vpsId, vpsTargets, vpsRegistry);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsId}` });
    }

    // AC9: Audit-First — look up container image BEFORE audit to embed in audit string (AC9).
    // If container not found → use 'image:unknown'. Audit stays before mutation.
    let imageForAudit = 'image:unknown';
    try {
      const listResult = await orchestrator.listDeployments({ vps: vpsTarget, tunnelId });
      if (listResult.deployments) {
        const found = listResult.deployments.find((d) => d.hostname === hostname);
        if (found?.image) {
          imageForAudit = found.image;
        }
      }
    } catch {
      // Best-effort image lookup — audit proceeds with 'image:unknown'
    }

    // AC9: Audit-First — VOR der Mutation; Token/Key NICHT im Audit
    const auditAction = `deploy:remove:${vpsId}:${hostname}:${imageForAudit}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Execute undeploy (zoneId resolved server-side in DeployOrchestrator)
    let result;
    try {
      result = await orchestrator.undeploy({
        vps: vpsTarget,
        hostname,
        confirm,
        tunnelId,
      });
    } catch (err) {
      const errorClass = err?.errorClass ?? 'error';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:remove:${vpsId}:${hostname}:failed:${errorClass}`,
        });
      } catch { /* ignore */ }
      console.error('[deploymentsRouter] DELETE /api/deployments Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Undeploy fehlgeschlagen' });
    }

    // Map errorClasses to HTTP status
    if (result.result !== 'ok') {
      const { errorClass, reason } = result;
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `deploy:remove:${vpsId}:${hostname}:failed:${errorClass ?? 'error'}`,
        });
      } catch { /* ignore */ }

      if (errorClass === 'protected-resource') {
        return res.status(422).json({ result: 'error', reason: 'protected-resource' });
      }
      if (errorClass === 'confirmation-required') {
        return res.status(422).json({ result: 'error', reason: 'confirmation-required' });
      }
      return res.status(502).json({ result: 'error', reason: sanitizeMsg(reason ?? 'Undeploy fehlgeschlagen') });
    }

    // Outcome-audit success
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `deploy:remove:${vpsId}:${hostname}:${imageForAudit}:success`,
      });
    } catch { /* ignore */ }

    return res.status(200).json(result);
  });

  // ── POST /api/deployments/local-test ─────────────────────────────────────
  // S-156: Lokaler Image-Test vor VPS-Deploy.
  // MUTATION: Audit-First + Identitäts-/Rollenschutz (AC5).
  // MUSS vor /api/deployments/:vps/:hostname registriert sein (Express matcht "local-test" sonst als :vps).

  /**
   * POST /api/deployments/local-test
   * Lokaler Probe-Lauf: Image lokal pullen → kurzlebigen Container starten →
   * Start-Status + ExposedPorts (docker inspect) → Best-Effort HTTP-Reachability →
   * Container immer entfernen (rm -f, try/finally, AC4).
   *
   * Body: { image, tag }
   *
   * Responses:
   *   200 { result: "ok", report: LocalTestReport }
   *   400 { error }        — Validierungsfehler (image/tag ungültig)
   *   403 { error }        — nicht in CRED_ADMIN_EMAILS oder AccessGuard-Block
   *   500 { error }        — Audit-Write fehlgeschlagen
   *   502 { result: "error", reason }  — Pull/Start-Fehler oder Docker unerreichbar
   */
  router.post('/api/deployments/local-test', async (req, res) => {
    const identity = req.identity ?? null;

    // AC5: Identitäts-/Rollenschutz (analog Deploy-Mutationen)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // AC5: Input-Validierung vor Docker-Sink
    const bodyVal = validateLocalTestBody(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const { image, tag } = bodyVal.params;

    // AC5: Audit-First — Eintrag VOR Pull/Start; schlägt Audit fehl → keine Aktion
    const auditAction = `local-test:${image}:${tag}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Prüfen ob LocalDockerControl verfügbar
    if (!localDockerControl) {
      return res.status(502).json({ result: 'error', reason: 'Lokaler Docker-Zugriff nicht konfiguriert' });
    }

    // Probe-Lauf (AC2, AC3, AC4 — rm -f in LocalDockerControl try/finally garantiert)
    try {
      const report = await localDockerControl.runProbe(image, tag);
      return res.status(200).json({ result: 'ok', report });
    } catch (err) {
      // Pull-Fehler, Start-Fehler oder Docker unerreichbar → 502 (kein Leak)
      const reason = sanitizeMsg(err?.message ?? 'Probe-Lauf fehlgeschlagen');
      console.error('[deploymentsRouter] POST /api/deployments/local-test Fehler:', reason);
      return res.status(502).json({ result: 'error', reason });
    }
  });

  // ── POST /api/deployments/vps/:vpsId/tunnel/recreate ─────────────────────
  // S-187+S-188: Tunnel-Selbstheilung Phase 1+2+3.
  // MUTATION: Audit-First (in TunnelHealService) + CRED_ADMIN_EMAILS + AccessGuard.
  // Kein Token/Key in Response/Audit/Log (AC11/AC12 HART).
  // MUSS vor /api/deployments/vps/:vps/:hostname registriert sein (kein Express-Pfadkonflikt,
  // aber klare Segmentierung: /vps/:vpsId/tunnel/recreate ist eindeutig).

  /**
   * POST /api/deployments/vps/:vpsId/tunnel/recreate
   * Legt einen neuen Cloudflare-Tunnel an (Phase 1), pusht das Token per SSH (Phase 2),
   * und bestückt die laufenden managed Container mit Routen am neuen Tunnel (Phase 3, S-188).
   *
   * Responses:
   *   200 { result: "ok",    report: TunnelRecreateReport }   — Phase 1+2+3 erfolgreich
   *   200 { result: "partial", report: TunnelRecreateReport } — Phase 2 fehlgeschlagen ODER
   *                                                             Phase 3 Teil-Fehler (AC8)
   *   400 { error }              — vpsId fehlt/ungültig
   *   403 { error }              — nicht in CRED_ADMIN_EMAILS
   *   422 { error }              — unbekannte vpsId / tunnelHealService nicht konfiguriert
   *   500 { error }              — Audit-Write fehlgeschlagen
   *   502 { result: "error", report: TunnelRecreateReport } — Phase 1 fehlgeschlagen (CF-Fehler)
   */
  router.post('/api/deployments/vps/:vpsId/tunnel/recreate', async (req, res) => {
    const identity = req.identity ?? null;

    // AC12: Identitäts-/Rollenschutz (CRED_ADMIN_EMAILS)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // vpsId aus Pfad-Parameter (Input-Validierung)
    const { vpsId } = req.params;
    if (!vpsId || typeof vpsId !== 'string' || !vpsId.trim()) {
      return res.status(400).json({ error: 'vpsId-Parameter fehlt' });
    }
    const vpsIdClean = vpsId.trim();

    // Dependency-Guard: tunnelHealService muss konfiguriert sein
    if (!tunnelHealService || typeof tunnelHealService.recreate !== 'function') {
      return res.status(422).json({ error: 'TunnelHealService nicht konfiguriert' });
    }

    // AC12: Audit-First — VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt
    // (Die feingranularen Audit-Einträge werden in TunnelHealService geschrieben;
    //  hier nur der Einstiegs-Audit)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `tunnel:recreate:start:${vpsIdClean}`,
      });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // AC1/AC12: VPS-Auflösung (vereinigte Quelle: Env ⊕ dynamisch)
    // Unbekannte vpsId → 422 (kein Tunnel-Anlage)
    const vpsTarget = await resolveVpsIdToTarget(vpsIdClean, vpsTargets, vpsRegistry);
    if (!vpsTarget) {
      return res.status(422).json({ error: `Unbekannter VPS: ${vpsIdClean}` });
    }

    // TunnelHealService.recreate() führt Phase 1 + Phase 2 durch.
    // Audit-Einträge (Audit-First je Phase) werden in TunnelHealService gemacht.
    // Security-Floor (AC11): kein Token in Rückgabe / Response.
    let report;
    try {
      report = await tunnelHealService.recreate({
        vpsId: vpsIdClean,
        vpsName: vpsIdClean, // sanitizeTunnelName aus dem vpsId ableiten
        vpsTarget,
        identity: identity?.email ?? null,
        auditStore,
      });
    } catch (err) {
      // Unerwarteter Fehler — secret-freie Antwort
      const errorClass = err?.errorClass ?? 'error';
      console.error('[deploymentsRouter] tunnel/recreate Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', errorClass });
    }

    // Security-Floor (AC11): Report muss secret-frei sein (TunnelHealService garantiert das).
    // HTTP-Status:
    //   Phase 1 fehlgeschlagen → 502 (oder 422 bei cloudflare-not-configured)
    //   Phase 2 fehlgeschlagen → 200 partial (Tunnel referenziert, cloudflared nicht neu)
    //   Phase 1+2 ok, Phase 3 Teil-Fehler → 200 partial (AC8: Teil-Fehler-Semantik)
    //   Alles ok → 200 ok
    if (!report.phase1.ok) {
      // Phase 1 fehlgeschlagen: kein Tunnel angelegt, kein Token, kein SSH
      const errorClass = report.phase1.errorClass ?? 'cloudflare-unavailable';
      if (errorClass === 'cloudflare-not-configured') {
        return res.status(422).json({ result: 'error', errorClass, report });
      }
      if (errorClass === 'cloudflare-auth-failed') {
        return res.status(502).json({ result: 'error', errorClass, report });
      }
      return res.status(502).json({ result: 'error', errorClass, report });
    }

    if (!report.phase2.ok) {
      // Phase 1 erfolgreich, Phase 2 fehlgeschlagen: Tunnel referenziert, cloudflared nicht neu gestartet
      // → AC5: kein verwaistes Geheimnis; Phase 3 übersprungen
      return res.status(200).json({ result: 'partial', report });
    }

    // Phase 1+2 erfolgreich; Phase 3 (S-188 AC8): report.result zeigt ok/partial
    const finalResult = report.result ?? 'ok'; // 'partial' wenn Phase-3-Teil-Fehler
    return res.status(200).json({ result: finalResult, report });
  });

  // ── POST /api/deployments/:app/gpg-provision ─────────────────────────────
  // per-app-gpg-passphrase-provisioning (F-073/S-335 AC7/AC10): Nach-Provisionierung
  // je App über DENSELBEN PerAppGpgProvisioningService wie die künftige Auto-
  // Provisionierung (AC2/AC3-Garantien, idempotent — nie überschreiben).
  // MUTATION: CRED_ADMIN_EMAILS + AccessGuard (server.js). Response geheimnisfrei
  // (AC8): nur { result, reason? } — nie die Passphrase. Audit-First liegt im
  // Dienst selbst (AC9), nicht im Router (Dienst ist der geteilte Einstiegspunkt).

  /**
   * POST /api/deployments/:app/gpg-provision
   * Legt (falls nötig) die per-App-GPG-Passphrase in Bitwarden an (idempotent).
   *
   * Responses:
   *   200 { result: "created"|"already-exists"|"access-not-ready"|"failed", reason? }
   *   400 { error }  — app-Parameter fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   503 { result: "failed", reason }  — Dienst nicht konfiguriert
   */
  router.post('/api/deployments/:app/gpg-provision', async (req, res) => {
    const identity = req.identity ?? null;

    // AC10: Identitäts-/Rollenschutz — ohne Berechtigung 403, KEIN bw-Aufruf.
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { app } = req.params;
    if (!app || typeof app !== 'string' || !app.trim() || app.trim().length > MAX_APP_SLUG_LEN || !APP_SLUG_PARAM_RE.test(app.trim())) {
      return res.status(400).json({ error: 'app-Parameter fehlt oder enthält ungültige Zeichen' });
    }

    if (!perAppGpgProvisioningService || typeof perAppGpgProvisioningService.provision !== 'function') {
      return res.status(503).json({ result: 'failed', reason: 'GPG-Provisionierungsdienst nicht konfiguriert' });
    }

    // AC1/AC8/AC9: Der Dienst übernimmt Audit-First, Zugangs-Gate, Existenz-Check
    // und Passphrasen-Erzeugung — Router reicht nur weiter, kein Secret in Sicht.
    const result = await perAppGpgProvisioningService.provision(app.trim(), { identity: identity?.email ?? null });
    return res.status(200).json(result);
  });

  // ── POST /api/deployments/:app/gpg-rotate/{start,commit,discard-previous} ──
  // per-app-gpg-passphrase-rotation (F-073/S-338, AC1-AC7/AC10-AC13): Zwei-Phasen-
  // Rotation über DENSELBEN perAppGpgRotationService (Audit-First/Zugangs-Gate
  // liegen im Dienst, nicht im Router). Response geheimnisfrei (AC7): nur
  // { ok, phase?, errorClass?, reason? } — nie eine Passphrase, nie .env.gpg-Klartext.

  /**
   * POST /api/deployments/:app/gpg-rotate/start
   * Phase (a)+(b): Kandidat hinterlegen + Beweis-Runde.
   *
   * Responses:
   *   200 { ok: true, phase: "candidate-proved" }
   *   200 { ok: false, phase: "aborted", errorClass, reason? }
   *   400 { error }  — app-Parameter fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   503 { ok: false, reason }  — Dienst nicht konfiguriert
   */
  router.post('/api/deployments/:app/gpg-rotate/start', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { app } = req.params;
    if (!app || typeof app !== 'string' || !app.trim() || app.trim().length > MAX_APP_SLUG_LEN || !APP_SLUG_PARAM_RE.test(app.trim())) {
      return res.status(400).json({ error: 'app-Parameter fehlt oder enthält ungültige Zeichen' });
    }

    if (!perAppGpgRotationService || typeof perAppGpgRotationService.startRotation !== 'function') {
      return res.status(503).json({ ok: false, reason: 'GPG-Rotationsdienst nicht konfiguriert' });
    }

    const result = await perAppGpgRotationService.startRotation(app.trim(), { identity: identity?.email ?? null });
    return res.status(200).json(result);
  });

  /**
   * POST /api/deployments/:app/gpg-rotate/commit
   * Phase (c): Umschalten (Commit-Punkt) — zuerst Bitwarden, danach Commit + Push.
   *
   * Responses:
   *   200 { ok: true }
   *   200 { ok: false, errorClass, reason? }
   *   400 { error }  — app-Parameter fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   503 { ok: false, reason }  — Dienst nicht konfiguriert
   */
  router.post('/api/deployments/:app/gpg-rotate/commit', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { app } = req.params;
    if (!app || typeof app !== 'string' || !app.trim() || app.trim().length > MAX_APP_SLUG_LEN || !APP_SLUG_PARAM_RE.test(app.trim())) {
      return res.status(400).json({ error: 'app-Parameter fehlt oder enthält ungültige Zeichen' });
    }

    if (!perAppGpgRotationService || typeof perAppGpgRotationService.commitRotation !== 'function') {
      return res.status(503).json({ ok: false, reason: 'GPG-Rotationsdienst nicht konfiguriert' });
    }

    const result = await perAppGpgRotationService.commitRotation(app.trim(), { identity: identity?.email ?? null });
    return res.status(200).json(result);
  });

  /**
   * POST /api/deployments/:app/gpg-rotate/discard-previous
   * Phase (d): manuelle Entsorgung des Rollback-Ankers `vorherige`.
   *
   * Responses:
   *   200 { ok: true }
   *   200 { ok: false, errorClass, reason? }
   *   400 { error }  — app-Parameter fehlt/ungültig
   *   403 { error }  — nicht in CRED_ADMIN_EMAILS
   *   503 { ok: false, reason }  — Dienst nicht konfiguriert
   */
  router.post('/api/deployments/:app/gpg-rotate/discard-previous', async (req, res) => {
    const identity = req.identity ?? null;

    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    const { app } = req.params;
    if (!app || typeof app !== 'string' || !app.trim() || app.trim().length > MAX_APP_SLUG_LEN || !APP_SLUG_PARAM_RE.test(app.trim())) {
      return res.status(400).json({ error: 'app-Parameter fehlt oder enthält ungültige Zeichen' });
    }

    if (!perAppGpgRotationService || typeof perAppGpgRotationService.discardPrevious !== 'function') {
      return res.status(503).json({ ok: false, reason: 'GPG-Rotationsdienst nicht konfiguriert' });
    }

    const result = await perAppGpgRotationService.discardPrevious(app.trim(), { identity: identity?.email ?? null });
    return res.status(200).json(result);
  });

  // ── POST /api/deployments/reconcile ──────────────────────────────────────
  // NOTE: Die GET /api/deployments/reconcile/*-Routen (reconcile/last, reconcile/reports,
  // reconcile/notices) sowie POST /api/deployments/reconcile müssen vor einem etwaigen
  // künftigen GET /:vps/:hostname registriert werden, damit Express "reconcile" nicht als
  // :vps-Parameter matcht. POST und DELETE konkurrieren NICHT (verschiedene HTTP-Methoden).

  /**
   * POST /api/deployments/reconcile
   * Manual reconcile trigger. Same logic as cron. Produces a ReconcileReport (AC2).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC2/AC8/AC9).
   *
   * Response: { result: "ok"|"error", report? }
   */
  router.post('/api/deployments/reconcile', async (req, res) => {
    if (!reconciliationJob) {
      return res.status(503).json({ result: 'error', reason: 'ReconciliationJob nicht konfiguriert' });
    }

    const identity = req.identity ?? null;

    // AC2: Identitäts-/Rollenschutz (same as deploy mutations)
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Audit-First (AC9)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: 'reconcile:manual-trigger',
      });
    } catch (auditErr) {
      console.error('[deploymentsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr?.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    try {
      const report = await reconciliationJob.reconcile('manual');
      if (report === null) {
        // Skip-if-running
        return res.status(200).json({ result: 'ok', reason: 'already-running' });
      }
      return res.status(200).json({ result: 'ok', report });
    } catch (err) {
      console.error('[deploymentsRouter] POST /api/deployments/reconcile Fehler:', sanitizeMsg(err?.message));
      return res.status(502).json({ result: 'error', reason: 'Reconciliation fehlgeschlagen' });
    }
  });

  // ── GET /api/deployments/reconcile/last ───────────────────────────────────

  /**
   * GET /api/deployments/reconcile/last
   * Returns the last ReconcileReport, or {} if none (AC8).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/last', (_req, res) => {
    if (!reconciliationJob) {
      return res.json({});
    }
    const report = reconciliationJob.getLastReport();
    return res.json(report ?? {});
  });

  // ── GET /api/deployments/reconcile/reports ────────────────────────────────

  /**
   * GET /api/deployments/reconcile/reports?limit=N
   * Returns the last N ReconcileReports (AC8).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/reports', (req, res) => {
    if (!reconciliationJob) {
      return res.json([]);
    }
    const limitRaw = req.query.limit;
    const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.min(Number(limitRaw), 100)
      : 20;
    const reports = reconciliationJob.getReports(limit);
    return res.json(reports);
  });

  // ── GET /api/deployments/reconcile/notices ────────────────────────────────

  /**
   * GET /api/deployments/reconcile/notices?limit=N
   * Returns the last N ReconcileNotices (AC8b).
   * Hinter Access.
   */
  router.get('/api/deployments/reconcile/notices', (req, res) => {
    if (!reconciliationJob) {
      return res.json([]);
    }
    const limitRaw = req.query.limit;
    const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.min(Number(limitRaw), 200)
      : 50;
    const notices = reconciliationJob.getNotices(limit);
    return res.json(notices);
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove token-like patterns from error messages before logging.
 * Tokens/keys MUST NOT appear in console logs (security/R01).
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeMsg(msg) {
  if (typeof msg !== 'string') return 'unbekannter Fehler';
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY[\s\S]*?END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/gi, '[KEY REDACTED]')
    .slice(0, 300);
}
