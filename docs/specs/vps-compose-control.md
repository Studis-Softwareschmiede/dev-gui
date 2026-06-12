---
id: vps-compose-control
title: VpsComposeControl — Compose-Stack-Steuerung auf einem VPS via SSH (Etappe 1a)
status: draft
version: 1
---

# Spec: VpsComposeControl (`vps-compose-control`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-kritisch (SSH-on-VPS,
> git-clone-mit-Token, `docker compose`-Mutation).
> Dach: [[compose-stack-deployment]] (E2/E5). Schwester-Boundary zu `VpsDockerControl` (ADR-012,
> `src/deploy/VpsDockerControl.js`) — **gleiche** SSH-/Host-Key-/Fehler-/Timeout-Mechanik (ssh2,
> ADR-008-Linie), aber für **Compose-Stacks** statt einzelner Container.

## Zweck
Eine neue Boundary `VpsComposeControl` (`src/deploy/VpsComposeControl.js`) ist der **einzige** Ort,
der **Compose-Lifecycle-Kommandos** (`git clone/pull`, `docker compose up -d / down`, `docker compose ps`)
auf einem laufenden VPS via SSH ausführt. Sie kapselt die VPS-seitige Mechanik des neuen Deploy-Modus
„Compose-Stack aus Repo" (E5), ohne die orchestrierende Logik (Stack-Registry, .env-Generierung,
Cloudflare-Routen) zu kennen — die liegt in [[stack-deploy-orchestration]].

> **Abgrenzung:** `VpsDockerControl` (ADR-012) bleibt für **Single-Image**-Deploys + den
> Container-Read (`ps`/`psAll`) zuständig und wird **nicht** verändert. `VpsComposeControl` deckt
> **Compose-Stacks** ab. Beide teilen denselben SSH-Transport (eine `connect`-Hilfe, kein zweiter
> SSH-Pfad — `coder` darf gemeinsame SSH-Hilfsfunktionen extrahieren, solange jede Boundary ihre
> eigene öffentliche Methodenfläche behält).

## Verhalten
1. **Repo bereitstellen** (`syncRepo`): klont das App-Repo auf den VPS in ein deterministisches
   Stack-Verzeichnis, oder zieht es per `git pull`, falls es schon existiert. Branch wählbar.
   Idempotent: Re-Sync = `pull` (kein erneutes `clone`-Überschreiben). Das Klon-/Pull-Ziel liegt in
   einem festen, pro Stack getrennten Basisverzeichnis auf dem VPS (z.B. `~/stacks/<stack-name>`).
2. **Stack hochfahren** (`composeUp`): führt im Stack-Verzeichnis `docker compose -f <compose-pfad>
   [-f <override>] --project-name <project> up -d` aus. `--project-name` setzt das
   `com.docker.compose.project`-Label deterministisch (E2, Stack-Erkennung).
3. **Stack herunterfahren** (`composeDown`): `docker compose --project-name <project> down`
   (optional `--volumes` NUR wenn explizit angefordert — Default: Volumes **behalten**, Datenverlust-Schutz).
4. **Stack-Status lesen** (`composePs`): `docker compose --project-name <project> ps` → strukturierte
   Liste der Stack-Container (Name, Service, Status, Ports). Read-only.
5. **Stack-Container labelorientiert lesen** (`psStack`): listet alle laufenden Container, die das
   Label `com.docker.compose.project=<project>` tragen, inkl. ihres `cloudflare.tunnel-hostname`-Labels
   (managed/öffentlich) bzw. `null` (intern). Liefert die stack-aware Sicht für [[stack-deploy-orchestration]]
   + [[cloudflare-reconciliation]].
6. **Sicherheit:** SSH-Private-Key + ggf. ein git-Token werden **store-intern** geladen (CredentialStore,
   ADR-007/008) und **nie** in Argv/Log/Audit/Response/persistierter Remote-URL exponiert.

