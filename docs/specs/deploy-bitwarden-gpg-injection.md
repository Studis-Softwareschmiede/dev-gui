---
id: deploy-bitwarden-gpg-injection
title: Deploy-Zugang zu Bitwarden (Variante B) + per-App-GPG-Passphrasen-Injektion
status: active
area: deployment
spec_format: use-case-2.0
version: 2
---

# Deploy-Zugang zu Bitwarden (Variante B) + per-App-GPG-Passphrasen-Injektion

**Schicht 3 (Spec).** Quelle für Schicht 1/2: `docs/concept.md`, `docs/architecture.md`.
**Bereich:** `deployment`. **Feature:** F-072.

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
  **nur für lokalen Betrieb** akzeptiert; für VPS/öffentlich neu zu bewerten (offener Punkt).

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

## 6. Offene Punkte (bewusst, nicht blockierend)

- **VPS/öffentlich:** S6 (at-rest-Schutz des `0600`-Zugangs) ist nur für **lokal**
  akzeptiert. Für Remote-Betrieb ein eigenes Konzept (z. B. Docker-Secret + eng geschnittene
  Rechte) — separate Story, nicht Teil von F-072.
- **Kein R2-Backup des Zugangs:** Der Bitwarden-Zugang wird **bewusst nicht** off-host
  gesichert (Owner-Entscheidung: Wurzel-Anker bleibt lokal; Voll-Restore kostet ohnehin nur
  eine erneute Zugangs-Eingabe über den Reiter). Siehe Retro/Owner-Diskussion 2026-07-12.

## 7. ADR-Notiz

**ADR-021 (vorgeschlagen):** Der unbeaufsichtigte Deploy-Bitwarden-Zugang (Variante B) lebt
in einem eigenen `0600`-Speicher außerhalb des `CredentialStore`, weil der `CredentialStore`
selbst erst durch den aus Bitwarden bezogenen Master-Key entsperrt wird (Henne-Ei). Der
bestehende interaktive `BitwardenMasterKeyService`-Pfad bleibt unverändert; der neue
API-Key-Login-Pfad ist additiv und teilt nur den Zugang.
