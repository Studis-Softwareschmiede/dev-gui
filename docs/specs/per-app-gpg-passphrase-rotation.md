---
id: per-app-gpg-passphrase-rotation
title: Per-App-GPG-Passphrase — sichere Zwei-Phasen-Rotation (beweisen, umschalten, alt erst am Schluss weg)
status: active
area: deployment
spec_format: use-case-2.0
version: 1
---

# Spec: Per-App-GPG-Passphrase — sichere Zwei-Phasen-Rotation (`per-app-gpg-passphrase-rotation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. **Security-kritisch.**

## Zweck
Die per-App-GPG-Passphrase einer App **sicher rotieren**, ohne je einen Zustand zu erzeugen, aus dem sich das `.env.gpg` der App nicht mehr entschlüsseln lässt. Goldenes Prinzip (Owner 2026-07-13): **beweisen, umschalten, alt erst am Schluss weg** — die alte Passphrase bleibt als Rollback-Anker erhalten, bis ein Deploy mit der neuen nachweislich durchlief. Jeder Fehlschlag vor dem Umschalt-Punkt = Abbruch ohne Änderung.

## Kontext & Abgrenzung
Baut auf [[per-app-gpg-passphrase-provisioning]] (Anlage) und [[deploy-bitwarden-gpg-injection]] (Zugang + Injektion) auf. Rotiert das Item `env.gpg-passphrase-<app>` **plus** das zugehörige `.env.gpg` der App. Das Item führt zusätzlich zum Passwortfeld (aktive Passphrase) zwei Felder: **`naechste`** (Kandidat während der Rotation) und **`vorherige`** (Rollback-Anker nach dem Umschalten).

**Nicht Teil dieser Spec:** Master-Key-Rotation des Credential-Stores ([[credential-key-rotation]]) — dasselbe Muster, anderes Artefakt. Erst-Anlage/Provisionierung → [[per-app-gpg-passphrase-provisioning]].

## Sicherheits-Leitplanken
Die Leitplanken **S1–S6** aus [[deploy-bitwarden-gpg-injection]] §3 gelten unverändert (kein Klartext in Log/Audit/Response/Argv; `bw`-Werte nur via stdin/Env; Zugang verlässt dev-gui nie; Audit-First; `AccessGuard` + `CRED_ADMIN_EMAILS`).

