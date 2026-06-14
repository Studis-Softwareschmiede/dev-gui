---
id: bitwarden-master-key-unlock
title: Bitwarden-Beschaffung des Master-Keys (Login, Item-Lesen, Key-Erstellen)
status: draft
version: 1
---

# Spec: Bitwarden-Beschaffung des Master-Keys (`bitwarden-master-key-unlock`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
Eine **serverseitige** Komponente beschafft den `CRED_MASTER_KEY` aus **Bitwarden**: sie führt einen interaktiven Bitwarden-Login (E-Mail + Master-Passwort + optional 2FA-Code) durch, liest ein vorhandenes Master-Key-Item aus, oder **erstellt** — nach expliziter Bestätigung — ein neues mit einem kryptographisch sicheren Zufalls-Key. Das Backend (nicht der Browser) spricht mit Bitwarden. Der beschaffte Key wird über das Runtime-Unlock-Zustandsmodell ([[credential-runtime-unlock]]) in den Prozess geladen und in `.env` persistiert. Diese Spec definiert das **Verhalten** der Beschaffung, nicht die konkrete Implementierung.

## Verhalten
1. **Backend-seitige Bitwarden-Kommunikation:** Der Login und alle Bitwarden-Operationen laufen **im Backend**. Die Bitwarden-Zugangsdaten (E-Mail, Master-Passwort, optional 2FA-Code) kommen aus dem Unlock-Request, werden **nur transient** für die Beschaffung verwendet und danach verworfen.
2. **Login:** Mit E-Mail + Master-Passwort (+ optional 2FA-Code) wird die Bitwarden-Sitzung authentifiziert und entsperrt, sodass Items lesbar/schreibbar sind. Fehlerfälle (falsche Credentials, 2FA erforderlich/falsch, Bitwarden nicht erreichbar) werden als **klassifizierte Fehler** zurückgemeldet — **ohne** Klartext-Geheimnisse.
3. **Master-Key-Item lesen:** Existiert in Bitwarden bereits das Master-Key-Item (festgelegter, konfigurierbarer Item-Name/-Bezeichner), wird dessen geheimer Wert ausgelesen und als Master-Key verwendet (→ Übergabe an [[credential-runtime-unlock]]).
4. **Master-Key-Item erstellen (nur nach Bestätigung):** Existiert **kein** Master-Key-Item, meldet die Beschaffung dies als Zustand `not-found` zurück. Erst bei **expliziter** Nutzer-Bestätigung (Flag im Folge-Request) generiert dev-gui einen kryptographisch sicheren Zufalls-Key (z.B. `crypto.randomBytes`, base64-kodiert, ausreichende Entropie) und legt ihn als neues Bitwarden-Item an; anschließend wird dieser Key verwendet.
5. **Übergabe an den Store:** Der beschaffte oder erzeugte Key wird über `CredentialStore.unlock(key, { persist:true })` ([[credential-runtime-unlock]]) validiert, in `.env` persistiert und in den Prozess geladen. Schlägt die Validierung gegen ein vorhandenes Store fehl (falscher Key), wird das als Fehler gemeldet und der Key **nicht** persistiert.
6. **Default-Anbindung = Bitwarden CLI (`bw`):** Die Beschaffung nutzt standardmäßig die im dev-gui-Image gebündelte **Bitwarden-CLI** (`bw`), via Subprozess (etablierter Weg für E-Mail/Passwort/2FA-Login + Item lesen/erstellen). Die REST-/Vault-API ist eine zulässige **Alternative** — die Wahl der Technik ist `coder`/`architekt`-Sache; diese Spec legt nur Verhalten/AC fest. Geheimnisse werden **nicht** über Prozess-Argv übergeben (kein Leak in der Prozessliste), sondern über stdin/Env-Mechanismen ohne Argv-Exposition (Ausnahme: kurzlebiger TOTP-2FA-Code via `--code`, siehe AC6).
7. **Geheimnis-Hygiene (hart):** Bitwarden-Login-Daten und der Master-Key werden **nie** persistiert (außer der Master-Key in `.env` über [[credential-runtime-unlock]]), **nie** geloggt/auditiert (das Audit nennt nur die Aktion, nie Werte), **nie** in HTTP-Response/WS/Frontend-Bundle/Argv ausgegeben (Ausnahme: kurzlebiger TOTP-2FA-Code via `--code`, siehe AC6). Die transiente Bitwarden-Sitzung wird nach Gebrauch beendet/verworfen (kein dauerhaft entsperrtes Vault).
8. **Audit-First:** Jede Beschaffungs-Aktion (login-attempt, key-read, key-create) schreibt **vor** Ausführung einen Audit-Eintrag (Identität, Aktion, Zeit) **ohne** Werte; schlägt der Audit-Write fehl, unterbleibt die Aktion.

