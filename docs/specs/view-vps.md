---
id: view-vps
title: VPS-Ansicht (Grundgerüst)
status: draft
version: 1
---

# Spec: VPS-Ansicht (`view-vps`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Eine eigenständige Ansicht zum **Verwalten von VPS-Servern** (z.B. bei Hetzner): anlegen, herunterfahren, erneuern. **Dieses Paket liefert nur das Gerüst**: die über das Einstiegs-Panel erreichbare, deep-linkbare Platzhalter-Ansicht. Die eigentlichen Server-Aktionen folgen als eigene Anforderungen; sie führen einen **neuen externen Provider** (Hetzner-API o.ä.) und damit eine Architektur-Erweiterung ein, die hier bewusst noch nicht entschieden wird (Detail an `architekt`).

## Verhalten
1. Die VPS-Ansicht ist über die Kachel *VPS* und über die Route `vps` erreichbar (siehe [[app-shell-navigation]]).
2. Im Grundgerüst zeigt die Ansicht einen klaren Titel („VPS") und einen Platzhalter-Hinweis, dass die Server-Verwaltung folgt — **ohne** Backend-Aufruf und **ohne** Provider-Zugriff.
3. Navigation/Home-Rückkehr funktioniert aus dieser Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Die VPS-Ansicht ist über die *VPS*-Kachel und per Deep-Link (Route `vps`) erreichbar und zeigt einen erkennbaren Titel „VPS".
- **AC2** — Das Grundgerüst rendert einen Platzhalter (Hinweis „folgt / in Arbeit") und löst **keinen** Backend-Aufruf und **keine** externe Provider-API-Anfrage aus.
- **AC3** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.

## Verträge
- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `vps`, Navigation, Home).
- Keine neuen Backend-Endpunkte in diesem Paket. **Offen / Folge-Anforderung:** Server-Aktionen (anlegen/herunterfahren/erneuern) erfordern einen neuen externen Provider-Boundary + Secret-Handling (Provider-Token) — Architektur-Entscheidung und Datenmodell sind noch zu treffen (`architekt` / ggf. `dba`).

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor.

## NFRs
- **A11y:** Titel als Überschrift; Ansicht per Tastatur erreichbar.
- **Sicherheit (Floor, für Folge-Items vorgemerkt):** Server-mutierende Aktionen sind hoch-privilegiert (Kosten + Verfügbarkeit) — sie MÜSSEN auditiert, identitäts-/rollengeschützt und gegen versehentliche Zerstörung abgesichert werden (Bestätigung); Provider-Token NIE im Frontend-Bundle/Log/WS-Stream.

## Nicht-Ziele
- Tatsächliches Anlegen/Herunterfahren/Erneuern von Servern (Folge-Anforderung).
- Festlegung des Providers/SDK oder des Secret-Speichers (Architektur-Entscheidung, ausstehend).

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[access-and-guardrails]] (Access-Mauer; künftiger Audit-/Lock-Pfad für Schreibaktionen).
