---
id: settings-credentials
title: Credential-Verwaltung (write-only, maskiert, je Integration)
status: draft
version: 1
---

# Spec: Credential-Verwaltung (`settings-credentials`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
In den Sektionen der Settings-Ansicht ([[settings-shell]]) lassen sich die **Credentials je Integration** anlegen, ändern und löschen — für die GitHub-App, Cloudflare, Hetzner/VPS sowie generische „weitere" Credentials. Geheime Werte werden **niemals im Klartext** ans Frontend zurückgegeben (write-only): die Oberfläche zeigt nur **Status** („gesetzt" / „nicht gesetzt") und ggf. eine **maskierte** Kurzform. Diese Spec legt das **fachliche** Verhalten + die Backend-Verträge **provider-agnostisch** fest; **wo** und **wie** verschlüsselt persistiert wird, entscheidet der `architekt` (siehe Offene Architektur-Punkte) — die Acceptance-Kriterien gelten unabhängig vom gewählten Speicher.

## Verhalten
1. Jede Integrations-Sektion listet die für sie definierten **Credential-Felder** (z.B. GitHub: App-ID, Installation-ID, Private Key; Cloudflare: API-Token, Account-ID; Hetzner/VPS: API-Token) mit ihrem **Status** (gesetzt / nicht gesetzt) und — falls gesetzt und sinnvoll — einer **maskierten** Darstellung (z.B. nur letzte 4 Zeichen oder ausschließlich „••••• gesetzt").
2. Der Nutzer kann einen Credential-Wert **setzen** (anlegen) oder **überschreiben** (ändern): er gibt den Klartext ein und speichert; nach dem Speichern wird der eingegebene Klartext **nicht** wieder angezeigt, der Status wechselt auf „gesetzt".
3. Der Nutzer kann ein gesetztes Credential **löschen**; der Status wechselt auf „nicht gesetzt".
4. Generische „weitere Credentials" können als benannte **Schlüssel/Wert-Einträge** in einer dedizierten Sektion (oder Unter-Bereich „Weitere") angelegt, geändert und gelöscht werden — gleiche write-only-Regeln.
5. **Kein** Lese-Endpunkt gibt jemals einen geheimen Klartext-Wert zurück; jede Lese-Antwort enthält ausschließlich Metadaten (Name, Status, optional Maske, Zeitstempel der letzten Änderung).
6. Schreibende und löschende Aktionen werden **auditiert** (welche Access-Identität, welches Credential-Feld, welche Aktion, wann) — der Klartext-Wert erscheint **nicht** im Audit.
7. Jede mutierende Aktion ist **identitäts-/rollengeschützt**: sie ist nur einer berechtigten Access-Identität erlaubt (über die bestehende Access-Mauer + Identitätsauswertung); ein Lese-Status genügt nicht zum Mutieren, wenn der Architekt-Entscheid eine Rollentrennung vorsieht.
8. Eingaben werden **validiert** (Pflichtfelder, erwartetes Format soweit prüfbar, Längenobergrenze); ungültige Eingaben werden mit klarer Fehlermeldung abgelehnt, ohne den bestehenden Wert zu verändern.

## Acceptance-Kriterien
- **AC1** — Je Integrations-Sektion werden die definierten Credential-Felder mit Status („gesetzt" / „nicht gesetzt") angezeigt; ein gesetzter Wert wird **niemals im Klartext** dargestellt (höchstens maskiert).
- **AC2** — Ein Credential lässt sich über das Backend **setzen/überschreiben**; nach erfolgreichem Speichern liefert jede nachfolgende Lese-Antwort den Status „gesetzt" und **keinen** Klartext, und das Frontend zeigt den eingegebenen Klartext nicht erneut an.
- **AC3** — Ein gesetztes Credential lässt sich **löschen**; danach ist der Status „nicht gesetzt" und kein Restwert mehr abrufbar.
- **AC4** — **Kein** API-Endpunkt dieser Capability gibt einen geheimen Klartext-Wert zurück; Lese-Antworten enthalten ausschließlich Metadaten (Name, Status, optional Maske, `updatedAt`). (Testbar: Response-Body enthält den gespeicherten Geheimwert nicht.)
- **AC5** — Generische „weitere" Credentials lassen sich als benannte Schlüssel/Wert-Einträge anlegen, ändern und löschen, mit denselben write-only-/Masken-Regeln.
- **AC6** — Jede schreibende/löschende Credential-Aktion erzeugt einen Audit-Eintrag (Identität, Feld/Schlüssel, Aktion, Zeit) **ohne** den Klartext-Wert; der Geheimwert erscheint nicht in Logs, Audit, WS-Stream oder Frontend-Bundle.
- **AC7** — Mutierende Endpunkte sind nur einer berechtigten Access-Identität zugänglich; eine Anfrage ohne gültigen Access-Nachweis wird mit 403 abgewiesen (geerbt aus [[access-and-guardrails]]); fehlende Berechtigung bei vorhandenem Access wird mit 403 abgewiesen.
- **AC8** — Ungültige/leere Pflichteingaben werden mit klarer Fehlermeldung (4xx) abgelehnt, ohne einen bestehenden gesetzten Wert zu verändern.

