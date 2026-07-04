---
id: vps-create-options
title: VPS-Create-Formular — Live-Dropdowns (Typ/Region/Image) mit Kosten + Tunnel-Rollback
status: draft
area: vps
version: 2
---

# Spec: VPS-Create-Formular — Live-Dropdowns mit Kosten (`vps-create-options`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-relevant: Provider-Token bleibt server-seitig; nur abgeleitete Listen/Preise gehen an den Client.

## Zweck
Das Create-Formular der VPS-Ansicht („Neuen Server erstellen", [[view-vps]] AC7) führt **Server-Typ**, **Region** und **Image** heute als **Freitextfelder** — fehleranfällig, weil veraltete/ungültige Werte (z.B. nicht mehr existierende Typen wie `cx11`, oder eine `network_zone` statt einer Location als Region) zu fehlgeschlagenen Server-Creates führen. Diese Spec ersetzt die drei Freitextfelder für **Hetzner** durch **Dropdowns mit live von der Hetzner-API geladenen Werten**: Server-Typ (mit Kostenangabe), Region/Location und System-Image. Andere Provider (IONOS/Hostinger) behalten ihre Freitextfelder (graceful Fallback), bis die provider-spezifische Optionen-Quelle dort nachgezogen wird. Zusätzlich schließt diese Spec eine beim Live-Test gefundene Lücke: ein **fehlgeschlagener VPS-Create** lässt heute den zuvor angelegten Cloudflare-Tunnel verwaist zurück — dieser wird künftig zurückgerollt.

## Hintergrund / Live-Diagnose (begründet das Feature)
- `cx11`/`cx21` existieren bei Hetzner nicht mehr; aktuelle Intel-Typen sind `cx23, cx33, cx43, cx53` (+ `cpx..`, `cax..`, `ccx..`). Freitext lädt zu veralteten Werten ein.
- `eu-central` ist eine **network_zone, KEINE Location**. Gültige Locations: `nbg1, fsn1, hel1` (network_zone `eu-central`), `ash, hil, sin`. Freitext-Region führte zum fehlgeschlagenen Create.
- Verfügbare Hetzner-Endpunkte (Token im CredentialStore unter `credentials/vps/hetzner_api_token`):
  - `GET /v1/server_types?per_page=60` → Felder je Typ: `name, cores, memory, disk, deprecated, prices[]`; je `prices`-Eintrag: `{ location, price_monthly{net,gross}, price_hourly{net,gross} }`.
  - `GET /v1/locations` → `name, network_zone, city, country`.
  - `GET /v1/images?type=system&per_page=60` → `name, description, os_flavor, os_version`.
  - `GET /v1/datacenters` → je Datacenter `name, location{name,…}, server_types{available[<id>], supported[], available_for_migration[]}` — **autoritative** Bereitstellbarkeit (Story E/F).
- Beim Create legt `VpsProviderRegistry.create()` ZUERST den Cloudflare-Tunnel an (`#provisionTunnel`) und ruft DANN `adapter.create()`. Scheitert der Server-Schritt, bleibt der Tunnel verwaist (real beobachtet: Tunnel `devgui-testserver` blieb übrig).
- **Live gefundene Lücke (2026-06-19, gegen Hetzner-API verifiziert) — begründet Story E/F:** Region+Server-Typ-Kombinationen, die das Formular anbietet, sind oft **nicht bereitstellbar** → Hetzner antwortet beim Create mit `unsupported location for server type` (z.B. `fsn1` + `cpx11`). Ursache: Die heutige Anzeige (Story A/B) leitet Verfügbarkeit implizit aus `server_types.prices[].location` ab — das ist **falsch/irreführend**: `cpx11` hat einen `fsn1`-**Preis** hinterlegt, ist laut `/v1/datacenters` in `fsn1` aber **nicht bereitstellbar** (cpx11 nur in `ash` + `hil`). Ein Preis-Eintrag ≠ Bereitstellbarkeit.
- **Autoritative Verfügbarkeits-Quelle:** `GET /v1/datacenters` → je Datacenter `{ name, location: { name, … }, server_types: { available: [<server_type_id>, …], supported: [...], available_for_migration: [...] } }`. `server_types.available` ist die Menge der server-type-**IDs**, die in diesem Datacenter **bereitstellbar** sind; `datacenter.location.name` ordnet das Datacenter einer Location zu. Eine Location kann **mehrere** Datacenters haben → pro Location die **Vereinigung (Union)** der `available`-Listen bilden. Beispiel-Befund: `fsn1-dc14.available = ccx13..ccx63, cpx22, cpx32, cpx42, cpx52, cpx62` (KEIN cpx11/cx33); `hel1` zusätzlich `cx33/cx43/cx53`; `ash`/`hil` `cpx11`..`cpx51`. server-type-IDs werden über die bereits in Story A geladenen `server_types` (`{ id, name }`) auf **Namen** gemappt, damit Frontend/Vertrag mit Typ-`name` (nicht-ID) arbeiten.

## Verhalten

### Backend — Hetzner-Options-Endpunkt (Story A)
1. Es gibt einen **read-only** Backend-Endpunkt, der für **Hetzner** die für das Create-Formular nötigen Auswahl-Listen liefert: Server-Typen (inkl. Preisen), Locations und System-Images. Der Endpunkt liegt hinter der Access-Mauer ([[access-and-guardrails]]).
2. Die Hetzner-API-Calls erfolgen **ausschließlich** im `HetznerAdapter` (`src/vps/providers/hetzner.js`) — der Adapter ist die Boundary (ADR-009 / R01). Der Router/Registry-Pfad ruft neue Adapter-Methoden auf, spricht **nicht** selbst die Hetzner-API an.
3. Der Hetzner-Token wird **store-intern** (transient, pro Aufruf) aus dem `CredentialStore` gezogen und verlässt das Backend nie — nur die abgeleiteten Listen/Preise gehen an den Client.
4. Die Antwort ist **provider-erweiterbar** angelegt: Der Endpunkt ist pro Provider adressierbar; nur für `hetzner` ist eine Optionen-Quelle implementiert. Für andere Provider (`ionos`, `hostinger`) liefert der Endpunkt eine **klare „keine Optionen-Quelle"-Antwort** (kein Fehler-500), damit das Frontend dort auf Freitext zurückfällt.
5. Ist Hetzner **nicht konfiguriert** (kein Token) oder schlägt die Hetzner-API fehl (Auth/Netz/Timeout), antwortet der Endpunkt **graceful** mit einem klaren Fehler-/Leer-Signal (kein Token-Leak), sodass das Frontend auf Freitext degradieren kann.
6. **Deprecated** Server-Typen werden aus der Typen-Liste **herausgefiltert** (oder als deprecated markiert, sodass das Frontend sie ausblenden kann) — sie sollen Nutzer nicht zu ungültigen Creates verleiten.
7. **Preis-Aufbereitung:** Je Server-Typ liefert der Endpunkt die verfügbaren Preise pro Location aus dem `prices`-Array durch (mindestens `location`, `price_monthly`, `price_hourly`, jeweils `net`/`gross`). Fehlen Preisfelder, wird das Feld `null`/weggelassen (nie Fehler — graceful Degradation, ADR-009-Linie).

### Frontend — Typ/Region-Dropdowns mit Kosten (Story B)
8. Im Create-Formular ([[view-vps]] AC7) lädt das Frontend bei gewähltem Provider `hetzner` die Optionen vom neuen Endpunkt und ersetzt die Freitextfelder **Region** und **Server-Typ** durch **Dropdowns**. Vorbild für Live-Dropdowns: `client/src/DeploymentsView.jsx` (S-155) und der Zones-Dropdown im CloudflareView.
9. Das **Region-Dropdown** zeigt die Hetzner-Locations (mindestens `name`; sinnvoll ergänzt um `city`/`country`/`network_zone` zur Orientierung). Auswahl setzt `region` = Location-`name`.
10. Das **Server-Typ-Dropdown** zeigt je Typ mindestens `name` und **Spezifikationen** (cores/memory/disk) sowie **Kosten**. Der angezeigte Preis soll möglichst zur **aktuell gewählten Region** passen: gibt es im `prices`-Array einen Eintrag für die gewählte Location, wird dessen Preis angezeigt; sonst ein verfügbarer Fallback-Preis mit erkennbarem Hinweis, dass er nicht regionsspezifisch ist. Angezeigt werden **monatlich + stündlich**, **brutto bevorzugt** (`gross`); fehlt `gross`, `net` mit Kennzeichnung. Fehlen alle Preisinfos → klarer „Preis unbekannt"-Hinweis statt Fehler.
11. Ändert der Nutzer die Region, aktualisiert sich die Preisanzeige der Typen auf die neue Location (soweit Preisdaten vorhanden).
12. **Graceful Degradation:** Schlägt das Laden der Optionen fehl oder liefert der Endpunkt „keine Optionen-Quelle" (Nicht-Hetzner-Provider / Hetzner nicht konfiguriert / API-Fehler), zeigt das Formular einen Hinweis **und fällt auf die heutigen Freitextfelder zurück**, sodass der Create-Flow nicht blockiert ist.
13. **Sicherheit:** Es erscheint **kein** Hetzner-Token im Frontend-Bundle/Log; das Frontend sendet beim Create weiterhin nur die fachlichen Parameter (`region`, `serverType`, `image`) + SSH-Label-Referenzen ([[view-vps]] AC9 / [[vps-provider-boundary]]).

### Frontend — Image-Dropdown (Story C)
14. Das **Image-Feld** wird für `hetzner` ebenfalls ein **Dropdown**, befüllt mit den System-Images aus dem Endpunkt (Anzeige z.B. `description` bzw. `name`). **Default-Vorauswahl Ubuntu 26.04**, falls in der Live-Liste vorhanden; ist Ubuntu 26.04 (noch) nicht verfügbar, fällt die Vorauswahl auf den nächstbesten aktuellen Ubuntu-LTS-Slug zurück (analog [[vps-provider-boundary]] AC7, Grep-Tag `UBUNTU_26_04_SLUG`).
15. Auswahl setzt `image` = Image-`name` (Slug). Graceful Degradation wie bei AC12: Fehler/keine Quelle → Freitext-Image-Feld (heutiges Verhalten) mit Default-Hinweis Ubuntu 26.04.

### Backend — Tunnel-Rollback bei fehlgeschlagenem Create (Story D)
16. Wirft `adapter.create()` in `VpsProviderRegistry.create()` einen Fehler, **nachdem** ein Cloudflare-Tunnel angelegt wurde (`#provisionTunnel` lieferte ein Ergebnis ≠ `null`), so wird dieser Tunnel **wieder entfernt** (`CloudflareApi.deleteTunnel(tunnelId)`) und die zugehörigen Tunnel-Credential-Referenzen aufgeräumt — analog dem bestehenden Cleanup-Pfad `#cleanupTunnel` aus S-153 ([[vps-delete]]).
17. Das Rollback ist **best-effort + idempotent**: schlägt das Tunnel-Cleanup selbst fehl, maskiert das **nicht** den ursprünglichen Create-Fehler (dieser wird weiterhin propagiert), und der Cleanup-Fehler wird klar protokolliert/auditiert (kein Token im Log). Wurde kein Tunnel angelegt (`#provisionTunnel` = `null`, z.B. Cloudflare nicht konfiguriert), entfällt das Rollback.
18. Nach erfolgreichem Rollback existiert **kein** verwaister Tunnel und **keine** verwaiste Tunnel-Token-/Tunnel-ID-Credential-Referenz für den fehlgeschlagenen Create.

### Backend — Region-Verfügbarkeits-Map aus `/v1/datacenters` (Story E)
19. Der Options-Endpunkt liefert für `hetzner` zusätzlich eine **autoritative Verfügbarkeits-Map** `availability: { <location-name>: [<server-type-name>, …] }`. Sie wird aus `GET /v1/datacenters` gebildet, **nicht** aus `prices[].location`. Ein neuer `HetznerAdapter`-Aufruf (`listDatacenters(token)`, Boundary/ADR-009 — selbe `#apiGet`-/Timeout-/Bearer-/Sanitize-Disziplin) holt die Datacenters; alle Hetzner-Calls bleiben im Adapter.
20. Die Map wird je **Location** als **Vereinigung** der `server_types.available`-Listen aller Datacenters dieser Location (`datacenter.location.name`) gebildet; die server-type-**IDs** werden über die in Story A geladenen `server_types` (`{ id, name }`) auf **Namen** gemappt. IDs ohne Name-Match werden ausgelassen (kein Fehler). Pro Location-Eintrag sind die Typ-Namen **dedupliziert**.
21. **Graceful Degradation (kein Hard-Fail):** Schlägt `GET /v1/datacenters` fehl (Auth/Netz/Timeout) oder ist die Antwort leer/unbrauchbar, wird `availability` **weggelassen oder leer** geliefert — die übrigen Optionen (`serverTypes`/`locations`/`images`) bleiben unverändert nutzbar, und das Frontend fällt für die Filterung auf das heutige Verhalten (alle Typen) zurück. Der Hetzner-Token bleibt store-intern (kein Token-Leak in `availability`/Response/Log).

### Frontend — region-gefiltertes Server-Typ-Dropdown (Story F)
22. **Region zuerst → Typen filtern (verbindliche UX):** Ist eine Region gewählt und liegt `availability[region]` vor, zeigt das Server-Typ-Dropdown ([[#Frontend — Typ/Region-Dropdowns mit Kosten (Story B)]], AC6/AC7) **nur** die in `availability[region]` enthaltenen Typen. Typen, die in der Region nicht bereitstellbar sind, erscheinen **nicht** als wählbare Option. (Kein beidseitiges Filtern — die Region steuert die Typen-Liste, nicht umgekehrt.)
23. **Kein ungültiger Submit bei Region-Wechsel:** Wechselt der Nutzer die Region und der aktuell gewählte Server-Typ ist in der neuen Region **nicht** verfügbar (`!availability[neueRegion].includes(serverType)`), wird die Typ-Auswahl **zurückgesetzt** (auf „kein Typ gewählt" oder den ersten gültigen Typ vorausgewählt), sodass nie eine bekannt-ungültige Region+Typ-Kombination absendbar ist. Bei verbleibender Verfügbarkeit bleibt die Typ-Wahl erhalten.
24. **Graceful Fallback:** Fehlt `availability` ganz (Story-E-Degradation, AC21) oder fehlt der Eintrag für die gewählte Region, wird **ungefiltert** gerendert (heutiges Story-B-Verhalten — alle nicht-deprecated Typen wählbar). Behebt nebenbei den „Preis unbekannt"-Fall für `fsn1`+`cpx11`-artige Kombis, da bei vorhandener `availability` nur Typen mit Region-Preis erscheinen. Floor unverändert: kein Token im Bundle/Log, Create-Payload (`region`/`serverType`/`image` + SSH-Label-Referenzen) unverändert; eine angebotene Region+Typ-Kombination führt **nicht** mehr zu `unsupported location for server type`.

## Acceptance-Kriterien

### Story A — Backend Hetzner-Options-Endpunkt
- **AC1** — Ein read-only Endpunkt liefert für `hetzner` `{ serverTypes[], locations[], images[] }`; alle Hetzner-API-Aufrufe (`server_types`, `locations`, `images?type=system`) erfolgen ausschließlich im `HetznerAdapter` (Grep-prüfbar: keine `api.hetzner.cloud`-URL außerhalb `src/vps/providers/hetzner.js`), nicht im Router.
- **AC2** — Der Endpunkt ist hinter der Access-Mauer (403 ohne gültigen Access); der Hetzner-Token wird store-intern transient gezogen und erscheint **nie** in Response/Log/Bundle (nur abgeleitete Listen/Preise gehen an den Client).
- **AC3** — `serverTypes[]` enthält je Typ `name`, `cores`, `memory`, `disk` und `prices[]` (je Eintrag `location`, `price_monthly{net,gross}`, `price_hourly{net,gross}`); **deprecated** Typen werden herausgefiltert oder als `deprecated: true` markiert. `locations[]` enthält je Eintrag `name`, `network_zone`, `city`, `country`. `images[]` enthält je Eintrag `name`, `description`, `os_flavor`, `os_version` (nur `type=system`).
- **AC4** — Fehlende Preisfelder führen **nicht** zu einem Fehler: das jeweilige Feld ist `null`/weggelassen, die übrigen Daten werden geliefert (graceful, ADR-009-Linie).
- **AC5** — Für einen Provider ohne implementierte Optionen-Quelle (`ionos`/`hostinger`) liefert der Endpunkt ein klares „keine Optionen-Quelle"-Signal (kein 500); ist `hetzner` nicht konfiguriert oder schlägt die Hetzner-API fehl (Auth/Netz/Timeout), antwortet er mit einem klaren, token-freien Fehler-/Leer-Signal, das das Frontend zum Freitext-Fallback befähigt.

### Story B — Frontend Typ/Region-Dropdowns + Kosten
- **AC6** — Bei Provider `hetzner` lädt das Create-Formular die Optionen und rendert **Region** und **Server-Typ** als Dropdowns (statt Freitext); beide befüllt aus den Live-Listen. Region-Auswahl setzt `region` = Location-`name`, Typ-Auswahl setzt `serverType` = Typ-`name`.
- **AC7** — Das Server-Typ-Dropdown zeigt je Typ Spezifikationen (cores/memory/disk) und **Kosten** (monatlich + stündlich, **brutto bevorzugt**); der Preis richtet sich nach der gewählten Region (Match im `prices`-Array), mit erkennbarem Hinweis, wenn nur ein nicht-regionsspezifischer Fallback-Preis verfügbar ist. Ein Regionswechsel aktualisiert die Preisanzeige.
- **AC8** — Fehlen alle Preisinfos eines Typs, zeigt das Dropdown einen „Preis unbekannt"-Hinweis statt eines Fehlers; ein deprecated Typ erscheint nicht als wählbare Option.
- **AC9** — **Graceful Degradation:** Schlägt das Optionen-Laden fehl oder liefert der Endpunkt „keine Optionen-Quelle" (Nicht-Hetzner / nicht konfiguriert / API-Fehler), fällt das Formular sichtbar auf die heutigen Freitextfelder zurück und der Create bleibt absendbar.
- **AC10** — Es erscheint **kein** Hetzner-Token im Frontend-Bundle/Log; die Create-Payload bleibt unverändert (`region`, `serverType`, `image` + SSH-Label-Referenzen, [[view-vps]] AC9).

### Story C — Image-Dropdown
- **AC11** — Bei Provider `hetzner` wird das Image-Feld ein Dropdown aus den System-Images; **Default-Vorauswahl Ubuntu 26.04**, falls in der Live-Liste vorhanden, sonst Fallback auf den aktuellen Ubuntu-LTS-Slug ([[vps-provider-boundary]] AC7). Auswahl setzt `image` = Image-`name`.
- **AC12** — Schlägt das Image-Laden fehl / keine Quelle, fällt das Feld auf das heutige Freitext-Image-Feld zurück (Default-Hinweis Ubuntu 26.04); der Create bleibt absendbar.

### Story D — Tunnel-Rollback bei fehlgeschlagenem Create
- **AC13** — Wirft `adapter.create()`, nachdem ein Tunnel angelegt wurde, entfernt `VpsProviderRegistry.create()` den Tunnel (`CloudflareApi.deleteTunnel(tunnelId)`) und räumt die Tunnel-Token-/Tunnel-ID-Credential-Referenzen auf (analog `#cleanupTunnel`, S-153). Wurde kein Tunnel angelegt, entfällt das Rollback.
- **AC14** — Das Rollback ist best-effort + idempotent: ein fehlschlagendes Cleanup maskiert **nicht** den ursprünglichen Create-Fehler (Original-Fehler wird propagiert), und der Cleanup-Fehler wird token-frei protokolliert/auditiert. Nach erfolgreichem Rollback existiert kein verwaister Tunnel und keine verwaiste Tunnel-Credential-Referenz.

### Story E — Backend Region-Verfügbarkeits-Map aus `/v1/datacenters`
- **AC15** — Der Options-Endpunkt liefert für konfiguriertes+erreichbares `hetzner` zusätzlich `availability: { <location-name>: [<server-type-name>, …] }`, gebildet aus `GET /v1/datacenters` (autoritativ), **nicht** aus `prices[].location`. Der Datacenters-Call erfolgt ausschließlich im `HetznerAdapter` (`listDatacenters(token)`); Grep-prüfbar keine `api.hetzner.cloud`-URL außerhalb `src/vps/providers/hetzner.js`.
- **AC16** — Pro Location ist der Wert die **Vereinigung** der `server_types.available`-Listen aller Datacenters mit dieser `location.name`, mit server-type-**ID→Name**-Mapping über die geladenen `server_types` und **deduplizierten** Namen. Verifikationsbeispiel: `availability["fsn1"]` enthält `cpx22`, **nicht** `cpx11`; `availability["ash"]` (bzw. `hil`) enthält `cpx11`; IDs ohne Name-Match werden ausgelassen (kein Fehler).
- **AC17** — **Graceful (kein Hard-Fail):** Schlägt `/v1/datacenters` fehl oder ist die Antwort leer/unbrauchbar, wird `availability` weggelassen/leer geliefert und `serverTypes`/`locations`/`images` bleiben vollständig nutzbar; der Hetzner-Token erscheint nicht in `availability`/Response/Log.

### Story F — Frontend region-gefiltertes Server-Typ-Dropdown
- **AC18** — Bei gewählter Region und vorhandenem `availability[region]` zeigt das Server-Typ-Dropdown **nur** die in `availability[region]` enthaltenen Typen; in der Region nicht bereitstellbare Typen sind nicht wählbar (Region steuert die Typen-Liste, kein beidseitiges Filtern).
- **AC19** — Wechselt die Region und der gewählte `serverType` ist in `availability[neueRegion]` **nicht** enthalten, wird die Typ-Auswahl zurückgesetzt (kein Typ bzw. erster gültiger vorausgewählt); eine bekannt-ungültige Region+Typ-Kombination ist nie absendbar. Bleibt der Typ verfügbar, bleibt die Wahl erhalten.
- **AC20** — **Graceful Fallback:** Fehlt `availability` ganz oder fehlt der Eintrag für die gewählte Region, wird ungefiltert gerendert (heutiges Story-B-Verhalten). Floor unverändert (kein Token im Bundle/Log, AccessGuard, Create-Payload unverändert); eine vom Formular angebotene Region+Typ-Kombination führt nicht mehr zu `unsupported location for server type`.

## Verträge
> Pfad/Felder kanonisch; konkreter Routen-Slug und Adapter-Methodennamen sind `coder`-Detail (an bestehende Konventionen anschließen). Vorschlag: `GET /api/vps/providers/:provider/options`.

- **GET `/api/vps/providers/:provider/options`** (read-only, hinter AccessGuard) →
  - für `hetzner` konfiguriert+erreichbar: `200 { provider: "hetzner", serverTypes: HetznerServerTypeOption[], locations: HetznerLocationOption[], images: HetznerImageOption[], availability?: HetznerAvailabilityMap }`
  - für Provider ohne Optionen-Quelle: `200 { provider, optionsAvailable: false, reason }` (Frontend → Freitext-Fallback)
  - Hetzner nicht konfiguriert / API-Fehler: klares token-freies Signal (z.B. `200 { optionsAvailable: false, reason }` oder `502 { error, errorClass }`) — `coder` wählt konsistent zum bestehenden Degradations-Muster; das Frontend behandelt **jedes** Nicht-Erfolg-Ergebnis als Freitext-Fallback (AC9/AC12).
- **`HetznerServerTypeOption`** = `{ name, cores, memory, disk, deprecated?: boolean, prices: [{ location, priceMonthly?: { net?, gross? }, priceHourly?: { net?, gross? } }] }` (fehlende Preisfelder → weggelassen/`null`).
- **`HetznerLocationOption`** = `{ name, networkZone, city, country }`.
- **`HetznerImageOption`** = `{ name, description, osFlavor, osVersion }`.
- **`HetznerAvailabilityMap`** = `{ [locationName: string]: string[] }` — je Location die deduplizierte Liste der dort **bereitstellbaren** server-type-Namen (Union der `server_types.available` aller Datacenters der Location, ID→Name-gemappt). Optional: fehlt bei Datacenters-Degradation (AC17); das Frontend behandelt fehlende Map / fehlende Location als ungefiltert (AC20).
- **Neue `HetznerAdapter`-Methoden** (Boundary, ADR-009): z.B. `listServerTypes(token)`, `listLocations(token)`, `listSystemImages(token)`, **`listDatacenters(token)`** (`GET /v1/datacenters`, liefert je Datacenter mindestens `{ location: { name }, server_types: { available: number[] } }`) — selbe `#apiGet`-/Timeout-/Token-Header-/Sanitize-Disziplin wie die bestehenden Methoden (Bearer-Header, nie URL/Log/Response).
- **Create-Vertrag unverändert:** `POST /api/vps/machines/:provider` Body `{ name, region, serverType, image?, sshKeyAssignment }` ([[vps-provider-boundary]] AC7). Diese Spec ändert nur, **wie** `region`/`serverType`/`image` im UI gewählt werden, nicht das Create-Schema.
- **Tunnel-Rollback** nutzt die bestehenden Registry-Bausteine: `#provisionTunnel` (liefert `{ tunnelId, tunnelToken } | null`), `CloudflareApi.deleteTunnel(tunnelId)`, `CredentialStore.delete(TUNNEL_TOKEN_KEY/TUNNEL_ID_KEY)` — kein neuer öffentlicher Endpunkt.

## Edge-Cases & Fehlerverhalten
- Hetzner-API liefert Typ ohne `prices` oder mit leerem Array → Typ wird gelistet, Preis als „unbekannt" (AC4/AC8).
- Gewählte Region hat keinen Preis-Eintrag für einen Typ → Fallback-Preis mit Hinweis bzw. „Preis unbekannt" (AC7/AC8).
- Alle Typen deprecated/leere Liste → Frontend zeigt klaren Leer-/Fallback-Zustand (kein Crash), ggf. Freitext-Fallback.
- Provider gewechselt von `hetzner` auf einen Freitext-Provider → Felder wechseln zurück auf Freitext (AC9).
- Hetzner-Token ungültig (401) → token-freies Fehler-Signal, Freitext-Fallback (AC5/AC9), kein Token-Leak.
- Optionen-Endpunkt-Timeout → wie API-Fehler behandelt (Freitext-Fallback).
- `adapter.create()`-Fehler nach Tunnel-Anlage → Tunnel-Rollback (AC13); Rollback-Fehler maskiert Original-Fehler nicht (AC14).
- Aufruf ohne Access-Cookie → Access-Mauer greift davor (AC2).
- `/v1/datacenters` schlägt fehl / liefert leer → `availability` weggelassen, Frontend filtert nicht (AC17/AC20); übrige Optionen unverändert.
- Location ohne Datacenters-Eintrag (oder `availability[region]` fehlt) → Frontend rendert Typen ungefiltert für diese Region (AC20).
- server-type-ID in `available` ohne Name-Match in `server_types` → wird ausgelassen, kein Fehler (AC16).
- Region-Wechsel auf Region, in der der gewählte Typ nicht bereitstellbar ist → Typ-Auswahl-Reset, kein ungültiger Submit (AC19).
- `prices[]` listet eine Location für einen Typ, der laut `availability` dort NICHT bereitstellbar ist (z.B. `cpx11`+`fsn1`) → Typ erscheint dort dank `availability`-Filter nicht (Wurzel der Live-Lücke, AC18).

## NFRs
- **Sicherheit (Floor, hart):** Hetzner-Token bleibt store-intern, **nie** in Response/Log/Audit/WS/Argv/Frontend-Bundle ([[vps-provider-boundary]] AC10). Nur abgeleitete Listen/Preise gehen an den Client. Der Optionen-Endpunkt ist read-only und ändert keinen Server-/Tunnel-Zustand.
- **Resilienz:** Optionen-Laden degradiert pro Anfrage (Fehler ⇒ Freitext-Fallback, nie blockierter Create-Flow). Tunnel-Rollback ist best-effort/idempotent und kippt nicht den Fehlerpfad des Create.
- **A11y (WCAG 2.1 AA):** Dropdowns beschriftet (`<label htmlFor>` / `aria-required`), Kosten-/Spec-Angaben für Screenreader erkennbar, Fehler programmatisch zugeordnet (`aria-describedby`, `role=alert`/`status`), sichtbarer Fokus, Touch-Target ≥ 44 px — konsistent zum bestehenden `VpsCreateForm`.

## Nicht-Ziele
- Live-Dropdowns für IONOS/Hostinger (bleiben Freitext; nur Architektur-Vorbereitung für späteres Nachziehen — AC5).
- Preis-Aggregation/Kostenrechner über mehrere Server hinweg oder Billing-Auswertung.
- Persistenter Cache der Hetzner-Optionen (Read bleibt live; ein optionaler kurzlebiger In-Request-Cache ist `coder`-Detail, kein Vertrag).
- Änderungen am Create-Schema oder an der Tunnel-Provisionierungs-Reihenfolge ([[vps-tunnel-provisioning]]) — Story D fügt nur das fehlende Rollback hinzu.

## Abhängigkeiten
- [[view-vps]] (Create-Formular — die UI, die hier umgebaut wird).
- [[vps-provider-boundary]] (Adapter-Boundary, Create-Vertrag, Token-Quelle, Default-Image-Annahme).
- [[vps-tunnel-provisioning]] (Tunnel-Provisionierung im Create-Pfad — Story D rollt deren Tunnel bei Create-Fehler zurück).
- [[vps-delete]] (bestehender `#cleanupTunnel`-Pfad aus S-153 als Vorbild fürs Rollback).
- [[settings-credentials]] (Hetzner-Token-Quelle im `CredentialStore`).
- [[access-and-guardrails]] (Access-Mauer vor dem read-only Endpunkt).
- `docs/architecture.md` ADR-009 (Adapter-Layout, transiente Token-Injektion, Degradations-Linie).
- [[deploy-lifecycle]] / `client/src/DeploymentsView.jsx` (S-155) + CloudflareView (Vorbild für Live-Dropdowns).
