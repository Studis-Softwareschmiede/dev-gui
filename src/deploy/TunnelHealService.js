/**
 * TunnelHealService — Tunnel-Selbstheilung (Capability B, S-187+S-188).
 *
 * Implementiert Phase 1, Phase 2 und Phase 3 der Tunnel-Wiederherstellung:
 *
 * Phase 1 — Tunnel neu anlegen & Referenz ersetzen:
 *   1. CloudflareApi.createTunnel("<sanitized-vpsname>") → { tunnelId, token }
 *   2. Token im CredentialStore unter TUNNEL_TOKEN_KEY(newTunnelId) ablegen.
 *   3. TUNNEL_ID_KEY(sanitized) auf die neue Id aktualisieren (alte tote Referenz ersetzt).
 *   4. Alte Token-Referenz best-effort aufräumen (kein Rollback bei Fehler).
 *
 * Phase 2 — Token auf VPS pushen & cloudflared neu starten:
 *   1. VpsDockerControl.pushTunnelEnvFile(vps, token) → env-file /etc/cloudflared/env
 *      mit Inhalt TUNNEL_TOKEN=<neu>, Permissions 0600 root:root.
 *   2. cloudflared-Container-Neustart (in pushTunnelEnvFile integriert).
 *   Token NIE in Argv/Log/Audit/Response/WS (AC4, HART).
 *
 * Phase 3 — Routen bestücken (S-188 AC6/AC7/AC8):
 *   1. VpsDockerControl.ps(vpsTarget) → managed Container (Label cloudflare.tunnel-hostname).
 *   2. Für jeden Container: DeployOrchestrator.addRouteOnly({ tunnelId: newTunnelId, hostname, hostPort })
 *      — GETEILTER ADR-012-Pfad: LockoutGuard → addRoute → createDnsRecord (idempotent).
 *      Kein eigener CF-Mutationscode neben dem geteilten Pfad.
 *   3. Pro Container: route-created / protected-skipped / error → routes[]-Eintrag.
 *   4. Teil-Fehler-Semantik: ein Container-Fehler kippt die übrigen nicht.
 *
 * Security-Floor (AC4/AC11, HART):
 *   - Token erscheint NIEMALS in Argv, Log, Audit, HTTP-Response oder WS-Stream.
 *   - Token fließt nur als Dateiinhalt (stdin-Muster, pushTunnelEnvFile).
 *   - Audit-First: Audit-Eintrag VOR jeder mutierenden Phase.
 *   - Keine Secrets in TunnelRecreateReport.
 *
 * Boundary (ADR-012):
 *   - CloudflareApi bleibt einziger CF-Sprecher (via addRouteOnly).
 *   - VpsDockerControl bleibt einziger SSH+Docker-auf-VPS-Pfad.
 *   - VpsProviderRegistry bleibt Tunnel-Persistenz-Boundary.
 *   - DeployOrchestrator.addRouteOnly ist der GETEILTE Anlege-Pfad (S-188 AC6).
 *
 * @module deploy/TunnelHealService
 */

import { sanitizeTunnelName } from '../vps/tunnelName.js';

/** CredentialStore-Schlüssel für das Tunnel-Token (geheim, verschlüsselt at rest). */
const TUNNEL_TOKEN_KEY = (tunnelId) => `credentials/cloudflare/tunnel_token/${tunnelId}`;

/** CredentialStore-Schlüssel für die Tunnel-ID-Zuordnung (nicht geheim). */
const TUNNEL_ID_KEY = (sanitizedName) => `credentials/misc/vps-${sanitizedName}-tunnel-id`;

// ── TunnelHealService ─────────────────────────────────────────────────────────

export class TunnelHealService {
  /** @type {import('../cloudflare/CloudflareApi.js').CloudflareApi} */
  #cloudflareApi;

  /** @type {import('./VpsDockerControl.js').VpsDockerControl} */
  #vpsDockerControl;

  /** @type {import('../CredentialStore.js').CredentialStore} */
  #credentialStore;

  /**
   * Shared ADR-012 route-add path (S-188 AC6).
   * null = not configured → Phase 3 skipped (no-op with empty routes[]).
   *
   * @type {import('./DeployOrchestrator.js').DeployOrchestrator|null}
   */
  #deployOrchestrator;

