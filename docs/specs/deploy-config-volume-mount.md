---
id: deploy-config-volume-mount
title: Persistenter rw-Verzeichnis-Mount für den Einzel-Container-Deploy
status: active
area: deployment
spec_format: use-case-2.0
version: 2
---

# Spec: Persistenter rw-Verzeichnis-Mount für den Einzel-Container-Deploy (`deploy-config-volume-mount`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).
> **Security-relevant** (Shell-Escaping über Mount-Pfade, Slug-/Pfad-Validierung, defense-in-depth).
> **Bereich:** `deployment`. **Feature:** F-078 (Erst-Auslieferung) + F-079 (Korrektur, diese Fassung).
> Boundaries fixiert in **ADR-012** (`DeployOrchestrator` + `VpsDockerControl`), SSH-Linie **ADR-008**, LockoutGuard **ADR-011**.

## Zweck
Der Einzel-Container-Deploy ([[deploy-lifecycle]]) startet eine App via `docker run` **ohne** jeglichen
`-v`-Volume-Mount. Eine App wie flashrescue braucht zur Laufzeit ein **persistentes, beschreibbares
Verzeichnis**, in dem sie ihre eigene `config.yaml` ablegt und der Operator sie per SSH editiert. Diese Spec
gibt dem Einzel-Container-Deploy genau **einen generischen, persistenten, read-write Verzeichnis-Mount**: ein
Host-Verzeichnis pro App wird angelegt (leer) und **read-write** an einen Container-Pfad (Default
`/app/config`) gemountet. dev-gui **kennt keinen config-Inhalt, keinen Dateinamen, kein config-ENV** — es
mountet nur ein persistentes rw-Verzeichnis. Die App bringt ihren Erst-Inhalt selbst mit (self-seeding aus
einer ins Image gebackenen Vorlage).

## Design-Entscheidung: Korrektur der F-078-Erst-Auslieferung (Owner-autorisiert)

Die Erst-Auslieferung (F-078, Stories S-347/S-348, Spec v1) hatte die **falsche Verantwortungsebene**
gewählt: dev-gui provisionierte eine **config-spezifische** Einzeldatei (`pushAppConfigFile`, `configSeed`-
Payload, `config-file-missing`-Guard) und mountete sie **read-only** nach `/app/config.yaml`. Damit trug das
generische Deploy-Tool config-Wissen (Dateiname, Erst-Inhalt), das ihm nicht gehört. Die App-Seite ist
inzwischen umgesetzt (flashrescue F-025, gelandet): die App **self-seeded** ihre `config.yaml` beim
Containerstart aus einer ins Image gebackenen Vorlage. dev-gui braucht daher nur noch den **Mount** — kein
Seed, kein config-Wissen.

