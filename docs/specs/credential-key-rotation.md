---
id: credential-key-rotation
title: Master-Key-Rotation des Credential-Stores (atomare Re-Encryption + datiertes Schlüssel-Archiv)
status: active
area: einstellungen
spec_format: use-case-2.0
version: 2
---

# Spec: Master-Key-Rotation des Credential-Stores (`credential-key-rotation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.
> **v2 — ENT-DEFERRED + Archiv-Modell (Owner 2026-07-13, löst S-083 / #194).** Der frühere DEFERRED-Status ist **aufgehoben** (Owner-Auftrag 2026-07-13); diese Spec wird jetzt umgesetzt. Das rollende **current/previous**-Item-Fenster aus v1 wird durch ein **datiertes Schlüssel-Archiv im Feld des Items `dev-gui-master-key`** präzisiert (AC11–AC13 unten): der alte Key wird **nicht gelöscht**, sondern **datiert archiviert**, solange alte S3/R2-GPG-Backups existieren, die ihn zum Entschlüsseln brauchen; unmittelbar nach der Rotation wird ein **frisches Off-Host-Backup mit dem neuen Key** erzeugt. Wo v1-Text (rollendes current/previous-Item-Fenster) und v2-Archiv-Modell abweichen, gilt **v2**.

## Zweck
Den Master-Key des Credential-Stores (`DEVGUI_CRED_MASTER_KEY`, [[credential-master-key-decoupling]]) **sicher rotieren**: das gesamte `secrets.enc.json` wird vom alten auf einen neuen Master-Key re-verschlüsselt, der neue Key wird in Bitwarden als rollendes current/previous-Fenster geführt, und **jeder** Schritt ist umkehrbar bis zum atomaren Commit-Punkt. Goldenes Prinzip: **alten Key/Zustand nie wegwerfen, bis der neue verifiziert ist.** Nur `DEVGUI_CRED_MASTER_KEY` wird rotiert — **nie** `GPG_PASSPHRASE` (Entkopplung aus [[credential-master-key-decoupling]] ist Voraussetzung).

## Verhalten
1. **Atomare Re-Encryption.** Rotation läuft strikt in dieser Reihenfolge:
   - (a) **Entschlüsseln** aller Einträge mit dem **alten** Key (in-memory, transient).
   - (b) **Verschlüsseln** aller Einträge mit dem **neuen** Key in eine **NEUE** Datei (`secrets.enc.json.rotate-tmp`, frischer Salt/KDF-Block, frische IVs).
   - (c) **Round-trip-Verifikation:** die neue Datei wird mit dem **neuen** Key vollständig wieder entschlüsselt und gegen die Klartexte aus (a) verglichen — **jeder** Eintrag muss byte-/wertgleich zurückkommen.
   - (d) **Atomarer Swap:** erst nach grüner Verifikation `rename()` der neuen Datei über das Original (atomar; bestehende `tmp+fsync+rename`-Linie aus ADR-007).
   - Scheitert (a)–(c) ⇒ **kein** Swap, die alte Datei bleibt unangetastet, der alte Key bleibt aktiv (vollständig umkehrbar).
2. **Rollendes current/previous-Fenster in Bitwarden.** Bei jeder Rotation wird der **neue** Key als „current" hinterlegt und der bisherige „current" wird zu „previous". Es werden **DATIERTE, separate Items** angelegt (nicht das Feld eines bestehenden Items überschrieben — vermeidet Feld-Historie-Reste). **BEHALTEN ist Default:** Bitwarden-Vault-Items sind unbegrenzt → **kein** Lösch-Zwang; ältere Keys bleiben einfach liegen.
3. **Permanentes Löschen nur bei Kompromittierung.** „Permanently Delete" (inkl. Trash-Check, dass das Item wirklich weg ist) wird **nur** bei Kompromittierung ausgeführt, als **bewusster, bestätigter** Schritt — **nie** automatisch im normalen Rotations-Ablauf.
4. **Frisches Backup je Rotation.** Jede Rotation erzeugt ein **frisches** Store-Backup, das mit dem **neuen** Key lesbar ist. Alte Backups bleiben mit dem **previous**-Key weiterhin lesbar (deshalb das current/previous-Fenster).
5. **`.env`/Prozess-Übergabe nach Swap.** Erst **nach** grünem Swap wird der neue Key in `.env` persistiert (`DEVGUI_CRED_MASTER_KEY=<neu>`, [[credential-runtime-unlock]]-Mechanik, atomar, `0600`) und in den laufenden Prozess geladen — der alte `.env`-Wert wird erst dann ersetzt.
6. **Umkehrbarkeit bis zum Commit.** Vor dem atomaren Swap (d) ist jeder Zwischenzustand vollständig umkehrbar: keine alte Datei verändert, kein `.env` überschrieben, kein Bitwarden-Item gelöscht. Der **Commit-Punkt** ist der `rename()` in (d).
7. **Schutz (Floor, hart).** Rotation ist hoch-privilegiert: Access-Mauer **+** `CRED_ADMIN_EMAILS`-Rollencheck **+** Audit-First (Audit nennt nur die Aktion/Phasen, **nie** Key-Werte). Weder alter noch neuer Key erscheint in Log/Audit/Response/WS/Argv/Bundle.

## Acceptance-Kriterien
- **AC1** — Eine Rotation re-verschlüsselt **alle** Einträge vom alten auf den neuen Key in eine **neue** Datei; das Original wird **erst nach** erfolgreicher Round-trip-Verifikation per atomarem `rename()` ersetzt.
- **AC2** — Die Round-trip-Verifikation entschlüsselt die neue Datei mit dem neuen Key vollständig und vergleicht jeden Eintrag gegen den Klartext aus der Entschlüsselung mit dem alten Key; **eine** Abweichung ⇒ **kein** Swap, alter Zustand bleibt aktiv.
- **AC3** — Schlägt irgendein Schritt vor dem Swap fehl (Entschlüsseln/Verschlüsseln/Verifikation/Crash) ⇒ `secrets.enc.json` und `.env` bleiben **unverändert**, der alte Key bleibt aktiv (kein Teil-/Misch-Zustand, vollständig umkehrbar).
- **AC4** — Der neue Key wird in Bitwarden als **datiertes, separates** Item („current") angelegt; der bisherige „current" wird zu „previous"; das bestehende Item-Feld wird **nicht** überschrieben.
- **AC5** — Default ist **BEHALTEN**: keine automatische Löschung alter/previous Key-Items. Permanentes Löschen erfolgt **nur** über einen bewussten, bestätigten Kompromittierungs-Schritt (inkl. Trash-Check) — **nie** im normalen Rotations-Flow.
- **AC6** — Jede Rotation erzeugt ein **frisches** Store-Backup, das mit dem **neuen** Key lesbar ist; ältere Backups bleiben mit dem **previous**-Key lesbar.
- **AC7** — Der neue Key wird **erst nach** grünem Swap in `.env` persistiert (atomar, `0600`) und in den Prozess geladen; vorher bleibt der alte `.env`-Wert aktiv.
- **AC8** — Rotation ist hinter Access-Mauer **+** `CRED_ADMIN_EMAILS` **+** Audit-First (Audit ohne Werte); ein fehlgeschlagener Audit-Write verhindert die Aktion.
- **AC9** — Weder alter noch neuer Key erscheint in Log/Audit/Response/WS/Argv/Frontend-Bundle (testbar: Werte tauchen nirgends auf).
- **AC10** — Es wird **ausschließlich** `DEVGUI_CRED_MASTER_KEY` rotiert; `GPG_PASSPHRASE`/`.env.gpg` bleiben unberührt.

### v2 — Datiertes Schlüssel-Archiv + frisches Backup + UI (Owner 2026-07-13, löst S-083)
- **AC11** — **Datiertes Schlüssel-Archiv statt Löschen (präzisiert AC4/AC5):** Beim Umschalten wird der neue Key aktiv, und der bisherige Key wird **datiert archiviert** — als datierter Eintrag im Feld **„Schlüssel-Archiv"** des Bitwarden-Items **`dev-gui-master-key`** (der neue Key wird der aktive Wert des Items). Der alte Key wird **nicht** gelöscht, solange **alte S3/R2-GPG-Backups** existieren, die ihn zum Entschlüsseln brauchen. (Testbar: nach Rotation ist das aktive Item-Feld der neue Key; das Feld „Schlüssel-Archiv" enthält einen datierten Eintrag mit dem alten Key; kein Lösch-Call.)
- **AC12** — **Frisches Off-Host-Backup mit neuem Key (verzahnt AC6 + [[credential-backup]]):** **Unmittelbar nach** grünem Swap wird ein **frisches** Off-Host-Backup erzeugt, das mit dem **neuen** Key lesbar ist; ältere Backups bleiben über den archivierten (previous) Key lesbar. Schlägt nur das frische Backup fehl, gilt die Rotation als erfolgreich (best-effort, geheimnisfreie Warnung) — der neue Key bleibt aktiv und über das Item recoverbar. (Testbar: nach Rotation existiert ein neues, mit dem neuen Key lesbares Off-Host-Artefakt; Backup-Fehler rollt die Rotation nicht zurück.)
- **AC13** — **Zweistufige UI-Quittung (Muster Backup-Settings):** Die Rotation wird über eine **zweistufige Quittung** in den Einstellungen ausgelöst (Stufe 1 „Re-Encryption + Round-trip-Verifikation", Stufe 2 „umgeschaltet + Backup"); bleibt eine Stufe aus/fehlerhaft, erscheint eine **stufen-genaue, geheimnisfreie** Warnung statt grüner Quittung. Die permanente Entsorgung eines archivierten Keys (nur bei Kompromittierung, AC5) ist eine **getrennte, explizit bestätigte** Aktion. (Testbar über UI-State je Stufe; Entsorgung erfordert eigene Bestätigung.)

## Verträge
- **Rotation-Operation (intern, neuer Service/Endpoint — später):** `POST /api/settings/credential-rotate` (hinter Access + `CRED_ADMIN_EMAILS`, Audit-First). Request liefert/triggert den neuen Key (aus Bitwarden-Beschaffung [[bitwarden-master-key-unlock]]); Response meldet nur Erfolg/Phase, **nie** einen Key.
- **`CredentialStore`-Erweiterung (intern, später):** `rotate(newKey): Promise<{ ok: true } | { ok: false, reason }>` — führt (a)–(d) aus; gibt **nie** einen Key zurück; im Fehlerfall sanitisierter `reason` ohne Wert.
- **Bitwarden-Archiv (v2, verbindlich):** Der neue Key wird der **aktive** Wert des Items `dev-gui-master-key`; der bisherige Key wird **datiert** ins Custom-Feld **„Schlüssel-Archiv"** desselben Items geschrieben (append, nie überschreiben) — kein Löschen, solange alte S3/R2-Backups ihn brauchen (AC11). (Der v1-Vorschlag `…-current`/`…-previous`-Items wird durch dieses Archiv-Feld ersetzt.)
- **Backup-Artefakt:** frische, mit dem neuen Key lesbare Kopie von `secrets.enc.json`; Ablageort beim Umsetzungs-Item (Backup/Restore-Verzahnung war in ADR-014 bewusst out-of-scope und wird hier als Folge zusammengeführt).

## Edge-Cases & Fehlerverhalten
- Crash zwischen (b) und (d) ⇒ verwaiste `…rotate-tmp`-Datei, aber Original intakt; nächster Start/Lauf räumt die tmp-Datei auf, alter Key bleibt aktiv.
- Neuer Key identisch zum alten ⇒ klare Ablehnung (keine sinnlose Re-Encryption) oder no-op mit klarer Meldung.
- `.env`-Persistenz scheitert **nach** grünem Swap ⇒ Store ist mit neuem Key in-memory aktiv, aber Reboot-Risiko: Aufrufer wird über fehlende Persistenz informiert (kein stiller Verlust), neuer Key bleibt über Bitwarden recoverbar.
- Round-trip-Verifikation grün, aber Bitwarden-Item-Anlage scheitert ⇒ Reihenfolge so wählen, dass **kein** Key aktiv wird, der nicht in Bitwarden gesichert ist (Bitwarden bleibt Source of Truth des Keys; goldenes Prinzip — alten Zustand nicht wegwerfen, bis neuer gesichert+verifiziert).
- Manipuliertes Store (GCM-Tag falsch) ⇒ harter Fehler in (a), **kein** Swap.

## NFRs
- **Sicherheit (Floor, hart):** kein Key-Wert in Log/Audit/Response/WS/Argv/Bundle; `.env` `0600`; alle Schreibvorgänge atomar.
- **Robustheit:** jeder Schritt umkehrbar bis zum atomaren Commit-Punkt (Swap); kein Teil-/Misch-Zustand.
- **Boundary-Disziplin:** `CredentialStore` bleibt einziger Lese-/Schreibpfad zu `secrets.enc.json`; Bitwarden-Interaktion nur über die eine Beschaffungs-Komponente ([[bitwarden-master-key-unlock]]).

## Nicht-Ziele
- Rotation von `GPG_PASSPHRASE` / SSH-Keys (separate Mechaniken; SSH-Rotation = [[ssh-key-rotation]]).
- Voll-automatische zeitgesteuerte Rotation (mögliche spätere Erweiterung; hier on-demand).
- Generelles Backup/Restore von `secrets.enc.json` außerhalb des Rotations-Kontexts (eigenes Folge-Item, vgl. ADR-014 „Zusammenhang Backup/Restore").

## Abhängigkeiten
- [[credential-master-key-decoupling]] (Entkopplung ist **Voraussetzung** — nur `DEVGUI_CRED_MASTER_KEY` wird rotiert).
- [[credential-runtime-unlock]] / ADR-007 (Krypto, scrypt/AES-GCM, atomares Schreiben, `.env`-Persistenz).
- [[bitwarden-master-key-unlock]] (Key-Beschaffung/-Anlage in Bitwarden; `bw`-Item-/Feld-Update-Technik für das datierte Schlüssel-Archiv, AC11).
- [[credential-backup]] (frisches Off-Host-Backup mit neuem Key nach der Rotation, AC12; UI-Muster zweistufige Quittung, AC13).
- [[access-and-guardrails]] (Access-Mauer, `CRED_ADMIN_EMAILS`, Audit-First, Floor).
