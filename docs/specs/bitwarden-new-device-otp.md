---
id: bitwarden-new-device-otp
title: Bitwarden New-Device-Verification (E-Mail-OTP) im Credential-Unlock
status: draft
version: 1
---

# Spec: Bitwarden New-Device-Verification (E-Mail-OTP) (`bitwarden-new-device-otp`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
Seit März 2025 verlangt Bitwarden für Accounts **ohne Two-Step-Login** beim Login von einem **neuen/unbekannten Gerät** einen Einmalcode per **E-Mail** („New Device Verification") — getrennt vom TOTP-2FA, das der Unlock-Dialog bereits behandelt ([[credential-unlock-dialog]] AC5). Ein dev-gui-Container ist nach jedem Recreate aus Bitwarden-Sicht ein **neues Gerät** → dieser E-Mail-Code wird regelmäßig verlangt. Bisher behandelt die Beschaffung nur `twofa-required`, **nicht** den E-Mail-OTP → der Login schlägt im non-2FA-Fall fehl. Diese Spec erweitert die bestehende Beschaffung ([[bitwarden-master-key-unlock]]) **und** den interaktiven Dialog ([[credential-unlock-dialog]]) um den E-Mail-OTP-Fluss, **ohne** ein neues Subsystem und **ohne** den bestehenden TOTP-2FA-Fluss zu brechen.

## Verhalten
1. **Neue Fehlerklasse `email-otp-required`:** Verlangt `bw` beim Login eine New-Device-Verification (E-Mail-OTP), meldet die Beschaffung dies als **klassifizierten Fehler** `email-otp-required` zurück — analog zu, aber **unterscheidbar von** `twofa-required`. Es entstehen keine weiteren Effekte (kein entsperrtes Vault, kein `.env`-Schreiben).
2. **Folge-Request mit E-Mail-Code:** Im Folge-Request wird der vom Nutzer eingegebene E-Mail-Code an die Beschaffung übergeben und via der von der bw-CLI bereitgestellten Methode (Bitwarden PR #13568) an den Login durchgereicht. Bei gültigem Code läuft die Beschaffung normal weiter (Item lesen / Store entsperren wie [[bitwarden-master-key-unlock]]).
3. **Falscher/abgelaufener E-Mail-Code → `email-otp-invalid`:** Ist der übergebene E-Mail-Code falsch oder abgelaufen, meldet die Beschaffung `email-otp-invalid` (analog zu `twofa-invalid`); der Nutzer kann erneut absenden.
4. **TOTP-2FA-Fluss bleibt unverändert (Kompatibilität, hart):** Accounts **mit** Two-Step-Login (TOTP) durchlaufen weiter den bestehenden `twofa-required`/`twofa-invalid`-Fluss ([[credential-unlock-dialog]] AC5) — für sie verlangt Bitwarden **keinen** E-Mail-OTP. Der bestehende 2FA-Pfad darf durch diese Erweiterung **nicht** brechen. `twofa-*` und `email-otp-*` sind getrennte, sich gegenseitig ausschließende Fälle pro Login-Versuch.
5. **Dialog: getrennte, klare Meldung:** Bei `email-otp-required` zeigt der Unlock-Dialog ein **eigenes** Code-Eingabefeld mit einer vom 2FA-Fall **deutlich unterschiedlichen** Meldung (sinngemäß: „Bitwarden hat dir einen Einmalcode per E-Mail geschickt — bitte eingeben"). Das Feld ist erneut absendbar (Muster wie der bestehende 2FA-Flow wiederverwendet, aber **eigener Auslöser/Label/State**). `email-otp-invalid` → feldzugeordnete Fehlermeldung, erneut absendbar (kein Verlust der übrigen Eingaben außer den nach Submit verworfenen Geheimnissen).
6. **Nur interaktiver Pfad:** Diese Erweiterung betrifft **ausschließlich** den interaktiven Dialog-Pfad. Der autonome Pfad (`DEVGUI_CRED_MASTER_KEY` via Env/Bootstrap, [[credential-master-key-decoupling]]) führt **keinen** bw-Login durch → **kein** E-Mail-OTP. Das wird im Verhalten klargestellt, damit kein Konsument den OTP-Fluss fälschlich im autonomen Pfad erwartet.
7. **bw-Version:** Die Beschaffung setzt eine bw-CLI-Version voraus, die New-Device-Verification unterstützt (Bitwarden PR #13568). Aktuell ist `@bitwarden/cli@2026.5.0` im Image gepinnt; ob diese Version den E-Mail-OTP-Parameter bietet, ist im Rahmen der Umsetzung zu **prüfen**. Bietet sie ihn nicht, ist ein Version-Bump des Pins nötig (Umsetzungs-Detail; die Spec definiert das Verhalten).
8. **Geheimnis-Hygiene (Floor, hart):** Der E-Mail-OTP-Code zählt wie alle Bitwarden-Login-Daten zu den Geheimnissen: Er erscheint in **keinem** Log, **keinem** Audit-Eintrag, **keiner** HTTP-Response, **keinem** WS-Frame, **nicht** im Frontend-Bundle und **nicht** in Prozess-Argv. Master-Passwort/Session-Token bleiben strikt Env-only. Der OTP-Code wird **nach Gebrauch verworfen** (transient, nicht persistiert). Audit-First bleibt: Audit nennt nur die Aktion, nie den Code.

## Acceptance-Kriterien
- **AC1** — Verlangt `bw` beim Login eine New-Device-Verification (E-Mail-OTP) und ist **kein** Code übergeben, liefert die Beschaffung den klassifizierten Fehler `email-otp-required` (unterscheidbar von `twofa-required`); es wird **nichts** entsperrt/persistiert.
- **AC2** — Wird im Folge-Request ein E-Mail-OTP-Code übergeben, reicht die Beschaffung ihn via der bw-CLI-Methode (PR #13568) an den Login durch; bei **gültigem** Code läuft die Beschaffung normal weiter (Item lesen → `CredentialStore.unlock` wie [[bitwarden-master-key-unlock]]).
- **AC3** — Ein **falscher/abgelaufener** E-Mail-OTP-Code liefert `email-otp-invalid` (unterscheidbar von `twofa-invalid`); der Store bleibt `locked`, `.env` unverändert, erneuter Versuch möglich.
- **AC4** — Der bestehende TOTP-2FA-Fluss (`twofa-required`/`twofa-invalid`) funktioniert **unverändert** weiter: ein TOTP-Account erhält den 2FA-Fluss, **keinen** E-Mail-OTP-Fluss; die bestehenden Tests/AC von [[bitwarden-master-key-unlock]] AC5 und [[credential-unlock-dialog]] AC5 bleiben grün.
- **AC5** — Der Unlock-Dialog zeigt bei `email-otp-required` ein **eigenes** Code-Feld mit einer vom 2FA-Fall **textlich unterschiedlichen** Meldung (E-Mail-OTP-spezifisch), eigenem Label und eigenem State; der Nutzer kann den Code eingeben und erneut absenden.
- **AC6** — Bei `email-otp-invalid` zeigt der Dialog eine **feldzugeordnete** (`aria-describedby`/`role=alert`) Fehlermeldung am E-Mail-OTP-Feld und erlaubt erneutes Absenden, ohne E-Mail/sonstige Nicht-Geheimnis-Eingaben zu verlieren.
- **AC7** — Der E-Mail-OTP-Code erscheint in **keinem** Log, **keinem** Audit-Eintrag, **keiner** HTTP-Response, **keinem** WS-Frame, **nicht** im Frontend-Bundle und **nicht** in Prozess-Argv; er wird nach Gebrauch aus dem transienten State/Prozess verworfen. (Testbar über Argv/Logs/Audit/Response/Bundle.)
- **AC8** — Der autonome Pfad ([[credential-master-key-decoupling]]) löst **keinen** E-Mail-OTP aus (kein bw-Login); das ist in Spec/Verhalten dokumentiert und es existiert **kein** Code, der OTP im autonomen Pfad erwartet/anfordert.
- **AC9** — A11y des E-Mail-OTP-Felds: Label (`label`/`htmlFor`), Fehler programmatisch zugeordnet, Fokusführung beim Erscheinen des Felds, `type` ohne Klartext-Persistenz, Touch-Target ≥ 44 px, `autoComplete="one-time-code"` (geerbt aus [[credential-unlock-dialog]] AC2).

## Verträge
- **Beschaffungs-Komponente ([[bitwarden-master-key-unlock]], erweitert):**
  - `acquireMasterKey({ email, password, twofa?, emailOtp?, identity })` und `createMasterKey({ email, password, twofa?, emailOtp?, identity })` akzeptieren zusätzlich `emailOtp?` (transient, nie geloggt/auditiert/in Argv).
  - `errorClass` erweitert um `email-otp-required` und `email-otp-invalid`: `errorClass ∈ { auth-failed, twofa-required, twofa-invalid, email-otp-required, email-otp-invalid, bw-unreachable, item-create-failed, error }`.
  - `reason` bleibt stets sanitisiert (`sanitizeErrorReason`) — neue Klassen erhalten geheimnisfreie, vom 2FA-Text unterscheidbare Begründungen; **nie** Code/Passwort/stderr-Rohtext.
- **HTTP-Endpunkt ([[credential-unlock-dialog]], erweitert):** `POST /api/settings/credential-unlock`
  - Body erweitert um optionales `emailOtp?: string`: `{ email, password, twofa?, emailOtp?, create? }`.
  - Neue Fehler-Antworten: `401 { ok: false, errorClass: "email-otp-required" | "email-otp-invalid" }` (analog zur 2FA-Mappung; Status-Code wie `twofa-*`).
  - Unverändert: kein Key/Login-Daten/OTP-Code in der Response; Audit-First; AccessGuard + `CRED_ADMIN_EMAILS`.
- **Frontend ([[credential-unlock-dialog]] `BitwardenUnlockDialog`, erweitert):** eigener `emailOtp`-State + `showEmailOtp`-State + eigenes Feld/Label/Fehler-ID; der Code wird wie das 2FA-Geheimnis nach jedem Submit aus dem React-State verworfen und nur an den Backend-Endpunkt gesendet.

## Edge-Cases & Fehlerverhalten
- E-Mail-OTP erforderlich, kein Code übergeben ⇒ `email-otp-required` → 401; Dialog blendet das E-Mail-OTP-Feld ein. Keine weiteren Effekte.
- Account hat **sowohl** TOTP als auch (theoretisch) New-Device-Verification ⇒ Bitwarden verlangt für TOTP-Accounts keinen E-Mail-OTP; der Login folgt dem von `bw` gemeldeten Fall. dev-gui klassifiziert nach dem, was `bw` zurückgibt — keine Annahme, dass beide gleichzeitig nötig sind.
- E-Mail-OTP abgelaufen während der Nutzer tippt ⇒ `email-otp-invalid`; erneuter Submit löst ggf. einen neuen Code-Versand durch Bitwarden aus (Bitwarden-Verhalten, nicht dev-gui-Logik).
- `bw`-Version unterstützt den OTP-Parameter nicht ⇒ Login schlägt fehl/klassifiziert als `error`/`auth-failed` ohne Leak; Spec-Hinweis: Version-Pin prüfen/bumpen (Verhalten §7).
- stderr-Muster für New-Device-Verification ⇒ wird nur **intern** zur Klassifizierung gematcht (z.B. „new device", „verification code", „check your email"); stderr-Rohtext verlässt die Komponente **nie**.

## NFRs
- **Sicherheit (Floor, hart):** E-Mail-OTP-Code + Login-Daten + Master-Key nie persistiert/geloggt/auditiert/in Response/WS/Argv/Bundle; OTP-Code nach Gebrauch verworfen; Audit-First.
- **Kompatibilität (hart):** bestehender TOTP-2FA-Fluss bleibt grün (Regression verboten).
- **A11y:** WCAG 2.1 AA für das neue Feld (geerbt aus [[credential-unlock-dialog]]).
- **Boundary-Disziplin:** weiterhin **genau eine** Komponente spricht mit Bitwarden ([[bitwarden-master-key-unlock]]); kein neues Subsystem.

## Nicht-Ziele
- Autonomer Pfad/Bootstrap-Key → [[credential-master-key-decoupling]] (löst keinen OTP aus).
- Runtime-Unlock-Mechanik + `.env`-Persistenz → [[credential-runtime-unlock]].
- Konkrete bw-CLI-Flag/-Mechanik + Version-Bump-Entscheidung → Umsetzungs-Detail (`coder`); die Spec definiert Verhalten/AC.
- Bitwarden-2FA-Methodenwechsel/Account-Verwaltung außerhalb des Login-Flusses.

## Abhängigkeiten
- [[bitwarden-master-key-unlock]] (erweitert: neue Fehlerklassen + `emailOtp`-Durchreichung).
- [[credential-unlock-dialog]] (erweitert: Endpunkt-Body + Dialog-Feld/Fluss).
- [[credential-master-key-decoupling]] (autonomer Pfad — Abgrenzung, kein OTP).
- [[access-and-guardrails]] (Access-Mauer; Audit; Floor „keine Secret-Leaks").
- Bitwarden-CLI PR #13568 (New-Device-Verification-Unterstützung) — bestimmt die Mindest-bw-Version.
