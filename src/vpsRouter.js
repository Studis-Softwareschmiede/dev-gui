/**
 * vpsRouter — Express-Router für VPS-Provider-Boundary (AC1–AC10, ADR-009).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET  /api/vps/providers                           → [{ id, configured, capabilities }]
 *   GET  /api/vps/machines                            → { machines, providerErrors? }
 *   POST /api/vps/machines/:provider/:serverId/start  → { result, reason? }   [MUTATION — Rollenschutz]
 *   POST /api/vps/machines/:provider/:serverId/stop   → { result, reason? }   [MUTATION — Rollenschutz]
 *   POST /api/vps/machines/:provider                  → { result, machine?, reason? } [MUTATION — Rollenschutz]
 *
 * Security (AC9/AC10 / ADR-009):
 *   - Alle /api/vps/* hinter AccessGuard (server.js — alle /api/* sind geschützt).
 *   - Mutierende Aktionen (start/stop/create) zusätzlich identitäts-/rollengeschützt
 *     (gleiche CRED_ADMIN_EMAILS-Logik wie ADR-007/credentialsRouter).
 *   - Audit-First: Audit-Eintrag VOR jeder Mutation; schlägt Audit fehl → Aktion unterbleibt.
 *   - Provider-Tokens erscheinen NIEMALS in Response, Log, Audit, WS, Argv oder URL.
 *   - Untrusted Input (provider, serverId, Body-Felder) wird validiert (security/R02/R03).
 *
 * @module vpsRouter
 */

import { Router } from 'express';
import { VpsRegistryError } from './vps/VpsProviderRegistry.js';

/** Erlaubte Provider-IDs (security/R02: Input-Validation vor API-Aufruf). */
const KNOWN_PROVIDERS = ['hetzner', 'ionos', 'hostinger'];

/** Maximale Länge für Freitextfelder im Create-Body. */
const MAX_FIELD_LEN = 256;

// ── Authz-Helper (gleiche Logik wie credentialsRouter / githubReposRouter) ─────

/**
 * Prüft ob die anfragende Identität mutieren darf (CRED_ADMIN_EMAILS-Logik, AC9/ADR-007).
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
 * Validiert einen Provider-Param (security/R02 — Input-Validation vor API-Call).
 * Gibt { ok: true } oder { ok: false, error } zurück.
 *
 * @param {unknown} provider
 * @returns {{ ok: boolean, error?: string }}
 */
