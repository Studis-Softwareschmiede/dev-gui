---
id: deploy-bitwarden-gpg-injection
title: Deploy-Zugang zu Bitwarden (Variante B) + per-App-GPG-Passphrasen-Injektion
status: active
area: deployment
spec_format: use-case-2.0
version: 3
---

# Deploy-Zugang zu Bitwarden (Variante B) + per-App-GPG-Passphrasen-Injektion

**Schicht 3 (Spec).** Quelle für Schicht 1/2: `docs/concept.md`, `docs/architecture.md`.
**Bereich:** `deployment`. **Feature:** F-072.

> **v3 — Folge-Bug zu S-386: `bw config server` bei jedem Deploy (2026-07-22).** Der in S-386 eingeführte **persistente**, eingeloggte bw-Appdata-Pfad hat einen Folge-Bug: `#openSession` rief `bw config server <url>` bei **jedem** Aufruf **vor** der `bw login --check`-Weiche auf. Auf dem persistenten, eingeloggten Verzeichnis verweigert die bw-CLI das mit „Logout required before server config update" (Exit 1) → jeder Deploy **nach dem ersten** scheitert. Neue **AC17–AC21** (§4.5) machen den `config`-Schritt **konditional** und geben dem config-Fehler eine **eigene** Fehlerklasse. Angewandter Workaround bis zum Fix: `server_url`-Feld im Deploy-Zugangs-Store geleert (dann entfällt der config-Schritt, AC21).

> **v2 — Item-Namens-Konvention `env.gpg-passphrase-<app>` (Owner 2026-07-13).** Die Item-Namens-Konvention lautet jetzt **`env.gpg-passphrase-<app>`** (vormals `deploy-gpg-<app>`). Alle nachstehenden Erwähnungen von `deploy-gpg-<app>` (AC14/AC15) gelten als auf **`env.gpg-passphrase-<app>`** umgestellt; **AC16** verdrahtet den daraus abgeleiteten Frontend-Default. Die Anlage-/Rotations-Seite dieser Passphrasen ist in [[per-app-gpg-passphrase-provisioning]] + [[per-app-gpg-passphrase-rotation]] spezifiziert.

## 1. Ergebnis in einem Satz

dev-gui ist der **einzige** Bitwarden-vertraute Knoten. Beim Deployment einer **fremden**
Applikation holt dev-gui deren **per-App-GPG-Passphrase** automatisch aus Bitwarden und
injiziert sie als `GPG_PASSPHRASE` in den Ziel-Container — damit die App ihre eigene
`.env.gpg` beim Start entschlüsselt. Damit das **unbeaufsichtigt** läuft (Variante B),
hinterlegt der Owner den **Bitwarden-Zugang** von dev-gui **einmalig** über einen neuen
Settings-Reiter.

## 2. Kontext & Abgrenzung (das 3-Schichten-Geheimnis-Modell)

Bereits existierend (unverändert):

- **Live-`CredentialStore`** (`secrets.enc.json`, AES-256-GCM auf Volume) — hält dev-guis
  Betriebs-Secrets (Hetzner, Cloudflare, SSH, GitHub-App …). Wird durch den
  **Master-Key** entsperrt.
- **R2/S3-GPG-Backup** — GPG-verschlüsselte Sicherung des Stores off-host.
- **Bitwarden** hält (a) dev-guis eigenen **Master-Key** (Item `dev-gui-master-key`,
  via `BitwardenMasterKeyService`) **und** (b) die **per-App-GPG-Passphrasen**
  (`deploy-gpg-<app>`) für fremde Apps.

**Henne-Ei-Kern (bindend):** Der Master-Key kommt aus Bitwarden. Der **Bitwarden-Zugang**
selbst (API-Key + Master-Passwort) kann daher **nicht** im `CredentialStore` liegen (der
Store ist ohne diesen Zugang gar nicht entsperrt). Er wird in einem **eigenen `0600`-Speicher
außerhalb** des `CredentialStore` gehalten — geschrieben über den neuen Settings-Reiter.

