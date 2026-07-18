---
id: per-app-gpg-passphrase-rotation
title: Per-App-GPG-Passphrase — sichere Zwei-Phasen-Rotation (beweisen, umschalten, alt erst am Schluss weg)
status: active
area: deployment
spec_format: use-case-2.0
version: 3
---

# Spec: Per-App-GPG-Passphrase — sichere Zwei-Phasen-Rotation (`per-app-gpg-passphrase-rotation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. **Security-kritisch.**

## Zweck
Die per-App-GPG-Passphrase einer App **sicher rotieren**, ohne je einen Zustand zu erzeugen, aus dem sich das `.env.gpg` der App nicht mehr entschlüsseln lässt. Goldenes Prinzip (Owner 2026-07-13): **beweisen, umschalten, alt erst am Schluss weg** — die alte Passphrase bleibt als Rollback-Anker erhalten, bis ein Deploy mit der neuen nachweislich durchlief. Jeder Fehlschlag vor dem Umschalt-Punkt = Abbruch ohne Änderung.

## Kontext & Abgrenzung
Baut auf [[per-app-gpg-passphrase-provisioning]] (Anlage) und [[deploy-bitwarden-gpg-injection]] (Zugang + Injektion) auf. Rotiert das Item `env.gpg-passphrase-<app>` **plus** das zugehörige `.env.gpg` der App. Das Item führt zusätzlich zum Passwortfeld (aktive Passphrase) zwei Felder: **`naechste`** (Kandidat während der Rotation) und **`vorherige`** (Rollback-Anker nach dem Umschalten).

**Nicht Teil dieser Spec:** Master-Key-Rotation des Credential-Stores ([[credential-key-rotation]]) — dasselbe Muster, anderes Artefakt. Erst-Anlage/Provisionierung → [[per-app-gpg-passphrase-provisioning]].

### `.env.gpg`-Zugriffsweg (Owner-Entscheidung 2026-07-13)
Woher dev-gui das `.env.gpg` der Ziel-App liest und wohin es zurückschreibt, ist entschieden: **dev-gui nutzt seinen lokalen Workspace-Klon der App** (bestehende Workspace-Verwaltung — Klonen/Pull existiert: [[github-repo-clone]], [[workspace-repos]], `WORKSPACE_DIR` aus [[workspace-path-config]]). Das `.env.gpg` lebt im App-Repo, **nicht** im Image; dev-gui liest/schreibt es über den Klon. Ablauf: **frischer Pull** des Klons **vor** der Beweis-Runde; Beweis-Runde + Neu-Verschlüsselung finden **im Klon** statt; das Rückschreiben erfolgt beim Umschalten (c) per **direktem Commit + Push auf den Default-Branch** der App (kein PR — bewusst: minimiertes Zeitfenster zwischen Bitwarden-Item-Umschaltung und Datei im Repo; ein PR-Fenster würde Deploys mit neuer Passphrase auf alter Datei brechen lassen). Push über die bestehende GitHub-App-Auth.

## Sicherheits-Leitplanken
Die Leitplanken **S1–S6** aus [[deploy-bitwarden-gpg-injection]] §3 gelten unverändert (kein Klartext in Log/Audit/Response/Argv; `bw`-Werte nur via stdin/Env; Zugang verlässt dev-gui nie; Audit-First; `AccessGuard` + `CRED_ADMIN_EMAILS`).

