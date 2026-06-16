---
id: credential-runtime-unlock
title: Runtime-Unlock-Zustandsmodell des Credential-Stores (gesperrt → entsperrt)
status: draft
version: 1
---

# Spec: Runtime-Unlock-Zustandsmodell des Credential-Stores (`credential-runtime-unlock`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
dev-gui darf **„gesperrt"** starten — ohne `CRED_MASTER_KEY`, mit inaktiven Credential-Features — und **zur Laufzeit „entsperrt"** werden, indem der Master-Key beschafft, in `.env` persistiert und in den laufenden Prozess geladen wird. Diese Spec definiert das **Zustandsmodell** des `CredentialStore` (gesperrt/entsperrt), die **Laufzeit-Schlüssel-Übergabe** ohne Neustart und die **`.env`-Persistenz** des Master-Keys. Sie ist die Grundlage, auf der [[bitwarden-master-key-unlock]] (Beschaffung) und [[credential-unlock-dialog]] (GUI) aufsetzen. Die **Quelle** des Keys (Bitwarden) ist hier bewusst **nicht** Thema — nur der Übergabe- und Persistenzmechanismus.

## Verhalten
1. **Zwei-Dateien-Modell bleibt unverändert (kein Umbau):** `.env` (Klartext, restriktive Dateirechte) enthält den `CRED_MASTER_KEY` + Basis-Konfig; `secrets.enc.json` (AES-256-GCM, im Volume `/home/node/.claude/dev-gui/`) bleibt der unverändert über die GUI verwaltete Laufzeit-Credential-Store. Bitwarden hütet **genau ein** Geheimnis: den Master-Key. Es entsteht **keine** zweite Verschlüsselungsebene und **keine** Abschaffung des Stores.
2. **Gesperrter Zustand (locked):** Ist beim Boot **kein** Master-Key verfügbar (weder `CRED_MASTER_KEY`/`CRED_MASTER_KEY_FILE` noch Entrypoint-Fallback), startet der Dienst dennoch — der `CredentialStore` ist „gesperrt": Credential-abhängige Operationen (Klartext-Lesen/Schreiben verschlüsselter Einträge) sind inaktiv, aber der Prozess nimmt Requests an. Der bestehende **Fail-Fast** (ADR-007: Store enthält verschlüsselte `entries` UND kein Key) bleibt erhalten und ist von „locked, leeres Store" zu unterscheiden: ein leeres/meta-only Store ⇒ locked ohne Abbruch; ein Store mit verschlüsselten Einträgen ohne Key ⇒ weiterhin Fail-Fast beim Boot.
3. **Entsperren (unlock) zur Laufzeit:** Über einen serverseitigen Aufruf wird ein Master-Key an den `CredentialStore` übergeben. Der Store (a) **validiert** den Key gegen ein vorhandenes `secrets.enc.json` (falls verschlüsselte Einträge existieren), (b) **persistiert** ihn in `.env` als `CRED_MASTER_KEY` und (c) **lädt** ihn in den laufenden Prozess, sodass der Store ab sofort „entsperrt" ist — **ohne Neustart**.
4. **Schlüssel-Validierung beim Unlock:** Existieren verschlüsselte Einträge, gilt ein Key nur dann als gültig, wenn ein Eintrag damit fehlerfrei entschlüsselt/verifiziert werden kann (GCM-Tag ok). Ein **falscher** Key wird abgelehnt — `.env` wird **nicht** beschrieben, der Store bleibt gesperrt. Existieren **keine** verschlüsselten Einträge (frischer Store), ist jeder nicht-leere Key formal akzeptierbar (er wird zum künftigen Verschlüsselungs-Key).
5. **`.env`-Persistenz:** Der Master-Key wird in die `.env`-Datei (Pfad konfigurierbar, Default = Projekt-`.env`) als Schlüssel/Wert `CRED_MASTER_KEY=<wert>` geschrieben. Bestehende `.env`-Inhalte (andere Variablen) bleiben erhalten; ein vorhandener `CRED_MASTER_KEY`-Eintrag wird ersetzt. Das Schreiben ist **atomar** (tmp + rename) und setzt **restriktive Dateirechte** (`0600`).
6. **Idempotenz/Reboot:** Nach erfolgreichem Unlock und `.env`-Persistenz startet der Dienst bei einem späteren Reboot **autonom** entsperrt (der Entrypoint/Prozess liest `CRED_MASTER_KEY` aus `.env`/Env) — **kein** erneuter Dialog. Damit laufen autonome Jobs (z.B. ReconciliationJob) nach Reboot weiter, sofern `.env` persistiert ist.
7. **Zustands-Abfrage:** Der Store kann seinen Zustand (`locked` | `unlocked`) sowie — ohne Geheimnis-Leak — ableitbare Bootstrap-Hinweise melden (ob verschlüsselte Einträge existieren). Dies konsumiert [[credential-bootstrap-status]].
8. **Sicherheits-Floor (hart):** Der Master-Key erscheint **nie** in Log/Audit/HTTP-Response/WS/Argv/Frontend-Bundle. Auch beim Unlock und beim `.env`-Schreiben wird der Wert nicht geloggt. Die Unlock-Operation ist hoch-privilegiert (vgl. [[credential-unlock-dialog]] / [[access-and-guardrails]]).
9. **Persistenz-Pfad im Container (`CRED_ENV_PATH`):** Der `.env`-Schreibpfad ist per Env-Variable `CRED_ENV_PATH` überschreibbar (Prio: `opts.envPath` > `CRED_ENV_PATH` > Projekt-Root/`.env`). Im Container ist `/app` (und damit der Default-Pfad `/app/.env`) **read-only** und der Prozess läuft als unprivilegierter User (`node`/uid 1000); ein Persist-Versuch dorthin schlägt zwangsläufig fehl. Deshalb **muss** das Deployment `CRED_ENV_PATH` auf einen Pfad innerhalb eines **persistenten, vom Laufzeit-User beschreibbaren** Volumes setzen (im dev-gui-Container: das Named Volume unter `/home/node/.claude/`, z.B. `CRED_ENV_PATH=/home/node/.claude/devgui-cred.env`). Nur so greift `persist` und der Store startet nach Container-Recreate autonom entsperrt (vgl. §6). Das Zielverzeichnis wird beim Persistieren bei Bedarf angelegt (`mkdir -p`); ein fehlendes Verzeichnis ist **kein** `persist-failed`-Grund.
10. **`persist-failed` ist eine eigene, unterscheidbare Fehlerklasse:** Wenn `unlock(key, { persist:true })` den Key gegen das Store **gültig** validiert, ihn aber **nicht persistieren** kann (Pfad/Volume nicht beschreibbar), liefert der Store `{ ok:false, reason:'persist-failed' }` (in-memory entsperrt, aber nicht reboot-stabil). Die aufrufenden Beschaffungspfade ([[bitwarden-master-key-unlock]]: `acquireMasterKey`/`createMasterKey`) **dürfen diesen Fall nicht auf den generischen `error`-/„Unbekannter Fehler"-Pfad abbilden**, sondern müssen ihn als **eigene errorClass** (z.B. `persist-failed`) mit einer **handlungsleitenden, geheimnisfreien Meldung** an die UI melden (Sinngemäß: „Master-Key konnte nicht gespeichert werden — Persistenz-Pfad nicht beschreibbar; `CRED_ENV_PATH`/Volume prüfen"). Dies betrifft **beide** Pfade gleichermaßen: den `createMasterKey`-Pfad (Key gerade erst in Bitwarden angelegt) **und** den regulären `acquireMasterKey`-Pfad (Item bereits vorhanden → unlock).