**Kein Widerspruch zum bestehenden `BitwardenMasterKeyService`:** Der bestehende Dienst
löst dev-guis **eigenes** Bootstrap **interaktiv** (Owner tippt E-Mail + Master-Passwort im
Unlock-Dialog). Diese Spec ergänzt den **unbeaufsichtigten** Weg (API-Key, kein OTP) für die
**Deploy-Rolle** und teilt sich denselben Bitwarden-Zugang.

**Nicht Teil dieser Spec:** die App-Seite des Vertrags (`.env.gpg` + Entrypoint-Entschlüsselung)
— die implementiert die jeweilige Ziel-App selbst (eigenes Repo). dev-gui reicht nur
`GPG_PASSPHRASE` ein.

## 3. Sicherheits-Leitplanken (bindend, gelten für ALLE ACs)

- **S1 — Kein Klartext nach außen.** Client-ID, Client-Secret, Master-Passwort, jede
  per-App-Passphrase erscheinen **niemals** in HTTP-Response, Log, Audit, WS oder URL.
  Alle Zugangs-Felder sind **write-only** (Status liefert nur `set`/`unset` + `updatedAt`).
- **S2 — Nie in Argv.** Geheimnisse gehen an `bw`/`docker` **nur** über Env oder stdin,
  nie als Kommando-Argument (Muster `BitwardenMasterKeyService`, `deploymentsRouter`).
- **S3 — Zugang verlässt dev-gui nie.** Auf den Ziel-Server geht **ausschließlich** die
  per-App-`GPG_PASSPHRASE` **dieser** App — nicht der Master-Key, nicht der Bitwarden-Zugang,
  nicht die Passphrase anderer Apps.
- **S4 — Audit-First.** Vor jeder Zugangs-Mutation und jedem Passphrasen-Abruf ein
  Audit-Eintrag (Identität, Aktion, Zeit) **ohne** Werte; schlägt der Audit-Write fehl,
  unterbleibt die Aktion.
- **S5 — Identitäts-/Rollenschutz.** Mutierende Zugangs-Endpunkte hinter `AccessGuard`
  **und** derselben `CRED_ADMIN_EMAILS`-Logik wie `deploymentsRouter`/`vpsRouter`.
- **S6 — At-rest-Schutz Variante B lokal.** Der `0600`-Zugangs-Speicher ist bewusst
  Klartext-nah at rest (kein Master-Key verfügbar, um ihn zu schützen — Henne-Ei). Das ist
  **nur für lokalen Betrieb** akzeptiert.

## 4. Komponenten & Acceptance Criteria

### 4.1 Zugangs-Speicher (`BitwardenDeployAccessStore`)

- **AC1** — Neuer Speicher persistiert vier Felder in **einer** Datei
  `${CRED_STORE_DIR}/bitwarden-deploy-access.json`, Modus `0600`, atomar (tmp + `fsync`
  + `rename`), Muster `DrainJobRegistry`/`DrainReportStore`. Felder:
  `server_url` (optional, Default `https://vault.bitwarden.com`), `client_id`,
  `client_secret`, `master_password`. Ohne `CRED_STORE_DIR`: In-Memory-Degradation +
  Warn-Log (kein Absturz), Status meldet `unpersisted`.
- **AC2** — `getStatus()` liefert je Feld nur `{ set: boolean, updatedAt?: iso }` und ein
  aggregiertes `ready: boolean` (`ready` = `client_id` + `client_secret` +
  `master_password` gesetzt). **Kein** Klartext (S1).
- **AC3** — `setField(name, value)` / `clearField(name)` schreiben/entfernen genau ein Feld;
  Wert wird nach dem Schreiben aus dem Speicher-RAM des Request-Handlers verworfen (S1).
  `getAccessForLogin()` (intern, nicht über HTTP) liefert das Tupel für `bw` — nur an
  interne Konsumenten (Login-Dienst), nie Richtung HTTP/Log.
- **AC4** — Der Speicher liegt **außerhalb** `CredentialStore`; keine Abhängigkeit vom
  Master-Key (Henne-Ei, §2).

### 4.2 Settings-Reiter „Deploy-Zugang"

- **AC5** — Neue Kategorie `deploy-zugang` in `SETTINGS_CATEGORIES` (`SettingsView.jsx`),
  Label „Deploy-Zugang", eigener Kategorie-Wrapper unter `client/src/settings/`.
