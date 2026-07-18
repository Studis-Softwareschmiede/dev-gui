---
id: deployments-gpg-subview
title: Deployments-Bereich — linkes Untermenü + kompakte GPG-Schlüssel-Ansicht
status: active
area: deployment
spec_format: use-case-2.0
version: 1
---

# Spec: Deployments-Bereich — linkes Untermenü + kompakte GPG-Schlüssel-Ansicht (`deployments-gpg-subview`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. **Security-relevant** (GPG-Passphrasen-Verwaltung).

## Zweck
Der Deployments-Bereich der dev-gui wird in **zwei Unterbereiche** aufgeteilt, die über ein **linkes Untermenü** umgeschaltet werden: „Deployment" (die bestehende Deployments-Ansicht, Standard-Auswahl) und „GPG-Schlüssel". Die GPG-Passphrasen-Verwaltung (Provisionierung + Rotation) wird aus der Hauptansicht **herausgelöst** und in den Unterbereich „GPG-Schlüssel" verschoben — dort **kompakt je gewählter App** (Dropdown) statt als lange Liste aller Apps. Ziel: die überladene Deployment-Ansicht entrümpeln und die sicherheitskritische GPG-Verwaltung an einem klaren, fokussierten Ort bündeln.

## Kontext & Abgrenzung
Baut auf [[per-app-gpg-passphrase-provisioning]] (Anlage/Nach-Provisionierung, Existenz-Abfrage AC16) und [[per-app-gpg-passphrase-rotation]] (Zwei-Phasen-Rotation) auf. **Diese Spec ändert weder die Provisionierungs- noch die Rotations-Logik, -Sicherheitsmechanik oder deren HTTP-Endpunkte** — sie ordnet nur die **Darstellung** neu (Herauslösen aus der Hauptansicht → Unterbereich, Liste-aller-Apps → Dropdown je App) und ergänzt das **Existenz-Gating** des „Passphrase anlegen"-Knopfs.

- **Betroffene UI:** `client/src/DeploymentsView.jsx` (heute zwei GPG-Sektionen als Listen aller Apps, ~Z.972–1168).
- **Backend:** unverändert bis auf die read-only Existenz-Abfrage aus [[per-app-gpg-passphrase-provisioning]] AC16, die dieser Unterbereich konsumiert.
- **Das `gpgBwItem`-Feld im „Neues Deployment"-Formular bleibt UNVERÄNDERT** ([[deploy-bitwarden-gpg-injection]] AC16) — es ist **nicht** Teil der herausgelösten GPG-Sektionen.

### Design-Vorgabe (nachgelagert, `designer`)
Das **linke-Untermenü-Pattern für Bereichs-Untermenüs** wird zusätzlich vom `designer` in `docs/design.md` als wiederverwendbare Design-Vorgabe verankert. Diese Design-Definition läuft als **separater Schritt nach dem requirement-Lauf** — hier nur als **Abhängigkeit/Verweis** vermerkt, **nicht** von dieser Spec/Story geschrieben. Die Umsetzung (S: Untermenü-Gerüst) folgt der dann vorliegenden Design-Vorgabe; bis dahin gilt das bestehende `docs/design.md`-Muster (Fokusringe, Text-Badges, Touch-Targets).

## Verhalten

