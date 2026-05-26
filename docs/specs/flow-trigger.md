---
id: flow-trigger
title: Flow-Trigger (Slash-Befehl in die Session injizieren)
status: draft
version: 1
---

# Spec: Flow-Trigger (`flow-trigger`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Fabrik-Flows auf Knopfdruck: ein GUI-Trigger injiziert einen **erlaubten** Slash-Befehl in die interaktive Session; der Lauf erscheint live im Terminal. Mit Concurrency-Schutz und Kill-Switch.

## Verhalten
1. `POST /api/command {command}` injiziert den Befehl in die Session (schreibt `command\n` in den PTY) und markiert den Command als `running`.
2. Es gibt eine **Allowlist** erlaubter Befehls-Präfixe (`/flow`, `/adopt`, `/preview`, `/requirement`, `/train`, …). Nicht-gelistete Befehle werden abgewiesen.
3. **Concurrency-Lock = 1:** ist bereits ein Command `running` (Session `busy`), wird ein weiterer Trigger abgelehnt.
4. **Kill-Switch:** `POST /api/command/cancel` sendet einen Interrupt (Ctrl-C) an die Session und gibt den Lock frei.
5. Frontend-Panels (Projekt/Item wählen → Aktions-Button) rufen diese Endpunkte; der Verlauf erscheint im Terminal-Pane aus [[terminal-frontend]].

## Acceptance-Kriterien
- **AC1** — `POST /api/command {command}` mit erlaubtem Befehl schreibt `command\n` in den PTY und antwortet `202 {commandId, status:"running"}`; der Output erscheint im `/ws/terminal`-Stream.
- **AC2** — Befehle werden gegen eine **Allowlist** geprüft; ein nicht-gelisteter oder leerer Befehl → `400` und **nichts** wird in den PTY geschrieben.
- **AC3** — Ist bereits ein Command `running`, liefert `POST /api/command` `409` (kein zweiter paralleler Job) — der Lock gilt **global**, nicht pro Client.
- **AC4** — Das Frontend zeigt Trigger-Panels (Projekt/Item → Button); bei aktivem Job sind Trigger deaktiviert und der Kill-Button aktiv. Ein Klick löst den passenden `/api/command` aus.
- **AC5** — `POST /api/command/cancel` sendet Interrupt an die Session, setzt den laufenden Command auf `cancelled` und gibt den Lock frei (`/api/session` wird wieder `ready`).

## Verträge
- `POST /api/command` `{command:string}` → `202 {commandId, status}` | `400` (Allowlist) | `409` (Lock).
- `POST /api/command/cancel` → `200 {cancelled:bool}`.
- Allowlist als Konfiguration (Liste erlaubter Präfixe), nicht hartkodiert verstreut.

## Edge-Cases & Fehlerverhalten
- Session nicht `ready` (z.B. `starting`/`failed`) → `409`/`503`, kein Schreiben in den PTY.
- Befehl mit Steuerzeichen/Newline-Injection → wird sanitisiert/abgewiesen (kein Mehrfach-Befehl schmuggeln).

## NFRs
- **Sicherheit (Floor):** Allowlist + Sanitisierung verhindern beliebige Befehls-Injektion; jeder akzeptierte Command wird auditiert (siehe [[access-and-guardrails]] AC3). Befehls-String wird nie unsanitisiert in eine Shell, nur in den PTY der Session geschrieben.

## Nicht-Ziele
- Freitext-Befehle außerhalb der Allowlist (bewusst eng).

## Abhängigkeiten
- [[terminal-bridge]] (PTY/Session) · [[access-and-guardrails]] (Gate, Lock, Audit) · [[terminal-frontend]] (Live-Ausgabe).
