---
id: credential-unlock-dialog
title: Bitwarden-Unlock-Dialog auf der Einstellungsseite + Unlock-Endpunkte
status: draft
version: 1
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
6. **Erfolg:** Nach erfolgreichem Unlock schließt der Dialog (oder zeigt eine Erfolgsmeldung), der Status wird neu geladen (`unlocked`), der Unlock-Bereich verschwindet und die regulären Credential-/SSH-Sektionen sind nutzbar.
7. **Geheimnis-Hygiene (Frontend-Floor):** Login-Daten + Key erscheinen **nie** im Frontend-Bundle (kein hartkodiertes Geheimnis), **nie** in `console.log`, **nie** im DOM nach dem Submit, **nie** in der URL/Query. Das Master-Passwort-Feld ist `type=password`, `autoComplete="off"`. Klartext wird nach Submit aus dem React-State verworfen.
8. **Schutz (Backend):** Die Unlock-Endpunkte sind hoch-privilegiert: hinter der Access-Mauer **+** `CRED_ADMIN_EMAILS`-Rollencheck (gleiche Logik wie ADR-007) **+** Audit-First (Audit nennt nur die Aktion, nie Werte).

## Acceptance-Kriterien
- **AC1** — Bei `state: "locked"` zeigt die Einstellungsseite den Button „Bitwarden verbinden"; bei `state: "unlocked"` wird **kein** Unlock-Bereich/Dialog angezeigt.
- **AC2** — Der Dialog enthält E-Mail-, Master-Passwort- (Typ `password`) und optionales 2FA-Feld; A11y: Labels (`label`/`htmlFor`), Fehler programmatisch zugeordnet (`aria-describedby`/`role=alert`), Fokusführung beim Öffnen/Fehler, modal (`role=dialog`/`aria-modal`), Touch-Targets ≥ 44 px.
- **AC3** — `POST /api/settings/credential-unlock` mit gültigen Daten beschafft den Key serverseitig, entsperrt den Store und persistiert in `.env`; die Response meldet nur `{ ok: true, state: "unlocked" }` und enthält **keinen** Key.
- **AC4** — Liefert die Beschaffung `not-found`, zeigt das Frontend ein **explizites** Erstellungs-Angebot; erst nach Bestätigung wird mit `create: true` erneut gesendet und der Key in Bitwarden angelegt + der Store entsperrt. Ohne Bestätigung wird **nichts** erstellt.
- **AC5** — `twofa-required`/`twofa-invalid` führt zu einer klaren, feldzugeordneten Meldung; der Nutzer kann den 2FA-Code eingeben und erneut absenden (kein Verlust der übrigen Eingaben außer den Geheimnissen, die nach jedem Submit verworfen werden dürfen).
- **AC6** — Falsche Zugangsdaten / Bitwarden nicht erreichbar / falscher Key gegen bestehendes Store → klare, klassifizierte Fehlermeldung (4xx/5xx) **ohne** Geheimnis-Leak; der Store bleibt `locked`, `.env` unverändert.
- **AC7** — Die Unlock-Endpunkte sind nur einer berechtigten Identität zugänglich: kein gültiger Access ⇒ 403 (geerbt aus [[access-and-guardrails]]); bei gesetztem `CRED_ADMIN_EMAILS` ⇒ nur gelistete E-Mails, sonst 403.
- **AC8** — Jede Unlock-/Create-Anfrage erzeugt **vor** Ausführung einen Audit-Eintrag (Identität, Aktion `credential-unlock`/`credential-master-key-create`, Zeit) **ohne** Werte; schlägt der Audit-Write fehl, unterbleibt die Aktion (geerbt aus [[bitwarden-master-key-unlock]] AC8).
- **AC9** — Login-Daten + Master-Key erscheinen in **keiner** HTTP-Response, **keinem** Log/Audit, **keinem** WS-Frame, **nicht** im Frontend-Bundle und **nicht** in der URL. (Floor — testbar über Response-Body/Bundle/Log.)
- **AC10** — Nach erfolgreichem Unlock lädt die Einstellungsseite den Status neu (`unlocked`) und der Unlock-Bereich verschwindet; die regulären Credential-Sektionen sind danach nutzbar (kein Neustart nötig).

## Verträge
- **GET `/api/settings/credential-status`** → siehe [[credential-bootstrap-status]] (Sichtbarkeits-Quelle).
- **POST `/api/settings/credential-unlock`** — Body `{ email: string, password: string, twofa?: string, create?: boolean }` →
  - Erfolg: `200 { ok: true, state: "unlocked" }` (**kein** Key).
  - Key nicht vorhanden: `200 { ok: false, status: "not-found" }` (Frontend bietet Erstellung an).
  - 2FA: `401 { ok: false, errorClass: "twofa-required"|"twofa-invalid" }`.
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
- [[credential-runtime-unlock]] (Unlock + `.env`-Persistenz).
- [[settings-credentials]] / [[settings-shell]] (Einstellungsseite, Sektions-Gerüst).
- [[access-and-guardrails]] (Access-Mauer + Audit + `CRED_ADMIN_EMAILS`).
</content>