1. **Untermenü mit zwei Einträgen.** Beim Öffnen des Deployments-Bereichs erscheint links ein Untermenü mit genau **zwei** Einträgen: **„Deployment"** (zeigt die bestehende Deployments-Ansicht) und **„GPG-Schlüssel"**. Beim Öffnen ist **„Deployment" die Standard-Auswahl** und aktiv. Umschalten zwischen den Einträgen wechselt den rechten Inhaltsbereich, ohne Voll-Reload; der aktive Eintrag ist als solcher erkennbar (`aria-current`).
2. **„Deployment"-Ansicht = bestehende Ansicht minus GPG-Sektionen.** Der Unterbereich „Deployment" rendert die heutige Deployments-Ansicht **unverändert**, jedoch **ohne** die beiden bisherigen GPG-Blöcke (siehe 3). Alle übrigen Sektionen (Modus-Umschalter, Bestand-Laden, „Neues Deployment"-Formular inkl. `gpgBwItem`-Feld, Stack-Deploy, Reconcile usw.) bleiben unverändert an ihrem Ort.
3. **GPG-Blöcke wandern aus der Hauptansicht.** Die zwei heutigen GPG-Sektionen der Deployment-Ansicht — Sektion „GPG-Passphrasen (Bitwarden)" (Provisionierungs-Liste aller Apps) **und** Sektion „GPG-Passphrasen-Rotation" (Rotations-Liste aller Apps) — **erscheinen nicht mehr** in der „Deployment"-Ansicht. Ihre Funktion lebt neu im Unterbereich „GPG-Schlüssel" (kompakt je gewählter App).
4. **„GPG-Schlüssel"-Ansicht.** Der Unterbereich „GPG-Schlüssel" zeigt:
   - eine **kurze Erklärung**, was man hier tun kann (Passphrase je App in Bitwarden anlegen; aktive Passphrase sicher rotieren);
   - ein **Dropdown zur App-Auswahl** (genau **eine** App gewählt statt Liste aller Apps);
   - daneben zwei Aktionen: **„Passphrase anlegen"** und **„Rotieren"** — jeweils bezogen auf die im Dropdown **gewählte** App.
5. **„Passphrase anlegen".** Der Knopf ruft für die gewählte App **denselben** Provisionierungs-Endpunkt (`POST /api/deployments/:app/gpg-provision`, [[per-app-gpg-passphrase-provisioning]] AC7) auf und quittiert das Ergebnis geheimnisfrei (`created` | `already-exists` | `access-not-ready` | `failed`, nie die Passphrase).
6. **Existenz-Gating des „Passphrase anlegen"-Knopfs.** Der Knopf ist **nur aktiv**, wenn für die gewählte App **noch KEINE** Passphrase in Bitwarden existiert (Item `env.gpg-passphrase-<app>`). Existiert sie bereits, ist der Knopf **deaktiviert** mit erkennbarem Hinweis („Passphrase existiert bereits"). Die Existenz wird über die read-only Existenz-Abfrage `GET /api/deployments/:app/gpg-exists` ([[per-app-gpg-passphrase-provisioning]] AC16) ermittelt — **bei jedem App-Wechsel neu**. Solange die Existenz noch nicht bekannt ist (Abfrage läuft), ist der Knopf im Lade-/Neutral-Zustand (deaktiviert oder Busy). Meldet die Abfrage `access-not-ready` (Existenz unbekannt), bleibt der Knopf **bedienbar** (der Provision-Aufruf meldet dann selbst `access-not-ready`) — konservativer Fallback, kein stiller falscher Deaktiviert-Zustand.
7. **„Rotieren".** Der Knopf klappt für die gewählte App die **bestehende zweistufige Rotation** auf: Stufe 1 „Kandidat + Beweis-Runde" (`POST .../gpg-rotate/start`), Stufe 2 „Umschalten" (`POST .../gpg-rotate/commit`) und der getrennte, explizit bestätigte Rollback-Anker-Aufräum-Knopf (`POST .../gpg-rotate/discard-previous`). **Logik, Sicherheitsmechanik, zweistufige Quittung, Bestätigungs-Gates und Endpunkte bleiben UNVERÄNDERT** ([[per-app-gpg-passphrase-rotation]] AC1–AC13) — nur die Darstellung ist kompakt je **gewählter** App statt als Liste aller Apps.
8. **Kein Secret in Sicht.** Weder Provisionierung noch Rotation noch die Existenz-Abfrage geben je einen Passphrasen-Wert an die UI; der Unterbereich führt **keine** neuen Secrets ein und zeigt nur geheimnisfreie Statusmeldungen.

