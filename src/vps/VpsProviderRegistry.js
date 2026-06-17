/**
 * VpsProviderRegistry — einziger Ort, der Provider-APIs anspricht (AC1, ADR-009).
 *
 * Aufgaben:
 *   1. Adapter pro Provider auflösen (hetzner / ionos / hostinger).
 *   2. Provider-API-Token per Aufruf store-intern aus dem CredentialStore ziehen
 *      (credentials/vps/<provider>_api_token) — transient, nie gecacht.
 *   3. Read-Aggregation über alle konfigurierten Provider live + degradierend (AC3/AC4).
 *   4. Mutierende Aktionen (start/stop/create) für einen adressierten Provider ausführen.
 *
 * Token-Injektion (ADR-009):
 *   - Token wird pro Aufruf aus dem CredentialStore gelesen.
 *   - Token wird als Funktionsargument transient an den Adapter übergeben.
 *   - Token landet NUR im Authorization-Header — NIEMALS in URL, Log, Audit, Response, Argv.
 *
 * Degradierung (AC4):
 *   - listMachines() über alle Provider: ein Provider-Fehler kippt nicht die Gesamt-Antwort.
 *   - Fehlerhafte Provider erscheinen als { provider, errorClass } in providerErrors.
 *   - Mutierende Einzel-Aktionen degradieren NICHT — sie melden Fehler klar als { result: "error" }.
 *
 * @module VpsProviderRegistry
 *
 * @typedef {object} VpsMachine
 * @property {"hetzner"|"ionos"|"hostinger"} provider
 * @property {string} serverId
 * @property {string} name
 * @property {"running"|"stopped"|"provisioning"|"error"|"unknown"} status
 * @property {string|null} ipv4
 * @property {string|null} ipv6
 * @property {string|null} region
 * @property {string|null} serverType
 * @property {string|null} createdAt
 *
 * @typedef {object} ProviderInfo
 * @property {"hetzner"|"ionos"|"hostinger"} id
 * @property {boolean} configured
 * @property {{ list: boolean, start: boolean, stop: boolean, create: boolean }} capabilities
 *
 * @typedef {object} ListResult
 * @property {VpsMachine[]} machines
 * @property {Array<{ provider: string, errorClass: string }>} [providerErrors]
 */

import { HetznerAdapter } from './providers/hetzner.js';
import { IonosAdapter } from './providers/ionos.js';
import { HostingerAdapter } from './providers/hostinger.js';
import { CloudInitBuilder } from './CloudInitBuilder.js';
import { sanitizeTunnelName } from './tunnelName.js';

/** Alle bekannten Provider-IDs. */
const KNOWN_PROVIDERS = ['hetzner', 'ionos', 'hostinger'];

/** CredentialStore-Schlüssel-Schema für Provider-Tokens. */
const TOKEN_KEY = (provider) => `credentials/vps/${provider}_api_token`;

/** Per-Provider-Timeout für listMachines (ms) — ADR-009. */
const LIST_TIMEOUT_MS = 10000;

// ── VpsProviderRegistry ────────────────────────────────────────────────────────

/** CredentialStore-Schlüssel für das Tunnel-Token (Geheimnis, verschlüsselt at rest). */
const TUNNEL_TOKEN_KEY = (tunnelId) => `credentials/cloudflare/tunnel_token/${tunnelId}`;

/** CredentialStore-Schlüssel für die Tunnel-ID-Zuordnung (nicht geheim, encrypted für Einheitlichkeit). */
const TUNNEL_ID_KEY = (sanitizedName) => `credentials/misc/vps-${sanitizedName}-tunnel-id`;

export class VpsProviderRegistry {
  /** @type {import('../CredentialStore.js').CredentialStore} */
  #credentialStore;

  /** @type {Map<string, object>} Provider-Adapter-Instanzen */
  #adapters;

