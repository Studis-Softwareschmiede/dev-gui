---
id: vps-readiness-gate
title: VPS-Bereitschafts-Gate vor dem Deploy (Readiness-Probe + Deploy-Gate + Status-Badge)
status: draft
version: 1
---

# Spec: VPS-Bereitschafts-Gate vor dem Deploy (`vps-readiness-gate`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-relevant (SSH-on-VPS via `VpsDockerControl`, kein Secret in Argv/Log/Audit/Response).
> Folge-Story zu **F-013** ([[deploy-lifecycle]], Done). Boundary fixiert in **ADR-012** (`VpsDockerControl` = einziger schreibender/SSH-Docker-on-VPS-Pfad; die Readiness-Probe gehört dorthin, da sie SSH+Docker bündelt). cloud-init-Setup-Reihenfolge in [[vps-cloud-init-setup]] (ADR-009).

## Zweck
Beim Neuanlegen eines VPS läuft cloud-init mehrere Minuten (Ubuntu-Update → Docker installieren → Docker starten → cloudflared-Container starten). SSH ist meist schon erreichbar, **bevor** Docker läuft. Drückt der Nutzer in diesem Fenster „Deploy starten", scheitert der erste Schritt (`docker pull`) mit der generischen, verwirrenden Meldung „docker-Kommando auf VPS fehlgeschlagen". Diese Capability führt ein **Bereitschafts-Gate** ein: eine günstige SSH-Readiness-Probe unterscheidet drei Zustände (`unreachable` / `provisioning` / `ready`); der Deploy wird **vor** dem Pull geprüft und bei Nicht-Bereitschaft mit einer freundlichen, eigenen Fehlerklasse (`vps-provisioning`) abgelehnt; das Frontend zeigt ein Status-Badge und sperrt „Deploy starten", bis der Server `ready` ist.

> **Abgrenzung:** Diese Spec ergänzt das Deploy-Verhalten aus [[deploy-lifecycle]] um eine **Vorab-Prüfung** — die Deploy-/Undeploy-Saga (AC3–AC9 dort) bleibt unverändert. Sie ändert **nicht** die cloud-init-Reihenfolge ([[vps-cloud-init-setup]]) und führt **keinen** neuen Server-Lifecycle ein ([[vps-provider-boundary]]).

## Verhalten
1. **Readiness-Probe als Boundary-Operation.** Die `VpsDockerControl`-Boundary (ADR-012, einziger SSH+Docker-on-VPS-Pfad) bekommt eine neue **read-only**-Operation `probe(vps)`, die in **einer** SSH-Session den Bereitschaftszustand des VPS ermittelt und genau einen von drei Zuständen zurückgibt:
   - **`unreachable`** — SSH ist noch nicht erreichbar (Connect-Fehler / Connect-Timeout / Auth noch nicht möglich). Der VPS ist gerade erst gebootet.
   - **`provisioning`** — SSH ist erreichbar, aber cloud-init/Docker/cloudflared ist **noch nicht** vollständig: mindestens eine der drei Bedingungen (cloud-init fertig, Docker läuft, cloudflared-Container läuft) ist `false`.
   - **`ready`** — cloud-init fertig **UND** Docker läuft **UND** ein cloudflared-Container läuft (Status `running`).
2. **Probe-Befehl (kein scary error, kein Secret in Argv/Log).** Die Probe führt **eine** Shell-Zeile aus, die selbst zwischen „fertig" und „nicht fertig" unterscheidet und ein eindeutiges Token (`READY` / `NOTREADY`) auf stdout schreibt — `docker info`-Fehler werden nach `/dev/null` umgeleitet, damit der Exit-Code der Session 0 bleibt und kein verwirrender Docker-Fehler entsteht. Kanonischer Befehl:
   ```sh
   test -f /var/lib/cloud/instance/boot-finished && docker info >/dev/null 2>&1 && docker ps --filter name=cloudflared --filter status=running -q | grep -q . && echo READY || echo NOTREADY
   ```
   - stdout `READY` → `ready`; stdout `NOTREADY` → `provisioning`.
   - SSH gar nicht erreichbar / Auth fehlt / Connect-Timeout → `unreachable` (nicht `provisioning`, nicht Fehler).
   - Der SSH-Private-Key wird store-intern aus dem `CredentialStore` gezogen (ADR-007/008), exakt wie die übrigen `VpsDockerControl`-Operationen; er erscheint **nie** in Argv, Log, Audit, Response oder WS-Stream.