## Acceptance-Kriterien
- **AC1** — Beim Öffnen des Deployments-Bereichs erscheint links ein Untermenü mit genau **zwei** Einträgen „Deployment" und „GPG-Schlüssel"; „Deployment" ist beim Öffnen die **Standard-Auswahl** und aktiv (rechts die bestehende Deployment-Ansicht). Beide Einträge sind per Maus **und** Tastatur aktivierbar; der aktive Eintrag ist per `aria-current` erkennbar; Umschalten wechselt den Inhalt ohne Voll-Reload. (Testbar: initial „Deployment" aktiv; Klick/Enter auf „GPG-Schlüssel" zeigt die GPG-Ansicht.)
- **AC2** — Die beiden bisherigen GPG-Sektionen der Deployment-Ansicht — „GPG-Passphrasen (Bitwarden)" (Provisionierungs-Liste) **und** „GPG-Passphrasen-Rotation" (Rotations-Liste) — erscheinen **nicht** mehr in der „Deployment"-Ansicht; alle übrigen Deployment-Sektionen bleiben unverändert; das `gpgBwItem`-Feld im „Neues Deployment"-Formular bleibt **unverändert** vorhanden. (Testbar: in der Deployment-Ansicht ist keine der beiden GPG-Sektions-Überschriften vorhanden; das `gpgBwItem`-Feld ist weiterhin vorhanden.)
- **AC3** — Die „GPG-Schlüssel"-Ansicht zeigt eine kurze Erklärung, ein **Dropdown zur App-Auswahl** (genau eine App wählbar) und daneben zwei Aktionen „Passphrase anlegen" und „Rotieren", jeweils auf die im Dropdown gewählte App bezogen. (Testbar: Ansicht enthält Erklärungstext, ein Select mit den Apps und die zwei benannten Aktionen.)
- **AC4** — „Passphrase anlegen" ruft für die **gewählte** App `POST /api/deployments/:app/gpg-provision` auf und quittiert das Ergebnis geheimnisfrei (`created` | `already-exists` | `access-not-ready` | `failed`), **nie** die Passphrase. (Testbar: Klick → Aufruf mit gewähltem App-Slug; UI-State enthält keinen Passphrasen-Wert.)
- **AC5** — „Passphrase anlegen" ist **nur aktiv**, wenn die Existenz-Abfrage `GET /api/deployments/:app/gpg-exists` für die gewählte App `exists:false` liefert; bei `exists:true` ist der Knopf **deaktiviert** mit Hinweis; bei App-Wechsel wird die Existenz **neu** ermittelt; meldet die Abfrage `access-not-ready`/Fehler (Existenz unbekannt), bleibt der Knopf **bedienbar** (konservativer Fallback). (Testbar: `exists:true` → Knopf disabled; `exists:false` → enabled; App-Wechsel triggert neue Abfrage; `access-not-ready` → nicht fälschlich disabled.)
- **AC6** — „Rotieren" klappt für die gewählte App die bestehende zweistufige Rotation auf (Stufe 1 `.../gpg-rotate/start`, Stufe 2 `.../gpg-rotate/commit`, getrennter Rollback-Anker-Aufräum-Knopf `.../gpg-rotate/discard-previous`) über die **unveränderten** Endpunkte; Logik/Sicherheitsmechanik/zweistufige Quittung/Bestätigungs-Gates entsprechen unverändert [[per-app-gpg-passphrase-rotation]] AC1–AC13; die Darstellung ist kompakt je gewählter App. (Testbar: Rotation wird für die im Dropdown gewählte App gerendert; die drei Rotations-Endpunkte werden unverändert genutzt.)
- **AC7** — Kein Passphrasen-Wert erscheint je in HTTP-Response, UI-State, Log oder WS-Frame; der Unterbereich führt **keine** neuen Secrets ein. (Testbar: kein Passphrasen-Wert in Response/State/Bundle.)
- **AC8** — A11y (WCAG 2.1 AA): Untermenü-Einträge, App-Dropdown und alle Knöpfe sind tastaturbedienbar mit sichtbarem Fokus; aktiver Untermenü-Eintrag per `aria-current`; Touch-Targets ≥ 44 px; Status/Fehler programmatisch zugeordnet (`role="alert"`/`aria-live`); Bedeutung nicht allein über Farbe. (Testbar: Tab/Enter erreicht/aktiviert Untermenü + Aktionen; aktiver Eintrag hat `aria-current`.)