- **AC6** — Vier **write-only** Felder (Muster `CredentialField`): Server-URL (optional,
  Platzhalter zeigt Default), Client-ID, Client-Secret (`type=password`),
  Master-Passwort (`type=password`, Show/Hide). Status je Feld „gesetzt/nicht gesetzt",
  Klartext wird nach Speichern sofort verworfen. Kurzer Erklärtext: „Zum unbeaufsichtigten
  Deployment fremder Apps. dev-gui liest damit deren GPG-Passphrase aus Bitwarden."
- **AC7** — „Prüfen"-Aktion (Validierung-on-save, AC10): Button testet Login+Unlock und
  zeigt grünes „Zugang gültig" oder eine klassifizierte Fehlermeldung (kein Secret-Leak).

### 4.3 Unbeaufsichtigter Bitwarden-Login (`BitwardenDeployLoginService`)

- **AC8** — Login **via API-Key** (`bw login --apikey`, `BW_CLIENTID`/`BW_CLIENTSECRET`
  als Env) → danach `bw unlock --passwordenv BW_PASSWORD --raw` → `BW_SESSION`. **Kein**
  interaktiver Prompt, **kein** OTP (API-Key-Login umgeht Bitwarden-2FA). Session-Token
  transient, nach Gebrauch `bw lock`/`logout`. Alle Geheimnisse via Env (S2).
- **AC9** — `readItemPassword(session, itemName)` liest ein Item-Passwortfeld
  (Wiederverwendung des `bw get password`-Musters aus `BitwardenMasterKeyService`).
  Fehlt das Item → klassifizierter Fehler `item-not-found` (kein Rohtext).
- **AC10** — `validateAccess()` (für AC7): Login+Unlock probeweise, Ergebnis
  `{ ok }` oder `{ ok:false, errorClass }` aus fixem Katalog
  (`auth-failed`|`bw-unreachable`|`unlock-failed`|`access-incomplete`). stderr von `bw`
  wird **nie** durchgereicht (S1).
- **AC11** — Session-Caching: ein gültiges `BW_SESSION` darf für die Dauer **eines**
  Deploy-Vorgangs wiederverwendet werden (mehrere Items in einem Lauf), wird danach
  verworfen. Kein dauerhaft offenes Vault.

### 4.4 Deploy-Guard + Passphrasen-Injektion

- **AC12** — **Guard vor dem Deploy:** Verlangt ein Deploy eine per-App-GPG-Passphrase
  (Ziel deklariert `requires_gpg_passphrase: true` bzw. einen `gpg_bw_item`) **und** ist
  der Bitwarden-Zugang **nicht** `ready` (§4.1 AC2) → **Abbruch vor jeder Mutation** mit
  `422` und maschinenlesbarem `reason: "bitwarden-access-missing"` + Klartext-Hinweis
  „Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen." **Kein**
  `docker run`, **kein** Teil-Deploy (Audit-First-Linie).
- **AC13** — **Nur wenn benötigt:** Braucht das Ziel **keine** GPG-Passphrase, läuft der
  Deploy **unverändert** durch — der Guard greift dann nicht (der fehlende Zugang ist dann
  kein Fehler).
- **AC14** — **Abruf + Injektion:** Ist der Zugang `ready` und das Ziel braucht die
  Passphrase → `BitwardenDeployLoginService` login+unlock → `env.gpg-passphrase-<app>` lesen →
  Wert als Env `GPG_PASSPHRASE` in den `docker run`/compose-Aufruf injizieren (S2/S3).
  Der Wert erscheint nicht in Log/Audit/Response; das Audit hält nur
  `deploy:gpg-fetch:<app>` (ohne Wert, S4).
- **AC15** — Item-Namens-Konvention: Default **`env.gpg-passphrase-<app>`** (`<app>` = Ziel-Slug;
  vormals `deploy-gpg-<app>`); überschreibbar per Ziel-Feld `gpg_bw_item`. Fehlt das Item in
  Bitwarden → Deploy-Abbruch mit `reason: "gpg-item-not-found"` (klarer Hinweis, welches Item
  angelegt werden muss).