**Mount-Vertrag** (Quelle: flashrescue `docs/specs/config-bereitstellung.md`, Abschnitt „Mount-Vertrag"):
- **Container-Mount-Punkt:** `/app/config` — ein **Verzeichnis** (NICHT eine Einzeldatei; Volume-Constraint:
  ein Bind-Mount auf eine nicht existierende Host-Einzeldatei ist unzuverlässig, ein Verzeichnis ist robust).
- **Modus:** **read-write** — die App **seedet** hinein, der Operator **editiert** per SSH.
- **Host-Seite:** ein **persistentes Verzeichnis pro App**, angelegt (`mkdir -p`), aber **NICHT befüllt**.
- dev-gui setzt **KEINEN** Seed-Inhalt, **KEIN** config-ENV, **KENNT** den Dateinamen **nicht** — nur „mounte
  ein persistentes rw-Verzeichnis an einen Container-Pfad".

## Abgrenzung
- Betrifft **ausschließlich** den **Einzel-Image-Deploy-Modus** ([[deploy-lifecycle]] / `VpsDockerControl.run()`).
  Der **Compose-Stack-Modus** ([[compose-stack-deployment]]) hat mit `~/stacks/<name>/` bereits ein
  App-Host-Verzeichnis und eine eigene Materialisierung — **nicht** Teil dieser Spec.
- Der **Inhalt** des gemounteten Verzeichnisses gehört **ausschließlich** der Ziel-App (self-seeding im
  eigenen Repo) und dem Operator (SSH-Edits). dev-gui **stellt nur das leere, persistente rw-Verzeichnis
  bereit + mountet es**.
- Die `.env.gpg`-Behandlung (ins Image gebacken, per `GPG_PASSPHRASE` entschlüsselt,
  [[deploy-bitwarden-gpg-injection]]) bleibt **unverändert** — der config-Mount ist ein **separater**,
  nicht-geheimer Mechanismus, orthogonal zur GPG-Passphrasen-Injektion.

## Design-Entscheidungen (bindend)

**D1 — Generischer persistenter rw-Verzeichnis-Mount (kein Seed, kein config-Wissen):**
1. Ist der Mount aktiv (`requiresConfig: true`), legt der Deploy das Host-Verzeichnis `~/apps/<app>/config`
   **idempotent** an (`mkdir -p`) und mountet es **read-write** an den Container-Pfad. Das Verzeichnis wird
   **nie befüllt** — dev-gui schreibt keinen Inhalt hinein (die App seedet selbst).
2. Es gibt **kein** Seed, **keine** `config-file-missing`-Prüfung, **keine** `pushAppConfigFile`-Provisionierung
   mehr (die entfallen mit dieser Korrektur ersatzlos). Ein bereits vom Operator/der App befülltes
   Host-Verzeichnis überlebt jeden Re-Deploy unverändert (persistentes Volume; dev-gui fasst den Inhalt nie an).
3. Ist der Mount inaktiv/abwesend, bleibt das `docker run`-Kommando **byte-identisch** zu heute (kein `-v`,
   kein `mkdir`).

**D2 — Read-write-Mount:** Der Mount ist **read-write** (kein `:ro`), damit die App ihre `config.yaml` beim
Start hineinschreiben und der Operator sie per SSH editieren kann. Reload per `docker restart` (die App liest
die Datei beim (Neu-)Start), ohne Image-Rebuild.

**D3 — Container-Pfad (Default + optional konfigurierbar):** Der Container-Mount-Punkt ist per Default
`/app/config`. Er ist über einen optionalen Parameter `configMountPath` überschreibbar (für Apps mit
abweichender Konvention). Der Pfad wird **vor** Verwendung gegen einen strikten Zeichensatz validiert (absoluter
Unix-Pfad, kein Shell-Metazeichen).

**D4 — Escaping (Fallgrube, aus S-347 sinngemäß erhalten):** Der Mount `-v <host>:<container>` darf **nicht**
als **ein** Single-Quote-String gequotet werden (dann parst Docker den `:`-Separator nicht). Host- und
Container-Pfad werden **getrennt** abgesichert; der `:`-Trenner bleibt **literal/ungequotet**. Der `<app>`-Slug
wird **vor** Verwendung gegen einen strikten Zeichensatz validiert; `$HOME` (bzw. `~`) bleibt shell-expandierbar
(kein Quoting, das die Tilde/`$HOME`-Expansion unterdrückt). Der `configMountPath` wird getrennt validiert.

## Verhalten
1. **Einfügepunkt (`VpsDockerControl.run()`):** Ist `requiresConfig` aktiv, stellt `run()` in **einer** SSH-Session
   sicher, dass das Host-Verzeichnis existiert (`mkdir -p <hostConfigDir>`), und fügt **genau einen** Bind-Mount
   `-v <hostConfigDir>:<containerMountPath>` (read-write, **kein** `:ro`) **zwischen** `...envArgs` und `-p` in
   das `docker run`-Kommando ein. Ist `requiresConfig` inaktiv/abwesend, bleibt das Kommando **byte-identisch**
   zu heute (kein `mkdir`, kein `-v`).
2. **Host-Ablage:** `~/apps/<app>/config` (Verzeichnis; `$HOME` des SSH-Ziel-Benutzers; `<app>` = validierter
   Slug). Das Verzeichnis wird per `mkdir -p` angelegt, aber **nie befüllt**.
3. **Container-Pfad:** Default `/app/config`, überschreibbar via `configMountPath` (validiert, absoluter Pfad).
4. **Durchreichung:** reduzierter Body-Param-Satz `requiresConfig`/`configApp`/`configMountPath` (**kein**
   `configSeed`) fließt `validateDeployBody()` → `POST /api/deployments`-Handler → `DeployOrchestrator.deploy()`
   → `VpsDockerControl.run()`. Plus Client-Formular in `DeploymentsView.jsx` (Checkbox + Host-Pfad-Vorschau,
   **kein** Seed-Feld). Es gibt **kein** separates Guard-/Seed-Gate im Orchestrator mehr.

## Acceptance-Kriterien

### Mount-Mechanik (`VpsDockerControl.run()`)
- **AC1** — Bei `requiresConfig: true` (a) legt `run()` das Host-Verzeichnis via `mkdir -p <hostConfigDir>` an
  (in **derselben** SSH-Session wie `docker run`) und (b) enthält das erzeugte `docker run`-Kommando **genau
  einen** Bind-Mount `-v <hostConfigDir>:<containerMountPath>` **ohne** `:ro`-Suffix (read-write), eingefügt
  **zwischen** dem Env-Block (`...envArgs`) und `-p <hostPort>:<containerPort>`. Bei `requiresConfig`
  falsy/abwesend enthält das Kommando **kein** `mkdir`, **kein** `-v` und ist **byte-identisch** zum heutigen
  Verhalten. (Testbar: Kommando-String-Capture via Spy.)
- **AC2** (Escaping/Security, D4) — Host- und Container-Pfad werden **getrennt** abgesichert; der `:`-Trenner
  bleibt **literal/ungequotet**, sodass Docker den Mount korrekt parst. Der `<app>`-Slug wird **vor**
  Verwendung gegen `^[a-z0-9][a-z0-9._-]*$` validiert; ein ungültiger Slug bricht mit `config-app-invalid` ab
  und führt **keinen** Docker-Schritt (und **kein** `mkdir`) aus. Ein ungültiger `configMountPath` (kein
  absoluter Unix-Pfad `^/[A-Za-z0-9._/-]*$`) bricht mit `config-mount-path-invalid` ab und führt **keinen**
  Docker-Schritt aus. **Kein** Shell-Injection über Slug oder Mount-Pfad möglich. (Testbar: Slug/Pfad mit
  `;`/Leerzeichen/`$()` wird abgelehnt; das assemblierte Kommando quotet **nicht** die gesamte
  `host:container`-Einheit als einen String.)
- **AC3** — Host-Pfad-Konvention: `~/apps/<app>/config` (Verzeichnis; `$HOME` des SSH-Ziel-Benutzers; `<app>`
  = validierter Slug). Das Verzeichnis wird per `mkdir -p` angelegt, falls es fehlt, und **nie** von dev-gui
  **befüllt** (kein Schreib-Kommando in das Verzeichnis). Die Tilde/`$HOME`-Expansion wird durch das Escaping
  **nicht** unterdrückt (D4).
- **AC4** (read-write, D2) — Der Mount ist **read-write** (die App seedet, der Operator editiert); das
  Kommando enthält **keinen** `:ro`-Suffix am config-Mount. (Testbar: Kommando-String enthält
  `-v <hostConfigDir>:<containerMountPath>` ohne `:ro`.)

### Entfernung der F-078-config-Seed-Mechanik (Korrektur)
- **AC5** (Rückbau, hart) — Die config-**spezifische** Seed-Mechanik der Erst-Auslieferung ist **vollständig
  entfernt**: (a) `VpsDockerControl.pushAppConfigFile(...)` existiert **nicht** mehr; (b) das Guard-/Seed-Gate
  in `DeployOrchestrator.deploy()` (Aufruf von `pushAppConfigFile`, `config-file-missing`-Abbruch) ist
  **entfernt**; (c) der Body-Param `configSeed` wird **nicht** mehr akzeptiert/durchgereicht; (d) die
  Fehlerklasse `config-file-missing` wird **nirgends** mehr erzeugt/gemappt; (e) das Seed-Textfeld in
  `DeploymentsView.jsx` ist **entfernt**. Die zugehörigen Tests der Erst-Auslieferung werden entsprechend
  angepasst/entfernt (kein Test referenziert noch `pushAppConfigFile`/`configSeed`/`config-file-missing`).
  (Testbar: repo-weite Suche nach den Symbolen liefert außerhalb dieser Spec/Board-Historie **keine**
  Produktions-Codestellen mehr.)

### Durchreichung (Router + Client)
- **AC6** — `POST /api/deployments` akzeptiert die optionalen Body-Params `requiresConfig` (boolean),
  `configApp` (string-Slug; Default = aus dem Image-/Package-Namen abgeleiteter App-Slug, dieselbe Ableitung
  wie beim `gpgBwItem`/Subdomain) und `configMountPath` (optionaler string; Default `/app/config`).
  `validateDeployBody()` validiert Typen + Slug-Zeichensatz (`^[a-z0-9][a-z0-9._-]*$`) + Mount-Pfad-Zeichensatz
  (absoluter Unix-Pfad); `configSeed` wird **nicht** mehr akzeptiert (unbekanntes Feld wird ignoriert, nie
  durchgereicht). Ungültige Werte → `400`.
- **AC7** — Bei `requiresConfig: true` reicht der Handler `requiresConfig`/`configApp`/`configMountPath` durch
  die Kette (`DeployOrchestrator.deploy` → `VpsDockerControl.run`); es gibt **kein** separates Seed-/Guard-Gate
  mehr und **keinen** `configSeed`-Fluss. Bei `requiresConfig` false/abwesend ist der Deploy-Pfad
  **unverändert** (kein config-Schritt, AC1-Byte-Gleichheit).
- **AC8** (Client) — `DeploymentsView.jsx` bietet eine Checkbox „persistentes config-Verzeichnis auf dem VPS
  mounten (read-write nach `/app/config`)". Ist sie aktiv, zeigt die View eine **read-only** Vorschau des
  Host-Pfads `~/apps/<app>/config` (Verzeichnis). Es gibt **kein** Seed-Textfeld mehr. Der `configApp`-Default
  wird aus dem gewählten Image/Package abgeleitet (gleiche Ableitung wie `gpgBwItem`/Subdomain), bleibt
  **editierbar**. Beim Absenden gehen `requiresConfig`/`configApp` (und `configMountPath` nur bei Abweichung
  vom Default) im Deploy-Request mit; ist die Checkbox inaktiv, werden **keine** config-Params gesendet
  (unveränderter Request).

### Sicherheit & Audit (Floor, hart)
- **AC9** (Floor) — Der config-Mount führt **kein** neues Secret und **keinen** neuen Endpunkt ein; dev-gui
  schreibt **keinen** Inhalt in das gemountete Verzeichnis (kein config-Wissen); Slug **und**
  `configMountPath` werden strikt validiert (kein Shell-Injection, getrenntes Escaping der Mount-Einheit, D4).
  Alle bestehenden Floors bleiben **unverändert** in Kraft (Access, `CRED_ADMIN_EMAILS`,
  LockoutGuard-Hard-Block, Audit-First, protected-Hostname → `422`); der config-Mount-Schritt läuft **nie**
  vor LockoutGuard/Hostname/Tunnel/Readiness-Gate ([[deploy-lifecycle]] AC7/AC8/AC9,
  [[vps-tunnel-existence-gate]], [[vps-readiness-gate]]).

## Verträge
- **POST `/api/deployments`** — Body additiv: `{ …bestehende Felder, requiresConfig?: boolean,
  configApp?: string, configMountPath?: string }` → unveränderte Response-Form (`{ result, deployment?,
  reason? }`). Fehlerklassen: `config-app-invalid` (400/422), `config-mount-path-invalid` (400/422).
  **Entfernt:** `configSeed` (Body-Param), `config-file-missing` (Fehlerklasse).
- **`VpsDockerControl.run(vps, image, hostname, opts)`** — `opts` additiv:
  `{ requiresConfig?: boolean, configApp?: string, configMountPath?: string }` → bei aktiv: `mkdir -p
  $HOME/apps/<configApp>/config` (leer) **plus** `-v $HOME/apps/<configApp>/config:<containerMountPath>`
  (read-write, kein `:ro`) zwischen `envArgs` und `-p`. Container-Pfad-Default: `/app/config`.
- **`DeployOrchestrator.deploy({ …, requiresConfig?, configApp?, configMountPath? })`** — reicht
  `requiresConfig`/`configApp`/`configMountPath` an `run()` durch; **kein** separates config-Gate, **kein**
  `configSeed`.
- **Host-Pfad-Konvention:** `~/apps/<app>/config` (Verzeichnis); Container-Pfad-Default `/app/config`; Mount
  **read-write** (kein `:ro`).
- **Entfernt:** `VpsDockerControl.pushAppConfigFile(...)` (ersatzlos).

## Edge-Cases & Fehlerverhalten
- `requiresConfig` aktiv → `mkdir -p ~/apps/<app>/config` (idempotent, existiert schon → No-op), dann Mount
  read-write; ein bereits befülltes Verzeichnis bleibt unangetastet (persistentes Volume, AC3).
- Ungültiger `configApp`-Slug → `config-app-invalid`, kein `mkdir`, kein Docker-Schritt (AC2).
- Ungültiger `configMountPath` → `config-mount-path-invalid`, kein Docker-Schritt (AC2).
- `requiresConfig` false/abwesend → Deploy exakt wie heute (kein `mkdir`, kein `-v`, keine neuen Schritte,
  AC1/AC7).
- protected-Hostname / fehlender/mismatchter Tunnel / VPS nicht ready → bestehende Gates greifen **vor** dem
  config-Mount-Schritt (AC9) — kein config-Schritt.

## NFRs
- **Sicherheit (Floor, hart):** getrenntes Escaping von Host-/Container-Pfad (D4); `<app>`-Slug **und**
  `configMountPath` strikt validiert (kein Shell-Injection); dev-gui schreibt **keinen** Inhalt in das
  Verzeichnis. Kein neues Secret, kein neuer Endpunkt, kein Frontend-Bundle-Secret.
- **Idempotenz/Resilienz:** `mkdir -p` ist idempotent; das persistente Host-Verzeichnis (und sein von der
  App/dem Operator gesetzter Inhalt) überlebt jeden Re-Deploy **unverändert** — dev-gui fasst den Inhalt nie an.
- **ADR-Konformität:** kein neuer Deploy-State-Store; SSH via ADR-008-Linie; `run()` bleibt in der
  `VpsDockerControl`-Boundary (ADR-012); LockoutGuard (ADR-011) unangetastet.

## Nicht-Ziele
- **Compose-Stack-Modus** ([[compose-stack-deployment]]) — hat `~/stacks/<name>/` + eigene Materialisierung.
- **Seed/Provisionierung des config-Inhalts durch dev-gui** — bewusst entfernt (Korrektur): die App seedet
  selbst (flashrescue F-025), dev-gui mountet nur ein leeres persistentes rw-Verzeichnis (D1).
- **Read-only-Mount** — bewusst read-write (D2), damit App-Seeding + Operator-Edit funktionieren.
- **Mehrere Verzeichnisse / beliebige Mount-Ziele pro Deploy** — genau ein config-Verzeichnis-Mount
  (Container-Pfad Default `/app/config`, optional via `configMountPath`).
- **Secret-Behandlung** — der config-Mount ist nicht-geheim; Secrets bleiben in `.env.gpg`
  ([[deploy-bitwarden-gpg-injection]]), unverändert.

## Abhängigkeiten
- [[deploy-lifecycle]] (Einzel-Image-Deploy-Saga, `VpsDockerControl.run()`, Gates-Reihenfolge).
- [[deploy-bitwarden-gpg-injection]] (`containerEnv`/`envArgs`-Einfügepunkt).
- [[compose-stack-deployment]] (`~/stacks`-Vorbild für App-Host-Verzeichnisse).
- [[vps-tunnel-existence-gate]], [[vps-readiness-gate]] (Gates, die **vor** dem config-Mount-Schritt greifen).
- flashrescue `docs/specs/config-bereitstellung.md` (Abschnitt „Mount-Vertrag" — die App-Seite dieses Vertrags).
- `docs/architecture.md` — ADR-012 (`DeployOrchestrator`/`VpsDockerControl`), ADR-008 (SSH-Linie), ADR-011 (LockoutGuard).
