---
id: vps-dynamic-ssh-targets
title: Dynamisch angelegte VPS als SSH-Ziel — Persistenz + Auflösung für Deploy/Container-Übersicht/Reconcile
status: draft
version: 1
---

# Spec: Dynamische VPS-SSH-Ziele (`vps-dynamic-ssh-targets`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (SSH-Ziel-Auflösung; Private-Key bleibt store-intern, ADR-008).
> **Schließt die Naht** zwischen „VPS anlegen" ([[vps-tunnel-provisioning]], S-152) und „App deployen/verwalten" ([[deploy-lifecycle]] S-155, [[vps-container-overview]] S-157, [[cloudflare-reconciliation]]).

## Zweck
Im Live-Test (2026-06) zeigte sich: ein über dev-gui **frisch angelegter VPS** (real: `testDevGui`, hetzner, IP `188.34.202.209`, running, Tunnel `devgui-testdevgui` healthy, `cloudflared` läuft bereits) ist **weder deploybar noch in der Container-Übersicht sichtbar**, obwohl alle Einzelbausteine funktionieren. **Ursache:** Alle SSH-basierten VPS-Funktionen lösen ihr Ziel **ausschließlich** aus der statischen Umgebungsvariable `VPS_TARGETS` auf (`server.js:189` `buildVpsTargetsFromEnv(process.env.VPS_TARGETS)`):
- Deploy-VPS-Dropdown `GET /api/deployments/vps-targets` → `Array.from(vpsTargets.keys())` (`src/deploymentsRouter.js:236`) → **leer**, wenn der VPS nicht in der Env steht.
- Container-Übersicht ([[vps-container-overview]]) `resolveVpsTarget()` (`src/vpsContainerRouter.js:192`) → `if (vpsTargets.size === 0) return null` → UI „Fehler: VPS-Ziel nicht konfiguriert".
- Reconciliation `buildReconcileVpsConfigs` (`server.js:192`, an `VPS_TARGETS` + `RECONCILE_TUNNEL_IDS` gebunden) → der dynamische VPS wird nie reconciled.

**Wurzel:** Beim Create ([[vps-tunnel-provisioning]], S-152, `VpsProviderRegistry.create`) wird zwar die **tunnelId** persistiert (`credentials/misc/vps-<sanitized>-tunnel-id`) und das Tunnel-Token verschlüsselt abgelegt — aber **nicht die SSH-Verbindungsdaten** (provider, serverId, host/IP, port, targetUser). Ein dynamisch angelegter Server ist daher als SSH-Ziel unsichtbar.

