---
id: dashboard-deployment-tile
title: Deployment als gleichwertige Einstiegs-Kachel (statt Extra-Nav-Link)
status: draft
version: 1
---

# Spec: Deployment als gleichwertige Einstiegs-Kachel (`dashboard-deployment-tile`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Auf dem Einstiegs-Panel (`EntryPanel` in `client/src/AppShell.jsx`) wird *Deployments* heute als separater Extra-Nav-**Textlink** unter dem Kachel-Raster geführt (`EXTRA_NAV`), während alle anderen Ansichten als gleichwertige **Kacheln** im Raster erscheinen. Das wirkt optisch uneinheitlich. Diese Anforderung integriert *Deployments* als **ganz normale, visuell und verhaltensgleiche Kachel** in das bestehende Kachel-Raster und **entfernt** den separaten Extra-Nav-Link unten — das Panel-Layout wird dadurch harmonisch und einheitlich.

## Verhalten
1. Das Einstiegs-Panel zeigt *Deployments* als **Kachel** im selben Kachel-Raster (`tileGrid`) wie die übrigen Kacheln (*GitHub*, *VPS*, *Cloudflare*, *Fabrik (dev-gui)*, *Team*). Die Deployments-Kachel ist von Aufbau, Styling und Bedienverhalten **identisch** zu den anderen Kacheln (gleiche `Tile`-Komponente: Label + Beschreibung, `styles.tile`, `role="listitem"`, Touch-Target ≥ 44 px, Klick **und** Tastatur Tab + Enter/Space).
2. Die Deployments-Kachel wird über denselben Mechanismus wie die übrigen Kacheln aus der zentralen Kachel-Definition (`TILES`) gerendert — kein separater Render-Pfad, keine Sonderbehandlung im Markup.
3. Der bisherige **Extra-Nav-Bereich** unter dem Kachel-Raster (`extraNavRow` / `EXTRA_NAV`-Textlink für *Deployments* im `EntryPanel`) **entfällt** vollständig; unter dem Kachel-Raster steht für *Deployments* kein separater Textlink mehr.
4. Das Aktivieren der Deployments-Kachel öffnet weiterhin die bestehende Deployments-Ansicht (`DeploymentsView`, Route `#/deployments`) — **kein Funktionsverlust** gegenüber dem heutigen Link.
5. Die Reihenfolge der Kacheln ist: *GitHub*, *VPS*, *Cloudflare*, *Fabrik (dev-gui)*, *Team*, *Deployments* — *Deployments* wird als **letzte** Kachel angehängt (entspricht ihrer heutigen Position „unten") (Default D1).
6. Die persistente Navigationsleiste (`NavBar`) führt *Deployments* weiterhin als Nav-Link auf (geerbt aus [[app-shell-navigation]]); funktional ändert sich für die NavBar nichts (siehe Edge-Case zur `EXTRA_NAV`-Ableitung).
7. Alle übrigen Shell-Eigenschaften (Routing, Deep-Link `#/deployments`, Browser-Back/Forward, Settings-Zahnrad, Fallback unbekannter Routen auf das Panel) bleiben **unverändert** ([[app-shell-navigation]], [[settings-shell]]).

## Acceptance-Kriterien
- **AC1** — Das Einstiegs-Panel rendert *Deployments* als Kachel im Kachel-Raster (`tileGrid`), erzeugt durch dieselbe Kachel-Komponente und denselben `TILES`-Render-Pfad wie die übrigen Kacheln; die Kachel trägt Label „Deployments" und eine kurze Beschreibung und ist per Maus **und** per Tastatur (Tab + Enter/Space) aktivierbar.
- **AC2** — Unter dem Kachel-Raster gibt es **keinen** separaten *Deployments*-Extra-Nav-Textlink mehr; der Extra-Nav-Bereich (`extraNavRow`) entfällt im `EntryPanel`, sofern dort keine anderen Extra-Nav-Einträge verbleiben. Testbar: im gerenderten Panel existiert genau **ein** für den Nutzer aktivierbares „Deployments"-Bedienelement, und dieses ist eine Kachel (Tile-Button im `tileGrid`), kein Textlink im Extra-Nav-Bereich.
- **AC3** — Das Aktivieren der Deployments-Kachel (Klick **oder** Enter/Space) navigiert auf die Route `deployments` und rendert die bestehende `DeploymentsView` — kein Funktionsverlust gegenüber dem bisherigen Link.
- **AC4** — Das Panel zeigt nach der Änderung **genau sechs** Kacheln in der Reihenfolge *GitHub*, *VPS*, *Cloudflare*, *Fabrik (dev-gui)*, *Team*, *Deployments*; die Deployments-Kachel ist die letzte.
- **AC5** — Die Deployments-Kachel ist visuell und semantisch **identisch** zu den übrigen Kacheln aufgebaut: gleiche `Tile`-Komponente/`styles.tile`, `role="listitem"`, sichtbarer Fokusring (kein `outline:none`), Touch-Target ≥ 44 px, Bedeutung nicht allein über Farbe (WCAG 2.1 AA).
- **AC6** — Alle übrigen Shell-Verhaltensweisen bleiben intakt: Deep-Link `#/deployments` öffnet die Deployments-Ansicht direkt, Browser-Back/Forward, Home/Panel-Rückkehr, Settings-Zahnrad und der Fallback unbekannter Routen auf das Panel funktionieren unverändert. Die NavBar führt *Deployments* weiterhin auf.
- **AC7** — Doc-Kommentare und AC-Texte, die die Kachelzahl/Extra-Nav-Führung von *Deployments* festschreiben, werden konsistent nachgezogen, **ohne** ein anderes bestehendes Verhalten zu brechen: `app-shell-navigation` (AC1) und `settings-shell` (AC5) werden in dieser Spec-Runde so fortgeschrieben, dass *Deployments* eine Kachel ist und die Panel-Kachelzahl korrekt benannt ist; die `AppShell`-Quell-Doc-Kommentare (z.B. „genau fünf Kacheln … Deployments als Extra-Nav-Textlink") werden entsprechend angepasst.
- **AC8** (Security/Floor) — Keine neuen Secrets im Frontend-Bundle; keine neuen Backend-Endpunkte; keine view-spezifische Autorisierung; keine Umgehung der Cloudflare-Access-Mauer. Die Änderung ist rein präsentationsschicht-intern (Kachel statt Textlink).

## Verträge
- **Frontend-only:** Änderung beschränkt auf das `EntryPanel`/`TILES`/`EXTRA_NAV`-Konstrukt in `client/src/AppShell.jsx` (und zugehörige Tests/Doc-Kommentare). *Deployments* wandert aus `EXTRA_NAV` in `TILES`.
- **Routing unverändert:** stabile Kennung `deployments`; Mechanismus (Hash) wie in [[app-shell-navigation]]. Kein neuer Router, keine neue Abhängigkeit.
- **Keine neuen Backend-Endpunkte.** Die Deployments-Ansicht konsumiert ihre Endpunkte wie bisher ([[deploy-lifecycle]]).
- **Kein neuer State, keine neuen Props** an `Tile`/`EntryPanel` über das hinaus, was die übrigen Kacheln bereits nutzen.

## Edge-Cases & Fehlerverhalten
- **NavBar-Ableitung:** Die `NavBar` baut ihre Links heute aus `[...TILES, ...EXTRA_NAV]`. Wandert *Deployments* nach `TILES` und wird `EXTRA_NAV` (für den Panel-Bereich) leer/entfernt, **muss** die NavBar weiterhin genau einen *Deployments*-Link führen (kein Duplikat, kein Verlust). Testbar: jede Nicht-Panel-Ansicht zeigt in der NavBar genau einen *Deployments*-Link.
- Wird `EXTRA_NAV` vollständig entfernt, dürfen keine toten Referenzen (`extraNavRow`/`extraNavLink`-Styles, leeres Mapping) zurückbleiben, die einen leeren Container rendern.
- Schmale Viewports (< 768 px): die Deployments-Kachel stapelt wie die übrigen Kacheln (auto-fit-Grid), bleibt bedienbar.

## NFRs
- **A11y (WCAG 2.1 AA):** Kachel per Tastatur erreichbar, sichtbarer Fokus, Touch-Target ≥ 44 px, Bedeutung nicht allein über Farbe; konsistent mit den übrigen Kacheln und `docs/design.md`.
- **Sicherheit (Floor):** kein neues Secret im Frontend-Bundle; keine neuen Endpunkte; keine Umgehung der Access-Mauer.
- **Performance:** View-Wechsel ohne Voll-Reload (client-seitig, unverändert).

## Nicht-Ziele
- Änderungen am Inhalt/Verhalten der Deployments-Ansicht selbst (→ [[deploy-lifecycle]], [[deployment]]).
- Icons für Kacheln (die übrigen Kacheln haben keine Icons — die Deployments-Kachel ebenfalls nicht; bewusst „identisch zu den anderen").
- Umsortieren der übrigen Kacheln.

## Defaults (mangels Rückfrage festgelegt — eng umrissener UI-Change)
- **D1** — *Deployments* wird als **letzte** Kachel angehängt (entspricht der heutigen Position „unten als Link"); die Reihenfolge der übrigen Kacheln bleibt unverändert.
- **D2** — **Kein Icon** für die Deployments-Kachel — „identisch zu den anderen Kacheln", die ebenfalls iconlos sind (Label + Beschreibung).
- **D3** — Kachel-Beschreibung kurz und konsistent zum Stil der übrigen Kacheln (z.B. „Deployments, Container und Cloudflare-Routen im Blick.").

## Abhängigkeiten
- [[app-shell-navigation]] (liefert `EntryPanel`/`TILES`/`EXTRA_NAV`/`NavBar` — wird durch diese Spec fortgeschrieben: *Deployments* ist nun eine Kachel).
- [[settings-shell]] (AC5-Kachelzahl wird konsistent nachgezogen).
- [[team-view-frontend]] (führte die Team-Kachel als zusätzliche Kachel ein — diese Spec setzt darauf auf).
- [[deploy-lifecycle]] / [[deployment]] (Ziel-Ansicht der Kachel, unverändert).
