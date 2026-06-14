---
id: credential-key-status-transparency
title: Key-Quelle-Transparenz (credential-status keySource + immer sichtbarer Store-Status)
status: draft
version: 1
---

# Spec: Key-Quelle-Transparenz (`credential-key-status-transparency`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch (Floor: nie Key/Wert leaken).

## Zweck
Behebt die Verwirrung „wieso erscheint kein Verbinden-Button" beim autonom (Env) entsperrten Container: Der Status-Endpunkt `GET /api/settings/credential-status` ([[credential-bootstrap-status]]) liefert **zusätzlich** die **Quelle** des Master-Keys (`keySource`), und die SettingsView zeigt den Store-Status **immer** an — nicht nur im gesperrten Zustand. So ist transparent, ob der Store automatisch (Boot-Env) oder manuell (Runtime-Dialog) entsperrt wurde oder gesperrt ist.

## Verhalten
1. **Key-Quelle wird im Store nachgehalten:** Der `CredentialStore` merkt sich, **woher** der aktuell geladene Master-Key stammt:
   - `auto` — beim Boot aus Env/`.env` geladen (`DEVGUI_CRED_MASTER_KEY` bzw. deprecated `CRED_MASTER_KEY`, [[credential-master-key-decoupling]]).
   - `manual` — zur Laufzeit per `unlock(...)` (Bitwarden-Dialog, [[credential-runtime-unlock]]) geladen.
   - `none` — kein Key geladen (Store `locked`).
2. **Status-Endpunkt erweitert:** `GET /api/settings/credential-status` liefert zusätzlich zum bestehenden `{ state, hasEncryptedEntries }` das Feld **`keySource`** (`"auto" | "manual" | "none"`). Es enthält **niemals** den Key oder einen Wert — nur die Quelle als Enum.
3. **Konsistenz state ↔ keySource:** `state: "locked"` ⇒ `keySource: "none"`. `state: "unlocked"` ⇒ `keySource ∈ { "auto", "manual" }`. Ein erfolgreicher Runtime-Unlock setzt `keySource` auf `"manual"` (ohne Neustart). Nach Reboot mit Key in `.env`/Env ist `keySource` wieder `"auto"`.
4. **SettingsView zeigt den Status IMMER:**
   - `unlocked` ⇒ Statuszeile „🔓 entsperrt", mit Quellen-Hinweis: `auto` → „(Quelle: automatischer Schlüssel)", `manual` → „(Quelle: via Bitwarden entsperrt)". **Kein** Verbinden-Button.
   - `locked` ⇒ Statuszeile „🔒 gesperrt" **+** Verbinden-Button (öffnet den Bitwarden-Unlock-Dialog, [[credential-unlock-dialog]]).
   - Der Status-Bereich ist **immer** sichtbar (auch unlocked) — der bisherige „nur bei locked sichtbar"-Abschnitt wird zu einem immer sichtbaren Status mit zustandsabhängigem Inhalt.
5. **Sicherheits-Floor (hart):** Weder Endpunkt-Response, Log, Audit noch WS/Frontend-Bundle enthalten je den Key oder einen Wert; `keySource` ist ein reines Quellen-Enum.

## Acceptance-Kriterien
- **AC1** — `GET /api/settings/credential-status` liefert `200 { state, hasEncryptedEntries, keySource }` mit `keySource ∈ { "auto", "manual", "none" }` und **niemals** einem Schlüssel/Klartext-Wert.
- **AC2** — Boot mit Master-Key aus Env/`.env` ⇒ `state: "unlocked"`, `keySource: "auto"`.
- **AC3** — Nach erfolgreichem Runtime-`unlock(...)` ⇒ `state: "unlocked"`, `keySource: "manual"` (ohne Prozess-Neustart, geerbt aus [[credential-runtime-unlock]] AC3).
- **AC4** — Im gesperrten Zustand ⇒ `state: "locked"`, `keySource: "none"`. (`state: "locked"` impliziert immer `keySource: "none"`.)
- **AC5** — SettingsView rendert die Status-Zeile **immer**: bei `unlocked` „entsperrt" inkl. quellenabhängigem Hinweis (auto/manual) und **ohne** Verbinden-Button; bei `locked` „gesperrt" **mit** Verbinden-Button.
- **AC6** — Der Verbinden-Button erscheint **ausschließlich** bei `state: "locked"`; bei `unlocked` (egal ob `auto` oder `manual`) erscheint **kein** Verbinden-Button. (Behebt die ursprüngliche „kein Button trotz unlocked"-Verwirrung — jetzt erklärt der sichtbare Status das Warum.)
- **AC7** — Endpunkt, Log, Audit, WS und Frontend-Bundle enthalten in **keinem** Fall den Master-Key/einen Wert; `keySource` ist ausschließlich ein Quellen-Enum.
- **AC8** — Der Endpunkt bleibt hinter der Access-Mauer (kein Access ⇒ 403, geerbt aus [[access-and-guardrails]]) und ist auch im `locked`-Zustand erreichbar.

## Verträge
- **`CredentialStore`-Erweiterung (intern):**
  - `getLockState(): { state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }` — erweitert um `keySource`; gibt **nie** Schlüssel/Klartext zurück.
  - Boot-Pfad setzt internen Quellen-Marker auf `auto` (Key aus Env/`.env`) bzw. `none` (kein Key); `unlock(...)` setzt ihn bei Erfolg auf `manual`.
- **GET `/api/settings/credential-status`** → `200 { state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }`. Hinter AccessGuard; rein lesend; kein Audit (kein Mutations-/Geheimnis-Pfad). Quelle = `CredentialStore.getLockState()`.
- **SettingsView:** konsumiert `keySource` zusätzlich zu `state`; rendert die immer sichtbare Status-Zeile + zustandsabhängig den Verbinden-Button.

## Edge-Cases & Fehlerverhalten
- Statusabruf während eines laufenden Unlock-Vorgangs ⇒ liefert den zu diesem Zeitpunkt gültigen Zustand inkl. konsistentem `keySource` (keine Teil-Zustände nach außen).
- Unbekannter/leerer interner Quellen-Marker bei geladenem Key ⇒ defensiv als `auto` melden (nie Key/Wert, nie Crash); `locked` bleibt immer `none`.
- Store-Datei unlesbar/manipuliert ⇒ konsistent mit ADR-007 (Fail-Fast/harter Fehler); der Endpunkt erfindet **keinen** „unlocked"-Zustand und kein falsches `keySource`.

## NFRs
- **Sicherheit (Floor, hart):** keine Geheimnisse in Response/Log/Audit/WS/Bundle; `keySource` ist reines Enum; hinter Access-Mauer.
- **Konsistenz:** `state`/`keySource` stets widerspruchsfrei (AC4).

## Nicht-Ziele
- Beschaffung/Unlock-Mechanik → [[credential-runtime-unlock]] / [[bitwarden-master-key-unlock]] / [[credential-unlock-dialog]].
- Entkopplung/Umbenennung des Env-Namens → [[credential-master-key-decoupling]].
- Key-Flow-Dokumentation → [[credential-key-flow]].

## Abhängigkeiten
- [[credential-master-key-decoupling]] (Boot-Key-Quelle/Prioritätskette; legt `auto` fest) — inhaltlich vorausgesetzt.
- [[credential-bootstrap-status]] (`GET /api/settings/credential-status`, wird erweitert).
- [[credential-runtime-unlock]] (`getLockState`, `unlock` → `manual`).
- [[credential-unlock-dialog]] (Verbinden-Button öffnet den Dialog).
- [[access-and-guardrails]] (Access-Mauer, Floor).
