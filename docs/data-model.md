# Datenmodell — dev-gui

> Kanonische, sprach-/paradigma-unabhängige Datenmodelle, die über mehrere Specs hinweg geteilt werden. **Source of Truth** für `coder`/`tester` (Drift-Gate). dev-gui hält **keine eigene DB** (ADR-005); die hier definierten Modelle sind **Read-Models** (live ermittelt) bzw. Transport-/Vertrags-Schemata — kein persistentes Tabellenmodell.

## VpsMachine (normalisiertes, provider-agnostisches Read-Model)

Vereinheitlichtes Maschinen-Modell der Multi-Provider-VPS-Boundary ([[vps-provider-boundary]], fixiert in `docs/architecture.md` **ADR-009**). Jeder Provider-Adapter (Hetzner, IONOS, Hostinger) mappt seine Roh-Antwort auf **dieses** Schema (`src/vps/normalize.js`); höhere Schichten ([[view-vps]]) sehen **nur** dieses Modell, nie provider-spezifische Felder.

**Grundregel:** Was ein Provider nicht liefert, wird zu `null` (bzw. `status: "unknown"`) — **nie** zu einem Fehler. Ein fehlendes Feld kippt weder das Mapping noch die Read-Aggregation.

| Feld | Typ | Pflicht | Bedeutung / Normalisierung |
|---|---|---|---|
| `provider` | `"hetzner" \| "ionos" \| "hostinger"` | ja | Quell-Provider des Adapters. |
| `serverId` | string | ja | Provider-interne Server-Id (als String normalisiert, auch wenn der Provider numerische Ids führt). Adressiert start/stop. |
| `name` | string | ja | Anzeigename/Hostname des Servers. |
| `status` | `"running" \| "stopped" \| "provisioning" \| "error" \| "unknown"` | ja | Normalisiertes Power-/Lifecycle-Enum. Unbekannter/ nicht mappbarer Provider-Status → `"unknown"` (kein Fehler). |
| `ipv4` | string \| null | nein | Primäre IPv4, sofern bekannt; sonst `null`. |
| `ipv6` | string \| null | nein | Primäre IPv6, sofern bekannt; sonst `null`. |
| `region` | string \| null | nein | Region/Location/Datacenter (provider-eigener Bezeichner, durchgereicht); sonst `null`. |
| `serverType` | string \| null | nein | Servertyp/Plan (provider-eigener Slug, durchgereicht); sonst `null`. |
| `createdAt` | string (ISO-8601) \| null | nein | Erstellzeitpunkt, sofern der Provider ihn liefert; sonst `null`. |

**Status-Mapping (Richtlinie je Adapter, `coder` finalisiert die provider-genauen Roh-Werte):**
- laufend / „running" / „on" → `running`
- gestoppt / „off" / „stopped" → `stopped`
- in Erstellung / „initializing" / „creating" → `provisioning`
- Fehl-/Defekt-Zustand des Servers → `error`
- alles sonst / nicht ermittelbar → `unknown`

### Verwendung in den Verträgen ([[vps-provider-boundary]])
- `GET /api/vps/machines` → `{ machines: VpsMachine[], providerErrors?: [{ provider, errorClass }] }` (Aggregation live über alle konfigurierten Provider, pro Provider degradierend — ADR-009).
- `POST /api/vps/machines/{provider}` → `{ result, machine?: VpsMachine, reason? }` (Create-Antwort; `machine` mindestens mit `provider`, `serverId`, `name`, `status`, sofern bekannt `ipv4`).
- `VpsProvider.listMachines()` → `VpsMachine[]`; `VpsProvider.create(...)` → `VpsMachine`.

> **Kein persistenter Maschinen-Store** (ADR-005-Linie): `VpsMachine` wird bei jeder Anfrage live aus der Provider-API ermittelt, nicht abgelegt.
