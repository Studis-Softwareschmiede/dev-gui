---
id: per-app-gpg-passphrase-provisioning
title: Per-App-GPG-Passphrasen — automatische Bitwarden-Provisionierung (Projektanlage + Nach-Provisionierung)
status: active
area: deployment
spec_format: use-case-2.0
version: 1
---

# Spec: Per-App-GPG-Passphrasen — automatische Bitwarden-Provisionierung (`per-app-gpg-passphrase-provisioning`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. **Security-kritisch.**

## Zweck
Jede von der Fabrik angelegte App bekommt eine **eigene, kryptografisch starke GPG-Passphrase**, die dev-gui automatisch in Bitwarden hinterlegt (Item `env.gpg-passphrase-<app>`) und dem Scaffold **einmalig** so durchreicht, dass das initiale `.env.gpg` (Plugin-Schritt GE4) mit genau dieser Passphrase entsteht. Damit löst dev-gui die geteilte Fabrik-Passphrase des agent-flow-Plugins durch **per-App-Passphrasen** ab (Doktrin-Wechsel, Owner 2026-07-13). Zwei Wege: **(a) Auto-Provisionierung** bei Projektanlage über alle drei Anlage-Wege der Fabrik-Übersicht; **(b) Nach-Provisionierung** bestehender Apps per Knopf. Beide teilen **einen** Dienst mit **einer** Idempotenz-Garantie.

## Kontext & Abgrenzung
Baut auf [[deploy-bitwarden-gpg-injection]] (F-072) auf: dort existiert bereits der unbeaufsichtigte Bitwarden-Deploy-Zugang (`BitwardenDeployAccessStore` 0600-Datei; `BitwardenDeployLoginService` mit API-Key-Login + Unlock) und die per-App-Passphrasen-**Injektion** beim Deploy. Diese Spec ergänzt die **Anlage-Seite** (Provisionierung), die dort fehlte.

Die **`bw`-create-item-Technik** (Item-Template → JSON-Manipulation → `bw encode` via stdin → `bw create item` via stdin, **kein** Wert in Argv) existiert bereits im `BitwardenMasterKeyService.#bwCreateItem` und wird wiederverwendet.

**agent-flow bleibt strikt Bitwarden-agnostisch:** Der Bitwarden-Zugang verlässt dev-gui nie (S3 unten). Das Plugin lernt nur, seine Passphrase aus einer von dev-gui bereitgestellten Datei (`GPG_PASS_FILE`) zu beziehen — nie aus Bitwarden direkt. Die konzeptionelle Verankerung dieses Doktrin-Wechsels im Plugin (secrets-subsystem.md + new-project SKILL GE4) erfolgt als PR gegen das agent-flow-Repo (AC11, Muster retro/train: PR, nie Direkt-Edit).

**Nicht Teil dieser Spec:** die Rotation einer bereits provisionierten Passphrase — das ist [[per-app-gpg-passphrase-rotation]]. Die App-Seite des Entschlüsselungs-Vertrags (`.env.gpg` + Entrypoint) implementiert die Ziel-App selbst.

## Sicherheits-Leitplanken (bindend, gelten für ALLE ACs)
Die Leitplanken **S1–S6** aus [[deploy-bitwarden-gpg-injection]] §3 gelten **unverändert** für alle Wege dieser Spec:
- **S1** — Kein Klartext (keine Passphrase, kein Bitwarden-Zugang) in HTTP-Response, Log, Audit, WS oder URL.
- **S2** — Geheimnisse an `bw`/Scaffold **nie** über Argv; nur Env/stdin bzw. `0600`-Datei.
- **S3** — Der Bitwarden-Zugang verlässt dev-gui nie; nach außen (Ziel-Server, Scaffold-Repo) geht **nur** die per-App-Passphrase dieser App.
- **S4** — Audit-First: vor jeder Provisionierung ein wertfreier Audit-Eintrag; schlägt der Audit-Write fehl, unterbleibt die Aktion.
- **S5** — Mutierende Endpunkte hinter `AccessGuard` **und** `CRED_ADMIN_EMAILS`-Logik (wie `deploymentsRouter`).
- **S6** — At-rest-Schutz Variante B lokal (geerbt).

