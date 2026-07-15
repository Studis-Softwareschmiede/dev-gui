---
id: container-image-update
title: Image-Update je Container — neues Image ziehen + Container neu aufbauen (nie nur neu starten)
status: draft
area: deployment
version: 1
---

# Spec: Image-Update je Container (`container-image-update`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (Docker-Mutation auf dem VPS + Übernahme bestehender Container-Env, die Secrets enthalten kann).
> Boundaries fixiert in **ADR-012** (`VpsDockerControl` + `DeployOrchestrator`), Self-Lockout-Schutz in **ADR-011**. Konsumiert die Deploy-Saga aus [[deploy-lifecycle]] (AC3/AC4/AC14/AC17) — **keine** zweite Deploy-Implementierung.

## Zweck
Der Betreiber kann einen **managed** Container direkt aus der VPS-Container-Übersicht ([[vps-container-overview]] AC15) per **„Update"** auf den aktuellen Stand seines Images bringen: dev-gui **zieht das Image neu** (`docker pull`, **derselbe** Image-Ref inkl. Tag) und **baut den Container neu auf** (rm + run) — unter **Erhalt seiner Run-Konfiguration** (Env, Verzeichnis-Mount, Label). Bisher war ein Rollout nur über die Deployments-Ansicht möglich; die Container-Übersicht bot lediglich Start/Stop/Neustart/Logs/Entfernen.

> **Kernregel: `docker restart` aktiviert KEIN neues Image.** Ein Neustart startet **denselben** Container aus **derselben** Image-Schicht — ein frisch gepushtes Image wird dadurch **nie** aktiv. Nur `pull` + **recreate** (rm + run) zieht den neuen Stand. Der Update-Pfad darf deshalb **niemals** auf `docker restart` zurückfallen, auch nicht als Fehler-Fallback. *(Bekannte Falle — `knowledge/cicd.md`.)*

> **Abgrenzung:** Diese Spec liefert **Verhalten + Endpunkt** des Updates. Der **Knopf** (Sichtbarkeit/Aktivierung/Ergebnis-Anzeige) lebt in [[vps-container-overview]] (AC15). Die **Deploy-Saga** (pull → replace → run → Route) lebt in [[deploy-lifecycle]] und wird **wiederverwendet**, nicht dupliziert. **Versionswechsel** (anderer Tag) bleibt der Deployments-Ansicht vorbehalten ([[deploy-lifecycle]] AC10–AC12).

## Verhalten

### Auslösen & Ablauf
1. Das Update gilt **nur für managed** Container (`cloudflare.tunnel-hostname`-Label gesetzt). Für **unmanaged** Container gibt es **kein** Update (kein Hostname → keine Route → der Deploy-Pfad ist nicht anwendbar) → 422 `not-managed`, kein Schritt.
2. Ablauf von `POST …/containers/:containerId/update`:
   - (a) **Access + Rolle** (`CRED_ADMIN_EMAILS`) + **Audit-First** (Audit-Eintrag **vor** jeder Mutation; schlägt der Audit-Write fehl → Aktion unterbleibt).
   - (b) **Container-Read** (`psAll`, `docker ps -a`) → Container existiert? managed? Hostname aus dem Label. Gestoppte Container sind hier **eingeschlossen** ([[vps-container-overview]] AC9b).
   - (c) **Run-Config lesen** (`VpsDockerControl.inspectContainer`) → aktueller Image-Ref inkl. Tag, Env, Binds, Labels.
   - (d) **tunnelId auflösen** (server-seitig aus der VPS-Registrierung — derselbe Weg wie beim managed-Remove); der Client übergibt **keine** tunnelId.
   - (e) **LockoutGuard** auf den Hostname (protected → 422 `protected-resource`, **kein** Schritt).
   - (f) **Deploy-Saga** ([[deploy-lifecycle]]) mit **demselben** Image-Ref + der rekonstruierten Run-Config → `pull` → Altcontainer entfernen (AC14/AC17) → `run` → Route/DNS aktualisieren.
