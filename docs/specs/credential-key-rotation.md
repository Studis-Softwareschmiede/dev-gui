---
id: credential-key-rotation
title: Master-Key-Rotation des Credential-Stores (atomare Re-Encryption + rollendes Bitwarden-Fenster)
status: draft
area: einstellungen
version: 1
---

# Spec: Master-Key-Rotation des Credential-Stores (`credential-key-rotation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.
> **STATUS: DEFERRED** — diese Spec wird **jetzt nur geschrieben**, **nicht** im aktuellen `/flow`-Lauf umgesetzt. Umsetzung als späteres Item.

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

## Verträge
- **Rotation-Operation (intern, neuer Service/Endpoint — später):** `POST /api/settings/credential-rotate` (hinter Access + `CRED_ADMIN_EMAILS`, Audit-First). Request liefert/triggert den neuen Key (aus Bitwarden-Beschaffung [[bitwarden-master-key-unlock]]); Response meldet nur Erfolg/Phase, **nie** einen Key.
- **`CredentialStore`-Erweiterung (intern, später):** `rotate(newKey): Promise<{ ok: true } | { ok: false, reason }>` — führt (a)–(d) aus; gibt **nie** einen Key zurück; im Fehlerfall sanitisierter `reason` ohne Wert.
- **Bitwarden-Fenster:** datierte Items, Bezeichner-Schema abgeleitet aus dem Basis-Item `dev-gui-cred-master-key` (z.B. `…-current` / `…-previous` oder datiert) — finale Benennung beim Umsetzungs-Item.
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
- [[bitwarden-master-key-unlock]] (Key-Beschaffung/-Anlage in Bitwarden; current/previous-Fenster).
- [[access-and-guardrails]] (Access-Mauer, `CRED_ADMIN_EMAILS`, Audit-First, Floor).
