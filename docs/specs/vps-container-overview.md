---
id: vps-container-overview
title: Container-Übersicht pro VPS — laufende und gestoppte Container in dev-gui sehen + steuern (ersetzt Portainer)
status: active
area: deployment
version: 2
---

# Spec: Container-Übersicht pro VPS (`vps-container-overview`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (SSH-on-VPS + Docker-Mutation + Self-Lockout-Risiko beim Undeploy).
> Boundaries fixiert in **ADR-012** (`VpsDockerControl` + `DeployOrchestrator`), Cloudflare-Pfad in **ADR-010**, Self-Lockout-Schutz in **ADR-011**.
> **v2 (Betreiber-Korrektur 2026-07-15):** die Übersicht zeigt **auch gestoppte** Container (`docker ps -a`). v1 listete nur **laufende** Container — drückte der Betreiber „Stop", **verschwand der Container aus der GUI** und war nicht mehr startbar: der Start-Endpunkt existierte, war aber unerreichbar, weil die Zeile weg war (Sackgasse). Zusätzlich: **Update-Knopf** je Container → [[container-image-update]].

## Zweck
Jede VPS-Zeile in der VPS-Ansicht ([[view-vps]]) bekommt eine **Container-Übersicht** direkt in dev-gui — der Betreiber sieht die auf diesem VPS vorhandenen Container, **laufende wie gestoppte** (Name, Status, Zustand, Image, Port), und kann sie **starten / stoppen / neu starten / aktualisieren / Logs ansehen / entfernen**, ohne ein externes Werkzeug wie Portainer. Das **Entfernen eines von dev-gui deployten** (managed) Containers ist ein **vollständiger Undeploy** (Container **+** zugehörige Cloudflare-Route, anhand des `cloudflare.tunnel-hostname`-Labels) mit type-to-confirm. Read-only-Listing zeigt **alle** Container (managed + unmanaged, laufend + gestoppt); das Routen-Mit-Entfernen gilt nur für managed Container.

> **Grundsatz (v2): Stop ist kein Verschwinden.** Ein gestoppter Container bleibt **sichtbar**, als `gestoppt` gekennzeichnet und **startbar**. „Stop" ist ein reversibler Betriebszustand — **kein** Undeploy: es entfernt weder Container noch Route (der Reconcile-Lauf lässt die Route eines gestoppten managed Containers ausdrücklich stehen, [[cloudflare-reconciliation]] AC3b). Nur „Entfernen" (AC6/AC7) räumt ab.

> **Abgrenzung:** Diese Spec liefert die **Container-zentrierte Ansicht + Einzel-Container-Aktionen** pro VPS in der VPS-View. Die **Deploy/Undeploy-Orchestrierung als atomare Einheit** lebt in [[deploy-lifecycle]] (`DeployOrchestrator`) und wird **wiederverwendet** (Undeploy = `DeployOrchestrator.undeploy`), **nicht** dupliziert. Der **Server-Lifecycle** (Maschine starten/stoppen/erstellen) bleibt in [[vps-provider-boundary]]. Schreibende Docker-Kommandos auf dem VPS bleiben **ausschließlich** in `VpsDockerControl` (ADR-012, R01).

## Verhalten

### UI-Einstieg (VpsView)
1. Jede VPS-Zeile in `client/src/VpsView.jsx` trägt einen **„Container"-Button**. Ein Klick öffnet (inline aufklappend oder als Panel) die Container-Übersicht **genau dieses VPS** und lädt deren Container live.
2. Die Übersicht listet je Container mindestens: **Name** (Container-Name oder kurze ID), **Status** (z.B. „Up 2 hours" / „Exited (0) 3 hours ago"), **Zustand** (`state`, maschinenlesbar), **Image** und **Port** (gemappter Host-Port, falls vorhanden). **Managed** Container (mit `cloudflare.tunnel-hostname`-Label) sind als solche erkennbar markiert und zeigen ihren Hostname; **unmanaged** Container (ohne das Label) sind ebenfalls sichtbar, aber als unmanaged markiert.
2b. **Gestoppte Container sind sichtbar** (`docker ps -a`) und tragen ein deutliches **Badge „gestoppt"** (optisch abgesetzt, z.B. gedimmt); laufende tragen entsprechend „läuft". Es gibt **keinen** Umschalter „auch gestoppte zeigen" — gestoppte Container sind **immer** in der Liste (ein Standard-Filter „nur laufende" wäre genau die Falle, die zur Sackgasse geführt hat). Die Reihenfolge darf laufende zuerst zeigen.
3. Leer-Zustand: existieren **überhaupt keine** Container (weder laufend noch gestoppt), zeigt die Übersicht einen neutralen Leer-Hinweis (kein Voll-Fehler).