## Verträge
- **Untermenü (Frontend-only):** ein linkes Untermenü **innerhalb** der Deployments-Ansicht mit zwei Zuständen (`deployment` = Standard, `gpg`); reiner Client-State (kein neuer Backend-Endpunkt, keine neue Route zwingend). Deep-Link/Route optional — nicht gefordert.
- **Konsumierte Endpunkte (unverändert):**
  - `POST /api/deployments/:app/gpg-provision` → `{ result, reason? }` ([[per-app-gpg-passphrase-provisioning]]).
  - `GET /api/deployments/:app/gpg-exists` → `{ exists: boolean, reason? }` ([[per-app-gpg-passphrase-provisioning]] AC16) — read-only, nie ein Passphrasen-Wert.
  - `POST /api/deployments/:app/gpg-rotate/start` | `.../commit` | `.../discard-previous` → `{ ok, phase?, errorClass?, reason? }` ([[per-app-gpg-passphrase-rotation]]).
- **App-Liste:** die im Dropdown wählbaren Apps stammen aus derselben Quelle wie heute die GPG-Listen (`packages` in `DeploymentsView`).

## Edge-Cases & Fehlerverhalten
- **Keine App vorhanden** (leere `packages`-Liste) → die „GPG-Schlüssel"-Ansicht zeigt einen neutralen Hinweis („keine App gefunden"); Dropdown/Aktionen deaktiviert, kein Crash.
- **Existenz-Abfrage schlägt fehl / `access-not-ready`** → „Passphrase anlegen" bleibt bedienbar (konservativ); der Provision-Aufruf meldet dann das echte Ergebnis (`access-not-ready`/`failed`).
- **App-Wechsel während laufender Abfrage/Aktion** → Ergebnis der alten App darf nicht der neuen App zugeordnet werden (State je App bzw. Verwerfen veralteter Antworten).
- **Unberechtigt (nicht in `CRED_ADMIN_EMAILS`)** → mutierende Aktionen liefern `403` (geerbt); die UI quittiert geheimnisfrei.

## NFRs
- **Sicherheit (Floor, hart, geerbt):** keine Passphrase in Response/UI-State/Log/WS/Bundle; keine neuen Secrets; alle mutierenden Endpunkte weiterhin hinter `AccessGuard` + `CRED_ADMIN_EMAILS`.
- **Robustheit:** reines Um-Arrangieren bestehender Aufrufe; keine Änderung an Provisionierungs-/Rotations-Logik oder deren Endpunkten.
- **A11y:** WCAG 2.1 AA (Untermenü, Dropdown, Knöpfe, Statusmeldungen) — siehe AC8.

## Nicht-Ziele
- Änderung der Provisionierungs- oder Rotations-**Logik**/-Sicherheitsmechanik/-Endpunkte → [[per-app-gpg-passphrase-provisioning]] / [[per-app-gpg-passphrase-rotation]] (unverändert).
- Änderung des `gpgBwItem`-Felds im „Neues Deployment"-Formular → [[deploy-bitwarden-gpg-injection]] AC16 (bleibt unverändert).
- Das Verankern des Untermenü-Patterns in `docs/design.md` (eigener, nachgelagerter `designer`-Schritt — hier nur Verweis).
- Deep-Link/Route je Unterbereich (nicht gefordert; optional).

## Abhängigkeiten
- [[per-app-gpg-passphrase-provisioning]] (Provisionierung `POST .../gpg-provision`; **neue** read-only Existenz-Abfrage AC16 — Voraussetzung für das Gating AC5).
- [[per-app-gpg-passphrase-rotation]] (Zwei-Phasen-Rotation, unveränderte Endpunkte; kompakte Darstellung AC14).
- [[deploy-bitwarden-gpg-injection]] (`gpgBwItem`-Feld bleibt unverändert; Item-Namens-Konvention).
- [[access-and-guardrails]] (AccessGuard, `CRED_ADMIN_EMAILS`, Floor).
- **Design (nachgelagert, kein Code-depends):** `docs/design.md` — Bereichs-Untermenü-Pattern (`designer`, separater Schritt nach requirement).