  /** @type {CloudInitBuilder} Server-interner cloud-init-Erzeuger (ADR-009) */
  #cloudInitBuilder;

  /**
   * Cloudflare-API-Boundary für Tunnel-Provisionierung beim VPS-Create (S-152).
   * Null wenn nicht konfiguriert → VPS-Create läuft ohne Tunnel (AC9).
   *
   * @type {import('../cloudflare/CloudflareApi.js').CloudflareApi|null}
   */
  #cloudflareApi;

  /**
   * @param {object} options
   * @param {import('../CredentialStore.js').CredentialStore} options.credentialStore
   * @param {object} [options.adapters] - Injectable adapters for tests: { hetzner, ionos, hostinger }
   * @param {CloudInitBuilder} [options.cloudInitBuilder] - Injectable for tests
   * @param {import('../cloudflare/CloudflareApi.js').CloudflareApi|null} [options.cloudflareApi]
   *   Cloudflare-API-Instanz für Tunnel-Provisionierung beim Create (S-152, AC5–AC10).
   *   Wenn null/undefined → Create läuft ohne Tunnel-Provisionierung (AC9-Variante: kein Crash).
   */
  constructor({ credentialStore, adapters, cloudInitBuilder, cloudflareApi } = {}) {
    this.#credentialStore = credentialStore;

    // Adapter-Instanzen aufbauen (injectable für Tests)
    const inj = adapters ?? {};
    this.#adapters = new Map([
      ['hetzner',   inj.hetzner   ?? new HetznerAdapter()],
      ['ionos',     inj.ionos     ?? new IonosAdapter()],
      ['hostinger', inj.hostinger ?? new HostingerAdapter()],
    ]);

    // CloudInitBuilder: server-intern, nie client-controlled (ADR-009)
    this.#cloudInitBuilder = cloudInitBuilder ?? new CloudInitBuilder();

    // CloudflareApi: optional — fehlt → kein Tunnel (AC9)
    this.#cloudflareApi = cloudflareApi ?? null;
  }

  // ── Öffentliche API ──────────────────────────────────────────────────────────

  /**
   * Listet alle Provider mit Konfigurations-Status und Capability-Flags.
   * Kein Provider-API-Aufruf (nur CredentialStore-Metadaten-Check).
   *
   * @returns {Promise<ProviderInfo[]>}
   */
  async listProviders() {
    const result = [];
    for (const id of KNOWN_PROVIDERS) {
      const configured = await this.#isConfigured(id);
      const adapter = this.#adapters.get(id);
      result.push({
        id,
        configured,
        capabilities: adapter.capabilities(),
      });
    }
    return result;
  }

  /**
   * Aggregiert VpsMachine-Listen über alle konfigurierten Provider live.
   * Degradierend: ein fehlerhafter Provider erzeugt keinen 500 (AC4).
   *
   * @returns {Promise<ListResult>}
   */
  async listAllMachines() {
    const machines = [];
    const providerErrors = [];

    // Nur konfigurierte Provider anfragen (AC2)
    const promises = KNOWN_PROVIDERS.map(async (id) => {
      const token = await this.#getToken(id);
      if (!token) {
        // Nicht konfiguriert — kein API-Call, kein Eintrag in providerErrors
        return;
      }

      try {
        // Per-Provider-Timeout via Promise.race (AC4 Degradation)
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('timeout')), LIST_TIMEOUT_MS);
        });
        const adapter = this.#adapters.get(id);
        const result = await Promise.race([
          adapter.listMachines(token),
          timeoutPromise,
        ]);
        clearTimeout(timeoutHandle); // S1: dangling Timer aufräumen (analog #apiGet-Muster)
        machines.push(...result);
      } catch (err) {
        const errorClass = classifyProviderError(err);
        providerErrors.push({ provider: id, errorClass });
        // Kein Re-Throw — Degradation: die übrigen Provider werden weiter verarbeitet
      }
    });

    await Promise.allSettled(promises);

    const response = { machines };
    if (providerErrors.length > 0) {
      response.providerErrors = providerErrors;
    }
    return response;
  }

  /**
   * Startet einen Server (power-on) beim adressierten Provider.
   *
   * @param {string} provider - "hetzner" | "ionos" | "hostinger"
   * @param {string} serverId
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   * @throws {VpsRegistryError} bei provider-not-configured oder unbekanntem Provider
   */
  async start(provider, serverId) {
    const { token, adapter } = await this.#resolveProviderOrThrow(provider);
    return adapter.start(serverId, token);
  }

  /**
   * Stoppt einen Server (power-off) beim adressierten Provider.
   *
   * @param {string} provider - "hetzner" | "ionos" | "hostinger"
   * @param {string} serverId
   * @returns {Promise<{ result: "ok"|"unsupported"|"error", reason?: string }>}
   * @throws {VpsRegistryError}
   */
  async stop(provider, serverId) {
    const { token, adapter } = await this.#resolveProviderOrThrow(provider);
    return adapter.stop(serverId, token);
  }

  /**
   * Erstellt einen neuen Server beim adressierten Provider.
   *
   * ADR-009: userData wird IMMER server-intern über CloudInitBuilder erzeugt —
   * niemals aus dem Client-Body übernommen. Der Client liefert nur fachliche
   * Create-Parameter (name, region, serverType, image) sowie die SSH-Key-Zuordnung
   * als Label-Referenzen (sshKeyAssignment: { root: <label>, alex: <label> }).
   *
   * SSH-Key-Auflösung (AC3, vps-ssh-key-assignment):
   *   Die Label-Referenzen werden store-intern über den CredentialStore in Public-Keys
   *   aufgelöst (getPublicKey). Fehlt ein Public-Key → CloudInitError(missing-ssh-key, 422)
   *   via CloudInitBuilder.build(). Nur Public-Keys verlassen den Store (security/R01).
   *
   * @param {string} provider
   * @param {object} params
   *   { name, region, serverType, image?,
   *     sshKeyAssignment?: { root: <label>, alex: <label> } }
   *   userData und sshPublicKeys werden NICHT aus params übernommen — sie werden
   *   server-intern erzeugt/aufgelöst.
   * @returns {Promise<VpsMachine>}
   * @throws {VpsRegistryError}
   * @throws {CloudInitError} wenn ein Public-Key fehlt (AC5, missing-ssh-key 422)
   */
  async create(provider, params) {
    const { token, adapter } = await this.#resolveProviderOrThrow(provider);

    // AC3/AC4: SSH-Key-Auflösung: Label → Public-Key store-intern.
    // Nur Public-Keys verlassen den Store (security/R01 / NFR AC4).
    const sshPublicKeys = await this.#resolveSshPublicKeys(params.sshKeyAssignment);

    // S-152 AC5–AC10: Cloudflare-Tunnel-Provisionierung VOR dem cloud-init-Build.
    // AC9-Variante (dokumentiert): Wenn Cloudflare nicht konfiguriert ist (cloudflare-not-configured)
    // oder kein cloudflareApi injiziert wurde → Create läuft ohne Tunnel-Setup weiter.
    // Bei anderen CF-Fehlern (Auth, Netz) → Create bricht ab (Fehler wird weiter geworfen).
    const tunnelResult = await this.#provisionTunnel(params.name);
    // tunnelResult: { tunnelId, tunnelToken } | null (null = kein Tunnel, kein Fehler)

    // ADR-009: cloud-init server-intern erzeugen — NIE vom Client übernehmen.
    // CloudInitBuilder.build() wirft CloudInitError(missing-ssh-key, 422) wenn
    // ein Public-Key fehlt — vor jedem Provider-Call (AC5/AC7).
    // Wenn tunnelToken vorhanden → cloudflared-Block wird eingebaut (vps-cloud-init-setup AC12).
    const userData = this.#cloudInitBuilder.build({
      name: params.name,
      sshPublicKeys,
      tunnelToken: tunnelResult?.tunnelToken, // undefined wenn kein Tunnel (rückwärtskompatibel)
    });

    // S-152 AC8/AC10: Token im CredentialStore ablegen NACH Build (aber VOR Provider-Call).
    // Bei späterer VPS-Laufzeit-Fehler bleibt Token referenziert (AC10 — kein verwaistes Geheimnis).
    if (tunnelResult) {
      await this.#persistTunnelCredentials(params.name, tunnelResult.tunnelId, tunnelResult.tunnelToken);
    }

    const adapterParams = {
      name: params.name,
      region: params.region,
      serverType: params.serverType,
      image: params.image,
      userData,
      sshPublicKeys,
      // S-152 AC7: tunnelId für nachgelagerte Zuordnung (Deploy, vps-delete).
      // Tunnel-Name-Konvention devgui-<sanitized-vpsname> ist der primäre Lookup-Pfad.
      // tunnelId steht zusätzlich im CredentialStore (TUNNEL_ID_KEY).
      // NICHT das tunnelToken selbst weitergeben — nur die ID.
      tunnelId: tunnelResult?.tunnelId ?? null,
    };

    return adapter.create(adapterParams, token);
  }

  // ── Tunnel-Provisionierung (S-152) ───────────────────────────────────────────

  /**
   * Legt einen Cloudflare-Tunnel für den VPS an (S-152 AC5).
   *
   * Tunnel-Name-Konvention: `devgui-<sanitized-vpsname>` (AC5, vps-tunnel-provisioning).
   * Der Deploy (S-155) findet den Tunnel via listTunnels + Namensabgleich.
   * Zusätzlich wird die tunnelId im CredentialStore gespeichert (TUNNEL_ID_KEY).
   *
   * AC9-Verhalten:
   *   - Kein cloudflareApi injiziert → return null (kein Tunnel, kein Crash).
   *   - cloudflare-not-configured → return null (kein Tunnel, kein Crash; klar protokolliert).
   *   - Andere CF-Fehler (Auth, Netz) → Fehler weiter werfen → Create bricht ab.
   *
   * Security-Floor:
   *   - tunnelToken NIEMALS in Log oder Fehlermeldung (AC2, AC6, security/R01).
   *   - Token fließt nur in CloudInitBuilder.build() + CredentialStore (verschlüsselt at rest).
   *
   * @param {string} vpsName - VPS-Name (roh, wird zu Tunnel-Name sanitisiert)
   * @returns {Promise<{ tunnelId: string, tunnelToken: string }|null>}
   */
  async #provisionTunnel(vpsName) {
    if (!this.#cloudflareApi) {
      // Kein cloudflareApi injiziert — AC9: VPS-Create ohne Tunnel
      console.log('[VpsProviderRegistry] Tunnel-Provisionierung übersprungen: kein CloudflareApi konfiguriert');
      return null;
    }

    const tunnelName = `devgui-${sanitizeTunnelName(vpsName)}`;

    try {
      // AC5: genau 1 Tunnel anlegen; Tunnel-Name-Konvention devgui-<sanitized-vpsname>
      const { tunnelId, token: tunnelToken } = await this.#cloudflareApi.createTunnel(tunnelName);

      // AC2/AC6/Security-Floor: Token NIEMALS loggen — nur tunnelId protokollieren
      console.log(`[VpsProviderRegistry] Cloudflare-Tunnel angelegt: id=${tunnelId} name=${tunnelName}`);

      return { tunnelId, tunnelToken };
    } catch (err) {
      if (err?.errorClass === 'cloudflare-not-configured') {
        // AC9: Cloudflare nicht konfiguriert → Create ohne Tunnel (kein Crash)
        // Kein Secret in diesem Log (errorClass, kein Token)
        console.log(`[VpsProviderRegistry] Tunnel-Provisionierung übersprungen: Cloudflare nicht konfiguriert (${err.errorClass})`);
        return null;
      }
      // Alle anderen Fehler (Auth, Netz, Name-Kollision) → weiter werfen → Create bricht ab
      // Security: err.message enthält kein Token (CloudflareApi-Floor)
      throw err;
    }
  }

  /**
   * Legt Tunnel-Token + Tunnel-ID im CredentialStore ab (S-152 AC7/AC8).
   *
   * Token-Schlüssel:  credentials/cloudflare/tunnel_token/<tunnelId>  (geheim, verschlüsselt)
   * ID-Schlüssel:     credentials/misc/vps-<sanitized-vpsname>-tunnel-id (nicht geheim, aber
   *                   encrypted für Einheitlichkeit; dient Deploy+vps-delete als Lookup)
   *
   * AC7: Token-Referenz = Token-Schlüssel (TUNNEL_TOKEN_KEY(tunnelId)); NICHT das Token selbst.
   * AC8: Token at rest verschlüsselt (ADR-007 / CredentialStore.set()).
   * AC10: Falls der VPS-Start zur Laufzeit scheitert, bleibt Token hier referenziert.
   *
   * Security: Bei Store-Fehler → Fehler weiter werfen (kein silent-Ignore bei Credentials-Write).
   *
   * @param {string} vpsName
   * @param {string} tunnelId
   * @param {string} tunnelToken
   */
  async #persistTunnelCredentials(vpsName, tunnelId, tunnelToken) {
    if (!this.#credentialStore) {
      // Kein Store (nur in Tests ohne Store-Stub) — kein Fehler, nur Log
      console.log('[VpsProviderRegistry] Tunnel-Credentials nicht persistiert: kein CredentialStore');
      return;
    }

    const sanitized = sanitizeTunnelName(vpsName);

    // AC8: Token verschlüsselt at rest im CredentialStore
    // Security-Floor: Token geht NUR in den Store — nie in Log, Response, Argv
    await this.#credentialStore.set(TUNNEL_TOKEN_KEY(tunnelId), tunnelToken);

    // AC7: Tunnel-ID als Zuordnung speichern (nicht geheim, aber im Store für Konsistenz)
    await this.#credentialStore.set(TUNNEL_ID_KEY(sanitized), tunnelId);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Löst die SSH-Key-Label-Zuordnung in Public-Keys auf (AC3, vps-ssh-key-assignment).
   *
   * Für jede Rolle (root, alex) wird das zugeordnete Label über
   * `CredentialStore.getPublicKey(label)` aufgelöst. Das Ergebnis-Objekt
   * `{ root, alex }` wird an CloudInitBuilder.build() übergeben.
   *
   * Security-Floor (security/R01 / AC4):
   *   - Nur Public-Keys werden zurückgegeben; Private-Keys verlassen den Store
   *     über diesen Pfad niemals.
   *   - Labels werden gegen die USER_LABEL_RE-Regex validiert (security/R02).
   *   - Fehlt ein Public-Key für root oder alex, gibt build() CloudInitError(missing-ssh-key)
   *     zurück — vor jedem Provider-Call.
   *
   * @param {{ root?: string, alex?: string }} [assignment] - Label-Referenzen je Rolle
   * @returns {Promise<{ root?: string, alex?: string }>} Public-Keys je Rolle
   */
  async #resolveSshPublicKeys(assignment) {
    if (!assignment || !this.#credentialStore) {
      return {};
    }

    // security/R02: Labels validieren (gleiche Regex wie CredentialStore/sshKeysRouter)
    const USER_LABEL_RE = /^[a-zA-Z0-9_\-.:@]+$/;
    const MAX_LABEL_LEN = 64;

    const resolved = {};

    for (const role of ['root', 'alex']) {
      const label = assignment[role];
      if (!label || typeof label !== 'string') {
        continue; // fehlendes Label → build() wirft missing-ssh-key
      }
      // Input-Validierung: Label darf nur sichere Zeichen enthalten (security/R02)
      const trimmed = label.trim();
      if (!trimmed || trimmed.length > MAX_LABEL_LEN || !USER_LABEL_RE.test(trimmed)) {
        continue; // ungültiges Label → kein Store-Zugriff → build() wirft missing-ssh-key
      }
      // Public-Key ist Klartext-Metadatum im Store — nicht verschlüsselt, nicht geheim
      const publicKey = await this.#credentialStore.getPublicKey(trimmed);
      if (publicKey) {
        resolved[role] = publicKey;
      }
      // fehlendes publicKey → resolved[role] bleibt undefined → build() wirft missing-ssh-key
    }

    return resolved;
  }

  /**
   * Prüft ob ein Provider konfiguriert ist (Token gesetzt).
   * @param {string} provider
   * @returns {Promise<boolean>}
   */
  async #isConfigured(provider) {
    if (!this.#credentialStore) return false;
    try {
      const meta = await this.#credentialStore.getMeta(TOKEN_KEY(provider));
      return meta.status === 'set';
    } catch {
      return false;
    }
  }

  /**
   * Liest das Provider-Token transient aus dem CredentialStore.
   * Gibt null zurück wenn nicht gesetzt (kein Fehler — nicht konfiguriert).
   * Token NIEMALS gecacht oder geloggt (ADR-009 / security/R01).
   *
   * @param {string} provider
   * @returns {Promise<string|null>}
   */
  async #getToken(provider) {
    if (!this.#credentialStore) return null;
    try {
      return await this.#credentialStore.getPlaintext(TOKEN_KEY(provider));
    } catch {
      return null;
    }
  }

  /**
   * Löst Provider-ID → { token, adapter } auf.
   * Wirft VpsRegistryError bei unbekanntem Provider oder fehlendem Token.
   *
   * @param {string} provider
   * @returns {Promise<{ token: string, adapter: object }>}
   * @throws {VpsRegistryError}
   */
  async #resolveProviderOrThrow(provider) {
    if (!KNOWN_PROVIDERS.includes(provider)) {
      throw new VpsRegistryError(
        `Unbekannter Provider: ${provider}`,
        'unknown-provider',
        404,
      );
    }

    const token = await this.#getToken(provider);
    if (!token) {
      throw new VpsRegistryError(
        `Provider '${provider}' nicht konfiguriert (kein API-Token gesetzt)`,
        'provider-not-configured',
        422,
      );
    }

    const adapter = this.#adapters.get(provider);
    return { token, adapter };
  }
}

// ── VpsRegistryError ───────────────────────────────────────────────────────────

/**
 * Typed error thrown by VpsProviderRegistry.
 * Message MUST NOT contain tokens or secrets.
 */
export class VpsRegistryError extends Error {
  /**
   * @param {string} message    - Human-readable (NO secrets)
   * @param {string} errorClass - Machine-readable classification
   * @param {number} [httpStatus] - Suggested HTTP status for router
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'VpsRegistryError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? 500;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Klassifiziert einen Provider-Fehler für den providerErrors-Array.
 * Tokens / Secrets DÜRFEN NICHT in der Klassifikation erscheinen.
 *
 * @param {Error} err
 * @returns {string} errorClass
 */
function classifyProviderError(err) {
  if (!err) return 'provider-unavailable';
  if (err.message === 'timeout') return 'provider-unavailable';

  const cls = err.errorClass;
  if (cls) return cls;

  const msg = String(err.message ?? '').toLowerCase();
  if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
    return 'provider-auth-failed';
  }
  if (msg.includes('timeout') || msg.includes('unavailable') || msg.includes('econnrefused')) {
    return 'provider-unavailable';
  }
  return 'provider-unavailable';
}
