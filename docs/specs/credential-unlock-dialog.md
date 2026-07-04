---
id: credential-unlock-dialog
title: Bitwarden-Unlock-Dialog auf der Einstellungsseite + Unlock-Endpunkte
status: draft
area: einstellungen
version: 2
---

# Spec: Bitwarden-Unlock-Dialog auf der Einstellungsseite (`credential-unlock-dialog`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
Auf der Einstellungsseite (`client/src/SettingsView.jsx`) gibt es im **gesperrten** Zustand einen Bitwarden-Unlock-Dialog: Button **„Bitwarden verbinden"** → Dialog mit interaktivem Bitwarden-Login (E-Mail + Master-Passwort + optional 2FA-Code). Das **Backend** beschafft den Master-Key ([[bitwarden-master-key-unlock]]), entsperrt den Store und persistiert den Key in `.env` ([[credential-runtime-unlock]]). Diese Spec definiert die **HTTP-Unlock-Endpunkte** + das **Frontend-Verhalten** (inkl. Key-Erstellung nach Bestätigung) und die Sichtbarkeits-Steuerung über den Status ([[credential-bootstrap-status]]).

## Verhalten
1. **Sichtbarkeit:** Die Einstellungsseite ruft `GET /api/settings/credential-status` ([[credential-bootstrap-status]]) ab. Nur bei `state === "locked"` wird der Unlock-Bereich mit dem Button **„Bitwarden verbinden"** angezeigt; bei `unlocked` erscheint **kein** Dialog (Normalbetrieb).
2. **Dialog öffnen:** Klick auf „Bitwarden verbinden" öffnet einen Dialog (modal, A11y-konform) mit Feldern: **E-Mail**, **Master-Passwort** (Typ `password`), **2FA-Code** (optional). Die Login-Daten werden ausschließlich an den Backend-Unlock-Endpunkt gesendet — niemals im Browser persistiert/geloggt/in localStorage abgelegt.
3. **Unlock-Submit:** Der Dialog ruft `POST /api/settings/credential-unlock` mit `{ email, password, twofa? }`. Das Backend: Audit-First → Bitwarden-Login + Item-Lesen ([[bitwarden-master-key-unlock]]) → `CredentialStore.unlock(key, { persist:true })` ([[credential-runtime-unlock]]). Bei Erfolg meldet die Response **nur** Erfolg + neuen Zustand (`unlocked`), **keinen** Key.
4. **Key-nicht-vorhanden → Erstellungs-Angebot:** Liefert die Beschaffung `not-found` ([[bitwarden-master-key-unlock]] AC3), zeigt der Dialog die Frage **„Master-Key in Bitwarden erstellen?"**. Erst bei expliziter Bestätigung sendet das Frontend `POST /api/settings/credential-unlock` mit `{ email, password, twofa?, create: true }`; das Backend erzeugt dann den Zufalls-Key + legt das Bitwarden-Item an ([[bitwarden-master-key-unlock]] AC4) und entsperrt.
5. **2FA-Nachforderung:** Liefert die Beschaffung `twofa-required`/`twofa-invalid`, zeigt der Dialog das 2FA-Feld (falls noch nicht sichtbar) und eine klare Meldung; der Nutzer kann den Code eingeben und erneut absenden.
5a. **E-Mail-OTP-Nachforderung (New Device Verification):** Liefert die Beschaffung `email-otp-required`/`email-otp-invalid` (non-2FA-Accounts), zeigt der Dialog ein **eigenes** E-Mail-OTP-Feld mit einer vom 2FA-Fall **textlich unterschiedlichen** Meldung; der Nutzer kann den E-Mail-Code eingeben und erneut absenden. Detail-Verhalten + AC → [[bitwarden-new-device-otp]].
6. **Erfolg:** Nach erfolgreichem Unlock schließt der Dialog (oder zeigt eine Erfolgsmeldung), der Status wird neu geladen (`unlocked`), der Unlock-Bereich verschwindet und die regulären Credential-/SSH-Sektionen sind nutzbar.
7. **Geheimnis-Hygiene (Frontend-Floor):** Login-Daten + Key erscheinen **nie** im Frontend-Bundle (kein hartkodiertes Geheimnis), **nie** in `console.log`, **nie** im DOM nach dem Submit (außer absichtlich sichtbar gemacht via §10-Toggle, der nur den Wert im eigenen Feld zeigt), **nie** in der URL/Query. Das Master-Passwort-Feld ist standardmäßig `type=password`, `autoComplete="off"`. Klartext-Geheimnisse werden bei **terminalem** Submit (Erfolg oder echter/terminaler Fehler) aus dem React-State verworfen — siehe §9 zur Abgrenzung von Retry-Fällen.
9. **Geheimnis-Erhalt bei Retry-Nachforderung (Bugfix S-129):** Bei den **nicht-terminalen** Nachforderungs-Antworten `twofa-required`/`twofa-invalid`/`email-otp-required`/`email-otp-invalid` (§5/§5a) handelt es sich um **Retry-Fälle** desselben Login-Versuchs. Das **Master-Passwort** (und die übrigen Nicht-final-verworfenen Eingaben) bleibt dabei **erhalten**, damit der Nutzer nur den 2FA-/E-Mail-Code nachreichen muss und das Master-Passwort **nicht erneut tippen** muss. Der State-Reset (`setPassword('')` etc.) greift **ausschließlich** bei terminalem Ausgang (Erfolg ODER echtem/terminalem Fehler wie `auth-failed`/`bw-unreachable`), **nicht** bei den vier Retry-Klassen. Der Floor bleibt gewahrt: das Passwort verlässt nie Log/URL und wird bei terminalem Ende weiterhin verworfen; während des Retry lebt es nur im React-State des offenen Dialogs.
10. **„Passwort anzeigen"-Toggle (UX S-129):** Das Master-Passwort-Feld erhält einen Show/Hide-Toggle: ein `showPassword`-State schaltet den Feld-`type` zwischen `password` (Default, verborgen) und `text` (sichtbar). Der Auslöser ist ein A11y-konformer Button (z.B. Auge-Icon) mit eindeutigem, zustandsabhängigem Label „Passwort anzeigen" / „Passwort verbergen" (`aria-pressed` oder `aria-label`), in den Tab-Fokus integriert, Touch-Target ≥ 44 px. Der sichtbare Klartext erscheint **nur** im Feld selbst, nie in Log/URL/Response.
8. **Schutz (Backend):** Die Unlock-Endpunkte sind hoch-privilegiert: hinter der Access-Mauer **+** `CRED_ADMIN_EMAILS`-Rollencheck (gleiche Logik wie ADR-007) **+** Audit-First (Audit nennt nur die Aktion, nie Werte).

