---
id: terminal-frontend
title: Terminal-Frontend (xterm.js Live-Pane)
status: draft
area: fabrik-arbeiten
version: 1
---

# Spec: Terminal-Frontend (`terminal-frontend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.

## Zweck
Eine xterm.js-Konsole im React-Frontend, verbunden mit `/ws/terminal`, die den Live-Verlauf der Session zeigt und Tastatureingaben durchreicht — der Mensch sieht jeden Flow-Lauf in Echtzeit.

## Verhalten
1. Das Frontend verbindet sich beim Laden mit `/ws/terminal` und rendert eingehenden Output in einer xterm.js-Instanz (ANSI-Farben korrekt).
2. Tastatureingaben im Terminal-Pane gehen als Input an die Session (read-write).
3. Bricht die WS-Verbindung ab, verbindet das Frontend automatisch neu und zeigt den Verbindungs-Status (verbunden / getrennt / verbinde …).

## Acceptance-Kriterien
- **AC1** — Eine xterm.js-Konsole ist sichtbar und zeigt den von `/ws/terminal` gestreamten Output live; ANSI-Farben/Steuersequenzen werden korrekt dargestellt.
- **AC2** — Tippt der Nutzer im Terminal, erscheint die Eingabe in der Session (Input wird über WS gesendet) — das Terminal ist read-write.
- **AC3** — Wird die WS-Verbindung getrennt, zeigt die UI einen Verbindungs-Status und versucht automatisch einen Reconnect; nach Wiederverbindung läuft der Output weiter.

## Verträge
- Konsumiert `WS /ws/terminal` aus [[terminal-bridge]] (Nachrichtenformat dort).

## Edge-Cases & Fehlerverhalten
- Server nicht erreichbar → Status „getrennt", periodischer Reconnect-Versuch, keine UI-Blockade.
- Sehr große Ausgaben → Scrollback begrenzt (kein unbegrenztes Wachstum).

## NFRs
- A11y: Terminal fokussierbar/per Tastatur verlassbar (keine Fokus-Falle); Verbindungs-Status nicht nur per Farbe (Label/Icon).

## Nicht-Ziele
- Mehrere Terminal-Tabs/Sessions.

## Abhängigkeiten
- [[terminal-bridge]] (Backend-WS).