## Verträge
> Pfade/Felder sind kanonisch; das genaue Schema des Persistenz-Backends ist Implementierungsdetail (Architekt).

- **GET `/api/settings/credentials`** → Liste aller bekannten Credential-Felder mit `{ integration, name, status: "set"|"unset", masked?: string, updatedAt?: string }`. **Nie** ein Klartext-Geheimwert.
- **PUT `/api/settings/credentials/{integration}/{name}`** — Body `{ value: <klartext> }` → setzt/überschreibt; Response enthält nur Metadaten (Status „set", `updatedAt`), **kein** `value`.
- **DELETE `/api/settings/credentials/{integration}/{name}`** → entfernt den Wert; Response Status „unset".
- **„Weitere" Credentials:** `integration = "misc"` mit frei wählbarem `name` (validiert: erlaubte Zeichen, Längenlimit); gleiche PUT/DELETE-Semantik.
- Alle Endpunkte hinter AccessGuard; mutierende zusätzlich identitäts-/rollengeprüft. Jede Mutation schreibt einen AuditEntry (vgl. [[access-and-guardrails]]).
- **Felder-Katalog (Default-Vorschlag, vom Architekt/`dba` bestätigbar):** GitHub = `app_id`, `installation_id`, `private_key`; Cloudflare = `api_token`, `account_id`; VPS = `hetzner_api_token`. (SSH-Keys NICHT hier — siehe [[settings-ssh-keys]].)

## Edge-Cases & Fehlerverhalten
- Speichern eines bereits gesetzten Felds = Überschreiben (kein Konflikt); alter Wert wird ersetzt.
- Löschen eines nicht gesetzten Felds = idempotent (200/204, Status bleibt „unset").
- Persistenz-Backend nicht erreichbar/nicht konfiguriert → 5xx mit klarer Meldung, **ohne** Teil-/Klartext-Leak; bestehende Werte bleiben unverändert.
- Unbekannte `integration`/`name` außerhalb des Katalogs (außer `misc`) → 404/422.
- Eingabe überschreitet Längenlimit → 422.

## NFRs
- **Sicherheit (Floor, hart):** Geheimwerte werden **at rest verschlüsselt** abgelegt (Verfahren/Schlüsselverwaltung: Architekt) und erscheinen **nie** im Frontend-Bundle, in Logs, im Audit oder im WS-Stream. Schreibpfad write-only, Lesepfad metadaten-only.
- **Sicherheit:** mutierende Aktionen auditiert + identitäts-/rollengeschützt (höher-privilegiert als reine Lese-Views).
- **A11y:** Formularfelder beschriftet, Fehler programmatisch zugeordnet, Fokusführung beim Speichern/Fehler.

## Nicht-Ziele
- Festlegung des Secret-Speichers / der Verschlüsselungsmechanik (Architektur-Entscheidung, ausstehend — siehe unten).
- SSH-Key-spezifische Behandlung und VPS-Provisionierung (→ [[settings-ssh-keys]]).
- Verifikation der Credentials gegen den jeweiligen Provider (kann Folge-Anforderung sein; hier nur Speicher-Lebenszyklus + Status).

## Architektur-Punkte (ENTSCHIEDEN — siehe `docs/architecture.md` ADR-007)
- **OA1 → ENTSCHIEDEN:** verschlüsselte JSON-Datei `secrets.enc.json` auf dem persistenten Volume (`/home/node/.claude/dev-gui/`); kein RDBMS. Einziger Boundary `CredentialStore` (`src/CredentialStore.js`). ADR-005 bleibt für Fabrik-Read-Models gültig (Re-Scoping in ADR-007).
- **OA2 → ENTSCHIEDEN:** **AES-256-GCM** (Node-`crypto`); Master-Key aus Env `CRED_MASTER_KEY` (optional `CRED_MASTER_KEY_FILE`), per **scrypt** abgeleitet; nie im Image/Log. Fehlt der Key in Prod bei vorhandenem Store → Fail-Fast.
- **OA3 → ENTSCHIEDEN:** gültige Access-Identität genügt zum Mutieren **+ Pflicht-Audit**; optionale Env `CRED_ADMIN_EMAILS` (Komma-Liste) schaltet eine engere Admin-Allowlist scharf (AC7 in beiden Auslegungen erfüllbar).

## Abhängigkeiten
- [[settings-shell]] (Sektions-Gerüst + Route).
- [[access-and-guardrails]] (Access-Mauer + Audit-Log + Identitätsauswertung).
- Offen: verschlüsselter Credential-Store (Architektur-Entscheidung, OA1).
</content>