- **AC16** — **Frontend-Default abgeleitet (Bonus-Lücke, Owner 2026-07-13):** Das Deploy-Formular
  (`DeploymentsView`) leitet den `gpgBwItem`-Default automatisch als **`env.gpg-passphrase-<slug>`**
  aus dem gewählten Ziel-Slug ab und sendet ihn im Deploy-Request mit (der AC15-Default war
  bislang nie im Frontend verdrahtet). Der abgeleitete Wert ist im Formular **überschreibbar**;
  ein vom Nutzer gesetzter Wert wird nicht überschrieben. Der Erklärtext im Settings-Reiter
  „Deploy-Zugang" (`DeployZugangCategory`) nennt die Konvention `env.gpg-passphrase-<app>`
  (nicht mehr `deploy-gpg-<app>`). (Testbar: bei gewähltem Ziel-Slug `foo` ist der
  Formular-Default `env.gpg-passphrase-foo`; ein manuell gesetzter Wert bleibt erhalten und wird
  gesendet.)

### 4.5 Konditionaler `bw config server`-Schritt (Folge-Bug zu S-386)

**Kontext:** Seit S-386 teilen alle Deploy-Sessions **ein persistentes, eingeloggtes**
`BITWARDENCLI_APPDATA_DIR` (Geräte-ID bleibt erhalten; `bw login --check` vor Login,
`bw lock` statt `logout`). `#openSession` rief `bw config server <url>` bislang **bei jedem
Aufruf** und **vor** der `bw login --check`-Weiche auf. Die bw-CLI erlaubt eine Server-Config-
Änderung aber **nur im ausgeloggten Zustand** → auf dem persistenten, eingeloggten Verzeichnis
antwortet `bw config server` mit „Logout required before server config update" (Exit 1). Der
**Erstversuch** (frisches Verzeichnis, noch nicht eingeloggt) gelingt, **jeder Folgeversuch**
scheitert. Verifiziert 2026-07-22 im laufenden Container.

- **AC17** — **`bw config server` läuft nur bedingt.** In `#openSession` wird `bw config server
  <server_url>` **ausschließlich** ausgeführt, wenn (a) der bw-Status **unauthenticated** ist
  (`bw login --check` liefert Exit ≠ 0) **ODER** (b) die hinterlegte `server_url` von der
  **aktuell konfigurierten** Server-URL abweicht. Ist bw bereits eingeloggt **und** stimmt die
  konfigurierte Server-URL mit `server_url` überein → `bw config server` wird **übersprungen**
  (kein Aufruf). Der bisherige **unbedingte** `config`-Aufruf **vor** der `login --check`-Weiche
  entfällt; die Weiche entscheidet **vor** einem etwaigen config-Aufruf über den Login-Zustand.
  Die aktuell konfigurierte Server-URL wird über die bw-CLI bzw. den bw-State ermittelt (Mechanik
  ist Umsetzungsdetail; Argv trägt kein Geheimnis, S2).
- **AC18** — **Eingeloggt + abweichende Server-URL → sauberer Reconfigure.** Ist bw **eingeloggt**,
  weicht aber die hinterlegte `server_url` von der aktuell konfigurierten ab (AC17-Fall b), führt
  der Dienst in dieser Reihenfolge aus: **`bw logout` → `bw config server <server_url>` →
  Neu-Login** (`bw login --apikey`, Secrets via Env, S2) → `bw unlock`. Das dabei entstehende
  **neue Device-Event ist akzeptiert** — Server-Wechsel ist ein seltener, bewusster Sonderfall,
  der genau **einen** neuen „New Device"-Login rechtfertigt (kein Widerspruch zur S-386-Mailflut-
  Vermeidung, die den *unveränderten* Normalbetrieb adressiert).
