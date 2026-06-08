/**
 * normalize.js — Provider-Rohdaten → VpsMachine (data-model.md).
 *
 * Grundregel (ADR-009 / data-model.md):
 *   Fehlende/unbekannte Felder → null (bzw. status:"unknown"), NIEMALS ein Fehler.
 *   Ein fehlendes Feld kippt weder das Mapping noch die Read-Aggregation.
 *
 * Status-Mapping (data-model.md Richtlinie):
 *   laufend / "running" / "on"             → "running"
 *   gestoppt / "off" / "stopped"           → "stopped"
 *   Erstellung / "initializing"/ "creating" → "provisioning"
 *   Defekt / Fehler des Servers            → "error"
 *   alles sonst                            → "unknown"
 *
 * @module normalize
 */

/**
 * Normalisiert einen Hetzner-Server-Roh-Eintrag auf VpsMachine.
 *
 * Hetzner-Rohdaten (GET /servers oder eingebettetes server-Objekt):
 *   id, name, status, public_net.ipv4.ip, public_net.ipv6.ip,
 *   datacenter.location.name, server_type.name, created
 *
 * Hetzner-Status-Werte (API-Dokumentation):
 *   running, off, stopping, starting, rebuilding, migrating, deleting, unknown
 *
 * @param {object} raw - Hetzner API server object
 * @returns {import('./VpsProviderRegistry.js').VpsMachine}
 */
export function normalizeHetzner(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      provider: 'hetzner',
      serverId: String(raw?.id ?? 'unknown'),
      name: raw?.name ?? 'unknown',
      status: 'unknown',
      ipv4: null,
      ipv6: null,
      region: null,
      serverType: null,
      createdAt: null,
    };
  }

  return {
    provider: 'hetzner',
    serverId: String(raw.id ?? 'unknown'),
    name: raw.name ?? 'unknown',
    status: mapHetznerStatus(raw.status),
    ipv4: raw.public_net?.ipv4?.ip ?? null,
    ipv6: raw.public_net?.ipv6?.ip ?? null,
    region: raw.datacenter?.location?.name ?? null,
    serverType: raw.server_type?.name ?? null,
    createdAt: raw.created ?? null,
  };
}

/**
 * Normalisiert einen IONOS-Server-Roh-Eintrag auf VpsMachine.
 *
 * IONOS Cloud API v6 (GET /cloudapi/v6/datacenters/{dcId}/servers?depth=1):
 *   id, properties.name, metadata.state,
 *   entities.nics.items[*].entities.ips.items[*].properties.ip,
 *   properties.availabilityZone, properties.vmState, properties.name,
 *   properties.cores, properties.ram, metadata.createdDate
 *
 * IONOS-Status-Werte:
 *   RUNNING, SHUTOFF, SUSPENDED, CRASHED, PAUSED
 *   (metadata.state kann auch BUSY, AVAILABLE sein für provisioning)
 *
 * ServerId-Kodierung (ionos.js):
 *   IONOS-Server sind unter Datacenters genestet und können nicht über ihre eigene
 *   ID allein adressiert werden. Der Adapter übergibt das vorberechnete composite
 *   serverId "<datacenterId>/<serverId>" (optionaler zweiter Parameter). Fehlt der
 *   Parameter, wird nur raw.id verwendet (Fallback für direkte Normalisierungsaufrufe).
 *
 * @param {object} raw            - IONOS API server object
 * @param {string} [compositeId]  - Optional composite "<dcId>/<srvId>" (from IonosAdapter)
 * @returns {import('./VpsProviderRegistry.js').VpsMachine}
 */
export function normalizeIonos(raw, compositeId) {
  if (!raw || typeof raw !== 'object') {
    return {
      provider: 'ionos',
      serverId: compositeId ?? String(raw?.id ?? 'unknown'),
      name: raw?.properties?.name ?? 'unknown',
      status: 'unknown',
      ipv4: null,
      ipv6: null,
      region: null,
      serverType: null,
      createdAt: null,
    };
  }

  // Extract first IP from NIC entities if available
  let ipv4 = null;
  try {
    const nics = raw.entities?.nics?.items;
    if (Array.isArray(nics) && nics.length > 0) {
      const ips = nics[0]?.entities?.ips?.items;
      if (Array.isArray(ips) && ips.length > 0) {
        ipv4 = ips[0]?.properties?.ip ?? null;
      }
    }
  } catch {
    ipv4 = null;
  }

  return {
    provider: 'ionos',
    serverId: compositeId ?? String(raw.id ?? 'unknown'),
    name: raw.properties?.name ?? 'unknown',
    status: mapIonosStatus(raw.properties?.vmState, raw.metadata?.state),
    ipv4,
    ipv6: null, // IONOS Cloud API v6 does not expose primary IPv6 in this schema
    region: raw.properties?.availabilityZone ?? null,
    serverType: raw.properties?.type ?? null,
    createdAt: raw.metadata?.createdDate ?? null,
  };
}

