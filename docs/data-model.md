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

## SshPublicKey — Identität & Matching (für `removeAuthorizedKey`)

Kanonisches Identitäts-/Matching-Modell für das gezielte Entfernen **eines** Public-Keys aus `authorized_keys` der Ziel-Rolle (`VpsProvisioner.removeAuthorizedKey`, **ADR-008-Erweiterung Key-Rotation**, [[ssh-key-rotation]]). Bindend für `coder`/`tester`.

Ein OpenSSH-`authorized_keys`-Eintrag hat die Form `[options] <type> <base64-blob> [comment]` (z.B. `ssh-ed25519 AAAAC3Nz… alex@host` oder mit Options-Prefix `restrict,from="…" ssh-ed25519 AAAAC3Nz… cloud-init`).

| Bestandteil | Rolle beim Matching |
|---|---|
| `options` (optionaler Prefix) | **ignoriert** — frei veränderbar, kein Identitätsbestandteil. |
| `type` (`ssh-ed25519` / `ssh-rsa` / `ecdsa-…` / …) | **Teil der Identität** (zusammen mit dem Blob). |
| `base64-blob` (der Key selbst) | **maßgebliche Identität.** |
| `comment` (optionaler Suffix) | **ignoriert** — nicht eindeutig, frei wählbar, darf das Matching nie bestimmen. |

- **Key-Identität = das normalisierte Paar `(type, base64-blob)`** (Whitespace-normalisiert). Zwei Einträge sind „derselbe Key" ⇔ ihre `(type, blob)` sind gleich — **unabhängig** von Options-Prefix, Kommentar und sonstigem Whitespace.
- `removeAuthorizedKey({ …, publicKey })` extrahiert je `authorized_keys`-Zeile die `(type, blob)`-Identität, vergleicht sie mit der des übergebenen `publicKey` und entfernt **alle** Zeilen mit gleicher Identität (Duplikat-tolerant); jede andere Zeile bleibt **bytegenau** erhalten. Datei wird **atomar** neu geschrieben (Tempfile + `chmod 600` + `mv`). Idempotent: Identität nicht vorhanden → Datei unverändert (`result: "already-absent"`).
- **Nie** über die ganze Zeile oder den Kommentar matchen (Aussperr-/Restmüll-Risiko, s. ADR-008-Erweiterung, verworfene Alternativen 2/3).
- Optionaler `hostKeyHash` (SHA256-Fingerprint des SSH-Host-Keys, Base64) ist **nicht** Teil der Key-Identität, sondern reines Audit-Metadatum (nicht geheim), konsistent mit der #47-Provision-Antwort.

## Cloudflare-Read-Models (CfZone / CfTunnel / CfRoute)

Read-Models der Cloudflare-API-Boundary ([[view-cloudflare]], fixiert in **ADR-010**; `protected`-Flag aus `LockoutGuard`, ADR-011). `CloudflareApi` mappt die Cloudflare-Roh-Antwort auf diese Schemata (`src/cloudflare/normalize.js`); die Cloudflare-View sieht **nur** diese Modelle, nie den API-Token. **Grundregel** wie bei `VpsMachine`: fehlende Felder → `null`, **nie** Fehler.

| Modell | Felder |
|---|---|
| `CfZone` | `{ id: string, name: string, status: string\|null }` |
| `CfTunnel` | `{ id: string, name: string, status: string\|null, zoneId: string }` |
| `CfRoute` | `{ hostname: string, service: string\|null, tunnelId: string, protected: boolean }` |

- `protected = true` ⇔ `LockoutGuard.isProtected(route)` (eigene `devgui`-Route / Access-Mauer; fail-closed bei Mehrdeutigkeit). Mutation auf ein protected Ziel → 422 `protected-resource` (ADR-011), nicht überschreibbar.
- Live aus der Cloudflare-API (kein Tunnel-Store, ADR-005-Linie); Aggregation pro Zone degradierend (`errors: [{ scope, errorClass }]`).
- `errorClass`-Werte (kanonisch, ADR-010): `cloudflare-not-configured` | `cloudflare-auth-failed` | `not-found` | `cloudflare-unavailable` | `protected-resource` | `confirmation-required`.

## Deployment (Read-Model, live) + ReconcileReport

Read-Model der Deploy-Lifecycle-Boundary ([[deploy-lifecycle]], **ADR-012**) und des Reconciliation-Crons ([[cloudflare-reconciliation]], **ADR-013**). **Kein** Deploy-State-Store: der Bestand wird live aus dem Container-Label `cloudflare.tunnel-hostname` ⊕ der Cloudflare-Route ermittelt.

| Modell | Felder |
|---|---|
| `Deployment` | `{ vps: string, hostname: string, image: string, containerId: string\|null, status: string, routePresent: boolean, containerPresent: boolean }` |
| `ReconcileReport` | `{ ranAt: string (ISO-8601), trigger: "cron"\|"manual", perVps: [{ vps: string, provider?: string, checkedContainers: number, createdRoutes: string[], removedRoutes: string[], protectedSkipped: string[], reportedUnmanaged: string[], errors: [{ scope, errorClass }] }] }` |
| `ReconcileNotice` | `{ at: string (ISO-8601), kind: "route-created"\|"route-removed"\|"protected-skipped"\|"error", vps: string, hostname: string, detail?: string }` |

- Container↔Route-Bindung = Label `cloudflare.tunnel-hostname=<hostname>` (ADR-012; Container-Label ist beim Reconcile der **autoritative Desired-State**).
- **Beidseitige Konvergenz (ADR-013, Betreiber-Korrektur):** verwaiste Route (kein managed Container, nicht protected) → `removedRoutes`; **managed** Container ohne Route → Route angelegt → `createdRoutes` (über den atomaren ADR-012-Anlege-Pfad, nicht dupliziert); protected Hostname → nie angelegt/gelöscht → `protectedSkipped`; **unmanaged** Container (ohne Deployment-Label) → nicht geheilt → `reportedUnmanaged`.
- `ReconcileReport` wird **nach jedem Lauf** (Cron **und** manuell) erzeugt und über die bestehende append-only **`AuditStore`**-Mechanik persistiert (eine Report-Zeile pro Lauf; **kein** neuer Store, ADR-005-Linie — O4 entschieden: JA). Abrufbar über `GET /api/deployments/reconcile/last` + `GET /api/deployments/reconcile/reports?limit=N`.
- `ReconcileNotice` ist das Read-Model der im Cloudflare-Panel sichtbaren internen Reconciliation-Statusmeldungen ([[view-cloudflare]]); ebenfalls AuditStore-getragen (kein zweiter Persistenz-Pfad), abrufbar über `GET /api/deployments/reconcile/notices` (letzte N).
- Drift sichtbar über `routePresent`/`containerPresent`; `ReconcileReport` und `ReconcileNotice` enthalten **keine** Secrets (weder SSH-Key noch Cloudflare-Token).