## Verhalten (Zwei-Phasen-Muster)
1. **(a) Kandidat hinterlegen.** Eine starke neue Passphrase (≥ 32 Byte Entropie) wird erzeugt und **zusätzlich** ins Bitwarden-Item geschrieben (Feld `naechste`); die aktive Passphrase (Passwortfeld) und `vorherige` bleiben **unangetastet**. Bis hierher ist alles umkehrbar (Kandidat verwerfen = Feld `naechste` leeren).
2. **(b) Beweis-Runde (hart, vor jeder Mutation am aktiven Zustand).** Das aktuelle `.env.gpg` wird mit der **ALTEN** (aktiven) Passphrase entschlüsselt; der Klartext wird mit der **NEUEN** Passphrase (`naechste`) in eine **NEUE** Datei verschlüsselt; diese neue Datei wird probeweise wieder entschlüsselt und ihr Klartext **byte-/wertgleich** gegen den Klartext aus der Alt-Entschlüsselung verglichen. **Jeder** Fehlschlag (Alt-Decrypt / Neu-Encrypt / Probe-Decrypt / Inhaltsvergleich) ⇒ **Abbruch ohne jede Änderung** am aktiven `.env.gpg` und am aktiven Item-Passwortfeld (`naechste` darf verworfen werden).
3. **(c) Umschalten (Commit-Punkt).** Erst nach grüner Beweis-Runde: **zuerst Bitwarden** — die neue Passphrase wird zum aktiven Passwortfeld, der bisherige aktive Wert wandert ins Feld **`vorherige`** (Rollback-Anker), `naechste` wird geleert. **Danach** wird das mit der neuen Passphrase verschlüsselte `.env.gpg` committet (Reihenfolge: Bitwarden vor `.env.gpg`, damit nie ein `.env.gpg` aktiv ist, dessen Passphrase nicht in Bitwarden als aktiv geführt wird).
4. **(d) Alt erst am Schluss weg (manuell).** Das Feld `vorherige` wird **ausschließlich** manuell per Knopf entsorgt — und zwar **erst**, nachdem ein Deploy mit der neuen Passphrase nachweislich durchlief. Kein automatisches Löschen des Rollback-Ankers im Rotations-Flow.
5. **Umkehrbarkeit bis (c).** Vor dem Umschalt-Punkt ist jeder Zwischenzustand vollständig umkehrbar: aktives `.env.gpg` unverändert, aktives Item-Passwortfeld unverändert, nur `naechste` gesetzt. Der Commit-Punkt ist Schritt (c).
6. **Schutz (Floor, hart).** Rotation hinter `AccessGuard` + `CRED_ADMIN_EMAILS` + Audit-First (Audit nennt nur Aktion/Phase, **nie** Passphrasen-Werte). Weder alte noch neue Passphrase noch Klartext des `.env.gpg` erscheint in Log/Audit/Response/WS/Argv/Bundle.
7. **UI-Muster.** Die Rotation wird über eine **zweistufige Quittung** ausgelöst (Muster Backup-Settings, [[credential-backup]]): Stufe 1 „Kandidat + Beweis-Runde", Stufe 2 „umgeschaltet". Der Rollback-Anker-Aufräum-Knopf ist eine getrennte, explizit bestätigte Aktion.

## Acceptance-Kriterien
- **AC1** — Eine gestartete Rotation schreibt die neue Passphrase **zusätzlich** ins Feld `naechste` des Items `env.gpg-passphrase-<app>`; das aktive Passwortfeld und `vorherige` bleiben **unverändert**. (Testbar: nach (a) hat das Item ein `naechste`, aktives Feld identisch zu vorher.)
- **AC2** — Die Beweis-Runde entschlüsselt `.env.gpg` mit der **alten** Passphrase, verschlüsselt den Klartext mit der **neuen** in eine **neue** Datei, entschlüsselt diese probeweise wieder und vergleicht den Klartext **wertgleich**. (Testbar: bei manipuliertem Zwischenschritt schlägt der Vergleich an.)
- **AC3** — **Jeder** Fehlschlag in der Beweis-Runde (Alt-Decrypt / Neu-Encrypt / Probe-Decrypt / Vergleich) ⇒ **Abbruch ohne Änderung**: aktives `.env.gpg` und aktives Item-Passwortfeld bleiben unangetastet; das Ergebnis meldet einen klassifizierten, geheimnisfreien Fehler. (Testbar: bei erzwungenem Fehler ist der aktive Zustand byte-identisch zu vorher, kein Commit.)
- **AC4** — Beim Umschalten (c) wird **zuerst** Bitwarden aktualisiert (neu → aktives Feld, alt → `vorherige`, `naechste` geleert), **danach** das neu verschlüsselte `.env.gpg` committet. (Testbar: Reihenfolge; nie ein aktives `.env.gpg`, dessen Passphrase nicht als aktiv in Bitwarden steht.)
- **AC5** — Das Feld `vorherige` wird **nie** automatisch im Rotations-Flow gelöscht; nur ein **manueller**, explizit bestätigter Knopf entsorgt es. (Testbar: nach (c) existiert `vorherige`; erst der manuelle Aufräum-Aufruf entfernt es.)
- **AC6** — Vor jeder Phase (a/b/c und der manuellen Entsorgung) wird ein wertfreier Audit-Eintrag geschrieben (Identität, Aktion/Phase, Zeit, ohne Wert); schlägt der Audit-Write fehl, unterbleibt die Aktion (Audit-First). (Testbar: Audit-Einträge je Phase ohne Werte.)
- **AC7** — Rotation + Entsorgung liegen hinter `AccessGuard` **+** `CRED_ADMIN_EMAILS`; ohne Berechtigung `403`, **keine** Mutation. Weder alte noch neue Passphrase noch `.env.gpg`-Klartext erscheint in Log/Audit/Response/WS/Argv/Bundle. (Testbar: unberechtigt → 403; Werte tauchen nirgends auf.)
- **AC8** — Die UI löst die Rotation über eine **zweistufige Quittung** aus (Stufe 1 Kandidat+Beweis, Stufe 2 umgeschaltet); bleibt eine Stufe aus/fehlerhaft, erscheint eine **stufen-genaue, geheimnisfreie** Warnung statt grüner Quittung. (Testbar über UI-State je Stufe.)
- **AC9** — Der Rollback-Anker-Aufräum-Knopf ist eine **getrennte, explizit bestätigte** UI-Aktion (nicht Teil der Rotations-Stufen) und ist deaktiviert/mit Warnung versehen, solange kein Deploy mit der neuen Passphrase bestätigt wurde. (Testbar: Aufräum-Aktion erfordert eigene Bestätigung.)

