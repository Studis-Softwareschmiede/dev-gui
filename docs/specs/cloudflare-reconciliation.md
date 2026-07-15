---
id: cloudflare-reconciliation
title: Reconciliation-Cron — beidseitig selbst-heilender Container ↔ Tunnel-Route Abgleich (Capability C)
status: draft
area: deployment
version: 3
---

# Spec: Reconciliation-Cron (`cloudflare-reconciliation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-kritisch (autonome Cloudflare-Mutation in **beide Richtungen**, Self-Lockout-Risiko).
> Boundary fixiert in **ADR-013** (`ReconciliationJob`, node-interner Mitternachts-Scheduler im always-on dev-gui-Prozess, ADR-002); konsumiert den atomaren Anlege-Pfad des `DeployOrchestrator` (ADR-012), `VpsDockerControl` (ADR-012), `CloudflareApi` (ADR-010), `LockoutGuard` (ADR-011), `AuditStore` (ADR-005-Linie).
> **v2 (Betreiber-Korrektur 2026-06-08):** beidseitig selbst-heilend (verwaiste Route löschen **und** managed Container ohne Route → Route anlegen); `ReconcileReport` nach **jedem** Lauf (Cron + manuell) über `AuditStore`; interne Reconciliation-Statusmeldung (`ReconcileNotice`) im Cloudflare-Panel.
> **v3 (Betreiber-Korrektur 2026-07-15 — Datenverlust-Fix):** der Container-Read umfasst **laufende UND gestoppte** Container (`docker ps -a`). Bisher las der Lauf nur **laufende** Container (`docker ps` ohne `-a`) und wertete die Route eines über Nacht **gestoppten** managed Containers als **verwaist** → `removeRoute` + `deleteDnsRecord`. Ein späteres `docker start` brachte den Container **unerreichbar** hoch (Route + CNAME weg, still, ohne Zutun des Betreibers). Ein **gestoppter managed Container zählt ab v3 als verwaltet** — seine Route bleibt stehen (AC3b). **Stop ist kein Undeploy**: nur das ausdrückliche Entfernen ([[deploy-lifecycle]] Undeploy / [[vps-container-overview]] AC6) räumt eine Route ab.

## Zweck
**Capability C des Cloudflare-Vorhabens:** ein zeitgesteuerter (und manuell auslösbarer) Abgleich über **alle konfigurierten VPS** zwischen laufenden Containern und existierenden Tunnel-Routen, der **beide Seiten zum Container-Label als Desired-State konvergiert**: **verwaiste** Routen (keine zugehörige managed-Container-Bindung) werden entfernt; **managed Container ohne Route** bekommen die fehlende Route **angelegt** (über denselben atomaren Anlege-Pfad wie der Deploy, [[deploy-lifecycle]] / ADR-012). So bleibt der Tunnel-Bestand selbst-heilend konsistent, auch wenn ein Deploy/Undeploy halb fehlschlägt. Jede Aktion ist im Cloudflare-Panel sichtbar; jeder Lauf erzeugt einen persistierten Report.