## Acceptance-Kriterien
- **AC1** — Startet der Dienst **ohne** verfügbaren Master-Key **und** ohne verschlüsselte Einträge im Store, bricht er **nicht** ab; der `CredentialStore` meldet Zustand `locked` und nimmt weiterhin Requests an. (Abgrenzung zum bestehenden Fail-Fast.)
- **AC2** — Der bestehende **Fail-Fast** bleibt: Store enthält verschlüsselte `entries` (kdf vorhanden UND entries nicht leer) UND kein Key ⇒ Boot bricht ab (Exit ≠ 0). (Regression-Schutz für ADR-007.)
- **AC3** — Eine Laufzeit-`unlock(key)`-Operation lädt den Key in den laufenden `CredentialStore`, sodass anschließend Klartext-Operationen funktionieren (z.B. ein zuvor gesetzter Eintrag ist entschlüsselbar) — **ohne** Prozess-Neustart. Zustand wechselt `locked → unlocked`.
- **AC4** — Bei vorhandenen verschlüsselten Einträgen wird ein **falscher** Key bei `unlock` **abgelehnt** (klarer Fehler), `.env` wird **nicht** verändert und der Zustand bleibt `locked`.
- **AC5** — Nach erfolgreichem `unlock` enthält die `.env`-Datei `CRED_MASTER_KEY=<key>`; zuvor vorhandene andere `.env`-Variablen bleiben unverändert; ein bereits vorhandener `CRED_MASTER_KEY` wird ersetzt (kein Duplikat). Die Datei hat Rechte `0600`.
- **AC6** — Das `.env`-Schreiben ist atomar (kein halb geschriebener Zustand bei Crash; tmp + rename).
- **AC7** — Der Master-Key erscheint in **keiner** HTTP-Response, **keinem** Log, **keinem** Audit-Eintrag, **keinem** WS-Frame und **nicht** im Frontend-Bundle — auch nicht beim Unlock/Persistieren. (Testbar: Logs/Audit/Response enthalten den Key-Wert nicht.)
- **AC8** — Der `CredentialStore` exponiert eine zustandslose, leak-freie Statusabfrage (`locked`/`unlocked` + Flag „hat verschlüsselte Einträge"), die **keinen** Schlüssel/Klartext zurückgibt.
- **AC9** — Ist `CRED_ENV_PATH` gesetzt (nicht leer), schreibt `#persistKeyToEnv` ausschließlich an diesen Pfad (Prio `opts.envPath` > `CRED_ENV_PATH` > Projekt-Root/`.env`); existiert dessen Zielverzeichnis noch nicht, wird es vor dem atomaren Schreiben angelegt (`mkdir -p`) — ein nur fehlendes Verzeichnis führt **nicht** zu `persist-failed`. (Testbar: bei gesetztem `CRED_ENV_PATH` auf ein noch nicht existierendes Unterverzeichnis legt ein erfolgreicher `unlock` Verzeichnis + Datei mit `0600` an.)
- **AC10** — Das dev-gui-Deployment (`docker-compose.yml`) setzt im `dev-gui`-Service `CRED_ENV_PATH` auf einen Pfad innerhalb des persistenten, vom Laufzeit-User (uid 1000) beschreibbaren Named Volumes (`/home/node/.claude/...`, z.B. `/home/node/.claude/devgui-cred.env`) — **nicht** auf den read-only Default `/app/.env`. (Regression-Schutz gegen das ursprüngliche „Unbekannter Fehler beim Entsperren".)
- **AC11** — Gibt `unlock(key, { persist:true })` `{ ok:false, reason:'persist-failed' }` zurück (Key gültig, Persistenz fehlgeschlagen), melden **beide** Beschaffungspfade (`acquireMasterKey` **und** `createMasterKey`) dies an die UI mit einer **eigenen, von `error` unterscheidbaren** `errorClass` (`persist-failed`) und einer handlungsleitenden, **geheimnisfreien** Meldung (Persistenz-Pfad/`CRED_ENV_PATH`/Volume prüfen) — **nicht** als generisches „Unbekannter Fehler". (Testbar: bei gemocktem `persist-failed` ist `errorClass !== 'error'` und die Meldung verweist auf die Persistenz/den Pfad.)
- **AC12** — In keiner der `persist-failed`-Antworten (errorClass/reason) noch in Logs erscheint der Master-Key oder das Bitwarden-Master-Passwort (Floor, vgl. AC7).

## Verträge
> Interner Boundary-Vertrag; HTTP-Oberfläche liegt in [[credential-unlock-dialog]] / [[credential-bootstrap-status]].

- **`CredentialStore`-Erweiterung (intern):**
  - `isUnlocked(): boolean` — `true`, wenn ein Master-Key im Prozess geladen ist.
  - `getLockState(): { state: "locked"|"unlocked", hasEncryptedEntries: boolean }` — niemals Schlüssel/Klartext.
  - `unlock(key, { persist?: boolean }): Promise<{ ok: true } | { ok: false, reason: "invalid-key"|"invalid-key-format"|"persist-failed"|"empty-key" }>` — validiert (s. AC4), persistiert (default `persist=true`) und lädt den Key in den Prozess. Wirft/liefert **nie** den Schlüssel zurück. `persist=false`: kein Reboot-Überleben — nach Prozess-Neustart ist der Store wieder gesperrt.
- **`.env`-Persistenz (intern, eigener kleiner Schreib-Boundary erlaubt):** Master-Key-Zeile (`DEVGUI_CRED_MASTER_KEY=<wert>`, Altname `CRED_MASTER_KEY=` wird beim Schreiben entfernt) als Zeile; übrige Zeilen unverändert; atomar (tmp + rename); mode `0600`. Pfad per `opts.envPath` (Tests) bzw. Env `CRED_ENV_PATH` überschreibbar (Default = Projekt-`.env` neben `server.js`; im Container read-only → `CRED_ENV_PATH` ist im Deployment Pflicht). Zielverzeichnis wird bei Bedarf via `mkdir -p` angelegt.
- **Deployment-Vertrag (`docker-compose.yml`):** `dev-gui`-Service `environment.CRED_ENV_PATH` = Pfad in einem persistenten, uid-1000-beschreibbaren Named Volume (`/home/node/.claude/...`). Optional `.env.example`/Doku den Pfad spiegeln.
- Der Roh-Key wird wie bisher per **scrypt** (Salt aus `secrets.enc.json`) zum AES-Key abgeleitet — der Roh-Wert wird nie direkt als AES-Key verwendet (ADR-007 unverändert).

## Edge-Cases & Fehlerverhalten
- `unlock` mit leerem/whitespace-Key ⇒ `{ ok:false, reason:"empty-key" }`, keine `.env`-Mutation.
- `unlock` mit Key, der eingebettetes `\r`/`\n` enthält ⇒ `{ ok:false, reason:"invalid-key-format" }`, keine `.env`-Mutation (ein solcher Key würde zwei .env-Zeilen erzeugen und den Eintrag korrumpieren).
- `unlock` mit falschem Key bei vorhandenen Einträgen ⇒ `{ ok:false, reason:"invalid-key" }` (GCM-Verifikation schlägt fehl), keine `.env`-Mutation, Zustand bleibt `locked`.
- `.env` nicht schreibbar (Rechte/Pfad) ⇒ `{ ok:false, reason:"persist-failed" }`; falls der Key gegen das Store gültig war, bleibt der Prozess **in-memory entsperrt** (keySource `manual`), aber der Aufrufer wird über die fehlende Persistenz informiert (kein stiller Verlust nach Reboot). Kein Key-Leak in der Fehlermeldung. **Häufigste Ursache im Container:** `CRED_ENV_PATH` nicht gesetzt → Default `/app/.env` ist read-only (Prozess als `node`/uid 1000) → der Beschaffungspfad muss dies als eigene errorClass `persist-failed` melden, nicht als generischen Fehler (s. §10 / AC11).
- Fehlendes Zielverzeichnis unter gesetztem `CRED_ENV_PATH` ⇒ **kein** `persist-failed`: `#persistKeyToEnv` legt das Verzeichnis via `mkdir -p` an und schreibt erfolgreich (AC9).
- Doppeltes `unlock` bei bereits entsperrtem Store ⇒ idempotent (gleicher gültiger Key) bzw. klare Ablehnung (anderer Key) — kein Datenverlust, keine Re-Verschlüsselung.
- Manipuliertes Store (GCM-Tag falsch generell) ⇒ harter Fehler beim Validieren, kein stiller Reset (ADR-007-Linie).

## NFRs
- **Sicherheit (Floor, hart):** Master-Key nie in Log/Audit/Response/WS/Argv/Frontend-Bundle; `.env` mit `0600`; atomares Schreiben.
- **Robustheit:** Unlock ohne Neustart; Reboot-stabil über `.env`.
- **Boundary-Disziplin:** `CredentialStore` bleibt der einzige Lese-/Schreibpfad zu `secrets.enc.json`; der `.env`-Schreibpfad ist eng gekapselt (ein Ort).

## Nicht-Ziele
- **Beschaffung** des Keys (Bitwarden-Login/Item-Lesen/Key-Erstellen) → [[bitwarden-master-key-unlock]].
- **GUI-Dialog** → [[credential-unlock-dialog]].
- **Bootstrap-/Status-Endpunkt** (HTTP) → [[credential-bootstrap-status]].
- Schlüssel-**Rotation** des Master-Keys / Re-Verschlüsselung des gesamten Stores (mögliche Folge-Anforderung).
- Backup/Restore-Verzahnung von `secrets.enc.json` (s. „Zusammenhang" in [[bitwarden-master-key-unlock]]).

## Bedrohungsmodell (dokumentiert)
- **Schützt:** Repo-/Backup-/Disk-Leak — der Master-Key liegt nicht im Image/Repo; `secrets.enc.json` ist ohne Key wertlos.
- **Schützt NICHT:** einen Angreifer mit **Root auf dem laufenden Server** (kann `.env` und Prozess-Speicher lesen) — bewusst akzeptierter Trade-off (gleiche Linie wie ADR-003/ADR-007).

## Abhängigkeiten
- [[settings-credentials]] / ADR-007 (`CredentialStore`, AES-256-GCM/scrypt, `secrets.enc.json`-Schema).
- [[access-and-guardrails]] (Access-Mauer; Floor „keine Secret-Leaks").
- Konsumiert von [[bitwarden-master-key-unlock]], [[credential-unlock-dialog]], [[credential-bootstrap-status]].
</content>
</invoke>
