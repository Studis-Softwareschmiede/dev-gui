---
id: deploy-config-volume-mount
title: config.yaml-Volume-Mount für den Einzel-Container-Deploy (Weg A)
status: active
area: deployment
spec_format: use-case-2.0
version: 1
---

# Spec: config.yaml-Volume-Mount für den Einzel-Container-Deploy (`deploy-config-volume-mount`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).
> **Security-relevant** (Shell-Escaping über Pfade, Seed-Inhalt via stdin nie in Argv, `0600`-Host-Datei).
> **Bereich:** `deployment`. **Feature:** F-078.
> Boundaries fixiert in **ADR-012** (`DeployOrchestrator` + `VpsDockerControl`), SSH-Linie **ADR-008**, LockoutGuard **ADR-011**.

## Zweck
Der Einzel-Container-Deploy ([[deploy-lifecycle]]) startet eine App via `docker run` **ohne** jeglichen
`-v`-Volume-Mount. Eine App wie flashrescue liest zur Laufzeit `/app/config.yaml`, die aber **weder ins
Image gebacken noch gemountet** wird → auf dem VPS fehlt sie, die App kommt nicht sauber hoch. Diese Spec
führt einen Mechanismus ein, der eine App-`config.yaml` als **editierbare Host-Datei** auf dem VPS
bereitstellt und **read-only** nach `/app/config.yaml` in den Container mountet — sodass der Owner sie per
SSH auf dem VPS-Host anpassen und mit `docker restart` neu laden kann, **ohne** das Image neu zu bauen.

## Abgrenzung
- Betrifft **ausschließlich** den **Einzel-Image-Deploy-Modus** ([[deploy-lifecycle]] / `VpsDockerControl.run()`).
  Der **Compose-Stack-Modus** ([[compose-stack-deployment]]) hat mit `~/stacks/<name>/` bereits ein
  App-Host-Verzeichnis und eine eigene `.env`-Materialisierung — **nicht** Teil dieser Spec.
- Die App-Seite des Vertrags (die App **liest** `/app/config.yaml`) implementiert die jeweilige Ziel-App
  selbst (eigenes Repo). dev-gui **stellt bereit + mountet** nur.
- Die `.env.gpg`-Behandlung (ins Image gebacken, per `GPG_PASSPHRASE` entschlüsselt,
  [[deploy-bitwarden-gpg-injection]]) bleibt **unverändert** — die config.yaml ist ein **separater**,
  nicht-geheimer Mechanismus, orthogonal zur GPG-Passphrasen-Injektion.

## Design-Entscheidung: Herkunft der INITIALEN config.yaml (Owner nicht erreichbar — begründet festgelegt)

**Gewählt: Hybrid „Seed-once aus Payload (B) + editier-erhaltende Idempotenz (A) + Abbruch-bei-fehlend-ohne-Seed (C-Fallback)".**

**D1 — Bereitstellung/Idempotenz (bindend):**
1. Existiert die Host-Datei `~/apps/<app>/config.yaml` **noch nicht** und wird beim Deploy ein
   **Seed-Inhalt** (`configSeed`) mitgegeben → dev-gui legt die Datei **einmalig** atomar an (Erst-Provisionierung).