## Acceptance-Kriterien
- **AC1** — Mit gültigen Bitwarden-Zugangsdaten (E-Mail + Master-Passwort, + 2FA falls nötig) authentifiziert die Backend-Komponente erfolgreich und kann Items lesen/schreiben; alle Bitwarden-Interaktion läuft **serverseitig** (nicht im Browser).
- **AC2** — Existiert das Master-Key-Item, liefert die Beschaffung dessen geheimen Wert **store-intern** an [[credential-runtime-unlock]]; der Wert erscheint **nicht** in der HTTP-Response (die Response meldet nur Erfolg/Status, keinen Key).
- **AC3** — Existiert **kein** Master-Key-Item, meldet die Beschaffung Status `not-found` (kein automatisches Erstellen).
- **AC4** — Nur bei **explizitem** Bestätigungs-Flag erzeugt dev-gui einen kryptographisch sicheren Zufalls-Key (ausreichende Entropie, z.B. ≥ 32 Byte randomBytes) und legt ihn als neues Bitwarden-Item an; ohne Flag wird **nichts** erstellt.
- **AC5** — Falsche Zugangsdaten / fehlende oder falsche 2FA / erforderliche oder falsche New-Device-E-Mail-Verifikation / nicht erreichbares Bitwarden werden als **klassifizierte** Fehler zurückgemeldet (`auth-failed` | `twofa-required` | `twofa-invalid` | `email-otp-required` | `email-otp-invalid` | `bw-unreachable` | `error`) — **ohne** Klartext-Geheimnis in Fehlermeldung/Log. Der E-Mail-OTP-Fluss ist in [[bitwarden-new-device-otp]] spezifiziert (eigene Klassen, getrennt vom TOTP-2FA-Fluss).
- **AC6** — Bitwarden-Login-Daten und der Master-Key erscheinen in **keinem** Log, **keinem** Audit-Eintrag, **keiner** HTTP-Response, **keinem** WS-Frame, **nicht** im Frontend-Bundle und **nicht** in Prozess-Argv (Geheimnisse nicht als CLI-Argumente). (Testbar: Argv/Logs/Audit/Response enthalten die Werte nicht.) **Begründete Ausnahme — TOTP-2FA-Code via `--code`-Argument:** Der kurzlebige TOTP-Code (30 s gültig, einmalig, replay-geschützt, nach dem Login verbraucht) darf als `bw`-Argument übergeben werden, weil die Bitwarden-CLI für diesen Parameter keine Env/stdin-Alternative anbietet. Master-Passwort und Session-Token bleiben strikt Env-only; diese Ausnahme gilt ausschließlich für den TOTP-2FA-Code.
- **AC7** — Der beschaffte/erzeugte Key wird über `CredentialStore.unlock(...)` übergeben; bei vorhandenem Store mit verschlüsselten Einträgen führt ein **falscher** Key (z.B. manuell manipuliertes Bitwarden-Item) zu Ablehnung ohne `.env`-Persistenz (geerbt aus [[credential-runtime-unlock]] AC4).
- **AC8** — Jede Beschaffungs-Aktion erzeugt vor Ausführung einen Audit-Eintrag (Identität, Aktion, Zeit) **ohne** Werte; schlägt der Audit-Write fehl, unterbleibt die Aktion.
- **AC9** — Die transiente Bitwarden-Sitzung wird nach der Beschaffung beendet/verworfen; es bleibt **kein** dauerhaft entsperrtes Vault und **keine** persistierte Bitwarden-Zugangsdaten zurück.

## Verträge
> HTTP-Oberfläche wird in [[credential-unlock-dialog]] verdrahtet; hier der serverseitige Beschaffungs-Vertrag.

- **Beschaffungs-Komponente (intern, neuer Boundary — einziger Ort, der mit Bitwarden spricht):**
  - `acquireMasterKey({ email, password, twofa? }): Promise<{ status: "found" } | { status: "not-found" } | { status: "error", errorClass, reason }>` — `key` verlässt die Komponente **nur** store-intern an [[credential-runtime-unlock]], nie nach außen. Im Error-Fall enthält `reason` eine sanitisierte, geheimnisfreie Fehlerbeschreibung (kein Klartext-Credential, kein stderr-Rohtext).
  - `createMasterKey({ email, password, twofa? }): Promise<{ status: "created" } | { status: "error", errorClass, reason }>` — erzeugt Zufalls-Key + legt Item an; nur nach explizitem Aufruf (Bestätigung). `reason` wie oben.
  - `errorClass ∈ { auth-failed, twofa-required, twofa-invalid, email-otp-required, email-otp-invalid, bw-unreachable, item-create-failed, error }`. Die E-Mail-OTP-Klassen + die `emailOtp?`-Durchreichung sind in [[bitwarden-new-device-otp]] spezifiziert.
  - `reason`: stets sanitisiert (via `sanitizeErrorReason`) — enthält **niemals** Passwort, Session-Token, Key-Wert oder stderr-Rohtext.