function validateProvider(provider) {
  if (typeof provider !== 'string' || !provider.trim()) {
    return { ok: false, error: 'provider ist ein Pflichtfeld' };
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Unbekannter Provider: ${provider}. Erlaubt: ${KNOWN_PROVIDERS.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Validiert eine serverId (security/R02).
 * Verhindert Injection durch reine alphanumerische + Bindestriche/Unterstriche.
 *
 * @param {unknown} serverId
 * @returns {{ ok: boolean, error?: string }}
 */
function validateServerId(serverId) {
  if (typeof serverId !== 'string' || !serverId.trim()) {
    return { ok: false, error: 'serverId ist ein Pflichtfeld' };
  }
  const s = serverId.trim();
  if (s.length > 128) {
    return { ok: false, error: 'serverId überschreitet Längenlimit (max. 128 Zeichen)' };
  }
  // Allow alphanumerics, hyphens, underscores, dots — reject anything path-injection-like
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    return { ok: false, error: 'serverId enthält ungültige Zeichen' };
  }
  return { ok: true };
}

/**
 * Validiert und sanitisiert das Create-Body.
 * Gibt { ok: true, params } oder { ok: false, error } zurück.
 *
 * ADR-009: Der Client liefert NUR fachliche Create-Parameter (name, region,
 * serverType, image). userData und sshPublicKeys werden NICHT vom Client
 * akzeptiert — sie werden server-intern durch CloudInitBuilder bzw. den
 * SSH-Key-Resolver (SSHKEYS_STUB_99, folgt in #99) erzeugt.
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateCreateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }

  const { name, region, serverType, image } = body;

  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'name ist ein Pflichtfeld' };
  }
  if (name.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `name überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  if (typeof region !== 'string' || !region.trim()) {
    return { ok: false, error: 'region ist ein Pflichtfeld' };
  }
  if (region.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `region überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  if (typeof serverType !== 'string' || !serverType.trim()) {
    return { ok: false, error: 'serverType ist ein Pflichtfeld' };
  }
  if (serverType.trim().length > MAX_FIELD_LEN) {
    return { ok: false, error: `serverType überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  // image ist optional — Default wird im Adapter gesetzt
  const resolvedImage = (typeof image === 'string' && image.trim()) ? image.trim() : undefined;

  return {
    ok: true,
    params: {
      name: name.trim(),
      region: region.trim(),
      serverType: serverType.trim(),
      image: resolvedImage,
    },
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Erstellt den VPS-Router.
 *
 * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry} registry
 * @param {import('./AuditStore.js').AuditStore} auditStore
 * @returns {import('express').Router}
 */
export function vpsRouter(registry, auditStore) {
  const router = Router();

  // ── GET /api/vps/providers ─────────────────────────────────────────────────

  /**
   * GET /api/vps/providers
   * Liefert je Provider { id, configured, capabilities }.
   * Kein Provider-API-Aufruf; nur CredentialStore-Metadaten-Check.
   *
   * Responses:
   *   200 [{ id, configured, capabilities }]
   *   500 { error }
   */
  router.get('/api/vps/providers', async (req, res) => {
    try {
      const providers = await registry.listProviders();
      return res.json(providers);
    } catch (err) {
      console.error('[vpsRouter] GET /api/vps/providers Fehler:', sanitizeMsg(err.message));
      return res.status(500).json({ error: 'Provider-Liste konnte nicht abgerufen werden' });
    }
  });

  // ── GET /api/vps/machines ──────────────────────────────────────────────────

  /**
   * GET /api/vps/machines
   * Aggregiert VpsMachine-Liste über alle konfigurierten Provider live.
   * Degradierend: ein Provider-Fehler → 200 mit providerErrors (AC4).
   *
   * Responses:
   *   200 { machines: VpsMachine[], providerErrors?: [{ provider, errorClass }] }
   *   500 { error }
   */
  router.get('/api/vps/machines', async (req, res) => {
    try {
      const result = await registry.listAllMachines();
      return res.json(result);
    } catch (err) {
      console.error('[vpsRouter] GET /api/vps/machines Fehler:', sanitizeMsg(err.message));
      return res.status(500).json({ error: 'Maschinen-Liste konnte nicht abgerufen werden' });
    }
  });

  // ── POST /api/vps/machines/:provider ─────────────────────────────────────

  /**
   * POST /api/vps/machines/:provider
   * Erstellt einen neuen Server beim angegebenen Provider.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC9/AC10).
   *
   * Body: { name, region, serverType, image? }
   * userData und sshPublicKeys werden NICHT vom Client akzeptiert —
   * sie werden server-intern durch CloudInitBuilder / SSH-Key-Resolver erzeugt
   * (ADR-009; SSHKEYS_STUB_99 folgt in #99).
   *
   * Responses:
   *   201 { result: "ok", machine: VpsMachine }
   *   400 { error }         — Validierungsfehler (Body)
   *   403 { error }         — kein Zugriff / nicht in CRED_ADMIN_EMAILS
   *   422 { error }         — provider nicht konfiguriert / ungültiges Image/Region/Servertyp
   *   500 { error }         — Audit-Write fehlgeschlagen / interner Fehler
   *   502 { error }         — Provider-API-Fehler
   */
  router.post('/api/vps/machines/:provider', async (req, res) => {
    const identity = req.identity ?? null;

    // AC9: Identitäts-/Rollenschutz
    const authz = checkMutationAuthz(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Provider validieren (security/R02)
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    // Body validieren
    const bodyVal = validateCreateBody(req.body);
    if (!bodyVal.ok) {
      return res.status(400).json({ error: bodyVal.error });
    }
    const params = bodyVal.params;

    // AC10: Audit-First — Eintrag VOR der Mutation; Token NICHT im Audit
    const auditAction = `vps:create:${provider}:${params.name}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[vpsRouter] Audit-Write fehlgeschlagen:', sanitizeMsg(auditErr.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Provider-API-Aufruf via Registry (Boundary)
    let machine;
    try {
      machine = await registry.create(provider, params);
    } catch (err) {
      // Outcome-Audit (Fehlschlag)
      const errorClass = (err instanceof VpsRegistryError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `vps:create:${provider}:${params.name}:failed:${errorClass}`,
        });
      } catch (ae) {
        console.error('[vpsRouter] Outcome-Audit (Fehlschlag) fehlgeschlagen:', sanitizeMsg(ae.message));
      }
      return mapRegistryErrorToResponse(res, err, 'create');
    }

    // Outcome-Audit (Erfolg)
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `vps:create:${provider}:${params.name}:success:${machine.serverId}`,
      });
    } catch (ae) {
      console.error('[vpsRouter] Outcome-Audit (Erfolg) fehlgeschlagen:', sanitizeMsg(ae.message));
    }

    return res.status(201).json({ result: 'ok', machine });
  });

  // ── POST /api/vps/machines/:provider/:serverId/start ──────────────────────

  /**
   * POST /api/vps/machines/:provider/:serverId/start
   * Startet einen Server (power-on).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC9/AC10).
   *
   * Responses:
   *   200 { result: "ok"|"unsupported"|"error", reason? }
   *   403 { error }  — kein Zugriff
   *   422 { error }  — provider nicht konfiguriert / result: "unsupported"
   *   500 { error }  — Audit-Write fehlgeschlagen
   *   502 { error }  — Provider-API-Fehler
   */
  router.post('/api/vps/machines/:provider/:serverId/start', async (req, res) => {
    return handlePowerAction(req, res, 'start', identity =>
      checkMutationAuthz(identity),
    );
  });

  // ── POST /api/vps/machines/:provider/:serverId/stop ───────────────────────

  /**
   * POST /api/vps/machines/:provider/:serverId/stop
   * Stoppt einen Server (power-off).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC9/AC10).
   */
  router.post('/api/vps/machines/:provider/:serverId/stop', async (req, res) => {
    return handlePowerAction(req, res, 'stop', identity =>
      checkMutationAuthz(identity),
    );
  });

  // ── Power-Action-Handler (shared for start/stop) ──────────────────────────

  /**
   * Führt eine Power-Aktion (start/stop) aus mit Authz + Audit-First.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {"start"|"stop"} action
   * @param {(identity: object|null) => { allowed: boolean }} authzFn
   */
  async function handlePowerAction(req, res, action, authzFn) {
    const identity = req.identity ?? null;

    // AC9: Identitäts-/Rollenschutz
    const authz = authzFn(identity);
    if (!authz.allowed) {
      return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion' });
    }

    // Provider validieren (security/R02)
    const providerVal = validateProvider(req.params.provider);
    if (!providerVal.ok) {
      return res.status(422).json({ error: providerVal.error });
    }
    const provider = req.params.provider;

    // ServerId validieren (security/R02/R03)
    const serverIdVal = validateServerId(req.params.serverId);
    if (!serverIdVal.ok) {
      return res.status(422).json({ error: serverIdVal.error });
    }
    const serverId = req.params.serverId.trim();

    // AC10: Audit-First — Token NICHT im Audit
    const auditAction = `vps:${action}:${provider}:${serverId}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error(`[vpsRouter] Audit-Write fehlgeschlagen (${action}):`, sanitizeMsg(auditErr.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Provider-API-Aufruf via Registry
    let result;
    try {
      if (action === 'start') {
        result = await registry.start(provider, serverId);
      } else {
        result = await registry.stop(provider, serverId);
      }
    } catch (err) {
      const errorClass = (err instanceof VpsRegistryError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `vps:${action}:${provider}:${serverId}:failed:${errorClass}`,
        });
      } catch (ae) {
        console.error('[vpsRouter] Outcome-Audit (Fehlschlag) fehlgeschlagen:', sanitizeMsg(ae.message));
      }
      return mapRegistryErrorToResponse(res, err, action);
    }

    // Outcome-Audit
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `vps:${action}:${provider}:${serverId}:${result.result}`,
      });
    } catch (ae) {
      console.error('[vpsRouter] Outcome-Audit fehlgeschlagen:', sanitizeMsg(ae.message));
    }

    // AC6: unsupported → 422 mit result:"unsupported"
    if (result.result === 'unsupported') {
      return res.status(422).json(result);
    }

    return res.json(result);
  }

  return router;
}

// ── Fehler-Mapping ─────────────────────────────────────────────────────────────

/**
 * Mappt Registry-/Adapter-Fehler auf HTTP-Response.
 * Tokens / Secrets DÜRFEN NICHT in der Response erscheinen.
 *
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {string} action - Kontext für Logging
 */
function mapRegistryErrorToResponse(res, err, action) {
  if (err instanceof VpsRegistryError) {
    switch (err.errorClass) {
      case 'unknown-provider':
        return res.status(404).json({ result: 'error', reason: err.message });
      case 'provider-not-configured':
        return res.status(422).json({ result: 'error', errorClass: 'provider-not-configured', reason: err.message });
      case 'provider-auth-failed':
        return res.status(502).json({ result: 'error', errorClass: 'provider-auth-failed', reason: 'Provider-Authentifizierung fehlgeschlagen' });
      case 'not-found':
        return res.status(404).json({ result: 'error', errorClass: 'not-found', reason: err.message });
      case 'provider-unavailable':
        return res.status(502).json({ result: 'error', errorClass: 'provider-unavailable', reason: 'Provider nicht erreichbar' });
      case 'validation-error':
        return res.status(422).json({ result: 'error', errorClass: 'validation-error', reason: err.message });
      default:
        console.error(`[vpsRouter] ${action} VpsRegistryError (${err.errorClass}):`, sanitizeMsg(err.message));
        return res.status(502).json({ result: 'error', reason: 'Provider-Fehler' });
    }
  }

  // Adapter-Fehler (HetznerAdapterError etc.) — können durchgereicht werden
  if (err.errorClass) {
    switch (err.errorClass) {
      case 'provider-auth-failed':
        return res.status(502).json({ result: 'error', errorClass: 'provider-auth-failed', reason: 'Provider-Authentifizierung fehlgeschlagen' });
      case 'not-found':
        return res.status(404).json({ result: 'error', errorClass: 'not-found', reason: 'Server nicht gefunden' });
      case 'provider-unavailable':
        return res.status(502).json({ result: 'error', errorClass: 'provider-unavailable', reason: 'Provider nicht erreichbar oder Rate-Limit' });
      case 'validation-error':
        return res.status(422).json({ result: 'error', errorClass: 'validation-error', reason: err.message });
      case 'not-implemented':
        return res.status(422).json({ result: 'unsupported', reason: err.message });
      default:
        console.error(`[vpsRouter] ${action} AdapterError (${err.errorClass}):`, sanitizeMsg(err.message));
        return res.status(502).json({ result: 'error', reason: 'Provider-Fehler' });
    }
  }

  // Unerwarteter Fehler
  const safeMsg = sanitizeMsg(String(err?.message ?? ''));
  console.error(`[vpsRouter] ${action} Unerwarteter Fehler:`, safeMsg);
  return res.status(502).json({ result: 'error', reason: 'Interner Provider-Fehler' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
