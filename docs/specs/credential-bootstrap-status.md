---
id: credential-bootstrap-status
title: Locked-Zustand-Erkennung + Bootstrap-Status-Endpunkt
status: draft
version: 1
---

# Spec: Locked-Zustand-Erkennung + Bootstrap-Status-Endpunkt (`credential-bootstrap-status`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
Ein leak-freier **Status-Endpunkt** meldet dem Frontend, ob der `CredentialStore` **gesperrt** (`locked`) oder **entsperrt** (`unlocked`) ist und ob ein **Bootstrap** (erstmaliges Entsperren) nötig ist. Auf dieser Grundlage entscheidet [[credential-unlock-dialog]], ob der Setup-Dialog erscheint. Der Auslöser ist eng: der Dialog erscheint **nur** im gesperrten Zustand — im Normalbetrieb/Reboot (Key in `.env`) startet dev-gui autonom **ohne** Dialog.

## Verhalten
1. **Zustands-Erkennung beim Boot:** Beim Start ermittelt der Dienst den Lock-Zustand des `CredentialStore` ([[credential-runtime-unlock]]): ist ein Master-Key geladen ⇒ `unlocked`; sonst ⇒ `locked`. Der bestehende Fail-Fast (verschlüsselte Einträge ohne Key) bleibt davon unberührt und verhindert einen „locked"-Start in genau diesem Fall (Boot bricht ab).
2. **Status-Endpunkt:** `GET /api/settings/credential-status` liefert den aktuellen Zustand: `state` (`locked`|`unlocked`) und `hasEncryptedEntries` (ob `secrets.enc.json` verschlüsselte Einträge enthält → unterscheidet „frisch einrichten" von „mit bestehendem Store entsperren"). Die Antwort enthält **niemals** Schlüssel/Klartext.
3. **Auslöser-Logik (für das Frontend):** Der Setup-/Unlock-Dialog ([[credential-unlock-dialog]]) erscheint **nur**, wenn `state === "locked"`. Bei `state === "unlocked"` erscheint **kein** Dialog (Normalbetrieb). `hasEncryptedEntries` steuert die Dialog-Variante (Erst-Einrichtung vs. Entsperren eines bestehenden Stores) und die Key-Erstellungs-Option ([[bitwarden-master-key-unlock]] AC3/AC4).
4. **Live-Aktualisierung nach Unlock:** Nach erfolgreichem Unlock spiegelt ein erneuter Abruf von `GET /api/settings/credential-status` den Zustand `unlocked` wider (ohne Neustart, geerbt aus [[credential-runtime-unlock]]).
5. **Sichtbarkeit/Schutz:** Der Status-Endpunkt liegt hinter der Access-Mauer ([[access-and-guardrails]]). Er ist **lesend** und nennt keine Geheimnisse; er ist auch im gesperrten Zustand erreichbar (sonst ließe sich der Bootstrap nicht anstoßen).

## Acceptance-Kriterien
- **AC1** — `GET /api/settings/credential-status` liefert `200 { state: "locked"|"unlocked", hasEncryptedEntries: boolean }` und **niemals** einen Schlüssel/Klartext-Wert.
- **AC2** — Startet der Dienst ohne verfügbaren Master-Key und **ohne** verschlüsselte Einträge, meldet der Endpunkt `state: "locked"` (und `hasEncryptedEntries: false`); der Dienst läuft (kein Fail-Fast — geerbt aus [[credential-runtime-unlock]] AC1).
- **AC3** — Ist ein Master-Key geladen (Env/`.env` beim Boot **oder** nach Laufzeit-Unlock), meldet der Endpunkt `state: "unlocked"`.
- **AC4** — Existieren verschlüsselte Einträge und ist der Store entsperrt, ist `hasEncryptedEntries: true`; existieren keine, `false`. (Steuert die Dialog-Variante.)
- **AC5** — Nach einem erfolgreichen Laufzeit-Unlock wechselt ein erneuter Abruf von `locked` auf `unlocked` **ohne** Prozess-Neustart.
- **AC6** — Der Endpunkt ist hinter der Access-Mauer (kein gültiger Access ⇒ 403, geerbt aus [[access-and-guardrails]]); im gesperrten Zustand bleibt er erreichbar.
- **AC7** — Der Endpunkt erscheint in keinem Pfad mit Geheimnis-Leak: weder Response, Log noch Audit enthalten Schlüssel-/Klartext-Werte.

## Verträge
- **GET `/api/settings/credential-status`** → `200 { state: "locked"|"unlocked", hasEncryptedEntries: boolean }`. Hinter AccessGuard; rein lesend; kein Audit nötig (kein Mutations-/Geheimnis-Pfad). Quelle = `CredentialStore.getLockState()` ([[credential-runtime-unlock]]).

## Edge-Cases & Fehlerverhalten
- Store-Datei unlesbar/manipuliert ⇒ konsistent mit ADR-007 (Fail-Fast bzw. harter Fehler beim Boot); der Status-Endpunkt erfindet **keinen** „entsperrt"-Zustand.
- Abruf während eines laufenden Unlock-Vorgangs ⇒ meldet den zu diesem Zeitpunkt gültigen Zustand (keine Teil-Zustände nach außen).

## NFRs
- **Sicherheit (Floor, hart):** keine Geheimnisse in Response/Log/Audit; hinter Access-Mauer.
- **Robustheit:** im gesperrten Zustand erreichbar (Bootstrap möglich); spiegelt Laufzeit-Unlock ohne Neustart.

## Nicht-Ziele
- Runtime-Unlock-Mechanik → [[credential-runtime-unlock]].
- Bitwarden-Beschaffung → [[bitwarden-master-key-unlock]].
- GUI-Dialog → [[credential-unlock-dialog]].

## Abhängigkeiten
- [[credential-runtime-unlock]] (`getLockState()`).
- [[access-and-guardrails]] (Access-Mauer).
- Konsumiert von [[credential-unlock-dialog]] (Sichtbarkeits-Steuerung).
</content>