## Verhalten

### Provisionierungs-Dienst (Kern, geteilt)
1. **Starke Passphrase.** Der Dienst erzeugt eine kryptografisch starke Zufalls-Passphrase (`crypto.randomBytes`, ≥ 32 Byte, url-/shell-sichere Kodierung z.B. base64url), analog zur Key-Erzeugung in `BitwardenMasterKeyService`. Die Passphrase existiert nur transient im Prozess und in der `0600`-Übergabe-Datei (siehe AC5) — nie geloggt/auditiert/in Response.
2. **Idempotente Item-Anlage.** Der Dienst legt in Bitwarden ein Item `env.gpg-passphrase-<app>` an (`<app>` = Ziel-Slug; Passwortfeld = Passphrase; `bw`-create-Technik aus `BitwardenMasterKeyService`). **Ein bereits existierendes Item wird NIEMALS überschrieben** — existiert es, ist die Provisionierung ein **No-Op** mit maschinenlesbarem Ergebnis `already-exists` + Klartext-Meldung; **keine** neue Passphrase wird erzeugt/verworfen, die vorhandene bleibt unangetastet.
3. **Zugang-Gate.** Ist der Bitwarden-Deploy-Zugang **nicht** `ready` ([[deploy-bitwarden-gpg-injection]] AC2), wird die Provisionierung **sauber übersprungen** mit Ergebnis `access-not-ready` + Hinweis — **kein** Fehler, **kein** Teil-Zustand. (Bei der Auto-Provisionierung bleibt das heutige Plugin-Backlog-Item-Verhalten der Fallback.)

### Auto-Provisionierung bei Projektanlage
4. **Auslöser.** Nach **erfolgreichem** Abschluss eines `new-project`-Laufs über **alle drei** Anlage-Wege der Fabrik-Übersicht (`NewProjectChooserDialog`) provisioniert dev-gui automatisch die per-App-Passphrase der neu angelegten App (ein Auslöser, keine Doppel-Provisionierung).
5. **Scaffold-Durchreichung via `GPG_PASS_FILE`.** Die erzeugte Passphrase wird dem Scaffold **einmalig** über eine **temporäre `0600`-Datei** bereitgestellt, deren Pfad über die **`GPG_PASS_FILE`-Kette des Plugins** an den `new-project`-Scaffold übergeben wird — **nie** über Argv, **nie** dauerhaft. Das Plugin bezieht daraus die Passphrase für das initiale `.env.gpg` (GE4). Nach Abschluss (Erfolg **oder** Fehler) wird die Datei **garantiert gelöscht** (auch im Fehlerpfad; kein verwaistes Klartext-Artefakt).
6. **Konsistenz Scaffold ↔ Bitwarden.** Dieselbe Passphrase, mit der das `.env.gpg` (GE4) erzeugt wird, wird als Bitwarden-Item `env.gpg-passphrase-<app>` hinterlegt (AC2), sodass ein späterer Deploy sie über [[deploy-bitwarden-gpg-injection]] AC14 abrufen und die App ihr `.env.gpg` entschlüsseln kann. Existiert das Item bereits (AC2 `already-exists`), wird für einen echten Neu-Scaffold **kein** abweichender Wert erzeugt — der Grenzfall „Item existiert schon bei Erst-Anlage" wird als Konflikt gemeldet (Edge-Cases), nicht still überschrieben.