- **Konfiguration (Env/Settings, nicht-geheim):** Bitwarden-Item-Bezeichner (Default-Name) für den Master-Key; optional Bitwarden-Server-URL (self-hosted). Keine Bitwarden-Zugangsdaten in der Konfiguration.
- **Technik-Default:** Bitwarden-CLI `bw` im Image gebündelt; Subprozess-Aufruf ohne Geheimnis in Argv. REST-API zulässige Alternative.

## Edge-Cases & Fehlerverhalten
- 2FA erforderlich, aber kein Code übergeben ⇒ `twofa-required` (UI fordert Code nach), keine weiteren Effekte.
- New-Device-Verification (E-Mail-OTP) erforderlich bei non-2FA-Account ⇒ `email-otp-required` (UI fordert E-Mail-Code nach) — siehe [[bitwarden-new-device-otp]], getrennt vom TOTP-Fluss.
- Bitwarden nicht erreichbar / CLI fehlt ⇒ `bw-unreachable`/`error`, klare Meldung ohne Geheimnis.
- Item existiert, aber Wert leer/unbrauchbar ⇒ behandelt wie `not-found` bzw. klarer Fehler (kein leerer Key an den Store).
- Key-Erstellung schlägt beim Anlegen in Bitwarden fehl ⇒ `item-create-failed`; **kein** Teil-Zustand (kein lokal persistierter Key ohne Bitwarden-Item — Bitwarden bleibt Source of Truth des Keys).
- Mehrfacher Login-Versuch: keine Sperr-/Lockout-Logik in dev-gui (Bitwarden selbst rate-limited); dev-gui leakt keine Hinweise auf Gültigkeit einzelner Felder über das Nötige hinaus.

## NFRs
- **Sicherheit (Floor, hart):** Login-Daten + Master-Key nie persistiert/geloggt/auditiert/in Response/WS/Argv/Bundle; transiente Sitzung verworfen; Subprozess ohne Geheimnis-Argv (Ausnahme: kurzlebiger TOTP-2FA-Code via `--code`, siehe AC6).
- **Robustheit:** klassifizierte Fehler, keine Teil-Zustände bei Key-Erstellung.
- **Boundary-Disziplin:** **genau eine** Komponente spricht mit Bitwarden; der Key verlässt sie nur store-intern.

## Nicht-Ziele
- Runtime-Unlock-Mechanik + `.env`-Persistenz → [[credential-runtime-unlock]].
- GUI-Dialog/HTTP-Endpunkte → [[credential-unlock-dialog]].
- Bootstrap-/Status-Erkennung → [[credential-bootstrap-status]].
- **Backup/Restore-Verzahnung (Zusammenhang, NICHT in Scope):** Master-Key aus Bitwarden **+** ein Backup von `secrets.enc.json` ergeben zusammen eine vollständige Wiederherstellung. Das eigentliche Backup/Restore von `secrets.enc.json` ist hier **nicht** Scope — als mögliches Folge-Item zu erwägen.

## Bedrohungsmodell (dokumentiert)
- **Schützt:** Repo-/Backup-/Disk-Leak (Key liegt in Bitwarden, nicht im Image/Repo).
- **Schützt NICHT:** Angreifer mit Root auf dem laufenden Server (kann transiente Login-Daten/Key im Prozessspeicher abgreifen) — bewusst akzeptierter Trade-off.
- **TOTP-2FA-Code in Prozess-Argv (bewusster Trade-off):** Der kurzlebige TOTP-Code (30 s, einmalig, replay-geschützt) erscheint als `--code`-Argument im Prozess-Argv des `bw`-Subprozesses, weil die Bitwarden-CLI keine Alternative bietet. Risiko: Ein Angreifer mit Lesezugang auf `/proc/<pid>/cmdline` zum Zeitpunkt des Logins könnte den Code lesen. Da der Code nach dem Login sofort verbraucht ist und die 30-s-Fenster ohnehin ablaufen, ist das Missbrauchspotential minimal. Master-Passwort und Session-Token sind davon **nicht** betroffen (bleiben Env-only).

## Abhängigkeiten
- [[credential-runtime-unlock]] (Key-Übergabe + `.env`-Persistenz + Validierung).
- [[access-and-guardrails]] (Access-Mauer; Audit; Floor „keine Secret-Leaks").
- [[settings-credentials]] / ADR-007 (`CredentialStore`, `CRED_ADMIN_EMAILS`-Rollencheck).
- [[bitwarden-new-device-otp]] (erweitert diese Spec um E-Mail-OTP-Klassen + `emailOtp?`-Durchreichung).
- Konsumiert von [[credential-unlock-dialog]].
</content>