3. **Deploy-Gate.** `DeployOrchestrator.deploy()` führt **vor** dem `docker pull`-Schritt die Probe aus. Ist der Zustand **nicht** `ready` (`unreachable` oder `provisioning`), wird der Deploy **abgebrochen, bevor** irgendein Docker- oder Cloudflare-Schritt läuft — mit der **neuen Fehlerklasse `vps-provisioning`** und einer freundlichen Meldung statt „docker-Kommando fehlgeschlagen". Kein Container wird gestartet, keine Route angelegt.
4. **Readiness-Endpunkt (Frontend-Quelle).** Das Backend stellt einen read-only-Endpunkt bereit, der für einen konfigurierten/aufgelösten VPS den Probe-Zustand liefert (`{ state: "unreachable"|"provisioning"|"ready" }`), damit das Frontend pollen kann.
5. **Frontend-Status-Badge + Gate.** Die Deployment-Ansicht zeigt neben dem VPS-Feld ein Status-Badge, das den Readiness-Endpunkt **alle paar Sekunden** pollt:
   - `unreachable` → „⏳ VPS wird hochgefahren…"
   - `provisioning` → „⏳ VPS wird eingerichtet (Docker installieren)…"
   - `ready` → „✅ VPS bereit"
   „Deploy starten" ist **gesperrt**, solange der gewählte VPS nicht `ready` ist, und wird **automatisch freigegeben**, sobald `ready` erreicht ist.