### Nach-Provisionierung bestehender Apps
7. **Knopf je App.** In der Fabrik-/Deploy-Ansicht existiert je App ein Knopf „GPG-Passphrase in Bitwarden anlegen", der **denselben** Provisionierungs-Dienst mit **derselben** Idempotenz-Garantie aufruft (AC2). Für eine App mit bereits vorhandenem Item ist das Ergebnis `already-exists` (No-Op) — sichtbar quittiert, **kein** Überschreiben.
8. **Rückmeldung.** Das Ergebnis (`created` | `already-exists` | `access-not-ready` | `failed`) wird geheimnisfrei am Schirm quittiert (nie die Passphrase selbst).

### agent-flow-Doktrin (Koordination, PR gegen Fremd-Repo)
9. **Plugin-Konzept-Update per PR.** Der Doktrin-Wechsel (per-App-Passphrasen statt geteilter Fabrik-Passphrase; Passphrasen-Quelle = dev-gui-Provisionierung via `GPG_PASS_FILE`) wird im agent-flow-Plugin verankert: `docs/architecture/secrets-subsystem.md` + der `new-project`-SKILL-Text zu GE4. Umsetzung **ausschließlich** als **PR** gegen das agent-flow-Repo (Muster retro/train — **nie** Direkt-Edit aus dev-gui heraus). dev-gui-Code bleibt Bitwarden-alleinvertraut; das Plugin lernt nur die `GPG_PASS_FILE`-Quelle.

## Acceptance-Kriterien
- **AC1** — Der Provisionierungs-Dienst erzeugt eine kryptografisch starke Zufalls-Passphrase (≥ 32 Byte Entropie); der Wert erscheint in **keinem** Log/Audit/HTTP-Response/WS-Frame/Argv/Frontend-Bundle. (Testbar: Werte tauchen nirgends auf; Argv der `bw`-Aufrufe enthält keinen Passphrasen-Wert.)
- **AC2** — Der Dienst legt das Bitwarden-Item `env.gpg-passphrase-<app>` idempotent an: existiert es **nicht**, wird es mit der Passphrase erzeugt (`created`); existiert es **bereits**, ist die Aktion ein **No-Op** mit Ergebnis `already-exists` — das vorhandene Item wird **nie** überschrieben und **keine** neue Passphrase erzeugt. (Testbar: gemocktes `bw` — vorhandenes Item → kein `create`-Call, Ergebnis `already-exists`; fehlendes Item → genau ein `create`-Call ohne Wert in Argv.)
- **AC3** — Ist der Bitwarden-Deploy-Zugang **nicht** `ready`, wird die Provisionierung mit Ergebnis `access-not-ready` **übersprungen** (kein Fehler, kein Teil-Zustand, kein `create`-Call). (Testbar: `ready:false` → Dienst ruft `bw` gar nicht auf.)
- **AC4** — Nach **erfolgreichem** `new-project`-Lauf über **jeden** der drei Anlage-Wege der Fabrik-Übersicht wird die Auto-Provisionierung **genau einmal** ausgelöst. (Testbar: Erfolgs-Abschluss triggert genau einen Provisionierungs-Aufruf; ein fehlgeschlagener Lauf triggert **keinen**.)
- **AC5** — Die Passphrase wird dem Scaffold über eine **temporäre `0600`-Datei** via `GPG_PASS_FILE` bereitgestellt (nicht Argv, nicht dauerhaft); die Datei wird nach Abschluss — **auch im Fehlerpfad** — garantiert gelöscht. (Testbar: während des Laufs existiert die `0600`-Datei am `GPG_PASS_FILE`-Pfad, danach **nicht** mehr; auch bei erzwungenem Scaffold-Fehler ist sie entfernt; Passphrase steht nie in Argv.)
- **AC6** — Die im `.env.gpg` (GE4) verwendete Passphrase und der Wert des Bitwarden-Items `env.gpg-passphrase-<app>` sind **identisch** (dieselbe erzeugte Passphrase). (Testbar: die aus dem temp-File gereichte Passphrase ist derselbe Wert, mit dem das Item angelegt wird.)
- **AC7** — In der Fabrik-/Deploy-Ansicht löst ein Knopf je App die Nach-Provisionierung über **denselben** Dienst (AC2/AC3-Garantien) aus; eine bereits provisionierte App liefert `already-exists` (No-Op, quittiert), **kein** Überschreiben. (Testbar: Knopf → Endpunkt → Dienst; vorhandenes Item → `already-exists`.)
- **AC8** — Die Rückmeldung (Auto **und** Nach-Provisionierung) ist geheimnisfrei: sie meldet nur `created` | `already-exists` | `access-not-ready` | `failed` (+ Klartext-Hinweis), **nie** die Passphrase. (Testbar: Response/UI-State enthält keinen Passphrasen-Wert.)
- **AC9** — Vor jeder Provisionierung (Auto **und** Nach) wird ein wertfreier Audit-Eintrag geschrieben (Identität, Aktion `deploy:gpg-provision:<app>`, Zeit, ohne Wert); schlägt der Audit-Write fehl, unterbleibt die Provisionierung (S4). (Testbar: Audit-Eintrag ohne Wert vorhanden; Audit-Fehler → kein `create`.)
- **AC10** — Der mutierende Nach-Provisionierungs-Endpunkt liegt hinter `AccessGuard` **+** `CRED_ADMIN_EMAILS`-Logik; ohne Berechtigung `403`, **kein** `bw`-Aufruf (S5). (Testbar: unberechtigt → 403, kein `create`.)
- **AC11** — Der Doktrin-Wechsel wird im agent-flow-Plugin **per PR** (nie Direkt-Edit) verankert: `docs/architecture/secrets-subsystem.md` + `new-project`-SKILL-GE4-Text nennen als Passphrasen-Quelle die dev-gui-Provisionierung via `GPG_PASS_FILE` und die per-App-Passphrasen-Doktrin. (Nachweis: PR-Referenz gegen das agent-flow-Repo; **kein** Direkt-Commit; dev-gui-Code bleibt Bitwarden-alleinvertraut.)