  /**
   * @param {object} opts
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi} opts.cloudflareApi
   * @param {import('./VpsDockerControl.js').VpsDockerControl} opts.vpsDockerControl
   * @param {import('../CredentialStore.js').CredentialStore} opts.credentialStore
   * @param {import('./DeployOrchestrator.js').DeployOrchestrator} [opts.deployOrchestrator]
   *   Shared ADR-012 route-add path (S-188 AC6). When omitted, Phase 3 is skipped.
   */
  constructor({ cloudflareApi, vpsDockerControl, credentialStore, deployOrchestrator }) {
    if (!cloudflareApi || typeof cloudflareApi.createTunnel !== 'function') {
      throw new Error('[TunnelHealService] cloudflareApi ist Pflicht');
    }
    if (!vpsDockerControl || typeof vpsDockerControl.pushTunnelEnvFile !== 'function') {
      throw new Error('[TunnelHealService] vpsDockerControl ist Pflicht');
    }
    if (!credentialStore || typeof credentialStore.set !== 'function') {
      throw new Error('[TunnelHealService] credentialStore ist Pflicht');
    }
    this.#cloudflareApi = cloudflareApi;
    this.#vpsDockerControl = vpsDockerControl;
    this.#credentialStore = credentialStore;
    // deployOrchestrator is optional — Phase 3 is skipped if not provided
    this.#deployOrchestrator = (deployOrchestrator && typeof deployOrchestrator.addRouteOnly === 'function')
      ? deployOrchestrator
      : null;
  }

  // ── Phase 1 + 2 + 3 (S-187 + S-188) ────────────────────────────────────────────

