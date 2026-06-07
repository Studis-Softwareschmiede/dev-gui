---
id: view-cloudflare
title: Cloudflare-Ansicht (Grundgerüst)
status: draft
version: 1
---

# Spec: Cloudflare-Ansicht (`view-cloudflare`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Eine eigenständige Ansicht zum **Verwalten von Domäne und Tunneln** bei Cloudflare. **Dieses Paket liefert nur das Gerüst**: die über das Einstiegs-Panel erreichbare, deep-linkbare Platzhalter-Ansicht. Die eigentlichen Verwaltungs-Funktionen (DNS/Domäne, Tunnel-Routen) folgen als eigene Anforderungen und führen einen **neuen Cloudflare-API-Boundary** ein — die Architektur-Erweiterung wird hier bewusst noch nicht entschieden (Detail an `architekt`).

## Verhalten
1. Die Cloudflare-Ansicht ist über die Kachel *Cloudflare* und über die Route `cloudflare` erreichbar (siehe [[app-shell-navigation]]).
2. Im Grundgerüst zeigt die Ansicht einen klaren Titel („Cloudflare") und einen Platzhalter-Hinweis, dass die Verwaltung folgt — **ohne** Backend-Aufruf und **ohne** Cloudflare-API-Zugriff.
3. Navigation/Home-Rückkehr funktioniert aus dieser Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Die Cloudflare-Ansicht ist über die *Cloudflare*-Kachel und per Deep-Link (Route `cloudflare`) erreichbar und zeigt einen erkennbaren Titel „Cloudflare".
- **AC2** — Das Grundgerüst rendert einen Platzhalter (Hinweis „folgt / in Arbeit") und löst **keinen** Backend-Aufruf und **keine** externe Cloudflare-API-Anfrage aus.
- **AC3** — Aus der Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich.

## Verträge
- Konsumiert das Container-Gerüst aus [[app-shell-navigation]] (Route `cloudflare`, Navigation, Home).
- Keine neuen Backend-Endpunkte in diesem Paket. **Offen / Folge-Anforderung:** Domänen-/Tunnel-Verwaltung erfordert einen neuen Cloudflare-API-Boundary + Secret-Handling (API-Token) — Architektur-Entscheidung ausstehend (`architekt`). Achtung Selbstbezug: die App läuft selbst hinter einem Cloudflare-Tunnel/Access — Änderungen an Tunnel/Domäne können die eigene Erreichbarkeit betreffen.

## Edge-Cases & Fehlerverhalten
- Aufruf ohne Access-Cookie → die bestehende Access-Mauer greift davor.

## NFRs
- **A11y:** Titel als Überschrift; Ansicht per Tastatur erreichbar.
- **Sicherheit (Floor, für Folge-Items vorgemerkt):** DNS-/Tunnel-mutierende Aktionen sind hoch-privilegiert (können die eigene Erreichbarkeit + Zugangsmauer betreffen) — sie MÜSSEN auditiert, identitäts-/rollengeschützt und mit Bestätigung versehen werden; Cloudflare-API-Token NIE im Frontend-Bundle/Log/WS-Stream.

## Nicht-Ziele
- Tatsächliche Domänen-/Tunnel-Verwaltung (Folge-Anforderung).
- Festlegung des Cloudflare-API-Zugangs oder des Secret-Speichers (Architektur-Entscheidung, ausstehend).

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing).
- [[access-and-guardrails]] (Access-Mauer; künftiger Audit-/Lock-Pfad für Schreibaktionen).