### Einzel-Container-Aktionen
4. Je Container bietet die Übersicht die Aktionen **Start**, **Stop**, **Neustart**, **Update** ([[container-image-update]]), **Logs ansehen** und **Entfernen**. Aktionen, die der zugrunde liegende Provider/VPS nicht zulässt oder die im aktuellen Zustand sinnlos sind, sind **disabled mit Begründung** — maßgeblich ist der `state`:
   - `state === 'running'` → **Stop**/**Neustart** aktiv, **Start** disabled.
   - `state !== 'running'` (gestoppt) → **Start** aktiv, **Stop**/**Neustart** disabled.
   - **Logs**/**Entfernen** sind in **beiden** Zuständen aktiv (Logs eines gestoppten Containers sind gerade im Fehlerfall die wichtigste Quelle).
5. **Start/Stop/Neustart** rufen die jeweilige Backend-Aktion; nach Erfolg aktualisiert die Übersicht die Container-Liste (Re-Fetch). Lade-/Erfolg-/Fehlerzustände sind je Container sichtbar. Nach **Stop** bleibt die Zeile stehen und wechselt auf „gestoppt" — sie verschwindet **nicht**.
6. **Logs ansehen** lädt die letzten N Zeilen Container-Logs read-only und zeigt sie an; der Log-Inhalt wird **nicht** als Secret behandelt, aber es werden keine Backend-Geheimnisse (SSH-Key/Token) eingeblendet.
7. **Entfernen — abhängig vom Container-Typ:**
   - (a) **Managed** Container (`cloudflare.tunnel-hostname`-Label gesetzt): „Entfernen" = **voller Undeploy** über [[deploy-lifecycle]] — entfernt den Container **und** die zugehörige Cloudflare-Tunnel-Route + DNS-CNAME (Hostname aus dem Label). Reihenfolge Route-zuerst (kein Traffic auf entfernten Container). Erfordert **type-to-confirm** (exakter Hostname/Name getippt). **LockoutGuard-Check** auf den Label-Hostname: protected → abgelehnt, kein Schritt.
   - (b) **Unmanaged** Container (kein Label): „Entfernen" = reines `docker rm -f` über `VpsDockerControl.rm`; **kein** Cloudflare-Schritt. Erfordert ebenfalls type-to-confirm (Container-Name/ID getippt).
8. Nach erfolgreichem Entfernen/Undeploy verschwindet der Container nach Re-Fetch aus der Liste; ein Fehler wird klar gemeldet, **ohne** Geheimnisse zu zeigen.
9. Liefert das Listing eines VPS einen Fehler (z.B. SSH unerreichbar), **degradiert** die Übersicht für genau diesen VPS (klare Fehlermarkierung), ohne die übrige VPS-Liste zu zerstören.

### Backend
10. Das Backend stellt pro VPS bereit: **Container-Listing** (`VpsDockerControl.psAll` — managed + unmanaged, **laufend + gestoppt**, je Eintrag containerId, name, image, hostname|null, **state**, status, hostPort), **Start/Stop/Restart**, **Update** ([[container-image-update]]), **Logs** (read-only) und **Entfernen** (managed → `DeployOrchestrator.undeploy`; unmanaged → `VpsDockerControl.rm`). `VpsDockerControl` ergänzt die heute fehlenden Methoden **start/stop/restart/logs** (ps/psAll/rm/run/pull existieren bereits).
10b. **`psAll` liest `docker ps -a`** (nicht `docker ps`) und liefert je Container ein maschinenlesbares **`state`** aus `{{.State}}` (`running` | `exited` | `created` | `paused` | `restarting` | `dead`) — **zusätzlich** zum bestehenden frei formatierten `status`-Text, der für Menschen bleibt, aber **nie** als Zustands-Prädikat geparst wird. Das Read-Model ist **geteilt** mit [[cloudflare-reconciliation]] (dortige AC3b) — **eine** Boundary, **ein** Read-Model, damit GUI und Reconcile-Lauf **denselben** Container-Bestand sehen.
11. Der VPS wird über `:provider` + die (ggf. slash-haltige, IONOS composite) `serverId` adressiert — analog der bestehenden `*splat`-Konvention in `vpsRouter.js`. Das Backend löst daraus das SSH-Ziel `{ host, port?, targetUser }` auf (SSH-Private-Key store-intern, ADR-008); der Client übergibt **kein** Key-Material und **kein** Token.
12. Alle Endpunkte hinter AccessGuard; **mutierende** Aktionen (start/stop/restart/remove/undeploy) zusätzlich **identitäts-/rollengeschützt** (`CRED_ADMIN_EMAILS`-Logik wie ADR-007/`vpsRouter`) und **audit-first** (Audit-Eintrag VOR der Mutation; schlägt der Audit-Write fehl → Aktion unterbleibt). Read-only (Listing/Logs) ist hinter Access ohne Rollencheck.

## Acceptance-Kriterien

### UI — Übersicht (Frontend)
- **AC1** — Jede VPS-Zeile in `VpsView.jsx` zeigt einen **„Container"-Button**; ein Klick öffnet die Container-Übersicht dieses VPS und ruft das Container-Listing dieses VPS ab (`GET /api/vps/machines/:provider/*splat/containers`). (Testbar: Button vorhanden, Klick triggert den Listing-Fetch mit korrekter provider/serverId-URL.)
- **AC2** — Die Übersicht listet je Container **Name, Status, Image, Port** und kennzeichnet **managed** (mit `cloudflare.tunnel-hostname`-Label, Hostname sichtbar) vs. **unmanaged** (ohne Label) Container. (Testbar: gerenderte Felder + Managed-Kennzeichen aus einer gemockten Listing-Antwort.)
- **AC3** — Existieren keine Container, zeigt die Übersicht einen neutralen Leer-Zustand; ein Listing-Fehler eines VPS degradiert nur diese Übersicht (Fehlermarkierung), nicht die gesamte VPS-Liste. (Testbar: Leer-Antwort → Leer-Hinweis; Fehler-Antwort → markierter Fehler, übrige VPS-Zeilen bleiben.)

### UI — Aktionen (Frontend)
- **AC4** — Je Container bietet die Übersicht **Start, Stop, Neustart, Logs ansehen, Entfernen**; nach erfolgreicher Start/Stop/Neustart-Aktion wird die Container-Liste neu geladen; Lade-/Erfolg-/Fehlerzustand je Container ist sichtbar; 403 → klare „keine Berechtigung"-Meldung ohne UI-Crash. (Testbar: Aktions-Buttons vorhanden; Erfolg → Re-Fetch; 403 → Berechtigungs-Meldung.)
- **AC4b** *(v2 — Aktivierung nach `state`)* — Die Aktivierung der Aktions-Buttons richtet sich nach `state`: bei `state === 'running'` sind **Stop/Neustart** aktiv und **Start** disabled; bei `state !== 'running'` ist **Start** aktiv und **Stop/Neustart** disabled; **Logs** und **Entfernen** sind in **beiden** Zuständen aktiv. Disabled-Buttons tragen eine **Begründung** (title/aria). (Testbar: gemockter Eintrag mit `state:'exited'` → Start klickbar, Stop/Neustart disabled; `state:'running'` → umgekehrt.)
- **AC5** — **Logs ansehen** lädt read-only die letzten Log-Zeilen (`GET …/containers/:containerId/logs`) und zeigt sie an; es erscheint **kein** SSH-Private-Key/Token im Frontend. (Testbar: Log-Abruf rendert Zeilen; keine Secret-Strings im DOM.)
- **AC6** — **Entfernen managed:** Für einen managed Container (Label gesetzt) löst „Entfernen" nach **type-to-confirm** (exakter Hostname getippt) den **vollen Undeploy** aus (`DELETE …/containers/:containerId` mit `confirm` + Undeploy-Semantik) — Container **und** Cloudflare-Route verschwinden; ohne korrekten Confirm-Wert ist die Aktion deaktiviert/abgelehnt. (Testbar: ohne Confirm keine Mutation; mit korrektem Confirm Undeploy-Aufruf; nach Erfolg ist der Container nach Re-Fetch weg.)
- **AC7** — **Entfernen unmanaged:** Für einen unmanaged Container (kein Label) entfernt „Entfernen" nach type-to-confirm **nur** den Container (`docker rm`), **ohne** Cloudflare-Schritt. (Testbar: bei unmanaged Container wird kein Cloudflare-Remove ausgelöst.)

### UI — Gestoppte Container (v2)
- **AC14** *(v2 — Kern des Sichtbarkeits-Fix)* — **Gestoppte Container erscheinen in der Übersicht** und tragen ein Badge **„gestoppt"** (laufende: „läuft"); die Sichtbarkeit ist **bedingungslos** — es gibt **keinen** Filter/Umschalter, der gestoppte Container standardmäßig ausblendet. Der **Start-Knopf ist für sie erreichbar und aktiv** (AC4b). Nach einem **Stop** bleibt die Zeile stehen und wechselt auf „gestoppt", statt zu verschwinden. (Testbar: Listing-Mock mit `state:'exited'` → Zeile gerendert + Badge „gestoppt" + Start aktiv; Stop-Aktion → Re-Fetch mit `state:'exited'` → Zeile weiterhin vorhanden. **Regressionstest** zur v1-Sackgasse „Container nach Stop unauffindbar/nicht startbar".)

### UI — Update-Knopf (v2)
- **AC15** *(v2)* — Je **managed** Container bietet die Übersicht einen **„Update"-Knopf**, der den Image-Update ([[container-image-update]]) für genau diesen Container anstößt (`POST …/containers/:containerId/update`) und dessen Ergebnis/Fehler je Container sichtbar macht; nach Erfolg wird die Liste neu geladen. Für **unmanaged** Container ist der Knopf **nicht vorhanden oder disabled mit Begründung**. **Verhalten, Endpunkt und Fail-closed-Regeln des Updates sind in [[container-image-update]] spezifiziert** — diese Spec deckt nur die **Einbettung** (Sichtbarkeit/Aktivierung, Ergebnis-Anzeige, Re-Fetch). (Testbar: managed → Knopf vorhanden, Klick ruft den Update-Endpunkt; unmanaged → kein aktiver Knopf; Erfolg → Re-Fetch.)

### Backend — Listing + Aktionen
- **AC8** — `GET /api/vps/machines/:provider/*splat/containers` liefert die Container des VPS — **laufende und gestoppte** — über `VpsDockerControl.psAll` (managed **und** unmanaged), je Eintrag `{ containerId, name?, image, hostname|null, state, status, hostPort }`; ein SSH-/Docker-Fehler degradiert geheimnisfrei (`{ result:'error', errorClass, reason }`), kein Crash. (Testbar mit gemocktem `VpsDockerControl`: gestoppter Container ist in der Antwort enthalten und trägt `state:'exited'`.)
- **AC9** — `VpsDockerControl` erhält die Methoden **start / stop / restart / logs** (zusätzlich zu den bestehenden ps/psAll/rm/run/pull); sie führen das jeweilige `docker`-Kommando via SSH aus (Shell-Escaping + Container-ID-Validierung wie bei `rm`), liefern geheimnisfreie `{ result, reason?, errorClass? }` und sind die **einzige** Stelle für schreibende Docker-Kommandos auf dem VPS (Grep-prüfbar, R01/ADR-012). (Testbar: Methoden existieren, validieren die Container-ID, Klassifizieren Fehler ohne Leak.)
- **AC9b** *(v2)* — **`VpsDockerControl.psAll` listet `docker ps -a`** (laufend **und** gestoppt) und liefert je Container `state` aus `{{.State}}` (`running`|`exited`|`created`|`paused`|`restarting`|`dead`), zusätzlich zum bestehenden Menschen-`status`-Text. Das `managed`-Prädikat bleibt **allein** `hostname !== null` und ist **unabhängig vom `state`**; das `running`-Prädikat ist **ausschließlich** `state === 'running'` (**kein** Parsen des `status`-Texts, z.B. kein `startsWith('Up')`). (Testbar: `psAll` setzt `-a`; gestoppter Container erscheint mit korrektem `state`; gestoppter **managed** Container hat weiterhin `managed: true`. Grep-prüfbar: kein `docker ps` ohne `-a` im Container-Read-Pfad.)
- **AC10** — `POST …/containers/:containerId/(start|stop|restart)` ruft die jeweilige `VpsDockerControl`-Methode; `GET …/containers/:containerId/logs` liefert read-only die letzten Log-Zeilen ohne Secret-Leak. (Testbar mit gemocktem Boundary.)
- **AC11** — `DELETE …/containers/:containerId` entfernt den Container: ist er **managed** (Label vorhanden), läuft der Pfad über `DeployOrchestrator.undeploy` (Route + DNS + Container, Hostname aus dem Label, `LockoutGuard`-Check, type-to-confirm); ist er **unmanaged**, über `VpsDockerControl.rm`. Bei protected Hostname → 422 `protected-resource`, **kein** Docker- und **kein** Cloudflare-Schritt. (Testbar: managed → Undeploy-Pfad inkl. Route-Remove; unmanaged → nur rm; protected → 422.)

### Sicherheit & Audit (Floor, hart)
- **AC12** — Alle `/api/vps/machines/:provider/*splat/containers*`-Endpunkte sind hinter AccessGuard (403 ohne gültigen Access); **mutierende** (start/stop/restart/remove) zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`; 403 ohne Berechtigung) und **audit-first** (Audit VOR der Mutation mit Identität, provider, serverId, containerId, Aktion, Zeit; schlägt der Audit-Write fehl → Aktion unterbleibt). (Testbar: ohne Berechtigung 403; Audit-Eintrag vorhanden, ohne Key/Token.)
- **AC13** — **Kein Leak:** SSH-Private-Key und Cloudflare-Token erscheinen **niemals** in Response, Logs, Audit, WS-Stream, Argv, URL oder Frontend-Bundle (store-intern aus dem `CredentialStore`, transient pro Aufruf). Fehlertexte sind geheimnisfrei klassifiziert. (Testbar: Response/Logs/Argv enthalten keinen Key/Token; Listing/Logs-Antworten sind secret-frei.)

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail in **ADR-012** (`VpsDockerControl`, `DeployOrchestrator`), **ADR-010** (`CloudflareApi`), **ADR-008** (SSH/`VpsProvisioner`-Linie). ServerId-Routing per `*splat` analog `vpsRouter.js` (IONOS composite IDs mit literalem Slash).

- **`ContainerEntry` (Read-Model, live):** `{ containerId, name?, image, hostname: string|null, state, status, hostPort: number|null, managed: boolean }`. `managed === (hostname !== null)` (cloudflare.tunnel-hostname-Label gesetzt) — **unabhängig vom `state`**. **`state`** (v2, additiv): `'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead'` aus `{{.State}}`; **`status`** bleibt der frei formatierte Menschen-Text („Up 2 hours" / „Exited (0) 3 hours ago") und ist **kein** Prädikat. Quelle: `VpsDockerControl.psAll` (`docker ps -a`). **Laufend-Prädikat:** `state === 'running'`. Read-Model geteilt mit [[cloudflare-reconciliation]].
- **GET `/api/vps/machines/:provider/*splat/containers`** → `{ result: 'ok', containers: ContainerEntry[] } | { result: 'error', errorClass, reason }`. Hinter Access, read-only. Enthält **laufende und gestoppte** Container.
- **POST `/api/vps/machines/:provider/*splat/containers/:containerId/update`** → Image-Update (pull + recreate); Vertrag/Verhalten kanonisch in **[[container-image-update]]**. [MUTATION]
- **GET `/api/vps/machines/:provider/*splat/containers/:containerId/logs?tail=N`** → `{ result: 'ok', lines: string[] } | { result: 'error', errorClass, reason }`. Read-only, hinter Access.
- **POST `/api/vps/machines/:provider/*splat/containers/:containerId/start`** → `{ result: 'ok'|'error', reason?, errorClass? }`. [MUTATION — Rollenschutz + Audit-First]
- **POST `/api/vps/machines/:provider/*splat/containers/:containerId/stop`** → `{ result, reason?, errorClass? }`. [MUTATION]
- **POST `/api/vps/machines/:provider/*splat/containers/:containerId/restart`** → `{ result, reason?, errorClass? }`. [MUTATION]
- **DELETE `/api/vps/machines/:provider/*splat/containers/:containerId`** — Body `{ confirm: "<hostname-oder-name>" }` → `{ result: 'ok'|'error', reason?, errorClass? }`. Managed → Undeploy (Route+DNS+Container, `LockoutGuard`); unmanaged → `docker rm`. Protected → 422 `protected-resource`; fehlender/falscher Confirm → 422 `confirmation-required`. [MUTATION]
- **`VpsDockerControl` (ADR-012, ergänzt):** bestehende `pull/run/rm/ps/psAll` + **neu** `start(vps, containerId, opts?)`, `stop(vps, containerId, opts?)`, `restart(vps, containerId, opts?)`, `logs(vps, containerId, opts?)` — jeweils via SSH, Container-ID-Validierung + Shell-Escaping wie `rm`, geheimnisfreie Fehlerklassen (`no-private-key`, `unreachable`, `auth-failed`, `host-key-mismatch`, `docker-failed`, `error`). **`psAll` (v2, geändert):** `docker ps -a` statt `docker ps`, liefert `state` je Container.
- **VPS-Referenz:** `{ host, port?, targetUser }` (ADR-008); SSH-Private-Key aus `ssh/<user>/private_key`, store-intern, transient, nie geleakt.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft (`CRED_ADMIN_EMAILS`) + AuditEntry + (für managed remove) LockoutGuard (ADR-011).

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → bestehende Access-Mauer greift davor (403).
- VPS unerreichbar / SSH-Auth fehlgeschlagen → `errorClass: unreachable|auth-failed`, geheimnisfreier `reason`, Übersicht degradiert für diesen VPS (AC3/AC8); übrige VPS bleiben.
- Kein SSH-Private-Key für `targetUser` → `errorClass: no-private-key`, klare Meldung, keine Mutation.
- Aktion auf nicht (mehr) existierenden Container → `docker-failed`, geheimnisfreie Meldung; Re-Fetch zeigt aktuellen Bestand.
- **Stop eines managed Containers** → Zeile bleibt sichtbar mit Badge „gestoppt", Start wird aktiv (AC14); **Route + DNS bleiben bestehen** — auch über Nacht ([[cloudflare-reconciliation]] AC3b). Ein anschließendes „Start" macht den Container unter seinem Hostname **wieder erreichbar**, ohne Deploy.
- **Container im Zustand `restarting` / `dead` / `paused`** → gilt als **nicht laufend** (`state !== 'running'`): Badge „gestoppt" (bzw. der jeweilige Zustand), Start aktiv, Stop/Neustart disabled. Kein Sonderpfad.
- **Gestoppter Altcontainer (Zombie) mit demselben Hostname wie ein laufender** → beide Zeilen sind sichtbar (v2 macht den Zombie überhaupt erst sichtbar); abgeräumt wird er vom Re-Deploy ([[deploy-lifecycle]] AC17), der Reconcile-Lauf wertet ihn nicht als mehrdeutig ([[cloudflare-reconciliation]] AC7b).
- **Update auf unmanaged Container** → kein aktiver Update-Knopf (AC15); Fehlerpfade des Updates selbst → [[container-image-update]].
- Entfernen managed Container, dessen Cloudflare-Route-Remove fehlschlägt → Verhalten gemäß [[deploy-lifecycle]] Undeploy (geheimnisfreier Fehler, keine Teil-Leaks); Container-Stand wird per Re-Fetch sichtbar.
- Entfernen auf protected Hostname (eigene devgui / Access-Mauer, ADR-011) → 422 `protected-resource`, **kein** Schritt; nicht via Identität/Confirm überschreibbar.
- Remove/Undeploy ohne/mit falschem `confirm` → 422 `confirmation-required`, keine Mutation.

## NFRs
- **Sicherheit (Floor, hart):** schreibende Docker-Kommandos ausschließlich in `VpsDockerControl` (R01/ADR-012); SSH-Private-Key + Cloudflare-Token nie in Response/Log/Audit/WS/Argv/URL/Bundle; mutierende Aktionen audit-first + `CRED_ADMIN_EMAILS`-geschützt; managed-Remove mit LockoutGuard-Hard-Block + type-to-confirm.
- **Robustheit:** Listing/Logs degradieren je VPS statt Voll-Fehler; eine fehlgeschlagene Aktion crasht die Ansicht nicht.
- **A11y (WCAG 2.1 AA):** Container-Button + Aktions-Buttons beschriftet (aria-label), managed/unmanaged für Screenreader erkennbar, type-to-confirm-Feld beschriftet mit programmatisch zugeordnetem Fehler, Lade-/Erfolg-/Fehlerzustände als role=status/alert, Touch-Targets ≥ 44 px, sichtbarer Fokus. **v2:** der Zustand „gestoppt"/„läuft" ist **nicht allein über Farbe/Dimmen** kodiert (Textbadge + für Screenreader erkennbar); disabled-Aktionen tragen eine lesbare Begründung.
- **Kein stiller Verlust (v2, hart):** kein Zustand der Übersicht darf einen existierenden Container **unsichtbar** machen — insbesondere führt „Stop" **nie** zum Verschwinden der Zeile. Sichtbarkeit ist die Voraussetzung dafür, dass der vorhandene Start-Endpunkt überhaupt erreichbar bleibt.

## Nicht-Ziele (bewusst ausgeschlossen)
- **Deploy (Container+Route neu anlegen)** → [[deploy-lifecycle]] / die `deployments`-View; diese Übersicht steuert + entfernt **bestehende** Container.
- **Update-Orchestrierung** (pull + recreate, Run-Config-Erhalt, Fail-closed-Regeln) → [[container-image-update]]; hier lebt nur der Knopf (AC15).
- **Versionswechsel/Tag-Auswahl beim Update** — der Update-Knopf zieht **denselben** Tag neu ([[container-image-update]]); gezieltes Hoch-/Zurückstufen auf einen anderen Tag bleibt der Deployments-Ansicht vorbehalten ([[deploy-lifecycle]] AC10–AC12).
- **Aufräumen gestoppter Altcontainer (Zombies)** → [[deploy-lifecycle]] AC17 (Re-Deploy-Ersetzungsschritt); diese Übersicht macht sie nur **sichtbar** und manuell entfernbar.
- **Compose-Stack-Steuerung** (mehrere Container als Stack) → [[vps-compose-control]] / [[compose-stack-deployment]].
- **Server-Lifecycle** (Maschine start/stop/create) → [[vps-provider-boundary]].
- **Reconciliation-Cron-Logik** → [[cloudflare-reconciliation]].
- **Voll-Portainer-Ersatz** (Volumes/Netzwerke/Images-Verwaltung, exec-Shell, Stats-Graphen) — bewusst nicht; nur die genannten Container-Aktionen.

## Abhängigkeiten
- [[view-vps]] (VPS-Ansicht + Zeilen-Gerüst, in das der „Container"-Button + die Übersicht integriert werden).
- [[deploy-lifecycle]] (`DeployOrchestrator.undeploy` für managed-Remove; `VpsDockerControl` als Docker-Boundary; Zombie-Abräumen AC17).
- [[container-image-update]] (Verhalten + Endpunkt des Update-Knopfs, AC15).
- [[vps-provider-boundary]] (Provider/serverId-Auflösung, `*splat`-Routing, `CRED_ADMIN_EMAILS`-Authz, Audit-First).
- [[view-cloudflare]] / [[cloudflare-reconciliation]] (Container↔Route-Bindung über `cloudflare.tunnel-hostname`-Label; Cloudflare-Route-Remove via `CloudflareApi`, ADR-010/011).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität + Self-Lockout-Floor).
- `docs/architecture.md` — **`VpsDockerControl`/`DeployOrchestrator` in ADR-012** (einziger schreibender Docker-Pfad via SSH), **`CloudflareApi` in ADR-010**, **`LockoutGuard` in ADR-011**.