  /**
   * Führt Phase 1 (Tunnel neu anlegen & Referenz ersetzen), Phase 2
   * (Token-Push via SSH + cloudflared-Restart) und Phase 3 (Routen bestücken)
   * durch.
   *
   * Gibt einen secret-freien TunnelRecreateReport zurück.
   *
   * Security-Floor (AC4/AC11, HART):
   *   - Token NIE in Audit, Response, Argv, Log.
   *   - Audit-First VOR Phase 1 (vorPhase1-Audit) und vor Phase 2.
   *   - Phase 3 nutzt ausschließlich den geteilten addRouteOnly-Pfad (AC6).
   *
   * @param {object} params
   * @param {string} params.vpsId        - VPS-ID (sanitisierter Name)
   * @param {string} params.vpsName      - VPS-Name für Tunnel-Namenskonvention
   * @param {object} params.vpsTarget    - { host, port?, targetUser } für SSH in Phase 2+3
   * @param {string|null} [params.identity] - Identität für Audit-Einträge (nie Token)
   * @param {import('../AuditStore.js').AuditStore} params.auditStore
   * @returns {Promise<TunnelRecreateReport>}
   */
  async recreate({ vpsId, vpsName, vpsTarget, identity, auditStore }) {
    const sanitized = sanitizeTunnelName(vpsName);
    // Tunnel-Name = Servername (sanitisiert). Kein Präfix — der Name spiegelt den VPS.
    const tunnelName = sanitized;

    // Alte Tunnel-Id lesen (für best-effort Alt-Token-Cleanup nach Phase 1, AC1)
    let oldTunnelId = null;
    try {
      oldTunnelId = await this.#credentialStore.getPlaintext(TUNNEL_ID_KEY(sanitized)) ?? null;
    } catch {
      // best-effort: Fehler beim Lesen der alten ID ist kein Phase-1-Abbruchgrund
    }

    // ── Audit-First (AC12): vor jeder mutierenden Phase ──────────────────────────
    // Audit VOR Phase 1 — schlägt Audit fehl → Aktion unterbleibt (AC12)
    // Security: kein Token, kein Key im Audit-Eintrag
    try {
      auditStore.record({
        identity: identity ?? null,
        command: `tunnel:recreate:phase1:${vpsId}:${tunnelName}`,
      });
    } catch {
      // Audit-Write fehlgeschlagen → Phase 1 unterbleibt (AC12); kein orphan-Secret
      console.log(`[TunnelHealService] Phase 1 Audit-Write fehlgeschlagen`);
      return {
        vpsId,
        newTunnelId: null,
        oldTunnelId,
        phase1: { ok: false, errorClass: 'audit-failed' },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1:audit', errorClass: 'audit-failed' }],
      };
    }

    // ── Phase 1 — Tunnel neu anlegen & Referenz ersetzen ─────────────────────────

    // Idempotenz (Selbstheilung wiederholbar): Ein gleichnamiger Tunnel aus einem früheren
    // (Teil-)Lauf — oder ein verwaister gleichnamiger Tunnel, der den Namen noch belegt — würde
    // createTunnel mit HTTP 409 conflict blockieren. Vorab abräumen. Best-effort: scheitert
    // der Cleanup, kommt der Konflikt unten sauber als errorClass 'conflict' hoch.
    try {
      const accountTunnels = await this.#cloudflareApi.listTunnels('');
      for (const t of (accountTunnels ?? [])) {
        if (t?.name === tunnelName && t?.id) {
          await this.#cloudflareApi.deleteTunnel(t.id);
          console.log(`[TunnelHealService] Phase 1: gleichnamigen Alt-Tunnel entfernt: id=${t.id} name=${tunnelName}`);
        }
      }
    } catch (cleanupErr) {
      console.log(`[TunnelHealService] Phase 1: Alt-Tunnel-Cleanup übersprungen (${cleanupErr?.errorClass ?? 'error'})`);
    }

    let newTunnelId;
    let tunnelToken; // transient — nie loggen, nie in Response

    try {
      const created = await this.#cloudflareApi.createTunnel(tunnelName);
      newTunnelId = created.tunnelId;
      tunnelToken = created.token;
      // Security-Floor: tunnelId ist nicht-geheim, darf geloggt werden; Token NIEMALS
      console.log(`[TunnelHealService] Phase 1: Cloudflare-Tunnel angelegt: id=${newTunnelId} name=${tunnelName}`);
    } catch (err) {
      // AC2: Fehler in Phase 1 → kein SSH-Schritt, kein orphan-Secret
      const errorClass = err?.errorClass ?? 'cloudflare-unavailable';
      console.log(`[TunnelHealService] Phase 1 fehlgeschlagen: ${errorClass}`);
      // Kein neues Token wurde angelegt → kein Cleanup nötig (AC2)
      return {
        vpsId,
        newTunnelId: null,
        oldTunnelId,
        phase1: { ok: false, errorClass },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1', errorClass }],
      };
    }

    // Token im CredentialStore ablegen (verschlüsselt at rest, AC1/AC11)
    // Security-Floor: Token fließt nur in den Store — nie in Log/Response/Audit/Argv
    try {
      await this.#credentialStore.set(TUNNEL_TOKEN_KEY(newTunnelId), tunnelToken);
    } catch {
      // Store-Fehler bei Token-Ablage: Phase 1 ungültig — kein orphan-Secret (Token nicht referenziert)
      const errorClass = 'store-error';
      console.log(`[TunnelHealService] Phase 1: Token-Ablage fehlgeschlagen`);
      return {
        vpsId,
        newTunnelId: null,
        oldTunnelId,
        phase1: { ok: false, errorClass },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1:token-store', errorClass }],
      };
    }

    // TUNNEL_ID_KEY aktualisieren: alte tote Referenz → neue Id (AC1)
    try {
      await this.#credentialStore.set(TUNNEL_ID_KEY(sanitized), newTunnelId);
    } catch {
      const errorClass = 'store-error';
      console.log(`[TunnelHealService] Phase 1: Tunnel-ID-Update fehlgeschlagen`);
      return {
        vpsId,
        newTunnelId: null,
        oldTunnelId,
        phase1: { ok: false, errorClass },
        phase2: { ok: false, errorClass: 'skipped' },
        routes: [],
        errors: [{ scope: 'phase1:id-store', errorClass }],
      };
    }

    // Alte Token-Referenz best-effort aufräumen (AC1: kein Rollback bei Fehler)
    if (oldTunnelId && oldTunnelId !== newTunnelId) {
      try {
        await this.#credentialStore.delete(TUNNEL_TOKEN_KEY(oldTunnelId));
      } catch {
        // best-effort: Fehler beim Aufräumen kippt die Heilung nicht (AC1)
      }
    }

    // Audit Phase-1-Erfolg (Tunnel-Id nicht-geheim → darf in Audit)
    try {
      auditStore.record({
        identity: identity ?? null,
        command: `tunnel:recreate:phase1:ok:${vpsId}:newTunnelId=${newTunnelId}`,
      });
    } catch { /* ignore outcome-audit failure */ }

    // ── Phase 2 — Token-Push via SSH + cloudflared-Restart ───────────────────────
    // Audit-First vor Phase 2 (AC12): schlägt Audit fehl → Aktion unterbleibt
    // Security: kein Token im Audit-Eintrag
    try {
      auditStore.record({
        identity: identity ?? null,
        command: `tunnel:recreate:phase2:${vpsId}:${newTunnelId}`,
      });
    } catch {
      // Audit-Write fehlgeschlagen → Phase 2 unterbleibt (AC12)
      console.log(`[TunnelHealService] Phase 2 Audit-Write fehlgeschlagen`);
      return {
        vpsId,
        newTunnelId,
        oldTunnelId,
        phase1: { ok: true },
        phase2: { ok: false, errorClass: 'audit-failed' },
        routes: [],
        errors: [{ scope: 'phase2:audit', errorClass: 'audit-failed' }],
      };
    }

    // VPS-Ziel-Prüfung: vpsTarget muss vorhanden sein (sonst SSH nicht möglich)
    if (!vpsTarget || !vpsTarget.host) {
      console.log(`[TunnelHealService] Phase 2: Kein VPS-Ziel verfügbar (kein host)`);
      return {
        vpsId,
        newTunnelId,
        oldTunnelId,
        phase1: { ok: true },
        phase2: { ok: false, errorClass: 'vps-target-missing' },
        routes: [],
        errors: [{ scope: 'phase2:target', errorClass: 'vps-target-missing' }],
      };
    }

    // Token-Push + cloudflared-Restart (AC3/AC4):
    // Token fließt via stdin (pushTunnelEnvFile), nie als Argv/Log
    // Security-Floor: tunnelToken ist transient; nach diesem Aufruf wird es nicht weiter verwendet
    const phase2Result = await this.#vpsDockerControl.pushTunnelEnvFile(vpsTarget, tunnelToken);

    // Explizit überschreiben: Token aus dem Speicher entfernen (GC-Hilfe, Defense in Depth)
    // (JavaScript hat kein sicheres Speicher-Löschen; das ist eine best-effort-Maßnahme)
    tunnelToken = null; // eslint-disable-line no-useless-assignment

    if (phase2Result.result !== 'ok') {
      // AC5: Phase 2 fehlgeschlagen → Tunnel bleibt referenziert, Phase 3 übersprungen
      const errorClass = phase2Result.errorClass ?? 'ssh-failed';
      console.log(`[TunnelHealService] Phase 2 fehlgeschlagen: ${errorClass}`);
      try {
        auditStore.record({
          identity: identity ?? null,
          command: `tunnel:recreate:phase2:failed:${vpsId}:${errorClass}`,
        });
      } catch { /* ignore */ }
      return {
        vpsId,
        newTunnelId,
        oldTunnelId,
        phase1: { ok: true },
        phase2: { ok: false, errorClass },
        routes: [],
        errors: [{ scope: 'phase2', errorClass }],
      };
    }

    // Audit Phase-2-Erfolg (kein Token im Eintrag)
    try {
      auditStore.record({
        identity: identity ?? null,
        command: `tunnel:recreate:phase2:ok:${vpsId}:${newTunnelId}`,
      });
    } catch { /* ignore */ }

    console.log(`[TunnelHealService] Phase 1+2 erfolgreich: vpsId=${vpsId} newTunnelId=${newTunnelId}`);

    // ── Phase 3 — Routen bestücken (S-188 AC6/AC7/AC8) ───────────────────────────
    // Nur wenn deployOrchestrator konfiguriert ist (optionale Dependency).
    const routes = [];
    const phase3Errors = [];

    if (!this.#deployOrchestrator) {
      // Phase 3 nicht konfiguriert — no-op (graceful degradation)
      console.log(`[TunnelHealService] Phase 3 übersprungen (kein deployOrchestrator)`);
    } else {
      // AC6: Managed Container auslesen (Label cloudflare.tunnel-hostname + Host-Port)
      let psResult;
      try {
        psResult = await this.#vpsDockerControl.ps(vpsTarget);
      } catch (psErr) {
        // ps() fehlgeschlagen → Phase 3 abgebrochen, Tunnel referenziert (additiv)
        const errorClass = psErr?.errorClass ?? 'ps-failed';
        console.log(`[TunnelHealService] Phase 3: ps() fehlgeschlagen: ${errorClass}`);
        phase3Errors.push({ scope: 'phase3:ps', errorClass });
        return {
          vpsId,
          newTunnelId,
          oldTunnelId,
          phase1: { ok: true },
          phase2: { ok: true },
          routes,
          errors: phase3Errors,
          result: 'partial',
        };
      }

      if (psResult.result !== 'ok') {
        // ps() returned error (non-throw)
        const errorClass = psResult.errorClass ?? 'ps-failed';
        console.log(`[TunnelHealService] Phase 3: ps() Fehler: ${errorClass}`);
        phase3Errors.push({ scope: 'phase3:ps', errorClass });
        return {
          vpsId,
          newTunnelId,
          oldTunnelId,
          phase1: { ok: true },
          phase2: { ok: true },
          routes,
          errors: phase3Errors,
          result: 'partial',
        };
      }

      const containers = psResult.containers ?? [];

      if (containers.length === 0) {
        // Keine managed Container → Phase 3 no-op (Spec: leere routes[]-Liste)
        console.log(`[TunnelHealService] Phase 3: Keine managed Container gefunden — no-op`);
      }

      // AC6/AC7/AC8: je Container über geteilten addRouteOnly-Pfad (LockoutGuard inbegriffen)
      // Pro Container degradierend: ein Fehler kippt die übrigen nicht (AC8).
      for (const container of containers) {
        const hostname = container.hostname;
        const hostPort = container.hostPort ?? 8080;

        if (!hostname) {
          // Unmanaged Container (kein Label) — überspringen, wie Reconciliation
          continue;
        }

        try {
          // AC6: GETEILTER ADR-012-Anlege-Pfad — kein eigener CF-Mutationscode
          const addResult = await this.#deployOrchestrator.addRouteOnly({
            tunnelId: newTunnelId,
            hostname,
            hostPort,
          });

          if (addResult.result === 'ok') {
            // AC8: Ergebnis je Container: route-created
            routes.push({ hostname, result: 'route-created' });
            console.log(`[TunnelHealService] Phase 3: Route angelegt: ${hostname}`);
          } else if (addResult.errorClass === 'protected-resource') {
            // AC7: Protected Hostname → protectedSkipped, kein Anlege-Call ausgeführt
            routes.push({ hostname, result: 'protected-skipped' });
            console.log(`[TunnelHealService] Phase 3: Protected-Skip: ${hostname}`);
          } else {
            // AC8: Fehler beim Anlegen → error im Report, übrige Container laufen weiter
            const errorClass = addResult.errorClass ?? 'error';
            routes.push({ hostname, result: 'error', errorClass });
            phase3Errors.push({ scope: `phase3:route:${hostname}`, errorClass });
            console.log(`[TunnelHealService] Phase 3: Route fehlgeschlagen ${hostname}: ${errorClass}`);
          }
        } catch (routeErr) {
          // AC8: Unerwarteter Fehler → error, übrige Container laufen weiter
          const errorClass = routeErr?.errorClass ?? 'error';
          routes.push({ hostname, result: 'error', errorClass });
          phase3Errors.push({ scope: `phase3:route:${hostname}`, errorClass });
          console.log(`[TunnelHealService] Phase 3: Unerwarteter Fehler ${hostname}: ${errorClass}`);
        }
      }
    }

    // AC8: Gesamt-Ergebnis: "ok" wenn keine Phase-3-Fehler, "partial" wenn Teil-Fehler
    const hasPhase3Errors = phase3Errors.length > 0;
    const overallResult = hasPhase3Errors ? 'partial' : 'ok';

    console.log(`[TunnelHealService] Phase 1+2+3 abgeschlossen: vpsId=${vpsId} newTunnelId=${newTunnelId} result=${overallResult} routes=${routes.length}`);

    return {
      vpsId,
      newTunnelId,
      oldTunnelId,
      phase1: { ok: true },
      phase2: { ok: true },
      routes,
      errors: phase3Errors,
      result: overallResult,
    };
  }
}

/**
 * @typedef {object} TunnelRecreateReport
 * @property {string}        vpsId        - VPS-ID
 * @property {string|null}   newTunnelId  - neue Tunnel-Id (null bei Phase-1-Fehler)
 * @property {string|null}   oldTunnelId  - alte Tunnel-Id (null wenn keine vorhanden war)
 * @property {{ ok: boolean, errorClass?: string }} phase1  - Phase-1-Ergebnis
 * @property {{ ok: boolean, errorClass?: string }} phase2  - Phase-2-Ergebnis
 * @property {Array<{ hostname: string, result: 'route-created'|'protected-skipped'|'error', errorClass?: string }>} routes
 *   Phase-3-Routen-Ergebnisse (S-188 AC6/AC7/AC8): je Container
 * @property {Array<{ scope: string, errorClass: string }>} errors
 *   Alle Fehler-Einträge (secret-frei)
 * @property {'ok'|'partial'} [result]
 *   Gesamt-Ergebnis: "ok" = alles erfolgreich; "partial" = Teil-Fehler (AC8)
 */