## Verhalten (Zwei-Phasen-Muster)
1. **(a) Kandidat hinterlegen.** Eine starke neue Passphrase (≥ 32 Byte Entropie) wird erzeugt und **zusätzlich** ins Bitwarden-Item geschrieben (Feld `naechste`); die aktive Passphrase (Passwortfeld) und `vorherige` bleiben **unangetastet**. Bis hierher ist alles umkehrbar (Kandidat verwerfen = Feld `naechste` leeren).
2. **(b) Beweis-Runde (hart, vor jeder Mutation am aktiven Zustand).** **Vor** der Beweis-Runde wird der **lokale Workspace-Klon** der App **frisch gepullt** (fehlt der Klon → Abbruch vor (a), siehe Edge-Cases). Das aktuelle `.env.gpg` **aus dem Klon** wird mit der **ALTEN** (aktiven) Passphrase entschlüsselt; der Klartext wird mit der **NEUEN** Passphrase (`naechste`) in eine **NEUE** Datei (im Klon) verschlüsselt; diese neue Datei wird probeweise wieder entschlüsselt und ihr Klartext **byte-/wertgleich** gegen den Klartext aus der Alt-Entschlüsselung verglichen. **Jeder** Fehlschlag (Alt-Decrypt / Neu-Encrypt / Probe-Decrypt / Inhaltsvergleich) ⇒ **Abbruch ohne jede Änderung** am aktiven `.env.gpg` und am aktiven Item-Passwortfeld (`naechste` darf verworfen werden).
3. **(c) Umschalten (Commit-Punkt).** Erst nach grüner Beweis-Runde: **zuerst Bitwarden** — die neue Passphrase wird zum aktiven Passwortfeld, der bisherige aktive Wert wandert ins Feld **`vorherige`** (Rollback-Anker), `naechste` wird geleert. **Danach** wird das mit der neuen Passphrase verschlüsselte `.env.gpg` **im Klon** committet und per **direktem Commit + Push auf den Default-Branch** der App zurückgeschrieben (kein PR; Reihenfolge: Bitwarden vor `.env.gpg`, damit nie ein `.env.gpg` aktiv ist, dessen Passphrase nicht in Bitwarden als aktiv geführt wird). **Beide-Seiten-Atomarität:** scheitert der Push, wird die Bitwarden-Umschaltung **rückgängig** gemacht (Item auf den Zustand vor (c): alte Passphrase wieder aktiv, neue zurück ins Feld `naechste`, `vorherige` geleert). Die Rotation gilt erst als **abgeschlossen**, wenn **beide** Seiten (Item **und** Repo) umgestellt sind.
4. **(d) Alt erst am Schluss weg (manuell).** Das Feld `vorherige` wird **ausschließlich** manuell per Knopf entsorgt — und zwar **erst**, nachdem ein Deploy mit der neuen Passphrase nachweislich durchlief. Kein automatisches Löschen des Rollback-Ankers im Rotations-Flow.
5. **Umkehrbarkeit bis (c).** Vor dem Umschalt-Punkt ist jeder Zwischenzustand vollständig umkehrbar: aktives `.env.gpg` unverändert, aktives Item-Passwortfeld unverändert, nur `naechste` gesetzt. Der Commit-Punkt ist Schritt (c).
6. **Schutz (Floor, hart).** Rotation hinter `AccessGuard` + `CRED_ADMIN_EMAILS` + Audit-First (Audit nennt nur Aktion/Phase, **nie** Passphrasen-Werte). Weder alte noch neue Passphrase noch Klartext des `.env.gpg` erscheint in Log/Audit/Response/WS/Argv/Bundle.
7. **UI-Muster.** Die Rotation wird über eine **zweistufige Quittung** ausgelöst (Muster Backup-Settings, [[credential-backup]]): Stufe 1 „Kandidat + Beweis-Runde", Stufe 2 „umgeschaltet". Der Rollback-Anker-Aufräum-Knopf ist eine getrennte, explizit bestätigte Aktion. **(v3, Owner 2026-07-18):** Die Rotations-UI lebt seit dem Deployments-Unterbereich-Umbau ([[deployments-gpg-subview]]) im linken Unterbereich „GPG-Schlüssel" und wird **kompakt je gewählter App (Dropdown)** aufgeklappt statt als Liste aller Apps. Zweistufige Quittung, Bestätigungs-Gates, Sicherheitsmechanik und **alle Endpunkte bleiben unverändert** — nur der Ort/die Darstellung ändert sich (AC14).