3. **Derselbe Tag:** das Update nutzt **exakt** den Image-Ref des bestehenden Containers (inkl. Tag/Digest-Referenz, wie er am Container steht). Es gibt **keine** Tag-Auswahl an diesem Knopf.
4. **Run-Config bleibt erhalten:** der neu aufgebaute Container übernimmt **Env**, **Verzeichnis-Mount** und **Hostname-Label** des Vorgängers. Der Update-Pfad rekonstruiert sie aus dem **bestehenden Container** (`inspectContainer`) — es gibt **keinen** Deploy-State-Store (ADR-005): **der laufende/gestoppte Container ist die einzige Quelle** seiner eigenen Run-Config.
5. **Fail-closed:** lässt sich die Run-Config **nicht vollständig und eindeutig** rekonstruieren, wird **abgebrochen** — **kein** `rm`, **kein** `run`, der bestehende Container bleibt **unangetastet**. Ein degradierter Neuaufbau (Container läuft, aber ohne seine Env/Mounts) ist **schlimmer** als kein Update und ausdrücklich untersagt.
6. **Gestoppter Container:** ein Update ist auch auf einen **gestoppten** Container zulässig; da die Deploy-Saga den Container **startet**, **läuft** er danach. Die UI weist **vor** dem Auslösen darauf hin ([[vps-container-overview]] AC15). Das Update ist damit **nie** zustands-neutral — es gibt keinen „Update, aber gestoppt lassen"-Pfad.
7. **Unbeweglicher Tag:** zeigt der Tag auf einen unveränderten Stand (z.B. feste Version), ist das Update ein **Neuaufbau ohne Versionswechsel** — **kein Fehler**, sondern erwartetes Ergebnis (nur bei beweglichen Tags wie `:latest` ändert sich der Stand).
8. **Secrets:** die inspizierte Env kann Secrets enthalten (z.B. `GPG_PASSPHRASE`, [[deploy-bitwarden-gpg-injection]]). Sie wird **rein server-intern und transient** verarbeitet und **ausschließlich** an den Container-Start durchgereicht — **nie** in Response, Log, Audit, `ReconcileNotice`, WS-Stream oder Frontend.

## Acceptance-Kriterien

### Update-Pfad
- **AC1** — `POST /api/vps/machines/:provider/*splat/containers/:containerId/update` bringt einen **managed** Container auf den aktuellen Image-Stand: `docker pull` des **unveränderten** Image-Refs des Containers, danach **recreate** über die Deploy-Saga ([[deploy-lifecycle]] AC3/AC14/AC17) → `{ result:'ok', deployment }`. (Testbar mit gemocktem Boundary: `pull` **und** `run` aufgerufen, Image-Ref identisch zum Bestands-Container.)
- **AC2** — **Nie Neustart:** der Update-Pfad ruft **zu keinem Zeitpunkt** `docker restart`/`VpsDockerControl.restart` — auch nicht als Fallback bei Fehlern (ein Neustart aktiviert kein neues Image). (Testbar: `restart`-Mock wird nie aufgerufen; **Grep-prüfbar**: keine `restart`-Referenz im Update-Pfad.)
- **AC3** — **Nur managed:** ein Container **ohne** `cloudflare.tunnel-hostname`-Label → 422 `not-managed`, **kein** `pull`, **kein** `rm`, **kein** `run`. (Testbar: unmanaged Container → keine Docker-Mutation.)
- **AC4** — **Derselbe Tag:** das Update verwendet **exakt** den Image-Ref des bestehenden Containers; ein abweichender Image-/Tag-Wunsch wird an diesem Endpunkt **nicht** entgegengenommen (ein mitgesendeter Image-/Tag-Parameter wird **ignoriert oder mit 422 abgelehnt** — er darf **nie** den Ziel-Ref bestimmen; Versionswechsel läuft über die Deployments-Ansicht). (Testbar: Client sendet fremdes Image → der Deploy wird mit dem **Bestands**-Ref oder gar nicht ausgeführt.)