## Acceptance-Kriterien
- **AC1** — Bei `state: "locked"` zeigt die Einstellungsseite den Button „Bitwarden verbinden"; bei `state: "unlocked"` wird **kein** Unlock-Bereich/Dialog angezeigt.
- **AC2** — Der Dialog enthält E-Mail-, Master-Passwort- (Typ `password`) und optionales 2FA-Feld; A11y: Labels (`label`/`htmlFor`), Fehler programmatisch zugeordnet (`aria-describedby`/`role=alert`), Fokusführung beim Öffnen/Fehler, modal (`role=dialog`/`aria-modal`), Touch-Targets ≥ 44 px.
- **AC3** — `POST /api/settings/credential-unlock` mit gültigen Daten beschafft den Key serverseitig, entsperrt den Store und persistiert in `.env`; die Response meldet nur `{ ok: true, state: "unlocked" }` und enthält **keinen** Key.
- **AC4** — Liefert die Beschaffung `not-found`, zeigt das Frontend ein **explizites** Erstellungs-Angebot; erst nach Bestätigung wird mit `create: true` erneut gesendet und der Key in Bitwarden angelegt + der Store entsperrt. Ohne Bestätigung wird **nichts** erstellt.
- **AC5** — `twofa-required`/`twofa-invalid` führt zu einer klaren, feldzugeordneten Meldung; der Nutzer kann den 2FA-Code eingeben und erneut absenden (kein Verlust der übrigen Eingaben außer den Geheimnissen, die nach jedem Submit verworfen werden dürfen).
- **AC5a** — `email-otp-required`/`email-otp-invalid` (New Device Verification, non-2FA-Accounts) führt zu einem **eigenen**, vom 2FA-Fall textlich unterscheidbaren E-Mail-OTP-Feld + feldzugeordneter Meldung, erneut absendbar; der bestehende 2FA-Fluss (AC5) bleibt unverändert. Vollständiges Verhalten + AC → [[bitwarden-new-device-otp]].
- **AC6** — Falsche Zugangsdaten / Bitwarden nicht erreichbar / falscher Key gegen bestehendes Store → klare, klassifizierte Fehlermeldung (4xx/5xx) **ohne** Geheimnis-Leak; der Store bleibt `locked`, `.env` unverändert.
- **AC7** — Die Unlock-Endpunkte sind nur einer berechtigten Identität zugänglich: kein gültiger Access ⇒ 403 (geerbt aus [[access-and-guardrails]]); bei gesetztem `CRED_ADMIN_EMAILS` ⇒ nur gelistete E-Mails, sonst 403.
- **AC8** — Jede Unlock-/Create-Anfrage erzeugt **vor** Ausführung einen Audit-Eintrag (Identität, Aktion `credential-unlock`/`credential-master-key-create`, Zeit) **ohne** Werte; schlägt der Audit-Write fehl, unterbleibt die Aktion (geerbt aus [[bitwarden-master-key-unlock]] AC8).
- **AC9** — Login-Daten + Master-Key erscheinen in **keiner** HTTP-Response, **keinem** Log/Audit, **keinem** WS-Frame, **nicht** im Frontend-Bundle und **nicht** in der URL. (Floor — testbar über Response-Body/Bundle/Log.)
- **AC10** — Nach erfolgreichem Unlock lädt die Einstellungsseite den Status neu (`unlocked`) und der Unlock-Bereich verschwindet; die regulären Credential-Sektionen sind danach nutzbar (kein Neustart nötig).
- **AC11** — Bei den Retry-Antworten `twofa-required`/`twofa-invalid`/`email-otp-required`/`email-otp-invalid` bleibt das **Master-Passwort-Feld befüllt** (Wert erhalten), sodass der Nutzer nur den 2FA-/E-Mail-Code nachreicht; das Passwort wird **nicht** geleert. Bei **terminalem** Ausgang (Erfolg ODER terminaler Fehler wie `auth-failed`/`bw-unreachable`) wird das Passwort (und die übrigen Geheimnisse) weiterhin aus dem State **verworfen**. Floor: das Passwort erscheint in **keinem** Log und **nicht** in der URL. (Testbar: nach `*-required`/`*-invalid`-Response ist das Passwort-Feld nicht leer; nach Erfolg/terminalem Fehler ist es leer.)
- **AC12** — Das Master-Passwort-Feld besitzt einen **Show/Hide-Toggle**: Default `type=password`; ein A11y-konformer Button (zustandsabhängiges Label „Passwort anzeigen"/„Passwort verbergen", fokussierbar, Touch-Target ≥ 44 px) schaltet auf `type=text` und zurück. Der sichtbare Klartext erscheint **nur** im Feld, **nicht** in Log/URL/Response/Bundle. (Testbar: Toggle ändert den Feld-`type`; Button trägt das passende Label je Zustand.)