## Verträge
> `bw`-Technik/GPG-Aufruf kanonisch im Verhalten; konkrete Umsetzung entscheidet `coder`/`architekt`. Der Bitwarden-Zugang wird **ausschließlich** über `BitwardenDeployLoginService` ([[deploy-bitwarden-gpg-injection]] §4.3) beschafft.

- **Provisionierungs-Dienst (intern, neuer Boundary, z.B. `PerAppGpgProvisioningService`):**
  - `provision(app, { identity }): Promise<{ result: "created" | "already-exists" | "access-not-ready" | "failed", reason? }>` — erzeugt (falls nötig) Passphrase, prüft Item-Existenz (`bw get`), legt bei Bedarf via `bw encode`/`bw create item` (stdin, kein Argv-Wert) an. Liefert **nie** die Passphrase nach außen.
  - `withScaffoldPassphrase(app, fn): Promise<…>` (Auto-Weg) — erzeugt Passphrase, schreibt sie in eine transiente `0600`-Datei, ruft `fn({ gpgPassFilePath })` (Scaffold-Lauf mit `GPG_PASS_FILE=<path>`), legt anschließend das Bitwarden-Item an, löscht die Datei im `finally` (garantiert, auch bei Fehler).
- **Nach-Provisionierungs-Endpunkt (HTTP):** `POST /api/deployments/:app/gpg-provision` — hinter `AccessGuard` + `CRED_ADMIN_EMAILS`, Audit-First. Response geheimnisfrei: `{ result, reason? }`.
- **Item-Namens-Konvention:** `env.gpg-passphrase-<app>` (`<app>` = Ziel-Slug; identisch zur Deploy-Abruf-Konvention in [[deploy-bitwarden-gpg-injection]] AC15). Zeichensatz-/Längen-Validierung wie beim bestehenden `gpgBwItem`-Feld.