### Run-Config-Erhalt (Datenerhalt)
- **AC5** — `VpsDockerControl.inspectContainer(vps, containerId, opts?)` liefert die Run-Config eines **bestehenden Containers** (laufend oder gestoppt): `{ image, env, binds, labels }` via `docker inspect` über SSH, mit Container-ID-Validierung + Shell-Escaping wie `rm`, geheimnisfrei klassifizierten Fehlern. Sie ist **von der bestehenden `inspect(vps, image)`-Methode getrennt** (die ein **Image** auf `ExposedPorts` prüft) und ersetzt sie **nicht**. (Testbar: Methode existiert, validiert die ID, parst Env/Binds/Labels, klassifiziert Fehler ohne Leak.)
- **AC6** — Der neu aufgebaute Container trägt **dieselbe Env**, **denselben Verzeichnis-Mount** und **dasselbe `cloudflare.tunnel-hostname`-Label** wie sein Vorgänger. (Testbar: Bestands-Container mit Env `{GPG_PASSPHRASE:…}` + config-Mount → der `run`-Aufruf der Saga erhält dieselbe Env und denselben Mount; das Hostname-Label ist identisch.)
- **AC7** — **Fail-closed:** schlägt einer der Vor-Schritte fehl — `inspectContainer`-Fehler, fehlendes Hostname-Label, **nicht auflösbare `tunnelId`**, oder eine Run-Config, die **nicht eindeutig** auf die von der Saga unterstützten Parameter abbildbar ist (z.B. unbekannte/zusätzliche Binds) — dann bricht das Update **vor jeder Mutation** ab: `{ result:'error', errorClass }` (422/502), **kein** `pull`, **kein** `rm`, **kein** `run`; der bestehende Container bleibt **unverändert** (läuft weiter bzw. bleibt gestoppt). (Testbar je Fehlerursache: keine Docker-Mutation, Container-Zustand unberührt.)