## Verträge
> GPG-Aufrufe (Passphrase nie über Argv) + `bw`-Item-Feld-Updates kanonisch im Verhalten; konkrete Technik entscheidet `coder`/`architekt`.

- **Rotations-Dienst (intern, neuer Boundary, z.B. `PerAppGpgRotationService`):**
  - `startRotation(app, { identity }): Promise<{ ok, phase: "candidate-proved" | "aborted", errorClass? }>` — führt (a)+(b) aus; bei Erfolg ist `naechste` gesetzt + Beweis grün, aktiver Zustand unangetastet.
  - `commitRotation(app, { identity }): Promise<{ ok, errorClass? }>` — führt (c) aus (Bitwarden vor `.env.gpg`).
  - `discardPrevious(app, { identity }): Promise<{ ok }>` — Schritt (d), manuell, explizit bestätigt.
- **HTTP-Endpunkte:** `POST /api/deployments/:app/gpg-rotate/start`, `POST /api/deployments/:app/gpg-rotate/commit`, `POST /api/deployments/:app/gpg-rotate/discard-previous` — alle hinter `AccessGuard` + `CRED_ADMIN_EMAILS`, Audit-First, Response geheimnisfrei (`{ ok, phase?, errorClass? }`).
- **Item-Felder:** Passwortfeld = aktive Passphrase; Custom-Felder `naechste` (Kandidat, transient während Rotation) und `vorherige` (Rollback-Anker) im Item `env.gpg-passphrase-<app>`.
- **Fehlerklassen (geheimnisfrei):** `decrypt-old-failed` | `encrypt-new-failed` | `verify-failed` | `bw-update-failed` | `commit-failed` | `error`.

## Edge-Cases & Fehlerverhalten
- **`.env.gpg` fehlt / nicht auffindbar** ⇒ klarer Fehler vor (a), keine Kandidaten-Anlage.
- **Item hat bereits ein `naechste` (Rotation läuft schon)** ⇒ Konflikt-Meldung; kein zweiter überlappender Kandidat ohne bewusstes Verwerfen.
- **Bitwarden-Update in (c) grün, `.env.gpg`-Commit scheitert** ⇒ Bitwarden führt neu als aktiv, alt als `vorherige`; der `.env.gpg`-Commit-Fehler wird gemeldet — der Rollback-Anker `vorherige` erlaubt eine erneute, saubere Wiederholung/Rückkehr. Kein stiller Misch-Zustand (klare Fehlermeldung, keine automatische Entsorgung von `vorherige`).
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
- [[access-and-guardrails]] (AccessGuard, `CRED_ADMIN_EMAILS`, Audit-First, Floor).