## Verhalten
1. Ein **node-interner Scheduler** im bestehenden always-on dev-gui-Prozess (ADR-002) löst den Abgleich **täglich um Mitternacht** aus; zusätzlich ein **manueller Trigger** (`POST /api/deployments/reconcile`, Access+Rolle+Audit) für Ad-hoc-Läufe („jetzt abgleichen"). Beide Auslöser durchlaufen **denselben** Abgleich und erzeugen einen Report.
2. Für jeden **konfigurierten** VPS gleicht der Lauf ab: (a) `VpsDockerControl` liest **alle** Container — **laufende und gestoppte** (`docker ps -a`) — je Container mit maschinenlesbarem `state` und dem `cloudflare.tunnel-hostname`-Label (Ist-Container-Menge); ein Container **mit** Label ist „managed", ein Container **ohne** Label ist „unmanaged" (kein Deployment). **Der `state` ändert die Managed-Eigenschaft nicht** — allein das Label entscheidet. (b) `CloudflareApi` liest die Tunnel-Routen der betroffenen Zone(n) (Ist-Routen-Menge).
3. **Verwaiste Route** = Route **ohne** zugehörigen managed Container (laufend **oder gestoppt**) UND **nicht protected** (LockoutGuard, ADR-011) → wird entfernt (Audit-First, **ohne** type-to-confirm — der Cron hat keinen menschlichen Akteur; der Self-Lockout-Schutz LockoutGuard gilt unverändert hart).
3b. **Gestoppter managed Container schützt seine Route:** ein managed Container im Zustand `exited` / `created` / `paused` / `restarting` / `dead` zählt als **verwaltet**; seine Route wird **nie** als verwaist gewertet und **nie** gelöscht. Ein gestoppter Container ist ein **normaler Betriebszustand** (Betreiber hat „Stop" gedrückt), **kein** Undeploy-Signal.
4. **Laufender managed Container ohne Route** → die fehlende Route wird **angelegt** (selbst-heilend) über den **atomaren Anlege-Pfad des `DeployOrchestrator`** (ADR-012, Schritt c: LockoutGuard-Check → `CloudflareApi.putTunnelConfig` + DNS-CNAME) — **nicht** über duplizierte Logik. Der Container läuft bereits; es wird **kein** `docker pull/run` ausgeführt. Ist der Hostname **protected**, wird **nicht** angelegt (`protectedSkipped`).
4b. **Gestoppter managed Container ohne Route** → wird **nicht** geheilt, nur als `stoppedSkipped` vermerkt. Begründung: eine Route auf einen gestoppten Container zeigt ins Leere (nur Fehlerseiten) — die Route entsteht beim nächsten Start/Deploy über den regulären Pfad. Der Lauf legt damit **nachts nie** neue Cloudflare-Einträge für nicht laufende Container an (konservativ, gegenläufig zu Regel 3b, die nur **schützt**).
   > **Resolution O5 (2026-07-15, ohne Betreiber-Rückfrage konservativ entschieden):** Regel 4b ist die vorsichtige Variante (schützen ja, anlegen nein). Soll der Lauf gestoppte Container auch **heilen** (Route vorab anlegen, damit sie nach dem Start sofort steht), ist das eine bewusste Betreiber-Umentscheidung — dann entfällt 4b und AC5d wird invertiert. Regel 3b (Datenverlust-Fix) ist davon **unberührt**.
5. **Unmanaged Container** (ohne Deployment-Label) → **nicht** geheilt, nur als `reportedUnmanaged` im Report vermerkt.
6. **Autorität:** das Container-Label `cloudflare.tunnel-hostname` ist der autoritative Desired-State. Eine **protected** Route wird **nie** als verwaist gewertet/gelöscht und ein protected Hostname **nie** angelegt.
7. **Statusmeldung:** jede Aktion (angelegt / gelöscht / protected-übersprungen / Fehler) erzeugt eine im Cloudflare-Panel ([[view-cloudflare]]) sichtbare interne Meldung (`ReconcileNotice`), getragen über die `AuditStore`-Mechanik (kein neuer Store).
8. **Report nach jedem Lauf:** jeder Lauf (Cron + manuell) erzeugt **einen** `ReconcileReport` (Zeit, je VPS/Provider: geprüfte Container, angelegte Routen, gelöschte verwaiste Routen, protected-übersprungene, unmanaged, Fehler), persistiert über die append-only `AuditStore`-Mechanik.
9. **Degradation pro VPS/Provider:** ein unerreichbarer VPS (SSH-Fehler) oder ein degradierter/fehlerhafter Cloudflare-Provider/eine Zone kippt den Gesamtlauf nicht — der betroffene Teil wird übersprungen und im Report als gestört vermerkt; die übrigen werden normal abgeglichen.
10. **Fail-closed bei Mehrdeutigkeit:** kann der Container-Bestand eines VPS **nicht** zuverlässig gelesen werden, werden für diesen VPS **weder** Routen als verwaist gelöscht **noch** Routen geheilt. Eine **mehrdeutige Bindung** (zwei managed Container desselben VPS auf denselben Hostname) wird **nicht** geheilt, sondern als `ambiguous` vermerkt.
11. **Idempotenz (beidseitig):** ein zweiter Lauf ohne zwischenzeitlichen Drift ist ein no-op (kein Cloudflare-Mutations-Call, keine Aktions-Meldung).

## Acceptance-Kriterien

### Scheduler & Ort
- **AC1** — Der Abgleich läuft als node-interner Scheduler **im** dev-gui-Prozess (kein zweiter Dienst/Container/`systemd`-Timer für den Scheduler — Grep/Deploy-Artefakt prüfbar). Standard: täglich Mitternacht (Zeitzone explizit dokumentiert).
- **AC2** — Ein manueller Trigger `POST /api/deployments/reconcile` führt denselben Abgleich aus (hinter Access + `CRED_ADMIN_EMAILS`-Rolle + Audit); er ist für Tests deterministisch aufrufbar **und erzeugt ebenfalls einen `ReconcileReport`** (nicht nur der Cron).

### Abgleich-Logik (beidseitig konvergent)
- **AC3** — Eine Tunnel-Route **ohne** zugehörigen managed Container — **weder laufend noch gestoppt** (kein `cloudflare.tunnel-hostname`-Match in der **`docker ps -a`**-Menge) — UND **nicht protected** wird entfernt (Audit-First); testbar mit Mock (verwaiste Route → Lösch-Call), idempotent (zweiter Lauf ohne Drift → kein Call).
- **AC3b** *(v3, Datenverlust-Fix)* — Der Container-Read je VPS umfasst **laufende und gestoppte** Container (`docker ps -a`, nicht `docker ps`), je Container mit maschinenlesbarem `state`. Ein **managed** Container im Zustand `exited` / `created` / `paused` / `restarting` / `dead` zählt als **verwaltet**: seine Route wird **nicht** als verwaist gewertet und **nicht** gelöscht — **kein** `removeRoute`- und **kein** `deleteDnsRecord`-Call. (Testbar: gestoppter managed Container + zugehörige Route → Lauf ist für diesen Hostname ein no-op, Route und CNAME bleiben; Regressionstest zum stillen Route-Verlust über Nacht.)
- **AC4** — Eine **protected** Route wird **nie** als verwaist gewertet/gelöscht (testbar: protected Route ohne Container → bleibt erhalten, kein Lösch-Call). *(ADR-011)*
- **AC5** — Ein **laufender managed** Container **ohne** zugehörige Route bekommt die Route **angelegt** über den **atomaren Anlege-Pfad des `DeployOrchestrator`** (ADR-012, nur Route-Teil, kein `docker pull/run`); testbar mit Mock (laufender managed Container ohne Route → Anlege-Call über den geteilten Pfad), idempotent (Route existiert bereits → kein Call). Der `ReconciliationJob` enthält **keinen** eigenen `CloudflareApi.mutate*`-Anlegecode neben dem geteilten Pfad (Grep-prüfbar).
- **AC5b** — Ist der zu heilende Hostname **protected**, wird **keine** Route angelegt (`protectedSkipped`); testbar: protected Hostname am managed Container → kein Anlege-Call. *(ADR-011)*
- **AC5c** — Ein **unmanaged** Container (ohne `cloudflare.tunnel-hostname`-Label) wird **nicht** geheilt, nur als `reportedUnmanaged` vermerkt (testbar: kein Anlege-Call, kein `docker rm`).
- **AC5d** *(v3)* — Ein **gestoppter** managed Container **ohne** Route wird **nicht** geheilt: **kein** Anlege-Call, der Hostname erscheint als `stoppedSkipped` im Report. (Testbar: gestoppter managed Container ohne Route → kein `putTunnelConfig`/`createDnsRecord`, `stoppedSkipped` enthält den Hostname.) Zusammen mit AC3b gilt für gestoppte managed Container: **schützen ja, anlegen nein** (Regel 4b / Resolution O5).

### Resilienz
- **AC6** — Ein unerreichbarer VPS / ein degradierter Cloudflare-Provider / eine fehlerhafte Zone kippt den Lauf nicht: die übrigen VPS/Provider/Zonen werden abgeglichen, der gestörte Teil im Report als Fehler markiert.
- **AC7** — Kann der Container-Bestand eines VPS nicht zuverlässig gelesen werden, werden für diesen VPS **weder** Routen gelöscht **noch** geheilt (fail-closed). Eine mehrdeutige Bindung (zwei **laufende** managed Container → derselbe Hostname) wird **nicht** geheilt, sondern als `ambiguous` vermerkt.
- **AC7b** *(v3 — Mehrdeutigkeit durch gestoppte Altcontainer)* — Weil der Read ab v3 **auch gestoppte** Container sieht, entscheidet bei mehreren managed Containern **desselben Hostname** auf demselben VPS der **`state`**:
  - **genau ein `running` + beliebig viele gestoppte** → der **laufende** ist maßgeblich; **nicht** `ambiguous`, Heilung/Schutz laufen normal (AC5/AC3b). Die gestoppten Altcontainer (Zombies) werden **nur gemeldet**, **nie** vom Cron entfernt (Nicht-Ziel „Auto-Kill"); ihr Abräumen ist Sache des Re-Deploy-Ersetzungsschritts ([[deploy-lifecycle]] AC17).
  - **zwei oder mehr `running`** → `ambiguous`, keine Heilung, **kein** Lösch-Call.
  - **kein `running`, ein oder mehrere gestoppte** → **nicht** `ambiguous`: Route bleibt geschützt (AC3b), keine Heilung (AC5d).

  (Testbar: 1 laufender + 1 gestoppter managed Container mit gleichem Hostname → **kein** `ambiguous`, Heilung erfolgt; 2 laufende → `ambiguous`, kein Call.) **Regressionsschutz:** ohne diese Regel würde der v3-Read (`docker ps -a`) einen bislang unsichtbaren gestoppten Altcontainer sichtbar machen und den Hostname dauerhaft als `ambiguous` blockieren — der Fix darf die Heilung nicht kaputtmachen.

### Beobachtbarkeit & Sicherheit (Floor)
- **AC8** — **Jeder** Lauf (Cron **und** manuell) erzeugt **genau einen** `ReconcileReport` (Zeit, `trigger`, je VPS/Provider `{ checkedContainers, createdRoutes[], removedRoutes[], protectedSkipped[], stoppedSkipped[], reportedUnmanaged[], errors[] }`), persistiert über die append-only `AuditStore`-Mechanik (**kein** neuer Store, O4 entschieden: JA). `checkedContainers` zählt **laufende und gestoppte** Container; **`stoppedSkipped[]`** (v3, additiv) listet die Hostnames gestoppter managed Container, deren Route geschützt und/oder deren Heilung übersprungen wurde. Abrufbar über `GET /api/deployments/reconcile/last` und `GET /api/deployments/reconcile/reports?limit=N` (hinter Access). Beide Heilungs-Pfade erzeugen Audit-Einträge (Audit-First).
- **AC8b** — Jede Reconciliation-Aktion (`route-created` | `route-removed` | `protected-skipped` | `error`) erzeugt eine `ReconcileNotice`, abrufbar über `GET /api/deployments/reconcile/notices` (hinter Access) und im Cloudflare-Panel ([[view-cloudflare]]) sichtbar. `ReconcileNotice` trägt `{ at, kind, vps, hostname, detail? }` und **keine** Secrets.
- **AC9** — **Beide** Heilungs-Pfade (Löschen **und** Anlegen) stehen unter demselben `LockoutGuard`-Hard-Block + Audit-First wie der interaktive Pfad (automatisch durch Wiederverwendung des ADR-012-Pfads). **Keine** Secrets (SSH-Private-Key, Cloudflare-Token) erscheinen in Log, Audit, Report, `ReconcileNotice`, WS-Stream oder Argv.

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail in **ADR-013** (`ReconciliationJob`), konsumiert ADR-010/011/012.

- **`ReconcileReport`:** `{ ranAt, trigger: "cron"|"manual", perVps: [{ vps, provider?, checkedContainers: number, createdRoutes: string[], removedRoutes: string[], protectedSkipped: string[], stoppedSkipped: string[], reportedUnmanaged: string[], errors: [{ scope, errorClass }] }] }`. **Keine** Secrets. `stoppedSkipped` ist **additiv** (v3) — bestehende Report-Leser bleiben lauffähig; fehlt das Feld in Altdaten, gilt `[]`. (Kanonisch in [[data-model]].)
- **Container-Read (v3, maßgeblich):** `VpsDockerControl.psAll` liest **laufende und gestoppte** Container (`docker ps -a`, **nicht** `docker ps`) und liefert je Container ein maschinenlesbares **`state`** (`running` | `exited` | `created` | `paused` | `restarting` | `dead`, Quelle `docker`-`{{.State}}` — **nicht** der frei formatierte `status`-Text wie „Up 2 hours"). **Managed-Prädikat:** `managed === (hostname !== null)`, **unabhängig vom `state`**. **Laufend-Prädikat:** `state === 'running'`. Vertrag geteilt mit [[vps-container-overview]] (dortige AC8/AC9) — **eine** Boundary, **ein** Read-Model.
- **`ReconcileNotice`:** `{ at, kind: "route-created"|"route-removed"|"protected-skipped"|"error", vps, hostname, detail? }`. **Keine** Secrets. (Kanonisch in [[data-model]].)
- **POST `/api/deployments/reconcile`** (manueller „jetzt abgleichen"-Trigger) → `{ result: "ok"|"error", report? }`; erzeugt **immer** einen `ReconcileReport`. Hinter Access + Rolle + Audit.
- **GET `/api/deployments/reconcile/last`** → letzter `ReconcileReport` (oder leer). Hinter Access.
- **GET `/api/deployments/reconcile/reports?limit=N`** → die letzten N `ReconcileReport` (live aus dem `AuditStore`). Hinter Access.
- **GET `/api/deployments/reconcile/notices?limit=N`** → die letzten N `ReconcileNotice` (live aus dem `AuditStore`); konsumiert vom Cloudflare-Panel ([[view-cloudflare]]). Hinter Access.
- **Bindung:** Container↔Route über das Label `cloudflare.tunnel-hostname=<hostname>` (ADR-012). Container-Label = autoritativer Desired-State.
- **Heilungs-Pfad (Wiederverwendung):** die Route-Heilung „managed Container ohne Route → Route anlegen" ruft **denselben** atomaren Anlege-Pfad wie der `DeployOrchestrator` (ADR-012, Schritt c) — **kein** eigener Cloudflare-Mutationscode im `ReconciliationJob`.
- **Persistenz:** `ReconcileReport` + `ReconcileNotice` werden über die bestehende append-only **`AuditStore`**-Mechanik geschrieben (kein neuer Store, ADR-005-Linie).
- **Quellen:** `DeployOrchestrator` (atomarer Route-Anlege-Pfad, ADR-012), `VpsDockerControl` (Container-Read je VPS **inkl. gestoppter Container**, `psAll`/`docker ps -a`, SSH-Linie ADR-008), `CloudflareApi` (Routen-Read/-Löschen, ADR-010), `LockoutGuard` (protected-Prädikat, ADR-011). Token/Key store-intern, transient, nie geleakt.

## Edge-Cases & Fehlerverhalten
- Verwaiste **protected** Route → nie gelöscht (AC4).
- **Gestoppter managed** Container **mit** Route → Route bleibt **unangetastet** (AC3b); der Lauf ist für diesen Hostname ein no-op. Ein späteres `docker start` findet Route + CNAME vor und ist sofort erreichbar. *(v3-Kernfall — vorher: Route + CNAME still gelöscht.)*
- **Gestoppter managed** Container **ohne** Route → **nicht** geheilt, `stoppedSkipped` (AC5d); die Route entsteht beim nächsten Start/Deploy.
- **Laufender managed** Container ohne Route → Route **angelegt** über den ADR-012-Anlege-Pfad (AC5); ist der Hostname protected → nicht angelegt, `protectedSkipped` (AC5b).
- **Gestoppter Container ohne Label** (unmanaged) → wie jeder unmanaged Container nur `reportedUnmanaged` (AC5c), kein Auto-Kill, keine Route.
- **Unmanaged** Container (ohne Label) → **nicht** geheilt, nur `reportedUnmanaged` (AC5c), kein Auto-Kill.
- **Mehrdeutige Bindung** (zwei **laufende** managed Container desselben VPS → derselbe Hostname) → **nicht** geheilt, `ambiguous` im Report (AC7).
- **Ein laufender + ein gestoppter Altcontainer (Zombie) auf denselben Hostname** → **kein** `ambiguous`; der laufende ist maßgeblich, Heilung/Schutz normal (AC7b). Der Zombie wird nur gemeldet — abgeräumt wird er vom Re-Deploy ([[deploy-lifecycle]] AC17), **nie** vom Cron.
- VPS-SSH-Fehler / degradierter Cloudflare-Provider / Zone-Fehler → degradiert (AC6); für gestörten VPS **weder** Route-Lösch **noch** Heilung (AC7, fail-closed).
- Kein VPS/keine Route konfiguriert → Lauf ist no-op mit leerem (aber existierendem) Report.
- Zweiter Lauf ohne Drift → no-op, kein Mutations-Call, keine Aktions-Meldung (AC3/AC5-Idempotenz); der Report wird dennoch erzeugt (mit leeren Aktions-Listen).
- Überlappende Läufe (Cron + manuell) → ein prozess-interner Lock verhindert Doppel-Ausführung (`coder` finalisiert die Lock-Mechanik; Default: skip-if-running).

## NFRs
- **Sicherheit (Floor, hart):** autonome Cloudflare-Mutation **in beide Richtungen** (Löschen **und** Anlegen) steht unter LockoutGuard-Hard-Block (protected → nie löschen, nie anlegen) + Audit-First — automatisch durch Wiederverwendung des ADR-012-Pfads; fail-closed bei unsicherem Container-Bestand. Keine Secrets in Log/Audit/Report/`ReconcileNotice`/WS/Argv.
- **Datenerhalt (v3, hart):** ein **Stop** darf **nie** zu Route-/DNS-Verlust führen. Der Lauf löscht eine Route nur, wenn auf dem VPS **kein** managed Container mit diesem Hostname existiert — **weder laufend noch gestoppt** (AC3/AC3b). Der Container-Read ist damit die **einzige** Autorität für „verwaist"; ein Read, der gestoppte Container ausblendet (`docker ps` ohne `-a`), ist ein **Datenverlust-Bug** und Grep-prüfbar untersagt.
- **ADR-005/006-Konformität:** Abgleich ist **live** (Docker-Label ⊕ Cloudflare-Route), kein persistenter Reconcile-/Deploy-State; Report + Statusmeldungen über die bestehende `AuditStore`-Append-only-Mechanik (kein neuer Store); kein neuer Dienst (interner Timer im always-on Prozess, ADR-002).
- **Resilienz:** pro VPS/Provider degradierend; idempotent in beide Richtungen; skip-if-running.

## Nicht-Ziele
- **Auto-Kill** von Containern (auch unmanaged) — der Cron heilt nur die Route-Seite (anlegen/löschen), killt **nie** einen Container.
- **Heilung von unmanaged Containern** (ohne Deployment-Label) — diese werden nur gemeldet.
- **Deploy/Undeploy** selbst → [[deploy-lifecycle]] (der Cron nutzt aber dessen Anlege-Pfad wieder).
- **Cloudflare-Inventar-UI** → [[view-cloudflare]] (diese Capability ist headless; das Panel zeigt nur Statusmeldungen + Reports read-only an).
- Eigener persistenter Reconcile-Historien-Store — die Historie liegt ausschließlich in den append-only `AuditStore`-Zeilen (Report + Notice; O4 entschieden: JA, AuditStore).

## Abhängigkeiten
- [[deploy-lifecycle]] (teilt `VpsDockerControl` + Label-Konvention **und den atomaren Route-Anlege-Pfad des `DeployOrchestrator`**; bereinigt/heilt dessen Rest-Drift).
- [[view-cloudflare]] (`CloudflareApi`-Boundary, ADR-010; zeigt `ReconcileNotice` + `ReconcileReport`).
- [[vps-provider-boundary]] (welche VPS konfiguriert sind).
- [[settings-credentials]] / [[settings-ssh-keys]] (Cloudflare-Token + SSH-Key store-intern).
- [[access-and-guardrails]] (Access-Mauer + Audit; LockoutGuard ADR-011; `AuditStore` als Persistenz von Report + Notice).
- [[data-model]] (`ReconcileReport`, `ReconcileNotice` kanonisch).
- `docs/architecture.md` — **`ReconciliationJob` in ADR-013** (node-interner Mitternachts-Scheduler, ADR-002; **beidseitig selbst-heilend** über den ADR-012-Anlege-Pfad; Container-Label autoritativer Desired-State; Report + Notice über `AuditStore`; degradierend pro VPS/Provider; fail-closed).