**Ziel:** Ein über dev-gui angelegter VPS wird **automatisch als SSH-Ziel auflösbar**, sodass er (1) im Deploy-VPS-Dropdown erscheint, (2) von der Container-Übersicht erreicht wird (zeigt z.B. den laufenden `cloudflared`-Container statt „nicht konfiguriert"), und (3) sein Tunnel der Deploy-/Reconcile-Route zugeordnet wird. **`VPS_TARGETS`-Env bleibt erhalten** als Override/Fallback (Bestandssetups brechen nicht).

## Verhalten
1. **Ziel-Metadaten beim Create persistieren:** Beim erfolgreichen Create (`VpsProviderRegistry.create`, nach erfolgreichem Provider-`adapter.create`) wird zusätzlich zur bereits persistierten `tunnelId` ein **VPS-Ziel-Datensatz** abgelegt, analog der bestehenden tunnelId-Persistenz: `{ provider, serverId, host, port, targetUser, tunnelId }`. **Kein** SSH-Private-Key, **kein** Tunnel-Token wandert in diesen Datensatz (nur Verbindungs-Metadaten + Token-/Key-**Referenzen**, ADR-008/ADR-007).
   - `host` = die vom Provider zurückgegebene öffentliche IP/Hostname (im Live-Fall `188.34.202.209`); ist die IP zum Create-Zeitpunkt noch nicht final (asynchrone Provisionierung), wird sie über `VpsProviderRegistry.getMachineIp(provider, serverId)` nachträglich auflösbar gehalten (siehe AC2/Edge-Cases).
   - `targetUser` + `port` werden **aus dem Create-Kontext** abgeleitet: beim Create wurden SSH-Keys für `root` **und** `alex` hinterlegt → Default-`targetUser` = `root`, `port` = `22`. (Annahme dokumentiert; `architekt`/`coder` dürfen den Default pro Provider verfeinern, solange er aus dem Create-Kontext stammt und nicht erraten wird.)
   - `serverId` = der Provider-Identifikator des angelegten Servers (bei IONOS ggf. composite mit Slash, analog `*splat`-Routing); `provider` = der Create-Provider (z.B. `hetzner`).
2. **Zwei Quellen, eine aufgelöste Menge:** Die VPS-Ziel-Menge ergibt sich aus **(a) der dynamischen Quelle** (persistierte Create-Datensätze) **vereinigt mit (b) `VPS_TARGETS`-Env**. Bei Schlüssel-/Ziel-Kollision (gleicher VPS in beiden) **gewinnt die Env** (Override/Fallback — Betreiber kann ein dynamisches Ziel manuell überschreiben). Die vereinigte Menge ist die Quelle für alle drei Konsumenten (vps-targets-Endpunkt, `resolveVpsTarget`, Reconcile).
3. **Deploy-Dropdown:** `GET /api/deployments/vps-targets` liefert die **IDs der vereinigten Menge** (dynamisch + Env), nicht nur die Env-Keys. Read-only, **kein** Leak von host/targetUser/Key (nur IDs, wie heute).
4. **Container-Übersicht-Auflösung:** `resolveVpsTarget(provider, serverId, …)` löst zuerst über die **dynamische Quelle** (exakter Match auf `{provider, serverId}`) und fällt dann auf die bestehende Env-/IP-Match-Strategie zurück. Findet sich ein dynamischer Datensatz, liefert er `{ host, port, targetUser }`; ist `host` veraltet/leer, wird er über `getMachineIp` aufgefrischt. So zeigt die Container-Übersicht des dynamischen VPS seinen laufenden `cloudflared`-Container statt „nicht konfiguriert".
5. **Reconcile-Zuordnung:** Die Reconcile-Konfiguration (`buildReconcileVpsConfigs`) bezieht den dynamischen VPS **inklusive seiner `tunnelId`** aus dem persistierten Datensatz ein (die tunnelId steht dort, kein zweiter `RECONCILE_TUNNEL_IDS`-Eintrag nötig). Env-`RECONCILE_TUNNEL_IDS` bleibt als Override/Fallback gültig.
6. **Aufräumen beim Löschen:** Beim VPS-Löschen ([[vps-delete]]) wird der dynamische Ziel-Datensatz **mit** entfernt (analog der bestehenden tunnelId-/Token-Cleanup-Sequenz), sodass kein verwaistes Ziel zurückbleibt.

## Acceptance-Kriterien

### Persistenz beim Create
- **AC1** — Bei erfolgreichem `POST /api/vps/machines/{provider}` (Create) persistiert `VpsProviderRegistry.create` zusätzlich zur tunnelId einen **VPS-Ziel-Datensatz** `{ provider, serverId, host, port, targetUser, tunnelId }` (analog der bestehenden tunnelId-Persistenz im Store). Der Datensatz enthält **kein** SSH-Private-Key-Material und **kein** Tunnel-Token (nur Metadaten + Referenzen). (Testbar mit gemocktem CredentialStore/Registry: nach Create ist der Datensatz abrufbar, secret-frei; `targetUser` default `root`, `port` default `22` aus dem Create-Kontext.)
- **AC2** — Ist die `host`-IP zum Create-Zeitpunkt nicht final, bleibt sie über `getMachineIp(provider, serverId)` nachträglich auflösbar; die Ziel-Auflösung (AC4/AC5) liefert dann die aktuelle IP, **ohne** dass der Datensatz eine stale IP fest verdrahtet. (Testbar: Datensatz ohne/mit veralteter host-IP + `getMachineIp`-Mock → aufgelöstes Ziel trägt die aktuelle IP.)

### Vereinigte Auflösung (dynamisch ⊕ Env)
- **AC3** — `GET /api/deployments/vps-targets` liefert die **Vereinigung** aus persistierten Create-Datensätzen **und** `VPS_TARGETS`-Env (deduppliziert, Env gewinnt bei Kollision); ein nur dynamisch angelegter VPS erscheint im Ergebnis. Read-only, nur IDs — **kein** host/targetUser/Key/Token in der Response. (Testbar: leere Env + 1 dynamischer Datensatz → ID erscheint; Kollision → Env-Wert gewinnt; Response secret-frei.)
- **AC4** — `resolveVpsTarget(provider, serverId, …)` löst einen **nur dynamisch** angelegten VPS zu `{ host, port, targetUser }` auf (exakter `{provider, serverId}`-Match in der dynamischen Quelle), auch wenn `VPS_TARGETS` leer ist; die bestehende Env-/IP-Match-Strategie bleibt als Fallback erhalten. (Testbar: `vpsTargets`-Env leer + dynamischer Datensatz → `resolveVpsTarget` gibt **nicht** `null`, sondern das aufgelöste Ziel.)
- **AC5** — Die [[vps-container-overview]]-Listing-Route (`GET /api/vps/machines/:provider/*splat/containers`) erreicht über die dynamische Auflösung (AC4) den dynamisch angelegten VPS und listet seine Container (mind. den laufenden `cloudflared`-Container) **statt** „VPS-Ziel nicht konfiguriert". (Testbar mit gemocktem `VpsDockerControl` + dynamischem Datensatz: Listing-Pfad ruft das Ziel, kein null-Fall.)

### Reconcile + Cleanup
- **AC6** — Die Reconcile-Konfiguration bezieht den dynamisch angelegten VPS **inklusive seiner `tunnelId`** aus dem persistierten Datensatz ein (ohne zusätzlichen `RECONCILE_TUNNEL_IDS`-Env-Eintrag); Env-`RECONCILE_TUNNEL_IDS` bleibt Override/Fallback. (Testbar: dynamischer Datensatz mit tunnelId → erscheint in der Reconcile-VPS-Konfig mit korrekter tunnelId.)
- **AC7** — Beim VPS-Löschen ([[vps-delete]]) wird der dynamische Ziel-Datensatz mit entfernt (analog tunnelId-/Token-Cleanup); danach erscheint der VPS **nicht mehr** in `vps-targets` und ist über `resolveVpsTarget` nicht mehr (dynamisch) auflösbar. (Testbar: nach Delete-Pfad ist der Datensatz weg, kein verwaistes Ziel.)

### Sicherheit (Floor, hart)
- **AC8** — Der Ziel-Datensatz und alle drei Auflösungs-Pfade leaken **niemals** SSH-Private-Key-Material oder Tunnel-Token in Response, Log, Audit, WS-Stream, Argv, URL oder Frontend-Bundle; der Private-Key bleibt store-intern und transient pro Aufruf (ADR-008), das Tunnel-Token bleibt verschlüsselt at rest (ADR-007). `vps-targets` exponiert weiterhin **nur IDs**. (Testbar: Response/Log/Argv secret-frei; Grep auf Key-/Token-Leak im neuen Pfad.)

## Verträge
> Persistenz-Mechanik (CredentialStore-Schlüssel vs. store-interne Map) wählt `architekt`/`coder` analog der bestehenden tunnelId-Persistenz (`credentials/misc/vps-<sanitized>-tunnel-id`); die ACs prüfen die Garantien, nicht die Zeilenform. Empfehlung: ein paralleler, nicht-geheimer Metadaten-Schlüssel (z.B. `credentials/misc/vps-<sanitized>-target` mit JSON `{ provider, serverId, host, port, targetUser, tunnelId }`) — **keine** Secrets darin, nur Referenzen.

- **`VpsTarget` (Read-Model, intern):** `{ host: string, port: number, targetUser: string }` — unverändertes Ziel-Schema (ADR-008), das `resolveVpsTarget`/`DeployOrchestrator`/`VpsDockerControl` heute schon konsumieren.
- **`VpsTargetRecord` (neu, persistiert, nicht geheim):** `{ provider, serverId, host, port, targetUser, tunnelId }`. **Kein** Private-Key, **kein** Tunnel-Token (nur Metadaten/Referenzen).
- **GET `/api/deployments/vps-targets`** → `{ vpsIds: string[] }` (unverändert), Quelle jetzt = Vereinigung(dynamische Datensätze, `VPS_TARGETS`-Env), Env gewinnt bei Kollision. Read-only, nur IDs.
- **`resolveVpsTarget(provider, serverId, vpsRegistry, vpsTargets)`** → `{ host, port, targetUser } | null`; löst zuerst dynamisch (`{provider,serverId}`-Match), dann Env/IP-Match; `null` nur, wenn **weder** dynamisch **noch** Env ein Ziel ergibt.
- **Reconcile-Konfig:** dynamische Datensätze (mit `tunnelId`) ⊕ `VPS_TARGETS`+`RECONCILE_TUNNEL_IDS`-Env.
- **Persistenz beim Create:** Erweiterung von `VpsProviderRegistry.create` (nach `adapter.create`), audit-/floor-konform wie die übrige Create-Mutation; **kein** neuer Endpunkt nötig.
- **Cleanup beim Delete:** Erweiterung der bestehenden `vps-delete`-Cleanup-Sequenz (neben tunnelId-/Token-Cleanup).
- **Defaults (Annahme, dokumentiert):** `targetUser = "root"`, `port = 22` aus dem Create-Kontext (root- + alex-Keys hinterlegt); pro Provider verfeinerbar durch `architekt`/`coder`.

## Edge-Cases & Fehlerverhalten
- IP zum Create-Zeitpunkt noch nicht final → host über `getMachineIp` nachträglich aufgelöst (AC2); kein stale-IP-Lock.
- Persistenz des Ziel-Datensatzes schlägt fehl, während der VPS schon angelegt ist → klarer Teil-Fehler analog der tunnelId-Persistenz-Linie (S-152 AC10): VPS bleibt angelegt, Datensatz-Fehler protokolliert (secret-frei), Betreiber kann via `VPS_TARGETS`-Env-Override nachsteuern (Fallback bleibt).
- Kollision dynamischer Datensatz ↔ Env-Eintrag → **Env gewinnt** (Override), keine Doppelung in `vps-targets` (dedup).
- Dynamischer Datensatz vorhanden, VPS aber provider-seitig schon gelöscht/unerreichbar → Auflösung liefert das Ziel, der nachgelagerte SSH-Pfad degradiert geheimnisfrei (`unreachable`, [[vps-container-overview]] AC8) — kein Crash.
- Bestandssetups ohne dynamische Datensätze (nur Env) → unverändertes Verhalten (Env bleibt vollwertige Quelle).
- IONOS composite `serverId` mit Slash → der Match nutzt die literale serverId (analog `*splat`-Routing), kein Pfad-Split.

## NFRs
- **Sicherheit (Floor, hart):** SSH-Private-Key store-intern + transient (ADR-008); Tunnel-Token verschlüsselt at rest (ADR-007); kein Key/Token im neuen Datensatz, in `vps-targets`, in Logs/Argv/WS/Bundle. `vps-targets` bleibt ID-only.
- **Rückwärtskompatibilität:** `VPS_TARGETS`/`RECONCILE_TUNNEL_IDS`-Env bleiben gültiger Override/Fallback; Bestandssetups brechen nicht.
- **ADR-005-Linie:** kein neuer eigenständiger State-Store — der Ziel-Datensatz reiht sich in die bestehende Create-Metadaten-Persistenz (CredentialStore-`misc`) ein, analog tunnelId; Auflösung bleibt live (host via `getMachineIp` auffrischbar).
- **Determinismus:** vereinigte Menge deterministisch (dedup, Env-Override), stabile `vps-targets`-Reihenfolge.

## Nicht-Ziele
- Neues Frontend (Dropdowns/Views) — der Deploy-Dropdown und die Container-Übersicht existieren bereits ([[deploy-lifecycle]] AC10, [[vps-container-overview]]); diese Spec füllt nur ihre Datenquelle.
- Tunnel-/cloudflared-Provisionierung (bleibt [[vps-tunnel-provisioning]], S-152).
- Server-Lifecycle (Maschine start/stop/create selbst) → [[vps-provider-boundary]].
- Multi-User-Auswahl des `targetUser` zur Laufzeit (Default `root`; alex-Key bleibt zusätzlich hinterlegt).
- Migration bestehender Env-Ziele in die dynamische Persistenz.

## Abhängigkeiten
- [[vps-tunnel-provisioning]] (S-152 — Create-Pfad + tunnelId-Persistenz, in deren Linie der Ziel-Datensatz eingereiht wird).
- [[deploy-lifecycle]] (S-155 — Konsument: `vps-targets`-Dropdown + Deploy-Ziel-Auflösung).
- [[vps-container-overview]] (S-157 — Konsument: `resolveVpsTarget` für die Container-Übersicht).
- [[cloudflare-reconciliation]] (Konsument: Reconcile-VPS-Konfig inkl. tunnelId).
- [[vps-provider-boundary]] (Create-/`getMachineIp`-Boundary, `*splat`/serverId-Routing).
- [[vps-delete]] (Cleanup des Ziel-Datensatzes beim Löschen).
- [[settings-ssh-keys]] (SSH-Private-Key store-intern, ADR-008).
- `docs/architecture.md` — ADR-008 (SSH-Linie), ADR-007 (CredentialStore), ADR-009 (VPS-Boundary), ADR-012 (`VpsDockerControl`/`DeployOrchestrator`).