2. Existiert die Host-Datei **bereits** → sie bleibt **byte-identisch** (wird **nie** überschrieben), auch wenn
   ein Seed-Inhalt mitgegeben wird. Die per-SSH-Edits des Owners überleben jeden Re-Deploy (analog der
   `.env`-Regel „byte-identisch belassen" aus [[compose-stack-deployment]] E3 / dem `.env`-Vorbild).
3. Verlangt der Deploy die config (`requiresConfig: true`), existiert die Host-Datei **nicht** **und** es
   wird **kein** Seed-Inhalt mitgegeben → **klarer Deploy-Abbruch** (`config-file-missing`) mit Hinweis, die
   Datei per SSH abzulegen oder einen Seed-Inhalt mitzugeben — **vor jeder Mutation**.

**Begründung (warum nicht reines (A) „Template automatisch ablegen"):** Der Einzel-Image-Modus **klont das
App-Repo nicht** (das ist Compose-Stack-Modus). dev-gui hat im Einzel-Image-Modus daher **keine** Quelle für
eine `config.example.yaml` der Ziel-App, ohne eine **neue Repo-Clone-Abhängigkeit** einzuführen (Scope-Creep,
falscher Modus). Der Payload-Seed (B) ist der **entkoppelte, abhängigkeits-freie** Weg, den Erst-Inhalt
bereitzustellen; fehlt er, greift der sichere (C)-Abbruch statt eines rateenden Auto-Templates. Die
editier-erhaltende Idempotenz (A) bleibt das Leitprinzip für Re-Deploys. Es gibt **kein** SFTP/scp — die
Bereitstellung nutzt denselben `bash -s`+stdin-Baustein wie `pushTunnelEnvFile()` (Inhalt nie in Argv).

**D2 — Read-only-Mount:** Der Mount ist `:ro`, damit der Container die Host-Datei nicht mutieren kann; der
Owner ist der **einzige** Editor (per SSH). Reload per `docker restart` (die App liest die Datei beim
(Neu-)Start), ohne Image-Rebuild.

**D3 — Escaping (Fallgrube):** Der Mount `-v <host>:<container>:ro` darf **nicht** als **ein** Single-Quote-
String gequotet werden (dann parst Docker den `:`-Separator nicht). Host- und Container-Pfad werden
**getrennt** abgesichert; die `:`-Trenner und `:ro` bleiben **literal/ungequotet**. Der `<app>`-Slug wird
**vor** Verwendung gegen einen strikten Zeichensatz validiert; `$HOME` (bzw. `~`) bleibt shell-expandierbar
(kein Quoting, das die Tilde/`$HOME`-Expansion unterdrückt).

## Verhalten
1. **Einfügepunkt (`VpsDockerControl.run()`):** Ist `requiresConfig` aktiv, fügt `run()` **genau einen**
   Bind-Mount `-v <hostConfigPath>:/app/config.yaml:ro` **zwischen** `...envArgs` und `-p` ein. Ist
   `requiresConfig` inaktiv/abwesend, bleibt das `docker run`-Kommando **byte-identisch** zu heute (kein `-v`).
2. **Host-Ablage:** `~/apps/<app>/config.yaml` (`$HOME` des SSH-Ziel-Benutzers; `<app>` = validierter Slug).
   Das Verzeichnis `~/apps/<app>` wird bei Bedarf angelegt.
3. **Seed-Bereitstellung (`VpsDockerControl.pushAppConfigFile()`):** schreibt die Host-Datei **atomar**
   (tmp + `rename`), `chmod 600`, im Besitz des Ziel-Benutzers, **nur wenn sie noch nicht existiert**; der
   Inhalt wird via **stdin** (`bash -s`) übergeben, **nie** in Argv/Log/Audit (analog `pushTunnelEnvFile`).
4. **Guard-/Seed-Gate (`DeployOrchestrator.deploy()`):** läuft **vor** dem Re-Deploy-Replace-Schritt und
   **vor** `pull`/`run` (analog den Tunnel-/Readiness-Gates), aber **nach** LockoutGuard/Hostname/Tunnel/
   Readiness. Prüft D1 (existiert/seedbar/fehlend) und bricht bei fehlend-ohne-Seed ab.
5. **Durchreichung:** neuer Body-Param-Satz `requiresConfig`/`configApp`/`configSeed` fließt
   `validateDeployBody()` → `POST /api/deployments`-Handler → `DeployOrchestrator.deploy()` →
   `VpsDockerControl.run()`/`pushAppConfigFile()`. Plus Client-Formularfeld in `DeploymentsView.jsx`.

## Acceptance-Kriterien

### Mount-Mechanik (`VpsDockerControl.run()`)
- **AC1** — Bei `requiresConfig: true` enthält das von `run()` erzeugte `docker run`-Kommando **genau einen**
  Bind-Mount `-v <hostConfigPath>:/app/config.yaml:ro`, eingefügt **zwischen** dem Env-Block (`...envArgs`)
  und `-p <hostPort>:<containerPort>`. Bei `requiresConfig` falsy/abwesend enthält das Kommando **kein** `-v`
  und ist **byte-identisch** zum heutigen Verhalten. (Testbar: Kommando-String-Capture via Spy.)
- **AC2** (Escaping/Security, D3) — Host- und Container-Pfad werden **getrennt** abgesichert; die `:`-Trenner
  und der `:ro`-Suffix bleiben **literal/ungequotet**, sodass Docker den Mount korrekt parst. Der `<app>`-Slug
  wird **vor** Verwendung gegen `^[a-z0-9][a-z0-9._-]*$` validiert; ein ungültiger Slug bricht mit
  `config-app-invalid` ab und führt **keinen** Docker-Schritt aus. **Kein** Shell-Injection über den
  config-Pfad möglich. (Testbar: Slug mit `;`/Leerzeichen/`$()` wird abgelehnt; das assemblierte Kommando
  quotet **nicht** die gesamte `host:container:ro`-Einheit als einen String.)

### Host-Ablage & Idempotenz
- **AC3** — Host-Pfad-Konvention: `~/apps/<app>/config.yaml` (`$HOME` des SSH-Ziel-Benutzers; `<app>` =
  validierter Slug). Das Verzeichnis `~/apps/<app>` wird angelegt, falls es fehlt. Die Tilde/`$HOME`-Expansion
  wird durch das Escaping **nicht** unterdrückt (D3).
- **AC4** (Seed-once) — `VpsDockerControl.pushAppConfigFile(vps, app, content, opts?)` schreibt die Host-Datei
  **atomar** (tmp + `rename`), `chmod 600`, im Besitz des Ziel-Benutzers, **nur wenn sie noch nicht existiert**.
  Der Inhalt wird via **stdin** (`bash -s`) übergeben — **nie** in Argv/Log/Audit/Response (Muster
  `pushTunnelEnvFile`). (Testbar: exec-Argv enthält den Inhalt nicht; Datei nur bei Nicht-Existenz geschrieben.)
- **AC5** (editier-erhaltende Idempotenz, D1.2) — Existiert `~/apps/<app>/config.yaml` bereits, lässt ein
  Re-Deploy sie **byte-identisch** (keine Überschreibung), **auch** wenn `configSeed` mitgegeben wird. (Testbar:
  vorbestehende Datei + Re-Deploy mit Seed → Host-Datei-Inhalt unverändert; kein Schreib-Kommando.)
- **AC6** (fehlend + kein Seed → Abbruch, D1.3) — Ist `requiresConfig` gesetzt, existiert die Host-Datei
  **nicht** **und** wird **kein** `configSeed` mitgegeben → Deploy bricht **vor jeder Mutation** ab (kein
  Re-Deploy-Replace, kein `pull`, kein `run`, kein Cloudflare-Schritt) mit `errorClass: "config-file-missing"`
  + klarem Hinweis (Datei per SSH ablegen **oder** Seed-Inhalt mitgeben). (Testbar: Spy zeigt keinen
  `pull`/`run`/Cloudflare-Call.)

### Durchreichung (Router + Client)
- **AC7** — `POST /api/deployments` akzeptiert die optionalen Body-Params `requiresConfig` (boolean),
  `configApp` (string-Slug; Default = aus dem Image-/Package-Namen abgeleiteter App-Slug, dieselbe Ableitung
  wie beim `gpgBwItem`/Subdomain) und `configSeed` (optionaler string). `validateDeployBody()` validiert
  Typen + Slug-Zeichensatz (`^[a-z0-9][a-z0-9._-]*$`) + ein Längenlimit auf `configSeed`; ungültig → `400`
  **ohne** den `configSeed`-Inhalt zu leaken.
- **AC8** — Bei `requiresConfig: true` reicht der Handler Mount + Seed durch die Kette
  (`DeployOrchestrator.deploy` → `VpsDockerControl.run`/`pushAppConfigFile`); der `configSeed`-Inhalt wird
  **nie** geloggt/auditiert/zurückgegeben — das Audit hält höchstens `deploy:config-seed:<app>` **ohne** Wert.
  Bei `requiresConfig` false/abwesend ist der Deploy-Pfad **unverändert** (kein config-Schritt, AC1-Byte-Gleichheit).
- **AC9** (Client) — `DeploymentsView.jsx` bietet eine Checkbox „config.yaml auf dem VPS bereitstellen
  (read-only nach `/app/config.yaml` gemountet)". Ist sie aktiv, zeigt die View (a) ein optionales
  mehrzeiliges Seed-Feld (Erst-Deploy-Inhalt) und (b) eine **read-only** Vorschau des Host-Pfads
  `~/apps/<app>/config.yaml`. Der `configApp`-Default wird aus dem gewählten Image/Package abgeleitet
  (gleiche Ableitung wie `gpgBwItem`/Subdomain), bleibt **editierbar**. Beim Absenden gehen
  `requiresConfig`/`configApp`/`configSeed` im Deploy-Request mit; ist die Checkbox inaktiv, werden **keine**
  config-Params gesendet (unveränderter Request).

### Sicherheit & Audit (Floor, hart)
- **AC10** (Floor) — Der config-Mount führt **kein** neues Secret und **keinen** neuen Endpunkt ein; der
  `configSeed`-Inhalt fließt zum VPS **ausschließlich** via stdin (nie Argv) und erscheint **nie** in
  dev-guis Log/Audit/Response/WS-Stream; die Host-Datei ist `chmod 600` im Besitz des Ziel-Benutzers. Alle
  bestehenden Floors bleiben **unverändert** in Kraft (Access, `CRED_ADMIN_EMAILS`, LockoutGuard-Hard-Block,
  Audit-First, protected-Hostname → `422`); das config-Gate läuft **nie** vor LockoutGuard/Hostname/Tunnel/
  Readiness-Gate ([[deploy-lifecycle]] AC7/AC8/AC9, [[vps-tunnel-existence-gate]], [[vps-readiness-gate]]).

## Verträge
- **POST `/api/deployments`** — Body additiv: `{ …bestehende Felder, requiresConfig?: boolean,
  configApp?: string, configSeed?: string }` → unveränderte Response-Form (`{ result, deployment?, reason? }`).
  Neue Fehlerklassen: `config-file-missing` (422), `config-app-invalid` (422/400).
- **`VpsDockerControl.run(vps, image, hostname, opts)`** — `opts` additiv:
  `{ requiresConfig?: boolean, configApp?: string }` → fügt bei aktiv `-v $HOME/apps/<configApp>/config.yaml:/app/config.yaml:ro`
  zwischen `envArgs` und `-p` ein. Container-Pfad-Konstante: `/app/config.yaml`.
- **`VpsDockerControl.pushAppConfigFile(vps, app, content, opts?)`** →
  `{ result: 'ok'|'error', seeded?: boolean, reason?, errorClass? }`. `seeded: false`, wenn die Datei bereits
  existierte (keine Überschreibung). Inhalt via stdin, `0600`, atomar (tmp+rename). Fehlerklassen analog
  bestehendem Katalog (`no-private-key`|`unreachable`|`auth-failed`|`host-key-mismatch`|`docker-failed`|`error`).
- **`DeployOrchestrator.deploy({ …, requiresConfig?, configApp?, configSeed? })`** — führt das config-Gate
  (D1) vor Re-Deploy-Replace/`pull`/`run` aus und reicht `requiresConfig`/`configApp` an `run()` durch.
- **Host-Pfad-Konvention:** `~/apps/<app>/config.yaml`; Container-Pfad fix `/app/config.yaml`; Mount `:ro`.

## Edge-Cases & Fehlerverhalten
- `requiresConfig` aktiv, Host-Datei fehlt, kein Seed → `422 config-file-missing`, **kein** Docker-/Cloudflare-Schritt (AC6).
- `requiresConfig` aktiv, Host-Datei existiert (ggf. vom Owner editiert) → **nie** überschrieben; Deploy nutzt sie (AC5).
- `requiresConfig` aktiv, Host-Datei fehlt, Seed vorhanden → atomar `0600` angelegt, dann Deploy (AC4).
- Ungültiger `configApp`-Slug → `config-app-invalid`, kein Docker-Schritt (AC2).
- Seed-Schreiben schlägt fehl (SSH/Disk) → `{ result: 'error', reason }` ohne Leak, **vor** `pull`/`run`;
  eine bereits erfolgreich geseedete Datei braucht **keinen** Rollback (nicht-destruktiv, wird beim nächsten
  Deploy wiederverwendet — editier-erhaltend).
- `requiresConfig` false/abwesend → Deploy exakt wie heute (kein `-v`, keine neuen Schritte, AC1/AC8).
- protected-Hostname / fehlender/mismatchter Tunnel / VPS nicht ready → bestehende Gates greifen **vor** dem
  config-Gate (AC10) — kein config-Schritt.

## NFRs
- **Sicherheit (Floor, hart):** Seed-Inhalt nur via stdin (nie Argv/Log/Audit/Response/WS); getrenntes
  Escaping von Host-/Container-Pfad (D3); `<app>`-Slug strikt validiert (kein Shell-Injection); Host-Datei
  `0600`; Mount `:ro`. Kein neues Secret, kein neuer Endpunkt, kein Frontend-Bundle-Secret.
- **Idempotenz/Resilienz:** Re-Deploy überschreibt eine (editierte) Host-config.yaml **nie**; Seed nur bei
  Nicht-Existenz; atomarer Schreibzugriff (tmp+rename) → nie eine halb-geschriebene config gemountet.
- **ADR-Konformität:** kein neuer Deploy-State-Store; SSH via ADR-008-Linie; `run()`/`pushAppConfigFile()`
  bleiben in der `VpsDockerControl`-Boundary (ADR-012); LockoutGuard (ADR-011) unangetastet.

## Nicht-Ziele
- **Compose-Stack-Modus** ([[compose-stack-deployment]]) — hat `~/stacks/<name>/` + eigene `.env`-Materialisierung.
- **Automatisches Template aus dem App-Repo** (reines (A)): der Einzel-Image-Modus klont das Repo nicht;
  Seed-Payload (B) + (C)-Fallback ersetzen das bewusst (Design-Entscheidung D1).
- **Schreibbarer Mount / In-Container-Edit** der config.yaml (bewusst `:ro`, D2).
- **Mehrere config-Dateien / beliebige Mount-Ziele** pro Deploy (Erst-Durchgang: genau `/app/config.yaml`).
- **Secret-Behandlung der config.yaml** — sie ist nicht-geheim; Secrets bleiben in `.env.gpg`
  ([[deploy-bitwarden-gpg-injection]]), unverändert.

## Abhängigkeiten
- [[deploy-lifecycle]] (Einzel-Image-Deploy-Saga, `VpsDockerControl.run()`, Gates-Reihenfolge).
- [[deploy-bitwarden-gpg-injection]] (`containerEnv`/`envArgs`-Einfügepunkt; `pushTunnelEnvFile`-stdin-Muster als Vorbild).
- [[compose-stack-deployment]] (`~/stacks`-Vorbild + `.env` „byte-identisch belassen"-Idempotenz-Regel).
- [[vps-tunnel-existence-gate]], [[vps-readiness-gate]] (Gates, die **vor** dem config-Gate greifen).
- `docs/architecture.md` — ADR-012 (`DeployOrchestrator`/`VpsDockerControl`), ADR-008 (SSH-Linie), ADR-011 (LockoutGuard).
