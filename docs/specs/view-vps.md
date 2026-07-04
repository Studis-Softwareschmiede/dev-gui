---
id: view-vps
title: VPS-Ansicht — Maschinen-Übersicht + Lifecycle-UI (Multi-Provider)
status: draft
area: vps
version: 2
---

# Spec: VPS-Ansicht (`view-vps`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate).
> **v2:** erweitert das in v1 gelieferte Platzhalter-Gerüst (AC1–AC3, Board #42 Done) um die **Maschinen-Übersicht** und die **Lifecycle-UI** (Create / Start / Stop) über die neue Multi-Provider-Boundary ([[vps-provider-boundary]]). Die Provider-/Setup-/Key-Logik liegt im Backend (eigene Specs); diese Spec definiert die **Ansicht**.

## Zweck
Eine eigenständige Ansicht zum **Verwalten von VPS-Servern über mehrere Provider** (Hetzner, IONOS, Hostinger): laufende Maschinen im Überblick, neue Server provisionieren (Create-from-scratch mit Default-Setup) sowie Server starten/stoppen. Die Ansicht konsumiert ausschließlich provider-agnostische Read-Models + Capability-Flags ([[vps-provider-boundary]]) und kennt keinen Provider-Code.

## Verhalten

### Gerüst (bestehend, v1)
1. Die VPS-Ansicht ist über die Kachel *VPS* und über die Route `vps` erreichbar ([[app-shell-navigation]]) und trägt den Titel „VPS".
2. Navigation/Home-Rückkehr funktioniert aus dieser Ansicht.

### Maschinen-Übersicht (v2)
3. Die Ansicht zeigt eine **Übersicht der laufenden/vorhandenen Maschinen** über **alle konfigurierten Provider** (`GET /api/vps/machines`): je Maschine mindestens Provider, Name, Status, IPv4 (falls bekannt).
4. Provider, für die **kein API-Token** hinterlegt ist, werden als „nicht konfiguriert" kenntlich gemacht mit Verweis auf die Settings-Sektion ([[settings-credentials]]); für sie wird **kein** Provider-Aufruf erwartet.
5. Liefert ein einzelner Provider beim Auflisten einen Fehler, zeigt die Ansicht die übrigen Maschinen weiterhin und markiert den fehlerhaften Provider als gestört (degradiert, kein leerer Voll-Fehler).

### Lifecycle-Aktionen (v2)
6. Pro Maschine bietet die Ansicht **Start** und **Stop** an; eine Aktion, die der Provider laut Capability-Flags nicht unterstützt, wird **deaktiviert/als nicht unterstützt** dargestellt (nicht angeboten oder klar disabled), statt einen Fehler zu provozieren.
7. Die Ansicht bietet **Server neu provisionieren (Create-from-scratch)**: ein Formular wählt Provider, Name, Region/Location, Servertyp/Plan und (Default) Ubuntu 26.04 LTS; es ordnet pro User-Rolle (`root`, `alex`) ein SSH-Key-Label zu ([[vps-ssh-key-assignment]]) und löst beim Absenden das Default-Setup ([[vps-cloud-init-setup]]) aus.
8. Create ist **gesperrt**, solange für `root` oder `alex` kein gesetzter Public-Key zuordenbar ist (Hinweis auf [[settings-ssh-keys]]).
9. Nach einer mutierenden Aktion aktualisiert die Ansicht die Übersicht (Re-Fetch); ein Fehler wird klar gemeldet, ohne Geheimnisse zu zeigen.

## Acceptance-Kriterien

### Gerüst (bestehend — unverändert gültig)
- **AC1** — Die VPS-Ansicht ist über die *VPS*-Kachel und per Deep-Link (Route `vps`) erreichbar und zeigt einen erkennbaren Titel „VPS".
- **AC2** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.

### Maschinen-Übersicht (v2)
- **AC3** — Die Ansicht ruft `GET /api/vps/machines` ab und listet die zurückgegebenen Maschinen mit Provider, Name, Status und (falls vorhanden) IPv4; bei leerer Liste erscheint ein klarer Leer-Zustand.
- **AC4** — Provider ohne hinterlegten Token werden als „nicht konfiguriert" angezeigt (mit Verweis auf die Settings/Credentials-Sektion); für sie löst die Ansicht keinen Lifecycle-Aufruf aus.
- **AC5** — Meldet `GET /api/vps/machines` einen `providerErrors`-Eintrag, zeigt die Ansicht die übrigen Maschinen weiter und kennzeichnet den gestörten Provider (degradiert), statt die ganze Übersicht auf Fehler zu setzen.

### Lifecycle-UI (v2)
- **AC6** — Pro Maschine sind **Start**/**Stop** auslösbar; sie rufen `POST /api/vps/machines/{provider}/{serverId}/start|stop` und spiegeln das Ergebnis (Erfolg/„nicht unterstützt"/Fehler) im UI; eine laut Capability-Flag nicht unterstützte Aktion ist disabled/als unsupported markiert (kein erzwungener Fehleraufruf).
- **AC7** — Das **Create-Formular** erfasst Provider, Name, Region, Servertyp und Image (Default Ubuntu 26.04 LTS) sowie je Rolle (`root`, `alex`) ein SSH-Key-Label ([[vps-ssh-key-assignment]]) und löst `POST /api/vps/machines/{provider}` aus; nach Erfolg erscheint die neue Maschine in der Übersicht.
- **AC8** — Create ist **gesperrt**, solange für `root` oder `alex` kein gesetzter Public-Key zuordenbar ist; die UI nennt den Grund und verweist auf [[settings-ssh-keys]].
- **AC9** — Mutierende Aktionen zeigen Lade-/Erfolg-/Fehlerzustände; **kein** Provider-Token oder Geheimnis erscheint im Frontend (nur Status/Meldungen aus den Backend-Antworten).

### Sicherheit / A11y
- **AC10** — Die Ansicht ist hinter der Access-Mauer; sie führt **keine** Provider-Tokens oder Geheimnisse mit (alle Secrets bleiben im Backend/`CredentialStore`). Mutierende Aktionen sind serverseitig zusätzlich identitäts-/rollengeschützt ([[vps-provider-boundary]] AC9) — die UI behandelt 403 als klare „keine Berechtigung"-Meldung.

## Verträge
- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `vps`, Navigation, Home).
- Backend-Endpunkte (definiert in [[vps-provider-boundary]]): `GET /api/vps/providers`, `GET /api/vps/machines`, `POST /api/vps/machines/{provider}`, `POST /api/vps/machines/{provider}/{serverId}/start|stop`.
- SSH-Key-Label-Auswahl liest `GET /api/settings/ssh-keys` (nur Labels mit gesetztem Public-Key); siehe [[vps-ssh-key-assignment]].
- Keine eigenen Backend-Endpunkte in dieser Spec — die UI verdrahtet die Boundary-Endpunkte.

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor.
- Kein Provider konfiguriert → Übersicht zeigt einen Onboarding-Hinweis (Token in Settings hinterlegen), keine Fehlerflut.
- Provider unterstützt eine Aktion nicht → disabled/„nicht unterstützt", kein Fehleraufruf (AC6).
- Create-Fehler (z.B. ungültige Region/Servertyp) → Formular zeigt die Backend-Fehlermeldung, kein Server angelegt.
- 403 bei mutierender Aktion (fehlende Rolle) → klare Meldung, kein UI-Crash.

## NFRs
- **A11y (WCAG 2.1 AA):** Titel als Überschrift; Tabellen/Listen mit Header; Aktions-Buttons beschriftet, Status für Screenreader erkennbar; Formularfelder beschriftet, Fehler programmatisch zugeordnet; sichtbarer Fokus.
- **Sicherheit (Floor):** Server-mutierende Aktionen sind hoch-privilegiert (Kosten + Verfügbarkeit) — serverseitig auditiert, identitäts-/rollengeschützt; Provider-Token **nie** im Frontend-Bundle/Log/WS-Stream (durchgesetzt im Backend, [[vps-provider-boundary]]).

## Nicht-Ziele
- **Rebuild** (destruktives Neu-Aufsetzen) und **Backup/Snapshot** → vertagt, [[vps-rebuild-backup]] (Platzhalter).
- Provider-Billing/Kosten, DNS-, Volume- oder Netzwerk-Verwaltung.
- Provider-spezifische Spezial-UI — die Ansicht bleibt provider-agnostisch (Capability-Flags steuern, was angeboten wird).

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[vps-provider-boundary]] (Read-Models, Lifecycle-Endpunkte, Capability-Flags).
- [[vps-ssh-key-assignment]] (root/alex-Key-Zuordnung im Create-Formular).
- [[vps-cloud-init-setup]] (Default-Setup, das Create auslöst).
- [[settings-credentials]] (Provider-Token-Konfiguration; Verweis bei nicht konfiguriertem Provider).
- [[settings-ssh-keys]] (Public-Key-Quelle).
- [[access-and-guardrails]] (Access-Mauer; Audit-/Identitätsschutz für Schreibaktionen).
