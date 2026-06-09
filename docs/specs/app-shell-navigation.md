---
id: app-shell-navigation
title: App-Shell — Einstiegs-Panel & Navigation
status: draft
version: 1
---

# Spec: App-Shell — Einstiegs-Panel & Navigation (`app-shell-navigation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`.

## Zweck
Aus der heute einzelnen Terminal/Fabrik-Oberfläche wird eine Multi-View-Konsole: Ein **Einstiegs-Panel** mit fünf Kacheln (Startseite) plus eine **Navigation**, die zwischen den Ansichten umschaltet — *GitHub*, *VPS*, *Cloudflare*, der bestehenden *Fabrik*-Ansicht (Terminal + Dashboard + Trigger) und *Deployments* (Capability B, ADR-012). Dieses Paket liefert **nur das Grundgerüst**: Panel, Navigation und die Einbindung der bestehenden Fabrik-Ansicht; die Detail-Funktionen der neuen Ansichten folgen als eigene Anforderungen (siehe [[view-github]], [[view-vps]], [[view-cloudflare]], [[deploy-lifecycle]]).

## Verhalten
1. Beim Laden der App ohne spezifische Ziel-Ansicht erscheint das **Einstiegs-Panel** mit genau **fünf Kacheln**: *GitHub*, *VPS*, *Cloudflare*, *Fabrik (dev-gui)*, *Deployments*.
2. Jede Kachel trägt ein erkennbares Label und eine kurze Beschreibung dessen, was die Ansicht (künftig) leistet; eine Kachel ist als Ganzes aktivierbar (Klick **und** Tastatur).
3. Aktiviert der Nutzer eine Kachel, wechselt die App in die zugehörige **Ansicht** und das Einstiegs-Panel weicht der Ansicht.
4. Aus jeder Ansicht führt ein eindeutiges Bedienelement (**Home / Zurück zum Panel**) wieder auf das Einstiegs-Panel; Navigation ist von jeder Ansicht aus zu jeder anderen Ansicht und zurück zum Panel möglich (persistente Navigationsleiste **oder** Home-Element — Detail beim `designer`).
5. Die aktive Ansicht ist **deep-linkbar**: ein direkter Aufruf der App mit Ansichts-Kennung (URL-Pfad oder Hash-Route, z.B. `#/github`) öffnet diese Ansicht direkt; das Einstiegs-Panel hat die kanonische Wurzel-Route (`#/` bzw. `/`).
6. Browser-Vor/Zurück navigiert zwischen besuchten Ansichten/Panel (Verlauf entspricht der Route).
7. Die **Fabrik-Ansicht** rendert unverändert die bestehende Komposition aus Terminal-Pane, Flow-Trigger-Panel und Status-Dashboard ([[terminal-frontend]], [[flow-trigger]], [[factory-status]]) — kein Funktionsverlust gegenüber dem heutigen Verhalten.
8. Die drei neuen Ansichten (*GitHub*, *VPS*, *Cloudflare*) rendern in diesem Paket je einen **Platzhalter** (Titel + Hinweis „in Arbeit / folgt"), ohne Backend-Aufrufe — das eigentliche Verhalten kommt aus den jeweiligen View-Specs.
9. Eine unbekannte Route fällt auf das Einstiegs-Panel zurück (kein toter Bildschirm).

## Acceptance-Kriterien
- **AC1** — Auf der Wurzel-Route zeigt die App ein Einstiegs-Panel mit **genau fünf** Kacheln, beschriftet *GitHub*, *VPS*, *Cloudflare*, *Fabrik (dev-gui)*, *Deployments*; jede Kachel ist per Maus **und** per Tastatur (Tab + Enter/Space) aktivierbar.
- **AC2** — Aktivieren der Kachel *Fabrik (dev-gui)* öffnet die Fabrik-Ansicht, die Terminal-Pane, Flow-Trigger-Panel und Status-Dashboard so wie heute zeigt (kein Funktionsverlust).
- **AC3** — Aktivieren einer der Kacheln *GitHub*, *VPS* oder *Cloudflare* öffnet die jeweilige Ansicht mit einem klar gekennzeichneten Platzhalter (Titel + „folgt"-Hinweis), **ohne** dass ein Backend-Endpunkt für diese Ansicht aufgerufen wird.
- **AC4** — Aus jeder Ansicht führt ein erreichbares Bedienelement zurück zum Einstiegs-Panel; von jeder Ansicht ist jede andere Ansicht erreichbar.
- **AC5** — Jede der fünf Ansichten ist deep-linkbar: ein direkter Aufruf mit der Ansichts-Route öffnet genau diese Ansicht; die Wurzel-Route zeigt das Einstiegs-Panel.
- **AC6** — Browser-Zurück/Vor navigiert entlang des besuchten Verlaufs (Panel ⇄ Ansichten); eine unbekannte Route zeigt das Einstiegs-Panel statt eines leeren/fehlerhaften Bildschirms.
- **AC7** — Die gesamte Shell (Panel-Kacheln + Navigation) ist hinter der bestehenden Cloudflare-Access-Mauer erreichbar; das Grundgerüst führt **keine** view-spezifische Autorisierung und **keine** neuen Secrets ein. (Mutierende Detail-Funktionen je Ansicht werden gesondert rollen-/identitätsgeschützt — siehe jeweilige View-Spec.)

## Verträge
- **Routing (client-seitig):** kanonische Routen — Wurzel = Einstiegs-Panel; je Ansicht eine stabile Kennung (`github`, `vps`, `cloudflare`, `factory`, `deployments`). Mechanismus (History-Pfad oder Hash) ist Implementierungsdetail, muss aber Deep-Link + Browser-Verlauf erfüllen.
- **Keine neuen Backend-Endpunkte** in diesem Paket. Die Fabrik-Ansicht konsumiert weiterhin `/ws/terminal`, `/api/status`, `/api/command*`, `/api/audit` (unverändert).
- **Keine neue Abhängigkeit erzwungen:** Routing soll mit minimalem Footprint umgesetzt werden (leichtgewichtiger Router/Hash-Routing bevorzugt; schwere Router-Bibliothek nur mit Begründung).

## Edge-Cases & Fehlerverhalten
- Unbekannte/abgelaufene Route → Fallback auf Einstiegs-Panel.
- Direkter Deep-Link auf eine neue Ansicht ohne Access-Cookie → die bestehende Access-Mauer greift (403/Redirect) **vor** dem Frontend; die Shell selbst trifft keine Auth-Entscheidung.
- Schmale Viewports (< 768 px): Kacheln stapeln; Navigation bleibt bedienbar (konsistent mit `docs/design.md`).

## NFRs
- **A11y (WCAG 2.1 AA):** Kacheln und Navigationselemente per Tastatur erreichbar, sichtbarer Fokus, Touch-Targets ≥ 44 px, Bedeutung nicht allein über Farbe; aktive Ansicht für Screenreader erkennbar (z.B. `aria-current`).
- **Sicherheit (Floor):** kein neues Secret im Frontend-Bundle; keine Umgehung der Access-Mauer.
- **Performance:** Navigation/Panel ohne Voll-Reload (Client-seitiger View-Wechsel).

## Nicht-Ziele
- Detail-Funktionen der GitHub-/VPS-/Cloudflare-Ansicht (eigene Anforderungen).
- View-spezifische Rollen/Autorisierung (kommt mit den mutierenden Detail-Funktionen).
- Neue externe Integrationen (Hetzner-API, Cloudflare-API) oder neue Backend-Endpunkte.

## Abhängigkeiten
- [[terminal-frontend]], [[flow-trigger]], [[factory-status]] (bestehende Fabrik-Ansicht, eingebettet).
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
- Liefert das Container-Gerüst für [[view-github]], [[view-vps]], [[view-cloudflare]].