### Zustand & Ergebnis
- **AC8** — Ein Update auf einen **gestoppten** Container ist zulässig und führt dazu, dass der Container danach **läuft** (die Saga startet ihn). (Testbar: Bestands-Container `state:'exited'` → nach Erfolg `run` aufgerufen; das Ergebnis weist den laufenden Container aus.)
- **AC9** — Zeigt der Tag auf einen unveränderten Stand, ist das Ergebnis dennoch `{ result:'ok' }` (Neuaufbau ohne Versionswechsel) — **kein** Fehlerpfad. (Testbar: `pull` meldet „up to date" → Update läuft regulär durch.)

### Sicherheit & Audit (Floor, hart)
- **AC10** — Der Endpunkt liegt hinter **AccessGuard**, ist **identitäts-/rollengeschützt** (`CRED_ADMIN_EMAILS`; 403 ohne Berechtigung) und **audit-first**: der Audit-Eintrag (Identität, provider, serverId, containerId, hostname, Aktion `update`, Zeit) wird **vor** der Mutation geschrieben; schlägt der Audit-Write fehl → **keine** Mutation. (Testbar: ohne Berechtigung 403 + keine Mutation; Audit-Write-Fehler → keine Mutation.)
- **AC11** — **LockoutGuard:** ein Update auf einen **protected** Hostname (eigene devgui / Access-Mauer, ADR-011) → 422 `protected-resource`, **kein** Docker- und **kein** Cloudflare-Schritt; nicht via Identität überschreibbar. (Testbar: protected → 422, keine Mutation.)
- **AC12** — **Kein Leak:** die aus `inspectContainer` gelesenen **Env-Werte** (potenziell Secrets), der SSH-Private-Key und das Cloudflare-Token erscheinen **niemals** in Response, Logs, Audit, WS-Stream, URL oder Frontend-Bundle. Der Audit-Eintrag nennt **nur** containerId/hostname/Aktion — **nie** Env-Inhalte. Fehlertexte sind geheimnisfrei klassifiziert. (Testbar: Response/Log/Audit enthalten keinen Env-Wert/Key/Token.)

## Verträge
> Pfade/Felder kanonisch; Boundary-Detail in **ADR-012** (`VpsDockerControl`, `DeployOrchestrator`), **ADR-011** (`LockoutGuard`). ServerId-Routing per `*splat` analog [[vps-container-overview]].

- **POST `/api/vps/machines/:provider/*splat/containers/:containerId/update`** — Body: **leer** (kein Image/Tag/tunnelId vom Client — alles server-seitig aus dem Bestands-Container bzw. der Registrierung aufgelöst) → `{ result: 'ok', deployment } | { result: 'error', errorClass, reason }`. [MUTATION — Rollenschutz + Audit-First + LockoutGuard]
- **`errorClass` (geheimnisfrei):** `not-managed` (kein Hostname-Label) · `update-unsafe` (Run-Config nicht eindeutig rekonstruierbar, AC7) · `tunnel-not-found` (tunnelId nicht auflösbar) · `protected-resource` (LockoutGuard) · `container-not-found` · `docker-failed` · `no-private-key` · `unreachable` · `auth-failed` · `host-key-mismatch` · `error`.
- **`VpsDockerControl.inspectContainer(vps, containerId, opts?)`** (neu, ADR-012) → `{ result:'ok', config: { image: string, env: Record<string,string>, binds: string[], labels: Record<string,string> } } | { result:'error', errorClass, reason }`. Liest einen **Container** (`docker inspect <containerId>`) — **getrennt** von der bestehenden `inspect(vps, image)` (Image-`ExposedPorts`, [[deploy-lifecycle]] AC13). Container-ID-Validierung + Shell-Escaping wie `rm`. Der zurückgegebene `config.env` ist **server-intern** und darf **nie** über eine HTTP-Response verlassen.
- **Deploy-Wiederverwendung:** der Update-Pfad ruft den **bestehenden** `DeployOrchestrator.deploy({ image, vps, hostname, tunnelId, vpsId, containerEnv, requiresConfig?, configApp?, configMountPath? })` — **kein** eigener `pull`/`run`/Route-Code neben der Saga (Grep-prüfbar, analog [[cloudflare-reconciliation]] AC5). `image` = Bestands-Ref (AC4), `hostname` = Label des Bestands-Containers, `containerEnv`/Mount-Parameter = rekonstruierte Run-Config (AC6).
- **`tunnelId`-Auflösung:** server-seitig über die VPS-Registrierung (derselbe Weg wie der managed-Remove in [[vps-container-overview]] AC11). Kein Treffer → `tunnel-not-found`, **kein** Schritt (AC7) — **kein** Fallback auf einen Deploy ohne Route.
- **Container-Read:** `psAll` (`docker ps -a`, inkl. `state`) — geteiltes Read-Model aus [[vps-container-overview]] (AC9b).
- Alle Endpunkte hinter AccessGuard; mutierend → `CRED_ADMIN_EMAILS` + AuditEntry (Audit-First) + LockoutGuard (ADR-011).

## Edge-Cases & Fehlerverhalten
- **Unmanaged Container** (kein Hostname-Label) → 422 `not-managed`, keine Mutation (AC3).
- **`inspectContainer` schlägt fehl** / Container zwischenzeitlich weg → `container-not-found`/`docker-failed`, keine Mutation (AC7); Re-Fetch zeigt den aktuellen Bestand.
- **tunnelId nicht auflösbar** → `tunnel-not-found`, **kein** Schritt (AC7). Bewusst **kein** Deploy ohne Route: das Ergebnis wäre ein laufender, aber unerreichbarer Container.
- **Run-Config nicht eindeutig abbildbar** (z.B. Binds außerhalb des bekannten Verzeichnis-Mount-Musters, [[deploy-config-volume-mount]]) → `update-unsafe`, **kein** Schritt; die Meldung verweist auf die Deployments-Ansicht als vollständigen Weg. Lieber **kein** Update als ein Container ohne seine Mounts.
- **protected Hostname** → 422 `protected-resource`, kein Schritt (AC11).
- **Pull schlägt fehl** (ghcr `denied`/Tag weg) → Fehler **vor** dem `rm` des Altcontainers; der bestehende Container bleibt **unangetastet** (die Saga entfernt den Altcontainer erst **nach** erfolgreichem Pull — [[deploy-lifecycle]] AC14/AC17-Reihenfolge).
- **Route-Schritt schlägt nach dem Container-Start fehl** → Saga-Rollback gemäß [[deploy-lifecycle]] AC4 (kein verwaister Container ohne Route).
- **Update auf gestoppten Container** → Container läuft danach (AC8) — erwartetes, in der UI angesagtes Verhalten.
- **Tag unverändert** → `ok`, Neuaufbau ohne Versionswechsel (AC9), kein Fehler.
- **Zwei Updates gleichzeitig auf denselben Container** → der zweite trifft auf einen bereits entfernten Altcontainer; er endet geheimnisfrei in `container-not-found`/`docker-failed`, **ohne** den neuen Container zu beschädigen.

## NFRs
- **Sicherheit (Floor, hart):** schreibende Docker-Kommandos ausschließlich in `VpsDockerControl` (R01/ADR-012); Update audit-first + `CRED_ADMIN_EMAILS` + LockoutGuard-Hard-Block. **Env-Übernahme:** inspizierte Env-Werte sind wie Secrets zu behandeln — server-intern, transient, nie in Response/Log/Audit/WS/Frontend (AC12). Kein neues Secret im Frontend-Bundle, **kein** Client-übergebenes Image/Tag/tunnelId.
- **Datenerhalt (hart):** ein Update darf **nie** Env oder Mounts eines Containers stillschweigend verlieren — im Zweifel fail-closed abbrechen (AC7), statt degradiert neu aufzubauen.
- **Korrektheit (hart):** **kein** `docker restart` im Update-Pfad (AC2) — sonst behauptet die GUI ein Update, das faktisch keines ist.
- **Robustheit:** Fehler degradieren je Container, ohne die Übersicht zu zerstören ([[vps-container-overview]] AC15); der bestehende Container bleibt bei jedem Vor-Schritt-Fehler unberührt.

## Nicht-Ziele (bewusst ausgeschlossen)
- **Versionswechsel / Tag-Auswahl** (Hoch-/Zurückstufen auf einen anderen Tag) → Deployments-Ansicht ([[deploy-lifecycle]] AC10–AC12). Dieser Knopf zieht **denselben** Tag neu.
- **Update unmanaged Container** (ohne Hostname-Label) — der Deploy-Pfad ist ohne Route/Hostname nicht anwendbar.
- **„Update, aber gestoppt lassen"** — die Saga startet den Container; ein zustands-erhaltender Update-Pfad ist bewusst nicht spezifiziert.
- **Automatisches/geplantes Update** (Watchtower-Stil, Cron-Rollout) — ausschließlich manuell durch den Betreiber ausgelöst.
- **Massen-Update** („alle Container dieses VPS aktualisieren") — je Container ein bewusster Klick.
- **Rollback auf die Vorgänger-Version** — der Altcontainer wird ersetzt; ein Zurück läuft über die Deployments-Ansicht mit dem alten Tag.
- **Der Knopf selbst** (Sichtbarkeit/Aktivierung/Anzeige) → [[vps-container-overview]] AC15.

## Abhängigkeiten
- [[vps-container-overview]] (Update-Knopf AC15; geteiltes `psAll`-Read-Model inkl. `state` AC9b; `*splat`-Routing + Authz/Audit-Muster).
- [[deploy-lifecycle]] (wiederverwendete Deploy-Saga AC3/AC4/AC14/AC17; `DeployOrchestrator`/`VpsDockerControl` ADR-012).
- [[deploy-config-volume-mount]] (bekanntes Verzeichnis-Mount-Muster, gegen das die Binds abgebildet werden — AC7).
- [[deploy-bitwarden-gpg-injection]] (Env-Secrets wie `GPG_PASSPHRASE`, die beim Neuaufbau erhalten bleiben müssen — AC6/AC12).
- [[cloudflare-reconciliation]] (gestoppte managed Container behalten ihre Route, AC3b — Voraussetzung dafür, dass ein Update auf einen gestoppten Container überhaupt sinnvoll ist).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität + Self-Lockout-Floor, ADR-011).
- `docs/architecture.md` — **`VpsDockerControl`/`DeployOrchestrator` in ADR-012**, **`LockoutGuard` in ADR-011**.