## Acceptance-Kriterien

### Boundary & SSH-Transport
- **AC1** — Es existiert **genau eine** Boundary `VpsComposeControl`, die `git clone/pull` und
  `docker compose up -d/down/ps` auf einem VPS via SSH ausführt; kein anderes Modul führt
  `docker compose`-Mutationen via SSH aus (Grep-prüfbar, analog R01). `VpsDockerControl` bleibt für
  Single-Image/Container-Read; dieser Diff verändert `VpsDockerControl` **nicht** in seinem Verhalten.
- **AC2** — SSH-Transport, Host-Key-Strategie (SHA-256-Fingerprint im `hostVerifier`; mit
  `hostFingerprint` strenge Prüfung, ohne TOFU + Hash im Audit), Fehlerklassen
  (`no-private-key | unreachable | auth-failed | host-key-mismatch | docker-failed | error`) und der
  Connect-Timeout (15 s) sind **identisch** zu `VpsDockerControl` (eine geteilte SSH-Hilfe, kein
  zweiter Pfad). Compose-Kommandos dürfen einen längeren Exec-Timeout haben (Pull + Up dauern).

### Repo-Sync
- **AC3** — `syncRepo({ vps, repoUrl, branch, stackName })` klont das Repo, falls das Stack-Verzeichnis
  nicht existiert, sonst `git fetch` + `git checkout <branch>` + `git pull --ff-only`. Idempotent:
  zweiter Aufruf ohne Remote-Änderung ist ein No-op-`pull`. Ergebnis `{ result: "ok"|"error", reason?, errorClass? }`.
- **AC4** — Wird für den Clone/Pull eines privaten Repos ein Token benötigt, wird es **transient**
  store-intern beschafft und **nie** in der auf dem VPS persistierten `origin`-URL, in Argv, Log,
  Audit oder Response abgelegt (Token-frei via git-credential-Helper/stdin, nicht in der URL).
  Der `stackName`/Pfad ist gegen Path-Traversal validiert (keine `..`, keine Shell-Metazeichen).

### Compose-Lifecycle
- **AC5** — `composeUp({ vps, stackName, composeFile, overrideFile?, project })` führt
  `docker compose -f … [-f …] --project-name <project> up -d` im Stack-Verzeichnis aus; bei Erfolg
  laufen die Stack-Container mit dem Label `com.docker.compose.project=<project>` (testbar: `psStack`
  bzw. `docker ps` zeigt das Label). Alle eingebetteten Werte (Pfade, Projektname) sind
  shell-escaped (Single-Quote-Muster wie `VpsDockerControl`); kein Command-Injection.
- **AC6** — `composeDown({ vps, stackName, project, removeVolumes? })` führt
  `docker compose --project-name <project> down` aus; `removeVolumes` ist **default false**
  (Datenverlust-Schutz) und nur bei explizitem `true` wird `--volumes` angehängt.
- **AC7** — `composePs({ vps, stackName, project })` liefert read-only die strukturierte Container-Liste
  des Stacks; `psStack({ vps, project })` liefert die Container mit `com.docker.compose.project=<project>`
  inkl. `cloudflare.tunnel-hostname`-Wert (oder `null` für interne). Fehler → `{ result: "error", reason, errorClass }`.

### Sicherheit & Audit (Floor)
- **AC8** — Kein SSH-Private-Key und kein git-Token erscheint je in Response, Log, Audit, WS-Stream,
  Argv oder in der auf dem VPS hinterlassenen Git-Remote-URL (store-intern aus dem `CredentialStore`).
  `stderr` von `docker compose`/`git` wird **nicht** in Response/Audit weitergeleitet (könnte Secrets
  enthalten); nur eine sanitisierte, geheimnis-freie Fehlerklasse verlässt die Boundary.

