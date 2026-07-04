---
id: team-view-frontend
title: Team-Ansicht — Frontend (TeamView + markdownLite + 6. Kachel)
status: draft
area: retro-lernen
version: 1
---

# Spec: Team-Ansicht — Frontend (`team-view-frontend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer`.

## Zweck
Eine read-only **Team-Ansicht** in der dev-gui-Shell, die das agent-flow-„Team" — Agenten, Skills, Knowledge-Packs — als **Master-Detail**-Oberfläche einsehbar macht: links eine gruppierte Navigationsliste, rechts ein Detail-Pane mit Metadaten-Badges und dem vollständigen, sicher gerenderten Markdown-Body. Erreichbar über eine **neue (6.) Kachel „Team"** im Einstiegs-Panel und die Route `team`. Konsumiert die Endpunkte aus [[team-view-backend]].

## Verhalten
1. Das Einstiegs-Panel hat eine **zusätzliche (6.) Kachel „Team"** (id `team`, Label „Team", Beschreibung z.B. „Agenten, Skills und Knowledge der Fabrik einsehen."). Das Panel zeigt damit **fünf** Kacheln (`github`, `vps`, `cloudflare`, `factory`, `team`) plus die bestehenden Extra-Nav-Links (z.B. Deployments). *(Annahme: die Anforderung beschreibt die Team-Kachel als „6." in Bezug auf die Gesamt-Bedienelemente inkl. Settings/Deployments; im TILES-Array ist sie die fünfte Kachel. Maßgeblich ist: Kachel „Team" existiert und ist aktivierbar.)*
2. Die Team-Ansicht ist **deep-linkbar** über die Route `team` (`#/team`); die Route ist im `VIEWS`-Array von `useHashRouter.js` registriert und wird in der App-Shell zu `<TeamView … />` gerendert. Unbekannte Routen fallen weiter auf das Panel zurück (geerbt aus [[app-shell-navigation]]).
3. Beim Öffnen lädt die View **einmalig** die Übersicht von `GET /api/team` und zeigt während des Ladens einen Lade-Zustand (`aria-busy`/`aria-live`).
4. **Master (links):** eine Navigationsliste, gruppiert in drei Sektionen — **AGENTEN**, **SKILLS**, **KNOWLEDGE**. Knowledge-Einträge sind zusätzlich nach ihrer `group` sortiert/gruppiert. Jeder Eintrag zeigt mindestens seinen Anzeigenamen.
5. **Auswahl:** Aktiviert der Nutzer einen Listeneintrag (Maus **oder** Tastatur), lädt die View das Detail über `GET /api/team/:kind/:id` und zeigt es im Detail-Pane. Der aktive Eintrag ist als solcher gekennzeichnet (`aria-current`).
6. **Detail (rechts):** zeigt die Metadaten als **Badges** (z.B. Modell, Tools, Kurzbeschreibung — soweit für das Kind vorhanden) **und** den vollständigen Markdown-`body`, gerendert mit einem **leichten eigenen** Markdown-Renderer.
7. **Markdown-Renderer (`markdownLite`):** rendert Überschriften (`#`..`######`), Absätze, ungeordnete **und** geordnete Listen, Inline-Code, Code-Blöcke (```), Bold/Italic und Links (als Anchor bzw. Text) — als **React-Elemente**. **Kein** `dangerouslySetInnerHTML`, **kein** `innerHTML` — keine HTML-Injection / kein XSS.
8. **Leerzustand:** Liefert die Übersicht leere Listen (kein Plugin installiert), zeigt die View einen klar erkennbaren Hinweis (z.B. „Kein agent-flow-Plugin gefunden") statt eines leeren/toten Bildschirms — **kein** Crash.
9. **Fehlerzustand:** Schlägt ein Fetch fehl, zeigt die View eine erkennbare Fehlermeldung (und einen Retry/Reload, soweit sinnvoll), ohne die Shell zu brechen.
10. Aus der Team-Ansicht funktionieren Home/Rückkehr zum Panel und der Wechsel zu jeder anderen Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Das Einstiegs-Panel zeigt eine aktivierbare Kachel **„Team"** (id `team`); sie ist per Maus **und** per Tastatur (Tab + Enter/Space) aktivierbar und öffnet die Team-Ansicht. Bestehende AppShell-AC-Texte/Doc-Kommentare, die „vier Kacheln" sagen, werden auf die neue Kachelzahl angepasst, **ohne** ein bestehendes AppShell-AC (Navigation, Deep-Link, Settings-Zahnrad, Browser-Back) zu brechen.
- **AC2** — Die Route `team` ist in `useHashRouter.js` (`VIEWS` + Doc-Kommentar `#/team`) registriert; `#/team` öffnet per Deep-Link direkt die Team-Ansicht, und die App-Shell rendert bei `view === 'team'` `<TeamView … />`.
- **AC3** — Beim Öffnen ruft die View `GET /api/team` **genau einmal** auf und zeigt links eine in **AGENTEN / SKILLS / KNOWLEDGE** gruppierte Liste; Knowledge ist zusätzlich nach `group` sortiert/gruppiert. Während des Ladens ist ein Lade-Zustand für Screenreader erkennbar (`aria-busy`/`aria-live`).
- **AC4** — Aktiviert der Nutzer einen Listeneintrag (Maus **oder** Tastatur), ruft die View `GET /api/team/:kind/:id` auf und zeigt im Detail-Pane die Metadaten als Badges **und** den gerenderten Markdown-Body; der aktive Eintrag trägt `aria-current`.
- **AC5** (markdownLite) — Der eigene Renderer erzeugt für Überschrift (`#`..`######`), ungeordnete + geordnete Liste, Inline-Code, Code-Block (```), Bold/Italic und Link die korrekten **React-Elemente** (z.B. `<h1>`…`<h6>`, `<ul>/<ol>/<li>`, `<code>/<pre>`, `<strong>/<em>`, `<a>`). Es wird **kein** `dangerouslySetInnerHTML`/`innerHTML` verwendet; in den Body eingebettetes HTML wird **nicht** als HTML ausgeführt (kein XSS).
- **AC6** (Leerzustand) — Liefert `GET /api/team` leere Listen, zeigt die View einen erkennbaren Hinweis statt eines leeren Bildschirms und stürzt nicht ab.
- **AC7** (Fehlerzustand) — Schlägt ein Fetch fehl, zeigt die View eine erkennbare Fehlermeldung; die übrige Shell bleibt bedienbar.
- **AC8** (A11y, WCAG 2.1 AA) — Navigationsliste semantisch ausgezeichnet (Liste/Landmark); sichtbare Fokusringe (kein `outline:none`); Touch-Targets ≥ 44 px; `aria-current` auf dem aktiven Eintrag; Tastaturbedienung (Tab + Enter/Space); Bedeutung nicht allein über Farbe.
- **AC9** (Responsiv/Theme) — Zwei Spalten auf Desktop, gestapelt auf schmalen Viewports; Dark-Theme-Styles konsistent zu bestehenden Views (Hintergründe `#1a1a1a`/`#111`/`#0d0d0d`, Text `#e5e7eb`/`#9ca3af`).
- **AC10** (Security/Floor) — Keine neuen Secrets im Frontend-Bundle; der Markdown-Body wird als Text/React-Elemente gerendert (keine HTML-Injection); die View ruft ausschließlich die `/api/team*`-Endpunkte hinter dem bestehenden AccessGuard auf; keine neue externe Markdown-/Router-Bibliothek.

## Verträge
- **`client/src/TeamView.jsx`** — Master-Detail-Komponente; konsumiert `GET /api/team` (Übersicht) und `GET /api/team/:kind/:id` (Detail) aus [[team-view-backend]].
- **`client/src/markdownLite.jsx`** (oder gleichwertig) — reine Funktion/Komponente: Markdown-String → Array von React-Elementen; unterstützt die in AC5 genannte Teilmenge; **kein** HTML-Roundtrip.
- **`client/src/AppShell.jsx`** — TILES um `{ id: 'team', label: 'Team', description: … }` erweitert; Rendering-Zweig `view === 'team' && <TeamView onNavigate={navigate} />`; betroffene Doc-Kommentare/AC-Texte auf die neue Kachelzahl angepasst.
- **`client/src/useHashRouter.js`** — `'team'` im `VIEWS`-Array; Doc-Kommentar `#/team`.
- **Daten-Shapes** wie in [[team-view-backend]] festgelegt (Übersicht ohne Body; Detail mit `body`).

## Edge-Cases & Fehlerverhalten
- Leere Listen aus dem Backend → Leerzustands-Hinweis (AC6).
- Detail-Fetch eines Eintrags scheitert → Fehlermeldung im Detail-Pane, Liste bleibt nutzbar (AC7).
- Body mit eingebettetem `<script>`/HTML → wird als Text/escaped gerendert, nicht ausgeführt (AC5/AC10).
- Sehr langer Body → Detail-Pane scrollt; Liste bleibt sichtbar (Desktop) bzw. stapelt (schmal).
- Unbekannte Route bleibt Panel-Fallback (unverändert aus [[app-shell-navigation]]).

## NFRs
- **A11y (WCAG 2.1 AA):** siehe AC8.
- **Sicherheit (Floor):** siehe AC10 — keine Secrets, kein `dangerouslySetInnerHTML`/`innerHTML`, keine externe Lib, nur `/api/team*` hinter AccessGuard.
- **Performance:** Übersicht einmalig laden; Detail on-demand pro Auswahl.
- **Konsistenz:** Dark-Theme + Touch-Targets analog bestehender Views.

## Nicht-Ziele
- **Kein** Editieren/Schreiben von Agenten/Skills/Knowledge (strikt read-only).
- **Keine** Live-Ausführung von Agenten/Skills aus dieser View.
- **Keine** externe Markdown-Library; **keine** neue externe Bibliothek; **keine** neue DB.
- **Keine** Secrets im Response/Bundle.

## Abhängigkeiten
- [[team-view-backend]] (`GET /api/team`, `GET /api/team/:kind/:id`) — **muss zuerst** vorliegen.
- [[app-shell-navigation]] (Kachel-Panel, Routing, Home/Navigation, Settings-Zahnrad) — wird erweitert, nicht ersetzt.
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
