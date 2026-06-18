---
id: github-app-key-format-tolerant
title: GitHub-App-Private-Key format-tolerant + newline-robust laden (PKCS#1 ⊕ PKCS#8) + Textarea-Eingabe
status: draft
version: 1
---

# Spec: GitHub-App-Private-Key format-tolerant laden (`github-app-key-format-tolerant`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). **Security-kritisch** (Private-Key-Handling; App-Token-Floor).
> **Härtet** den App-Token-Provider ([[github-app-token-unification]], S-146; App-Token-only S-149) so, dass der im Live-Test (2026-06) beobachtete Setup-Fallstrick (PKCS#1-Key bzw. Key ohne Zeilenumbrüche → `jwt-sign-failed` → kein App-Token) nicht mehr auftritt. **Voraussetzung für** [[ghcr-image-list-app-token]] (S-165) und alle weiteren App-Token-Funktionen.

## Zweck
Im ersten echten Live-Deploy (2026-06, VPS unter `alexstuder.cloud`) brach der App-Token-Provider: `src/githubAppToken.js:109` nutzt `importPKCS8(privateKeyPem, 'RS256')` aus `jose`, das **ausschließlich PKCS#8** (`-----BEGIN PRIVATE KEY-----`) akzeptiert. GitHub liefert App-Private-Keys jedoch im **PKCS#1**-Format (`-----BEGIN RSA PRIVATE KEY-----`). Zusätzlich war der im `CredentialStore` hinterlegte Key **ohne Zeilenumbrüche** gespeichert — typischer Copy-Paste-Fallstrick beim Einfügen in ein **einzeiliges** Eingabefeld (Newlines durch Leerzeichen ersetzt). Folge: `importPKCS8` wirft → `jwt-sign-failed` → **kein** Installation-Token → `GET /api/github/packages` liefert `[]` (Image-Dropdown leer, [[ghcr-image-list-app-token]]) **und** jede andere App-Token-Funktion (Repo-Create/Clone/Pull, Reconcile, gh-Auth im Container) ist betroffen.

**Gegenprobe (live verifiziert):** Node's `crypto.createPrivateKey()` erkennt **beide** Formate (PKCS#1 **und** PKCS#8); auch der per Newline-Normalisierung reparierte Key signiert einwandfrei. Ein manueller Sofort-Fix (Key normalisieren + zu PKCS#8 konvertieren + neu speichern) hielt den Live-Test am Laufen — der **Code bleibt aber anfällig**, solange er nur PKCS#8 mit erhaltenen Newlines akzeptiert. Diese Spec macht das Laden **format-tolerant + newline-robust** und verhindert den Newline-Verlust schon **bei der Eingabe**.

## Verhalten
1. **Format-Toleranz beim Laden:** Beim Minten des App-JWT (`getToken`-Pfad, `src/githubAppToken.js`) wird der aus dem `CredentialStore` gelesene `privateKeyPem` **format-tolerant** zu einem Signier-Schlüssel verarbeitet — **sowohl PKCS#1** (`-----BEGIN RSA PRIVATE KEY-----`) **als auch PKCS#8** (`-----BEGIN PRIVATE KEY-----`) ergeben einen gültigen RS256-Signierschlüssel. Lösungsweg frei (`architekt`/`coder`), z.B.:
   - (a) `crypto.createPrivateKey(pem)` → resultierendes `KeyObject` an `jose`'s `SignJWT(...).sign(keyObject)` übergeben (akzeptiert KeyObject; deckt beide Formate ab), **oder**
   - (b) PKCS#1 → PKCS#8 konvertieren (`crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' })`) und dann wie bisher `importPKCS8`.
2. **Newline-Normalisierung beim Laden:** Vor dem Schlüssel-Import wird der PEM **whitespace-tolerant normalisiert**: Header/Footer-Zeile (`-----BEGIN … KEY-----` / `-----END … KEY-----`) erkennen, den Base64-**Body** dazwischen extrahieren, **allen** Whitespace (Leerzeichen, Tabs, einzelne `\n`/`\r`) aus dem Body entfernen und ihn in **64-Zeichen-Zeilen** mit `\n` neu umbrechen, dann mit Header/Footer wieder zusammensetzen. So lädt auch ein Key, dessen Zeilenumbrüche bei der Eingabe zu Leerzeichen wurden, korrekt. Bereits korrekt formatierte Keys bleiben funktional unverändert (idempotent).
3. **Mehrzeilige Eingabe im Frontend:** Das Credential-Eingabefeld für den Private-Key (`integration: github`, `name: private_key`, `client/src/SettingsView.jsx` `CredentialField`) wird beim Bearbeiten eine **mehrzeilige Textarea** statt eines einzeiligen `<input>`, sodass eingefügte Zeilenumbrüche **erhalten** bleiben. Andere Credential-Felder (App-ID, Installation-ID, Tokens) bleiben einzeilig. Der Write-only-Charakter ([[settings-credentials]]) bleibt: kein Klartext im DOM nach dem Speichern, Klartext sofort verworfen.
4. **Floor unverändert:** **App-Token-only** bleibt ([[github-app-token-unification]] AC9, S-149) — **kein** `process.env.GH_TOKEN`-Fallback wird eingeführt. Der Private-Key bleibt **store-intern** (ADR-007), wird nur transient pro Mint geladen und erscheint **nie** in Log/Response/Audit/WS/Argv/Bundle.

## Acceptance-Kriterien

### Format-Toleranz
- **AC1** — Ein **PKCS#1**-RSA-Private-Key (`-----BEGIN RSA PRIVATE KEY-----`) mit **korrekten** Zeilenumbrüchen ergibt beim Minten ein **gültiges, mit dem Public-Key verifizierbares** RS256-JWT (kein `jwt-sign-failed`). (Testbar: lokal generierter PKCS#1-Key im gemockten Store → `getToken`-JWT verifiziert gegen den zugehörigen Public-Key; `header.alg === RS256`, `iss === appId`.)
- **AC2** — Ein **PKCS#8**-Private-Key (`-----BEGIN PRIVATE KEY-----`) mit korrekten Zeilenumbrüchen ergibt weiterhin ein gültiges, verifizierbares RS256-JWT (Bestandsverhalten bleibt erhalten). (Testbar: PKCS#8-Key → JWT verifiziert.)

### Newline-Robustheit
- **AC3** — Ein **PKCS#1**-Key, dessen Body-Zeilenumbrüche durch **Leerzeichen** ersetzt wurden (einzeiliger Copy-Paste-Fall, exakt der Live-Befund), ergibt nach der Normalisierung ein **gültiges, verifizierbares** RS256-JWT. (Testbar: PEM mit `\n`→` ` ersetzt → `getToken` liefert verifizierbares JWT.)
- **AC4** — Die Normalisierung ist **idempotent**: ein bereits korrekt zeilenumgebrochener Key bleibt funktional identisch (verifizierbares JWT, kein Bruch). (Testbar: korrekt formatierter Key → JWT verifiziert; doppelte Normalisierung ändert das Ergebnis nicht.)

### Eingabe
- **AC5** — Das Bearbeiten-Feld für `github`/`private_key` rendert eine **mehrzeilige Textarea** (`<textarea>` bzw. `multiline`-Steuerung), während die übrigen Credential-Felder einzeilig bleiben; ein mit Zeilenumbrüchen eingefügter PEM wird **mit** seinen Newlines an `PUT /api/settings/credentials/github/private_key` übergeben. Write-only bleibt: nach dem Speichern kein Klartext im DOM. (Testbar: Komponententest — für `private_key` ist das Edit-Control eine Textarea; eingegebener mehrzeiliger Wert landet unverändert (inkl. `\n`) im Request-Body.)

### Floor (hart)
- **AC6** — Der Private-Key (Klartext, normalisiert oder konvertiert), das App-JWT und der Installation-Token erscheinen **nie** in Response, Log, Fehlertext, Audit, WS-Stream, Argv oder Frontend-Bundle; bei ungültigem/unbrauchbarem Key bleibt die Fehlerklasse generisch (`jwt-sign-failed`, **ohne** Key-Inhalt). **Kein** `process.env.GH_TOKEN`-Pfad wird eingeführt (App-Token-only bleibt, Grep-prüfbar). (Testbar: Log-/Response-Pfade secret-frei; Grep ohne `GH_TOKEN`-Fallback im geänderten Pfad.)
- **AC7** — Ist der Key **strukturell unbrauchbar** (kein parsbarer PEM beider Formate), degradiert der Mint geheimnisfrei mit `jwt-sign-failed` (Bestandsverhalten), **ohne** Crash und ohne Key-Leak. (Testbar: Müll-PEM → `GitHubAppTokenError('jwt-sign-failed')`, kein Key im Fehlertext.)

## Verträge
- **`getToken()` / App-JWT-Mint** (`src/githubAppToken.js`): liest `privateKeyPem` weiterhin **ausschließlich** store-intern (`credentials/github/private_key`, ADR-007); akzeptiert PKCS#1 **und** PKCS#8; normalisiert Whitespace im PEM-Body vor dem Import; signiert RS256, `iss = app_id`, `iat = now-60`, `exp = now+600` (unverändert). **Keine** Signatur-Änderung nach außen.
- **PEM-Normalisierung (intern):** `(pem) → pem'` — extrahiert `-----BEGIN (RSA )?PRIVATE KEY-----` … `-----END (RSA )?PRIVATE KEY-----`, entfernt Whitespace im Body, umbricht in 64-Zeichen-Zeilen (`\n`), setzt Header/Footer wieder; idempotent; gibt bei nicht erkennbarem Rahmen den Eingabe-PEM unverändert zurück (der nachgelagerte Import wirft dann sauber, AC7).
- **`PUT /api/settings/credentials/github/private_key`** (unverändert, [[settings-credentials]]): nimmt den (jetzt mehrzeiligen) PEM als Klartext-Wert entgegen, speichert verschlüsselt at rest (ADR-007), liefert nur Metadaten zurück (kein Klartext).
- **Frontend `CredentialField`** (`client/src/SettingsView.jsx`): für `integration === 'github' && name === 'private_key'` ist das Edit-Control eine `<textarea>` (mehrzeilig); sonst unverändert `<input type="password">`. Length-Limit (`MAX_VALUE_LEN`) + Trim-auf-leer-Validierung bleiben (Trim entfernt nur äußeren Whitespace, nicht die Body-Newlines).
- **Org/Provider-Konstanten** unverändert.

## Edge-Cases & Fehlerverhalten
- PKCS#1 mit korrekten Newlines → JWT (AC1).
- PKCS#1 mit Newlines→Leerzeichen (Live-Befund) → normalisiert → JWT (AC3).
- PKCS#8 (mit/ohne korrekte Newlines) → JWT (AC2 + Normalisierung greift analog).
- Bereits PKCS#8 + korrekt formatiert (heutiger Erwartungsfall) → unverändert funktional (AC4).
- Nicht-parsbarer/abgeschnittener Key → `jwt-sign-failed`, kein Crash, kein Leak (AC7).
- Verschlüsselter Private-Key (Passphrase-geschützt) → **Nicht-Ziel**; degradiert wie unbrauchbarer Key (`jwt-sign-failed`); GitHub-App-Keys sind unverschlüsselt, daher kein realer Pfad.
- Textarea-Eingabe mit CRLF (`\r\n`) → Normalisierung entfernt `\r` aus dem Body wie anderen Whitespace.

## NFRs
- **Sicherheit (Floor, hart):** Private-Key store-intern + transient (ADR-007); nie in Log/Response/Audit/WS/Argv/Bundle; App-Token-only (kein `GH_TOKEN`). Generische Fehlerklasse ohne Key-Inhalt.
- **Robustheit:** format-tolerant (PKCS#1 ⊕ PKCS#8) + newline-tolerant; idempotente Normalisierung; kein neuer Crash-Pfad.
- **Kein neues SDK:** nur eingebautes `node:crypto` + das bereits genutzte `jose`; kein neuer Dependency-Eintrag nötig.

## Nicht-Ziele
- Aufweichen des App-Token-only-Floors (kein `GH_TOKEN`-Fallback).
- Migration/automatische Re-Konvertierung bereits gespeicherter Keys im Store (das Laden ist tolerant; ein Re-Save über die Textarea genügt). Eine optionale Normalisierung-beim-Schreiben ist erlaubt, aber nicht gefordert.
- Unterstützung passphrase-verschlüsselter Private-Keys.
- Änderungen am Token-Exchange (`POST /app/installations/{id}/access_tokens`) oder an der Cache-Logik des Providers.

## Abhängigkeiten
- [[github-app-token-unification]] (App-Token-Provider, S-146; App-Token-only S-149 — Token-Quelle + Floor, gehärtet).
- [[ghcr-image-list-app-token]] (S-165 — Konsument: ohne gültiges App-Token bleibt das Image-Dropdown leer; verwandte Live-Lücke).
- [[settings-credentials]] (Credential-Schreibpfad + Write-only-Charakter; Textarea-Erweiterung).
- `docs/architecture.md` — ADR-007 (CredentialStore, Private-Key store-intern).