6. **errorClass-Mapping im Frontend.** Die Fehlerklassen `docker-failed` und `vps-provisioning` aus einer Deploy-Antwort werden auf einen **freundlichen Retry-Hinweis** abgebildet (z.B. „VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen") statt der rohen Klasse.

## Acceptance-Kriterien

### Readiness-Probe (Boundary)
- **AC1** — `VpsDockerControl` exponiert eine **read-only**-Operation `probe(vps, opts?)`, die genau einen der drei Zustände `unreachable | provisioning | ready` zurückgibt (Schema: `{ state, reason? }`). Die Probe ist der **einzige** neue SSH-on-VPS-Pfad; kein anderes Modul baut eine eigene SSH-Verbindung für die Bereitschaft auf (Grep-prüfbar, analog AC1 [[deploy-lifecycle]]).
- **AC2** — Die Probe führt **genau eine** SSH-Session/-Kommandozeile aus (kanonischer Befehl, siehe Verhalten §2). stdout `READY` → `ready`; stdout `NOTREADY` → `provisioning`; SSH nicht erreichbar / Auth-Fehler / Connect-Timeout → `unreachable`. Ein Docker-`info`-Fehler erzeugt **keinen** harten Fehler und **keinen** `DOCKER_FAILED` (er wird nach `/dev/null` verworfen) → der Zustand ist `provisioning`, nicht ein Fehler.
- **AC3** — `ready` wird **nur** dann gemeldet, wenn cloud-init fertig (`/var/lib/cloud/instance/boot-finished` existiert) **UND** Docker läuft (`docker info` exit 0) **UND** mindestens ein cloudflared-Container mit Status `running` existiert. Fehlt **eine** Bedingung → `provisioning`.

### Deploy-Gate
- **AC4** — `DeployOrchestrator.deploy()` ruft die Probe **vor** dem `docker pull`-Schritt auf. Ist der Zustand **nicht** `ready`, wird **kein** `docker pull`/`run` und **kein** Cloudflare-Route-/DNS-Schritt ausgeführt; der Deploy endet mit `{ result: "error", errorClass: "vps-provisioning", reason: <freundliche Meldung> }` (testbar: Orchestrator-Test mit `probe`→`provisioning`/`unreachable` ruft `pull` **nie** auf).
- **AC5** — Bei Probe-Zustand `ready` läuft die bestehende Deploy-Saga **unverändert** weiter (AC3–AC9 [[deploy-lifecycle]] bleiben erfüllt) — das Gate ist im `ready`-Fall ein No-op-Vorschritt.
- **AC6** — Die freundliche Meldung bei `vps-provisioning` weist auf erneutes Versuchen hin (sinngemäß „VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen") und enthält **keinen** rohen Docker-/SSH-Fehlertext, keinen Host, keinen Key, kein Token.

### Readiness-Endpunkt
- **AC7** — Es existiert ein read-only-Endpunkt **`GET /api/deployments/readiness?vps=<vpsId>`**, der die Probe für den über die vereinigte VPS-Auflösung (Env-Map ⊕ dynamische Records, [[vps-dynamic-ssh-targets]]) aufgelösten VPS ausführt und `{ state: "unreachable"|"provisioning"|"ready" }` zurückgibt. Unbekannte `vpsId` → 422 (`Unbekannter VPS: <id>`), analog dem Deploy-Pfad. Der Endpunkt liegt hinter dem AccessGuard (403 ohne gültigen Access).
- **AC8** — Der Readiness-Endpunkt ist **nicht-mutierend**: er erzeugt **keinen** Container, keine Route, keinen Audit-Eintrag (read-only, kein Audit-First nötig) und keine Zustandsänderung am VPS. Die Antwort enthält **keinen** Host, Key, Token oder rohen SSH-Fehlertext (nur `state` + optional eine neutrale, secret-freie `reason`).

### Frontend-Badge & Gate
- **AC9** — Die Deployment-Ansicht (`client/src/DeploymentsView.jsx`) zeigt neben dem VPS-Auswahlfeld ein Status-Badge, das `GET /api/deployments/readiness?vps=<gewählter VPS>` **periodisch** (Standard-Intervall, siehe NFR) pollt und je Zustand rendert: `unreachable` → „⏳ VPS wird hochgefahren…", `provisioning` → „⏳ VPS wird eingerichtet (Docker installieren)…", `ready` → „✅ VPS bereit". Ohne gewählten VPS wird kein Badge/kein Poll gezeigt.
- **AC10** — „Deploy starten" ist **deaktiviert**, solange der gewählte VPS nicht `ready` ist (zusätzlich zu den bestehenden AC12-Bedingungen aus [[deploy-lifecycle]]: Image+Tag+VPS+Domäne+Subdomain). Erreicht das Polling `ready`, wird der Button **automatisch** freigegeben (ohne erneuten Nutzer-Klick), sofern die übrigen Bedingungen erfüllt sind.
- **AC11** — Das Polling stoppt, sobald `ready` erreicht ist (kein Dauer-Poll auf einem bereiten VPS) und läuft erneut an, wenn der Nutzer einen anderen (noch nicht bereiten) VPS wählt. Beim Verlassen der Ansicht / Wechsel der VPS-Auswahl wird der laufende Timer aufgeräumt (kein Leak, kein Poll auf abgewähltem VPS).
- **AC12** — Eine Deploy-Antwort mit `errorClass: "vps-provisioning"` **oder** `errorClass: "docker-failed"` wird im Frontend auf denselben **freundlichen Retry-Hinweis** abgebildet (statt der rohen Klasse); andere Fehlerklassen behalten ihre bestehende Anzeige.

### Sicherheit (Floor)
- **AC13** — In **keinem** Pfad dieser Capability (Probe, Endpunkt, Deploy-Gate, Frontend) erscheint der SSH-Private-Key oder ein Token in Argv, Log, Audit, HTTP-Response, WS-Stream oder Frontend-Bundle. Der Private-Key wird store-intern aus dem `CredentialStore` gezogen (ADR-007/008), exakt wie die übrigen `VpsDockerControl`-Operationen (testbar: Argv/Response/Audit enthalten den Key-/Token-Klartext nicht).

## Verträge
> Boundary-Detail: `VpsDockerControl` (ADR-012), SSH-Linie (ADR-008), vereinigte VPS-Auflösung ([[vps-dynamic-ssh-targets]]).

- **`VpsDockerControl.probe(vps, opts?)`** → `Promise<{ state: "unreachable"|"provisioning"|"ready", reason?: string }>`.
  - `vps`: Ziel-Schema `{ host, port?, targetUser }` (analog ADR-008), Private-Key store-intern.
  - `opts`: `{ hostFingerprint?, _sshClientFactory? }` (testbar, konsistent mit `inspect`/`pull`/`ps`).
  - SSH-Befehl: kanonische Zeile (siehe Verhalten §2). Connect-/Exec-Timeout = derselbe `CONNECT_TIMEOUT_MS`/`EXEC_TIMEOUT_MS` wie die übrigen `VpsDockerControl`-Operationen (keine zweite Timeout-Quelle). Timeout/Connect-Fehler/Auth-Fehler → `state: "unreachable"`.
- **`GET /api/deployments/readiness?vps=<vpsId>`** → `200 { state: "unreachable"|"provisioning"|"ready" }`; `422 { error: "Unbekannter VPS: <id>" }`; `403` (kein Access). Query-Parameter `vps` Pflicht (fehlt → 400). Read-only, kein Audit, keine Mutation.
- **Deploy-Antwort-Erweiterung:** `POST /api/deployments` kann bei nicht-bereitem VPS zusätzlich `{ result: "error", errorClass: "vps-provisioning", reason }` liefern (neue Fehlerklasse, additiv zu den bestehenden aus [[deploy-lifecycle]]).
- **Fehlerklassen-Vokabular (additiv):** `vps-provisioning` (neu, vom Deploy-Gate). Bestehende Klassen (`docker-failed`, `unreachable`, `auth-failed`, `host-key-mismatch`, `protected-resource`, `zone-not-found` …) bleiben unverändert.

## Edge-Cases & Fehlerverhalten
- VPS gerade gebootet, SSH noch nicht offen → Probe `unreachable` (kein Fehler, kein Crash); Badge „VPS wird hochgefahren…", Deploy gesperrt.
- SSH offen, Docker noch nicht installiert/gestartet (cloud-init mittendrin) → `docker info` exit ≠ 0, aber nach `/dev/null` verworfen → Probe `provisioning` (kein `DOCKER_FAILED`); Badge „VPS wird eingerichtet…", Deploy gesperrt.
- Docker läuft, cloudflared-Container noch nicht hoch → `docker ps --filter name=cloudflared --filter status=running` leer → Probe `provisioning`.
- Alles bereit → Probe `ready`; Badge „VPS bereit"; Deploy-Button freigegeben (sofern übrige Bedingungen erfüllt); Polling stoppt.
- Race: Nutzer klickt Deploy genau im Übergang `provisioning`→`ready` (Frontend noch gesperrt, Backend bereits ready) → Deploy-Gate (AC4/AC5) lässt durch (Backend ist die maßgebliche Prüfung; das Frontend-Gate ist nur UX-Komfort).
- Race umgekehrt: Frontend zeigt `ready` (gecacht), VPS fällt unmittelbar vorher zurück → Deploy-Gate fängt es serverseitig mit `vps-provisioning` ab (kein Teil-Deploy).
- Unbekannte `vpsId` am Readiness-Endpunkt → 422 (analog Deploy), kein Probe-Versuch.
- Probe-SSH-Befehl liefert unerwartetes stdout (weder `READY` noch `NOTREADY`) → konservativ `provisioning` (nie fälschlich `ready`).

## NFRs
- **Sicherheit (Floor, hart):** kein SSH-Private-Key/Token in Argv/Log/Audit/Response/WS/Frontend-Bundle (AC13). Readiness-Endpunkt hinter Access (403 ohne gültigen Access). Probe ist read-only (keine Mutation am VPS, kein Audit-Eintrag).
- **Kosten/Last:** Probe = **eine** günstige SSH-Session pro Aufruf (kein Polling-Sturm). Frontend-Poll-Intervall **Standard ~3 s** (token-frei, reine HTTP-Polls); Polling stoppt bei `ready` (AC11) und beim Abwählen/Verlassen (kein Leak).
- **Robustheit:** Probe wirft **nie** (jeder SSH-/Docker-Fehler wird auf einen der drei Zustände abgebildet); ein `provisioning`/`unreachable` ist nie ein 5xx, sondern ein normaler Zustand.
- **ADR-005/012-Konformität:** kein neuer Store; Zustand wird **live** per Probe ermittelt. Die Probe lebt in der bestehenden `VpsDockerControl`-Boundary (kein neuer SSH-Pfad).

## Nicht-Ziele
- **Auto-Deploy nach Create** (Frontend triggert nach `ready` automatisch einen Deploy) — bewusst ausgeschlossen; der Nutzer klickt „Deploy starten" selbst, das Gate gibt den Button nur frei. (Kann als spätere Story ergänzt werden.)
- **Änderung der cloud-init-Reihenfolge** ([[vps-cloud-init-setup]]) — die Probe akzeptiert die bestehende Reihenfolge (Docker spät, cloudflared zuletzt) und wartet darauf, statt sie umzubauen.
- **Server-Lifecycle** (Maschine starten/stoppen/erstellen) → [[vps-provider-boundary]].
- **Health-Check der deployten App** (HTTP-Erreichbarkeit nach Deploy) — diese Capability prüft nur die VPS-/Infra-Bereitschaft **vor** dem Deploy.
- **Erweiterung der `VpsProvisioner.testConnection`** — diese prüft nur SSH-Auth (zu wenig für Bereitschaft); die Bereitschafts-Probe gehört bewusst in `VpsDockerControl` (SSH+Docker gebündelt, ADR-012).

## Abhängigkeiten
- [[deploy-lifecycle]] (`DeployOrchestrator` + `VpsDockerControl`; Deploy-Gate ergänzt AC3 dort; ADR-012).
- [[vps-dynamic-ssh-targets]] (vereinigte VPS-Auflösung Env ⊕ dynamisch für den Readiness-Endpunkt).
- [[vps-cloud-init-setup]] (cloud-init-Reihenfolge — die Probe wartet auf `boot-finished` + Docker + cloudflared; ADR-009).
- [[settings-ssh-keys]] (SSH-Private-Key für die Probe, store-intern; ADR-008).
- [[access-and-guardrails]] (Access-Mauer vor dem Readiness-Endpunkt).
- `docs/architecture.md` — `VpsDockerControl` in ADR-012 (einziger SSH+Docker-on-VPS-Pfad).