- **AC19** — **config-Fehler bekommt eine eigene Fehlerklasse.** Schlägt der `bw config server`-
  Schritt fehl (Exit ≠ 0, einschließlich „Logout required before server config update"), liefert
  der Dienst die **eigene** Fehlerklasse `config-failed` (neu in `DEPLOY_LOGIN_ERROR_CLASSES`) —
  **nicht** mehr das generische `error`. Der Deploy-Pfad (`deploymentsRouter`) bildet
  `config-failed` auf `errorClass: "bitwarden-config-failed"` mit einer eigenen, verständlichen
  `reason` ab (statt auf den Sammelfall `bitwarden-login-failed`). Es wird **kein** bw-Rohtext
  nach außen gereicht (S1); stderr bleibt intern gepuffert.
- **AC20** — **Zwei aufeinanderfolgende Deploy-Sessions funktionieren ohne manuellen Eingriff.**
  Über dasselbe persistente, eingeloggte Appdata-Verzeichnis laufen zwei aufeinanderfolgende
  `openSession()`/`fetchItemPassword()`-Vorgänge erfolgreich durch (der zweite überspringt den
  config-Schritt gemäß AC17). Regressionstest mit injiziertem `_spawnBw`, der den **eingeloggten**
  Zustand simuliert (`bw login --check` → Exit 0; `bw config server` → Exit 1 mit „Logout required
  before server config update"): der zweite Vorgang darf **nicht** an `config-failed`/
  `bitwarden-login-failed` scheitern.
- **AC21** — **Leeres/fehlendes `server_url` = Default-Server, kein config-Aufruf.** Ist
  `server_url` leer oder nicht gesetzt, gilt der Default-Server `https://vault.bitwarden.com`
  und `bw config server` wird **nicht** aufgerufen (bestehendes Verhalten aus §4.1 AC1, hier
  dokumentiert). Dieser Pfad war der angewandte Workaround, bis AC17 landet.

## 5. Tests (Pflicht)

- Store: Persistenz `0600` + atomar; Status ist write-only (kein Klartext); In-Memory-
  Degradation ohne `CRED_STORE_DIR`.
- Login-Service: API-Key-Login-Argv enthält **kein** Secret (nur Env); `validateAccess`
  klassifiziert Fehler ohne Rohtext-Leak; Session wird verworfen.
- Guard: fehlt Zugang + Ziel braucht Passphrase → `422 bitwarden-access-missing`, **kein**
  `docker run` (Spy); Ziel ohne Passphrase-Bedarf → Deploy läuft; fehlendes Item →
  `gpg-item-not-found`.
- Injektion: `GPG_PASSPHRASE` landet in der Env des Deploy-Aufrufs, **nicht** im Argv,
  **nicht** im Log/Audit/Response (Assertions gegen Spy-Capture).
- **config-Gating (AC17–AC21):**
  - Eingeloggt + gleiche Server-URL (`login --check` Exit 0) → `_spawnBw`-Spy erhält **keinen**
    `config server`-Aufruf (übersprungen).
  - Unauthenticated (`login --check` Exit ≠ 0) mit gesetzter `server_url` → `config server` wird
    aufgerufen, dann Login+Unlock.
  - Eingeloggt + abweichende `server_url` → Aufrufreihenfolge `logout` → `config server` →
    `login --apikey` → `unlock` (AC18).
  - config-Schritt Exit 1 („Logout required …") → Fehlerklasse `config-failed`; `deploymentsRouter`
    mappt auf `errorClass: "bitwarden-config-failed"` (nicht `bitwarden-login-failed`); kein
    Rohtext-Leak (AC19).
  - **Zwei aufeinanderfolgende Sessions** über den simulierten eingeloggten Zustand (`config server`
    → Exit 1) laufen beide erfolgreich durch, weil config übersprungen wird (AC20-Regressionstest).
  - Leere `server_url` → **kein** `config server`-Aufruf, Default-Server (AC21).

## 6. Offene Punkte (bewusst, nicht blockierend)

- **Kein R2-Backup des Zugangs:** Der Bitwarden-Zugang wird **bewusst nicht** off-host
  gesichert (Owner-Entscheidung: Wurzel-Anker bleibt lokal; Voll-Restore kostet ohnehin nur
  eine erneute Zugangs-Eingabe über den Reiter). Siehe Retro/Owner-Diskussion 2026-07-12.

## 7. ADR-Notiz

**ADR-021 (vorgeschlagen):** Der unbeaufsichtigte Deploy-Bitwarden-Zugang (Variante B) lebt
in einem eigenen `0600`-Speicher außerhalb des `CredentialStore`, weil der `CredentialStore`
selbst erst durch den aus Bitwarden bezogenen Master-Key entsperrt wird (Henne-Ei). Der
bestehende interaktive `BitwardenMasterKeyService`-Pfad bleibt unverändert; der neue
API-Key-Login-Pfad ist additiv und teilt nur den Zugang.