## Acceptance-Kriterien
- **AC1** — Eine gestartete Rotation schreibt die neue Passphrase **zusätzlich** ins Feld `naechste` des Items `env.gpg-passphrase-<app>`; das aktive Passwortfeld und `vorherige` bleiben **unverändert**. (Testbar: nach (a) hat das Item ein `naechste`, aktives Feld identisch zu vorher.)
- **AC2** — Die Beweis-Runde entschlüsselt `.env.gpg` mit der **alten** Passphrase, verschlüsselt den Klartext mit der **neuen** in eine **neue** Datei, entschlüsselt diese probeweise wieder und vergleicht den Klartext **wertgleich**. (Testbar: bei manipuliertem Zwischenschritt schlägt der Vergleich an.)
- **AC3** — **Jeder** Fehlschlag in der Beweis-Runde (Alt-Decrypt / Neu-Encrypt / Probe-Decrypt / Vergleich) ⇒ **Abbruch ohne Änderung**: aktives `.env.gpg` und aktives Item-Passwortfeld bleiben unangetastet; das Ergebnis meldet einen klassifizierten, geheimnisfreien Fehler. (Testbar: bei erzwungenem Fehler ist der aktive Zustand byte-identisch zu vorher, kein Commit.)
- **AC4** — Beim Umschalten (c) wird **zuerst** Bitwarden aktualisiert (neu → aktives Feld, alt → `vorherige`, `naechste` geleert), **danach** das neu verschlüsselte `.env.gpg` **im Workspace-Klon** committet und per **direktem Commit + Push auf den Default-Branch** der App zurückgeschrieben (kein PR, bestehende GitHub-App-Auth). (Testbar: Reihenfolge; nie ein aktives `.env.gpg`, dessen Passphrase nicht als aktiv in Bitwarden steht; Rückschreiben = Commit + Push auf Default-Branch, kein PR.)
- **AC5** — Das Feld `vorherige` wird **nie** automatisch im Rotations-Flow gelöscht; nur ein **manueller**, explizit bestätigter Knopf entsorgt es. (Testbar: nach (c) existiert `vorherige`; erst der manuelle Aufräum-Aufruf entfernt es.)
- **AC6** — Vor jeder Phase (a/b/c und der manuellen Entsorgung) wird ein wertfreier Audit-Eintrag geschrieben (Identität, Aktion/Phase, Zeit, ohne Wert); schlägt der Audit-Write fehl, unterbleibt die Aktion (Audit-First). (Testbar: Audit-Einträge je Phase ohne Werte.)
- **AC7** — Rotation + Entsorgung liegen hinter `AccessGuard` **+** `CRED_ADMIN_EMAILS`; ohne Berechtigung `403`, **keine** Mutation. Weder alte noch neue Passphrase noch `.env.gpg`-Klartext erscheint in Log/Audit/Response/WS/Argv/Bundle. (Testbar: unberechtigt → 403; Werte tauchen nirgends auf.)
- **AC8** — Die UI löst die Rotation über eine **zweistufige Quittung** aus (Stufe 1 Kandidat+Beweis, Stufe 2 umgeschaltet); bleibt eine Stufe aus/fehlerhaft, erscheint eine **stufen-genaue, geheimnisfreie** Warnung statt grüner Quittung. (Testbar über UI-State je Stufe.)
- **AC9** — Der Rollback-Anker-Aufräum-Knopf ist eine **getrennte, explizit bestätigte** UI-Aktion (nicht Teil der Rotations-Stufen) und ist deaktiviert/mit Warnung versehen, solange kein Deploy mit der neuen Passphrase bestätigt wurde. (Testbar: Aufräum-Aktion erfordert eigene Bestätigung.)
- **AC10** — Lese-/Schreibpfad auf das `.env.gpg` der Ziel-App ist der **lokale Workspace-Klon** (`WORKSPACE_DIR`, [[github-repo-clone]]/[[workspace-repos]]); **vor** der Beweis-Runde (b) wird der Klon **frisch gepullt**, und Beweis-Runde + Neu-Verschlüsselung finden **im Klon** statt. (Testbar: Rotation liest/schreibt `.env.gpg` im Klon-Pfad; vor (b) erfolgt ein Pull.)
- **AC11** — Beim Umschalten (c) wird das neu verschlüsselte `.env.gpg` per **direktem Commit + Push auf den Default-Branch** der App zurückgeschrieben (**kein PR**), über die bestehende GitHub-App-Auth. (Testbar: Rückschreiben löst genau einen Commit + Push auf den Default-Branch aus, keinen PR/Branch.)
- **AC12** — **Fehlt der Workspace-Klon** der App, bricht die Rotation **VOR jeder Änderung** ab (vor (a)) mit klarem, geheimnisfreiem Hinweis („App zuerst in den Workspace klonen"); **keine** Kandidaten-Anlage, **keine** Bitwarden-Mutation, **kein** Repo-Zugriff. (Testbar: fehlender Klon → Abbruch vor (a), aktiver Zustand + Item unverändert.)
- **AC13** — **Scheitert der Push** nach der Bitwarden-Umschaltung (c), wird die Bitwarden-Umschaltung **rückgängig** gemacht (Item zurück auf den Zustand vor (c): alte Passphrase wieder aktiv, neue zurück ins Feld `naechste`, `vorherige` geleert) und ein klassifizierter, geheimnisfreier Fehler gemeldet; die Rotation gilt erst als **abgeschlossen**, wenn **beide** Seiten (Item **und** Repo) umgestellt sind. (Testbar: erzwungener Push-Fehler → Bitwarden-Item byte-identisch zum Zustand vor (c), Rotation meldet `push-failed`, kein Misch-Zustand.)
- **AC14 (v3, Owner 2026-07-18)** — Die Rotations-UI wird im Unterbereich „GPG-Schlüssel" ([[deployments-gpg-subview]]) **kompakt je gewählter App** (App-Dropdown-Auswahl) aufgeklappt, **nicht** mehr als Liste aller Apps; die zweistufige Quittung (AC8), der getrennte Rollback-Anker-Aufräum-Knopf (AC9) und **alle** Rotations-Endpunkte/-Sicherheitsmechanik (AC1–AC13) bleiben **unverändert** und gelten fort. (Testbar: Rotation wird für die im Dropdown gewählte App gerendert; die drei Endpunkte `.../gpg-rotate/{start,commit,discard-previous}` werden unverändert genutzt; keine Liste aller Apps mehr.)

## Verträge
> GPG-Aufrufe (Passphrase nie über Argv) + `bw`-Item-Feld-Updates kanonisch im Verhalten; konkrete Technik entscheidet `coder`/`architekt`.

- **Rotations-Dienst (intern, neuer Boundary, z.B. `PerAppGpgRotationService`):**
  - `startRotation(app, { identity }): Promise<{ ok, phase: "candidate-proved" | "aborted", errorClass? }>` — führt (a)+(b) aus; bei Erfolg ist `naechste` gesetzt + Beweis grün, aktiver Zustand unangetastet.
  - `commitRotation(app, { identity }): Promise<{ ok, errorClass? }>` — führt (c) aus (Bitwarden vor `.env.gpg`).
  - `discardPrevious(app, { identity }): Promise<{ ok }>` — Schritt (d), manuell, explizit bestätigt.
- **HTTP-Endpunkte:** `POST /api/deployments/:app/gpg-rotate/start`, `POST /api/deployments/:app/gpg-rotate/commit`, `POST /api/deployments/:app/gpg-rotate/discard-previous` — alle hinter `AccessGuard` + `CRED_ADMIN_EMAILS`, Audit-First, Response geheimnisfrei (`{ ok, phase?, errorClass? }`).
- **Item-Felder:** Passwortfeld = aktive Passphrase; Custom-Felder `naechste` (Kandidat, transient während Rotation) und `vorherige` (Rollback-Anker) im Item `env.gpg-passphrase-<app>`.
- **`.env.gpg`-Zugriffsweg:** über den lokalen Workspace-Klon (`WORKSPACE_DIR`, bestehende Klon-/Pull-Verwaltung [[github-repo-clone]]/[[workspace-repos]]); frischer Pull vor (b), Neu-Verschlüsselung im Klon, Rückschreiben in (c) per direktem Commit + Push auf den Default-Branch (kein PR), GitHub-App-Auth. Klon fehlt → Abbruch vor (a) (AC12). Push scheitert → Bitwarden-Rückabwicklung (AC13).
- **Fehlerklassen (geheimnisfrei):** `clone-missing` | `access-not-ready` | `decrypt-old-failed` | `encrypt-new-failed` | `verify-failed` | `bw-update-failed` | `push-failed` | `commit-failed` | `branch-mismatch` | `error`. (`access-not-ready` deckt den Edge-Case „Zugang nicht ready" ab, geerbt aus [[deploy-bitwarden-gpg-injection]] AC12-Linie — siehe Edge-Cases. `branch-mismatch`: der Klon steht nicht auf dem Default-Branch der App — z. B. weil er manuell im Terminal auf einen anderen Branch umgeschaltet wurde — Rückschreiben wird hart abgebrochen statt still auf den Nicht-Default-Branch zu pushen; Bitwarden-Umschaltung wird wie bei `push-failed` zurückgerollt, AC13.)

## Edge-Cases & Fehlerverhalten
- **Workspace-Klon fehlt** ⇒ Abbruch **vor (a)** mit `clone-missing` + klarem Hinweis („App zuerst in den Workspace klonen"); keine Kandidaten-Anlage, keine Bitwarden-Mutation, kein Repo-Zugriff (AC12).
- **`.env.gpg` fehlt / nicht auffindbar** (Klon vorhanden, Datei fehlt) ⇒ klarer Fehler vor (a), keine Kandidaten-Anlage.
- **Item hat bereits ein `naechste` (Rotation läuft schon)** ⇒ Konflikt-Meldung; kein zweiter überlappender Kandidat ohne bewusstes Verwerfen.
- **Bitwarden-Update in (c) grün, `.env.gpg`-Push scheitert** ⇒ die Bitwarden-Umschaltung wird **rückgängig** gemacht (Item auf den Zustand vor (c): alte Passphrase aktiv, neue zurück ins Feld `naechste`, `vorherige` geleert); Fehler `push-failed` gemeldet. Kein stiller Misch-Zustand; die Rotation gilt erst als abgeschlossen, wenn Item **und** Repo umgestellt sind (AC13). *(Owner 2026-07-13: bewusste Abkehr vom früheren „Bitwarden bleibt umgeschaltet, `vorherige` als Wiederanlauf-Anker" — die minimierte Zwei-Seiten-Atomarität schützt Deploys, die sonst mit neuer Passphrase auf alter Datei brechen würden.)*
- **Zugang nicht `ready`** ⇒ Abbruch mit `access-not-ready`-artigem Hinweis (geerbt aus [[deploy-bitwarden-gpg-injection]] AC12-Linie), keine Mutation.
- **Manipuliertes `.env.gpg` (GPG-Fehler)** ⇒ `decrypt-old-failed`, Abbruch ohne Änderung.

## NFRs
- **Sicherheit (Floor, hart):** keine Passphrase / kein `.env.gpg`-Klartext in Log/Audit/Response/WS/Argv/Bundle; GPG-Passphrase nie über Argv; alle Datei-Writes atomar (tmp+rename); Audit-First; `CRED_ADMIN_EMAILS`.
- **Robustheit:** umkehrbar bis zum Commit-Punkt (c); Rollback-Anker bleibt bis manueller, deploy-bestätigter Entsorgung; kein Teil-/Misch-Zustand.
- **A11y:** zweistufige Quittung + Aufräum-Knopf WCAG 2.1 AA (Labels, Fokusführung, Bestätigungs-States, Touch-Targets ≥ 44 px).

## Nicht-Ziele
- Erst-Anlage/Provisionierung → [[per-app-gpg-passphrase-provisioning]].
- Master-Key-Rotation des Credential-Stores → [[credential-key-rotation]].
- Automatische zeitgesteuerte Rotation (hier on-demand).

## Abhängigkeiten
- [[per-app-gpg-passphrase-provisioning]] (Anlage; Item-Namens-Konvention).
- [[deploy-bitwarden-gpg-injection]] (Bitwarden-Zugang, Login-Service, Injektion, Guard-Linie).
- [[credential-backup]] (UI-Muster zweistufige Quittung).
- [[deployments-gpg-subview]] (v3: Rotations-UI lebt kompakt je gewählter App im Unterbereich „GPG-Schlüssel"; Endpunkte/Logik unverändert, AC14).
- [[access-and-guardrails]] (AccessGuard, `CRED_ADMIN_EMAILS`, Audit-First, Floor).
- [[github-repo-clone]] / [[workspace-repos]] / [[workspace-path-config]] (Workspace-Klon + Pull, `WORKSPACE_DIR` — `.env.gpg`-Zugriffsweg, Owner 2026-07-13).
