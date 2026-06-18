---
id: vps-create-options
title: VPS-Create-Formular — Live-Dropdowns (Typ/Region/Image) mit Kosten + Tunnel-Rollback
status: draft
version: 1
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
- Beim Create legt `VpsProviderRegistry.create()` ZUERST den Cloudflare-Tunnel an (`#provisionTunnel`) und ruft DANN `adapter.create()`. Scheitert der Server-Schritt, bleibt der Tunnel verwaist (real beobachtet: Tunnel `devgui-testserver` blieb übrig).

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

## Verträge
> Pfad/Felder kanonisch; konkreter Routen-Slug und Adapter-Methodennamen sind `coder`-Detail (an bestehende Konventionen anschließen). Vorschlag: `GET /api/vps/providers/:provider/options`.

- **GET `/api/vps/providers/:provider/options`** (read-only, hinter AccessGuard) →
  - für `hetzner` konfiguriert+erreichbar: `200 { provider: "hetzner", serverTypes: HetznerServerTypeOption[], locations: HetznerLocationOption[], images: HetznerImageOption[] }`
  - für Provider ohne Optionen-Quelle: `200 { provider, optionsAvailable: false, reason }` (Frontend → Freitext-Fallback)
  - Hetzner nicht konfiguriert / API-Fehler: klares token-freies Signal (z.B. `200 { optionsAvailable: false, reason }` oder `502 { error, errorClass }`) — `coder` wählt konsistent zum bestehenden Degradations-Muster; das Frontend behandelt **jedes** Nicht-Erfolg-Ergebnis als Freitext-Fallback (AC9/AC12).
- **`HetznerServerTypeOption`** = `{ name, cores, memory, disk, deprecated?: boolean, prices: [{ location, priceMonthly?: { net?, gross? }, priceHourly?: { net?, gross? } }] }` (fehlende Preisfelder → weggelassen/`null`).
- **`HetznerLocationOption`** = `{ name, networkZone, city, country }`.
- **`HetznerImageOption`** = `{ name, description, osFlavor, osVersion }`.
- **Neue `HetznerAdapter`-Methoden** (Boundary, ADR-009): z.B. `listServerTypes(token)`, `listLocations(token)`, `listSystemImages(token)` — selbe `#apiGet`-/Timeout-/Token-Header-/Sanitize-Disziplin wie die bestehenden Methoden (Bearer-Header, nie URL/Log/Response).
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