## Verträge
> Methoden-Signaturen kanonisch; Boundary-Detail (geteilte SSH-Hilfe, genaues `cd`/Verzeichnis-Layout)
> = `architekt` (neuer ADR „VpsComposeControl-Boundary").

- **`syncRepo({ vps, repoUrl, branch, stackName, gitTokenRef? })`** → `{ result, reason?, errorClass? }`.
- **`composeUp({ vps, stackName, composeFile, overrideFile?, project, envFilePath? })`** → `{ result, reason?, errorClass? }`.
- **`composeDown({ vps, stackName, project, removeVolumes? = false })`** → `{ result, reason?, errorClass? }`.
- **`composePs({ vps, stackName, project })`** → `{ result, containers?: ComposePsEntry[], reason?, errorClass? }`.
  `ComposePsEntry = { name, service, status, ports }`.
- **`psStack({ vps, project })`** → `{ result, containers?: StackContainer[], reason?, errorClass? }`.
  `StackContainer = { containerId, image, service, hostname: string|null, status, hostPort: number|null }`
  (`hostname` = `cloudflare.tunnel-hostname`-Label-Wert oder `null` für interne Services).
- **`VpsTarget`** identisch zu `VpsDockerControl`: `{ host, port?, targetUser }`; SSH-Private-Key
  store-intern via `ssh/<targetUser>/private_key`.
- Fehlerklassen + `sanitizeErrorReason` analog `VpsDockerControl`.

## Edge-Cases & Fehlerverhalten
- Kein Private-Key für `targetUser` → `no-private-key` (nicht erreichbar gemeldet, keine SSH-Verbindung).
- VPS nicht erreichbar / Host-Key-Mismatch → `unreachable`/`host-key-mismatch`, keine Mutation.
- `git pull` mit lokalen Änderungen / Merge-Konflikt → `git`-Fehler → `docker-failed`/`error`-Klasse,
  klare geheimnis-freie Meldung; kein halbgezogenes Repo wird als „ok" gemeldet.
- `docker compose up` schlägt fehl (Image-Pull denied, Compose-Syntax) → `docker-failed`, kein „ok".
- `compose down` auf nicht-existenten Stack → idempotent „ok" (nichts zu tun).
- Ungültiger `stackName`/`project` (Path-Traversal/Shell-Metazeichen) → `error` (validation), kein SSH.

## NFRs
- **Sicherheit (Floor, hart):** SSH-Key + git-Token store-intern, nie geleakt; Shell-Escaping wie
  `VpsDockerControl`; Path-Traversal-Schutz für `stackName`. `stderr` nie in Response/Audit.
- **ADR-006/008-Konformität:** SSH via `ssh2` (kein System-`ssh`/openssh-client im Image); SDK-frei.
- **Idempotenz:** `syncRepo` (pull), `composeUp` (compose re-up), `composeDown` (no-op) sind idempotent.

## Nicht-Ziele
- Stack-Registry / Welche Repos/Branches existieren → [[stack-deploy-orchestration]].
- .env-Materialisierung/-Generierung auf dem VPS → [[stack-deploy-orchestration]].
- Cloudflare-Routen anlegen/entfernen → [[stack-deploy-orchestration]] (nutzt `DeployOrchestrator`/`CloudflareApi`).
- UI → [[stack-deploy-orchestration]].
- Änderung des Single-Image-Pfads (`VpsDockerControl`/`DeployOrchestrator`-Verhalten unverändert).

## Abhängigkeiten
- [[compose-stack-deployment]] (Dach, E2/E5).
- [[stack-deploy-orchestration]] (Konsument dieser Boundary).
- [[settings-ssh-keys]] (SSH-Key store-intern), [[settings-credentials]] (ggf. git-Token).
- `src/deploy/VpsDockerControl.js` (Schwester-Boundary; geteilter SSH-Transport).
- `docs/architecture.md` — ADR-008 (SSH-Linie), **neuer ADR (`VpsComposeControl`-Boundary)**.
