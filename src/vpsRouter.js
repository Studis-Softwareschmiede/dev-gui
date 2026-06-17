/**
 * vpsRouter — Express-Router für VPS-Provider-Boundary (AC1–AC10, ADR-009).
 *
 * Routes (alle hinter AccessGuard in server.js):
 *   GET  /api/vps/providers                              → [{ id, configured, capabilities }]
 *   GET  /api/vps/machines                               → { machines, providerErrors? }
 *   POST /api/vps/machines/:provider/*splat/start        → { result, reason? }   [MUTATION — Rollenschutz]
 *   POST /api/vps/machines/:provider/*splat/stop         → { result, reason? }   [MUTATION — Rollenschutz]
 *   POST /api/vps/machines/:provider                     → { result, machine?, reason? } [MUTATION — Rollenschutz]
 *
 * ServerId-Routing (IONOS composite IDs):
 *   IONOS serverIds have the format "<datacenterId>/<serverId>" (a literal slash).
 *   Express 5 *splat captures everything between :provider and /start|/stop,
 *   including slashes, as an array of path segments. The segments are joined
 *   with "/" to reconstruct the composite ID (e.g. ["dc-uuid","srv-uuid"] → "dc-uuid/srv-uuid").
 *   This requires no client-side URL-encoding discipline (#100 note: send the literal
 *   composite ID as path segments, e.g. POST /api/vps/machines/ionos/dc-uuid/srv-uuid/start).
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
import { CloudInitError } from './vps/CloudInitBuilder.js';

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
 * Slashes sind für IONOS composite IDs ("<datacenterId>/<serverId>") erlaubt.
 * Path-Traversal-Sicherheit: Der Adapter (ionos.js parseCompositeId) splittet am
 * ersten '/' und übergibt beide Teile getrennt an encodeURIComponent() — sie werden
 * nicht zu Dateipfaden zusammengesetzt. Whitespace, ".." und andere
 * Injektions-Vektoren bleiben ausgeschlossen.
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
  // Allow alphanumerics, hyphens, underscores, dots, forward-slash (IONOS composite IDs).
  // Excludes whitespace and other injection vectors.
  if (!/^[a-zA-Z0-9._/-]+$/.test(s)) {
    return { ok: false, error: 'serverId enthält ungültige Zeichen' };
  }
  // Reject ".." sequences — path-traversal guard (security/R03).
  // Even though composite IDs are only passed to encodeURIComponent() in the adapter,
  // we reject ".." defensively to prevent future misuse.
  if (/\.\./.test(s)) {
    return { ok: false, error: 'serverId enthält ungültige Zeichen' };
  }
  return { ok: true };
}

/** Erlaubte Zeichen für SSH-Key-Labels (sync mit CredentialStore/sshKeysRouter). */
const SSH_LABEL_RE = /^[a-zA-Z0-9_\-.:@]+$/;

/** Maximale Länge eines SSH-Key-Labels. */
const MAX_LABEL_LEN = 64;

/**
 * Validiert und sanitisiert das Create-Body.
 * Gibt { ok: true, params } oder { ok: false, error } zurück.
 *
 * ADR-009: Der Client liefert NUR fachliche Create-Parameter (name, region,
 * serverType, image) sowie SSH-Key-Label-Referenzen (sshKeyAssignment).
 * userData und rohe sshPublicKeys werden NICHT vom Client akzeptiert —
 * sie werden server-intern durch CloudInitBuilder / SSH-Key-Resolver erzeugt.
 *
 * AC3 (vps-ssh-key-assignment): sshKeyAssignment: { root: <label>, alex: <label> }
 *   — nur Label-Referenzen, nie Key-Material vom Client (security/R01/NFR).
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, params?: object, error?: string }}
 */
function validateCreateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }

  const { name, region, serverType, image, sshKeyAssignment } = body;

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

  // sshKeyAssignment (AC3): { root: <label>, alex: <label> } — optional im Body,
  // aber fehlende/ungültige Labels führen zu 422 (missing-ssh-key) im Registry-Pfad.
  // Hier: nur Label-Referenz-Validierung (security/R02 — keine rohen Keys akzeptieren).
  let resolvedSshKeyAssignment = undefined;
  if (sshKeyAssignment !== undefined) {
    if (typeof sshKeyAssignment !== 'object' || sshKeyAssignment === null || Array.isArray(sshKeyAssignment)) {
      return { ok: false, error: 'sshKeyAssignment muss ein Objekt mit root- und alex-Label sein' };
    }
    const assignment = {};
    for (const role of ['root', 'alex']) {
      const label = sshKeyAssignment[role];
      if (label === undefined || label === null) continue;
      if (typeof label !== 'string' || !label.trim()) {
        return { ok: false, error: `sshKeyAssignment.${role} muss ein nicht-leerer Label-String sein` };
      }
      const trimmed = label.trim();
      if (trimmed.length > MAX_LABEL_LEN) {
        return { ok: false, error: `sshKeyAssignment.${role} überschreitet Label-Länge (max. ${MAX_LABEL_LEN})` };
      }
      if (!SSH_LABEL_RE.test(trimmed)) {
        return { ok: false, error: `sshKeyAssignment.${role} enthält unerlaubte Zeichen` };
      }
      assignment[role] = trimmed;
    }
    resolvedSshKeyAssignment = assignment;
  }

  return {
    ok: true,
    params: {
      name: name.trim(),
      region: region.trim(),
      serverType: serverType.trim(),
      image: resolvedImage,
      sshKeyAssignment: resolvedSshKeyAssignment,
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
   * Body: { name, region, serverType, image?, sshKeyAssignment?: { root: <label>, alex: <label> } }
   * userData und sshPublicKeys werden NICHT vom Client akzeptiert —
   * sie werden server-intern durch CloudInitBuilder / SSH-Key-Resolver erzeugt
   * (ADR-009; vps-ssh-key-assignment #99 implementiert).
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

    // AC6/AC10: Audit-First — Label-Zuordnung auditieren, KEIN Key-Material im Audit
    // (security/R01: nur Label-Namen, nie Public/Private-Key-Werte)
    const sshAssignmentAudit = params.sshKeyAssignment
      ? `:ssh[root=${params.sshKeyAssignment.root ?? ''},alex=${params.sshKeyAssignment.alex ?? ''}]`
      : '';
    const auditAction = `vps:create:${provider}:${params.name}${sshAssignmentAudit}`;
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

  // ── POST /api/vps/machines/:provider/*splat/start ────────────────────────

  /**
   * POST /api/vps/machines/:provider/*splat/start
   * Startet einen Server (power-on).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC9/AC10).
   *
   * *splat captures the serverId portion, which may contain "/" for IONOS
   * composite IDs ("<datacenterId>/<serverId>"). Express 5 delivers the
   * segments as an array; they are joined with "/" to reconstruct the ID.
   *
   * Responses:
   *   200 { result: "ok"|"unsupported"|"error", reason? }
   *   403 { error }  — kein Zugriff
   *   422 { error }  — provider nicht konfiguriert / result: "unsupported"
   *   500 { error }  — Audit-Write fehlgeschlagen
   *   502 { error }  — Provider-API-Fehler
   */
  router.post('/api/vps/machines/:provider/*splat/start', async (req, res) => {
    return handlePowerAction(req, res, 'start', identity =>
      checkMutationAuthz(identity),
    );
  });

  // ── POST /api/vps/machines/:provider/*splat/stop ─────────────────────────

  /**
   * POST /api/vps/machines/:provider/*splat/stop
   * Stoppt einen Server (power-off).
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC9/AC10).
   *
   * *splat captures composite serverIds (see /start above for details).
   */
  router.post('/api/vps/machines/:provider/*splat/stop', async (req, res) => {
    return handlePowerAction(req, res, 'stop', identity =>
      checkMutationAuthz(identity),
    );
  });

  // ── DELETE /api/vps/machines/:provider/*splat ─────────────────────────────

  /**
   * DELETE /api/vps/machines/:provider/*splat
   * Löscht einen Server beim Provider und räumt den Cloudflare-Tunnel auf.
   * MUTATION: Audit-First + Identitäts-/Rollenschutz (AC6/AC7, vps-delete).
   *
   * *splat captures composite serverIds (see /start above for details).
   *
   * Body: { vpsName: string } — VPS-Name für den Tunnel-Lookup (Zuordnung devgui-<sanitized-vpsname>)
   *
   * Responses:
   *   200 { result: "ok"|"unsupported"|"error", reason?, cleanupError? }
   *   400 { error }         — Validierungsfehler (vpsName fehlt)
   *   403 { error }         — kein Zugriff / nicht in CRED_ADMIN_EMAILS
   *   422 { error }         — provider nicht konfiguriert / unsupported
   *   500 { error }         — Audit-Write fehlgeschlagen
   *   502 { error }         — Provider-API-Fehler
   */
  router.delete('/api/vps/machines/:provider/*splat', async (req, res) => {
    const identity = req.identity ?? null;

    // AC6: Identitäts-/Rollenschutz
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

    // ServerId aus *splat rekonstruieren (Express 5 liefert Array bei mehreren Segmenten).
    const splatRaw = req.params.splat;
    const rawServerId = Array.isArray(splatRaw) ? splatRaw.join('/') : String(splatRaw ?? '');

    // ServerId validieren (security/R02/R03)
    const serverIdVal = validateServerId(rawServerId);
    if (!serverIdVal.ok) {
      return res.status(422).json({ error: serverIdVal.error });
    }
    const serverId = rawServerId.trim();

    // vpsName aus Body für Tunnel-Lookup (AC3)
    const vpsName = req.body?.vpsName;
    if (typeof vpsName !== 'string' || !vpsName.trim()) {
      return res.status(400).json({ error: 'vpsName ist ein Pflichtfeld für den Tunnel-Cleanup' });
    }
    const vpsNameTrimmed = vpsName.trim();
    if (vpsNameTrimmed.length > MAX_FIELD_LEN) {
      return res.status(400).json({ error: `vpsName überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` });
    }

    // AC7: Audit-First — Token NICHT im Audit
    const auditAction = `vps:delete:${provider}:${serverId}`;
    try {
      auditStore.record({ identity: identity?.email ?? null, command: auditAction });
    } catch (auditErr) {
      console.error('[vpsRouter] Audit-Write fehlgeschlagen (delete):', sanitizeMsg(auditErr.message));
      return res.status(500).json({ error: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' });
    }

    // Provider-API-Aufruf via Registry (Boundary)
    let result;
    try {
      result = await registry.delete(provider, serverId, vpsNameTrimmed);
    } catch (err) {
      const errorClass = (err instanceof VpsRegistryError) ? err.errorClass : 'unexpected';
      try {
        auditStore.record({
          identity: identity?.email ?? null,
          command: `vps:delete:${provider}:${serverId}:failed:${errorClass}`,
        });
      } catch (ae) {
        console.error('[vpsRouter] Outcome-Audit (Fehlschlag) fehlgeschlagen:', sanitizeMsg(ae.message));
      }
      return mapRegistryErrorToResponse(res, err, 'delete');
    }

    // Outcome-Audit (AC7)
    // cleanupError wird auditiert falls vorhanden (AC4: Teil-Erfolg klar melden)
    const outcomeLabel = result.cleanupError ? `partial:cleanup-error` : result.result;
    try {
      auditStore.record({
        identity: identity?.email ?? null,
        command: `vps:delete:${provider}:${serverId}:${outcomeLabel}`,
      });
    } catch (ae) {
      console.error('[vpsRouter] Outcome-Audit fehlgeschlagen:', sanitizeMsg(ae.message));
    }

    // AC2: unsupported → 422 mit result:"unsupported"
    if (result.result === 'unsupported') {
      return res.status(422).json(result);
    }

    return res.json(result);
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

    // ServerId aus *splat rekonstruieren (Express 5 liefert Array bei mehreren Segmenten).
    // IONOS composite IDs ("<datacenterId>/<serverId>") kommen so korrekt an ohne
    // Client-seitige URL-Encodierung zu erzwingen.
    const splatRaw = req.params.splat;
    const rawServerId = Array.isArray(splatRaw) ? splatRaw.join('/') : String(splatRaw ?? '');

    // ServerId validieren (security/R02/R03)
    const serverIdVal = validateServerId(rawServerId);
    if (!serverIdVal.ok) {
      return res.status(422).json({ error: serverIdVal.error });
    }
    const serverId = rawServerId.trim();

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
  // CloudInitError (AC7): fehlende SSH-Keys → 422 mit errorClass vor Provider-Call
  if (err instanceof CloudInitError) {
    return res.status(err.httpStatus ?? 422).json({ result: 'error', errorClass: err.errorClass, reason: err.message });
  }

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