/**
 * Normalisiert einen Hostinger-Server-Roh-Eintrag auf VpsMachine.
 *
 * Hostinger VPS API (GET /api/vps/v1/virtual-machines):
 *   id, hostname, state, ip_addresses (array of { address, type }),
 *   location, plan_id, created_at
 *
 * Hostinger-Status-Werte (Hostinger VPS API):
 *   running, stopped, starting, stopping, provisioning, error
 *
 * @param {object} raw - Hostinger API virtual-machine object
 * @returns {import('./VpsProviderRegistry.js').VpsMachine}
 */
export function normalizeHostinger(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      provider: 'hostinger',
      serverId: String(raw?.id ?? 'unknown'),
      name: raw?.hostname ?? 'unknown',
      status: 'unknown',
      ipv4: null,
      ipv6: null,
      region: null,
      serverType: null,
      createdAt: null,
    };
  }

  // Extract IPs by type
  let ipv4 = null;
  let ipv6 = null;
  try {
    const ips = raw.ip_addresses;
    if (Array.isArray(ips)) {
      const v4 = ips.find((ip) => ip.type === 'ipv4' || ip.version === 4);
      const v6 = ips.find((ip) => ip.type === 'ipv6' || ip.version === 6);
      ipv4 = v4?.address ?? null;
      ipv6 = v6?.address ?? null;
    }
  } catch {
    ipv4 = null;
    ipv6 = null;
  }

  return {
    provider: 'hostinger',
    serverId: String(raw.id ?? 'unknown'),
    name: raw.hostname ?? raw.name ?? 'unknown',
    status: mapHostingerStatus(raw.state),
    ipv4,
    ipv6,
    region: raw.location ?? null,
    serverType: raw.plan_id ? String(raw.plan_id) : (raw.plan ?? null),
    createdAt: raw.created_at ?? null,
  };
}

// ── Status-Mapping-Helfer ──────────────────────────────────────────────────────

/**
 * Mappt Hetzner-Status-Strings auf normalisierte VpsMachine-Status-Werte.
 *
 * Hetzner-Werte: running, off, stopping, starting, rebuilding, migrating, deleting, unknown
 *
 * @param {string|undefined|null} raw
 * @returns {"running"|"stopped"|"provisioning"|"error"|"unknown"}
 */
function mapHetznerStatus(raw) {
  switch (raw) {
    case 'running':    return 'running';
    case 'off':        return 'stopped';
    case 'stopping':   return 'stopped';   // transitioning to off — map as stopped
    case 'starting':   return 'provisioning';
    case 'rebuilding': return 'provisioning';
    case 'migrating':  return 'provisioning';
    case 'deleting':   return 'provisioning';
    case 'unknown':    return 'unknown';
    default:           return 'unknown';
  }
}

/**
 * Mappt IONOS vmState + metadata.state auf normalisierte VpsMachine-Status-Werte.
 *
 * vmState-Werte: RUNNING, SHUTOFF, SUSPENDED, CRASHED, PAUSED
 * metadata.state-Werte: AVAILABLE, BUSY, INACTIVE, DEPLOYING
 *
 * @param {string|undefined|null} vmState
 * @param {string|undefined|null} metaState
 * @returns {"running"|"stopped"|"provisioning"|"error"|"unknown"}
 */
function mapIonosStatus(vmState, metaState) {
  // metadata.state takes priority for provisioning detection
  if (metaState === 'BUSY' || metaState === 'DEPLOYING') return 'provisioning';

  switch (vmState) {
    case 'RUNNING':   return 'running';
    case 'SHUTOFF':   return 'stopped';
    case 'SUSPENDED': return 'stopped';
    case 'PAUSED':    return 'stopped';
    case 'CRASHED':   return 'error';
    default:          return 'unknown';
  }
}

/**
 * Mappt Hostinger-Status-Strings auf normalisierte VpsMachine-Status-Werte.
 *
 * Hostinger-Werte: running, stopped, starting, stopping, provisioning, error
 *
 * @param {string|undefined|null} raw
 * @returns {"running"|"stopped"|"provisioning"|"error"|"unknown"}
 */
function mapHostingerStatus(raw) {
  switch (raw) {
    case 'running':      return 'running';
    case 'stopped':      return 'stopped';
    case 'stopping':     return 'stopped';   // transitioning to stopped
    case 'starting':     return 'provisioning';
    case 'provisioning': return 'provisioning';
    case 'error':        return 'error';
    default:             return 'unknown';
  }
}