## Verträge
- **GET `/api/settings/credential-status`** → siehe [[credential-bootstrap-status]] (Sichtbarkeits-Quelle).
- **POST `/api/settings/credential-unlock`** — Body `{ email: string, password: string, twofa?: string, emailOtp?: string, create?: boolean }` (`emailOtp?` → [[bitwarden-new-device-otp]]) →
  - Erfolg: `200 { ok: true, state: "unlocked" }` (**kein** Key).
  - Key nicht vorhanden: `200 { ok: false, status: "not-found" }` (Frontend bietet Erstellung an).
  - 2FA: `401 { ok: false, errorClass: "twofa-required"|"twofa-invalid" }`.
  - E-Mail-OTP (New Device Verification): `401 { ok: false, errorClass: "email-otp-required"|"email-otp-invalid" }` (→ [[bitwarden-new-device-otp]]).
  - Auth/Erreichbarkeit/Validierung: `4xx/5xx { ok: false, errorClass }` mit `errorClass ∈ { auth-failed, bw-unreachable, invalid-key, persist-failed, error }`.
  - Hinter AccessGuard **+** `CRED_ADMIN_EMAILS`-Rollencheck; Audit-First. **Nie** Key/Login-Daten in der Response.
- **Frontend (`SettingsView.jsx`):** Unlock-Bereich + Dialog-Komponente; Fetch-Helfer für Status + Unlock; Geheimnis-State wird nach Submit verworfen.

## Edge-Cases & Fehlerverhalten
- Leere Pflichtfelder (E-Mail/Passwort) ⇒ Frontend-Validierung (4xx vermeidbar) mit klarer, feldzugeordneter Meldung.
- `create: true` bei bereits existierendem Item (Race) ⇒ Backend behandelt idempotent/klar (kein zweites Item, kein Leak); Frontend zeigt klares Ergebnis.
- Mehrfaches Absenden während laufendem Unlock ⇒ Button im Ladezustand (`aria-busy`), kein Doppel-Submit-Schaden.
- `persist-failed` (`.env` nicht schreibbar) ⇒ klare Meldung „Key konnte nicht persistiert werden" ohne Key-Leak; Status spiegelt den tatsächlichen Zustand ([[credential-runtime-unlock]] Edge-Case).

## NFRs
- **Sicherheit (Floor, hart):** Login-Daten + Key nie im Bundle/Log/Audit/Response/WS/URL; Master-Passwort `type=password`/`autoComplete=off`; Klartext nach Submit verworfen; Backend serverseitige Beschaffung.
- **A11y:** WCAG 2.1 AA — modaler Dialog, Labels, Fehler programmatisch zugeordnet, Fokusführung, Touch-Targets ≥ 44 px, Kontrast ≥ 4.5:1, Loading-State.

## Nicht-Ziele
- Bitwarden-Beschaffungs-Mechanik → [[bitwarden-master-key-unlock]].
- Runtime-Unlock + `.env`-Persistenz → [[credential-runtime-unlock]].
- Status-Erkennung → [[credential-bootstrap-status]].
- Re-Sperren/Logout / Master-Key-Wechsel über die GUI (mögliche Folge-Anforderung).

## Abhängigkeiten
- [[credential-bootstrap-status]] (Sichtbarkeits-/Variantensteuerung).
- [[bitwarden-master-key-unlock]] (serverseitige Beschaffung + Key-Erstellung).
- [[bitwarden-new-device-otp]] (erweitert Endpunkt-Body + Dialog um den E-Mail-OTP-Fluss).
- [[credential-runtime-unlock]] (Unlock + `.env`-Persistenz).
- [[settings-credentials]] / [[settings-shell]] (Einstellungsseite, Sektions-Gerüst).
- [[access-and-guardrails]] (Access-Mauer + Audit + `CRED_ADMIN_EMAILS`).
</content>