## Edge-Cases & Fehlerverhalten
- **Item existiert bei echter Erst-Anlage (Kollision):** `already-exists` gemeldet; die neu erzeugte (transiente) Passphrase wird verworfen — **kein** Überschreiben. Bei der Auto-Provisionierung eines echten Neu-Projekts ist das ein unerwarteter Konflikt (Slug-Wiederverwendung) und wird als Warnung quittiert, damit der Owner das Item prüfen kann.
- **`bw create` schlägt fehl (Netz/Auth):** Ergebnis `failed` mit sanitisiertem, geheimnisfreiem `reason`; **kein** Teil-Zustand (kein `.env.gpg`, das auf einem Item ohne Gegenstück beruht — Reihenfolge so wählen, dass ein aktives `.env.gpg` immer ein Bitwarden-Gegenstück hat, analog Master-Key-Prinzip).
- **Scaffold-Lauf bricht ab, nachdem die temp-Datei geschrieben wurde:** temp-Datei wird trotzdem gelöscht (AC5 `finally`); die Provisionierung meldet `failed` — kein verwaistes Klartext-File.
- **Zugang wird zwischen Generierung und Item-Anlage `unready`:** wie `access-not-ready` behandelt; transiente Passphrase verworfen.
- **`GPG_PASSPHRASE`/`.env.gpg` der App bleibt Sache der App** — dev-gui erzeugt nur das initiale `.env.gpg` über den Scaffold, nicht dessen spätere Inhalte.

## NFRs
- **Sicherheit (Floor, hart):** Passphrase + Bitwarden-Zugang nie in Log/Audit/Response/WS/Argv/Bundle; temp-Datei `0600` + garantiert gelöscht; `bw`-Werte nur via stdin/Env; Audit-First; `CRED_ADMIN_EMAILS`.
- **Robustheit:** idempotent (nie überschreiben); kein Teil-Zustand bei Fehlern; garantierter temp-File-Cleanup (auch Fehlerpfad).
- **Boundary-Disziplin:** genau **eine** Komponente spricht mit Bitwarden (`BitwardenDeployLoginService` für Login/Read, `bw`-create-Technik aus `BitwardenMasterKeyService` wiederverwendet); der Zugang verlässt dev-gui nie.
- **A11y:** Nach-Provisionierungs-Knopf + Quittung WCAG 2.1 AA (Label, Fehlerzuordnung, Touch-Target ≥ 44 px, Loading-State).

## Nicht-Ziele
- Rotation einer bereits provisionierten Passphrase → [[per-app-gpg-passphrase-rotation]].
- Master-Key-Rotation des Credential-Stores → [[credential-key-rotation]].
- Änderung des agent-flow-Plugins per Direkt-Edit (nur PR, AC11).
- Bitwarden-Zugang jemals nach außen geben (S3).

## Offene Punkte (bewusst, an `architekt`)
- **Naht der Auto-Provisionierung am `new-project`-Abschluss:** `new-project` läuft heute interaktiv über den PTY-`CommandService` (`.claude/CLAUDE.md`) bzw. headless über die Runner-Familie. Wo genau der „erfolgreich abgeschlossen"-Hook sitzt und wie die `GPG_PASS_FILE`-Kette VOR GE4 verfügbar gemacht wird (Passphrase muss **während** des Scaffolds existieren, das Bitwarden-Item entsteht **danach**), entscheidet `architekt` — inkl. der Frage, ob dafür ein eigener ADR nötig ist. Diese Spec legt nur das beobachtbare Verhalten + den Floor fest.

## Abhängigkeiten
- [[deploy-bitwarden-gpg-injection]] (Bitwarden-Deploy-Zugang, `BitwardenDeployLoginService`, per-App-Injektion, Item-Namens-Konvention; F-072).
- [[bitwarden-master-key-unlock]] (`bw`-create-item-Technik wiederverwendet).
- [[access-and-guardrails]] (AccessGuard, `CRED_ADMIN_EMAILS`, Audit-First, Floor).
- Koordination: agent-flow-Plugin `secrets-subsystem.md` + `new-project`-SKILL (per PR, AC11).
