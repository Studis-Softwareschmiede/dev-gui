---
id: retro-trend-frontend
title: Retro-Trend — Frontend (Momentum-Board + #/retro-trend + Link im TeamView-Header)
status: draft
version: 1
---

# Spec: Retro-Trend — Frontend (`retro-trend-frontend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer`.

## Zweck
Eine read-only **Momentum-Board**-Ansicht in der dev-gui-Shell, die die **Trajektorie** der Self-Improvement-Effektivität zeigt: ob sich die vom Retro verbesserten Artefakte über die Retro-Läufe hinweg **verbessern oder verschlechtern**. Komplementär zur bestehenden [[retro-view-frontend]] (`#/retro`, Lauf-Historie) ist Retro-Trend die **Trajektorien-Sicht**: ein Bump-/Slope-Chart (inline SVG) mit einer **Mittellinie (Momentum 0)**, dessen Bahnen je nach gewähltem **Artefakt-Typ** (Knowledge Packs / Agent-Defs / Skills) umgeschaltet werden. Erreichbar über die **eigene Hash-Route `#/retro-trend`** (deep-linkbar, Browser-Back/Forward) und einen **dritten markanten „Retro-Trend"-Link im Kopfbereich der TeamView** (neben „Team" und „Retro"). **Kein Modal, kein 7. Tile, kein TILES-Eintrag.** Konsumiert ausschliesslich den Endpunkt aus [[retro-trend-backend]].

## Verhalten
1. **Einstieg:** Der Kopfbereich der TeamView (`client/src/TeamView.jsx`, in der `headerRow` neben `<h1>Team</h1>` und dem bestehenden „Retro"-Button) enthält einen **dritten markanten Link/Button „Retro-Trend"**. Aktivierung (Maus **oder** Tastatur, Tab + Enter/Space) navigiert auf `#/retro-trend` (`onNavigate('retro-trend')`), analog zum bestehenden „Retro"-Link. Das Einstiegs-Panel bleibt bei **sechs** Kacheln — **kein** 7. Tile, **kein** zusätzlicher TILES-Eintrag.
2. **Routing:** Die Route `retro-trend` ist im `VIEWS`-Array von `useHashRouter.js` (+ Doc-Kommentar `#/retro-trend`) registriert; die App-Shell rendert bei `view === 'retro-trend'` `<RetroTrendView … />`. Da `RetroTrendView` **nicht** aus `TILES` kommt, erscheint sie weder als Panel-Kachel noch zwingend als NavBar-Link — der Einstieg ist der TeamView-Header (Muster wie [[retro-view-frontend]]).
3. **Deep-Link & Verlauf:** `#/retro-trend` öffnet die View direkt; Browser-Zurück/Vor navigiert entlang des besuchten Verlaufs (z.B. `#/team` ⇄ `#/retro-trend` ⇄ `#/retro`); eine unbekannte Route fällt weiter auf das Panel zurück (geerbt aus [[app-shell-navigation]]).
4. **Kategorie-Umschalter:** Die View zeigt **drei Radio-Buttons** als eine Radio-Gruppe (`role="radiogroup"`), die die Artefakt-Kategorie der Bahnen umschalten: **„Knowledge Packs"** (`knowledge`), **„Agent-Defs"** (`agents`), **„Skills"** (`skills`). Default-Auswahl ist **Knowledge Packs**. Die Gruppe ist tastaturbedienbar (Tab in die Gruppe, **Pfeiltasten** wechseln die Auswahl, sichtbare Fokusringe). Jeder Wechsel lädt die gewählte Kategorie über `GET /api/retro/trend?category=<…>`.
5. **Laden:** Beim Öffnen lädt die View die Default-Kategorie **einmalig**; jeder Radio-Wechsel löst einen neuen Fetch aus. Während des Ladens ist ein Lade-Zustand für Screenreader erkennbar (`aria-busy`/`aria-live`); ein veraltetes Antwort-Ergebnis eines überholten Wechsels wird verworfen (Stale-Response-Guard, Muster wie [[retro-view-frontend]]).
6. **Momentum-Board (inline SVG):** Die View rendert ein **Bump-/Slope-Chart** als **inline SVG** (kein `dangerouslySetInnerHTML`, keine externe Chart-Lib):
   - **X-Achse:** die Retro-Läufe chronologisch (aufsteigend), beschriftet aus `runs[]` der Antwort.
   - **Y-Achse = Momentum:** zentriert um eine sichtbare **Mittellinie (0 = keine Änderung)**. Eine Bahn, die **steigt**, bedeutet Defektrate seit letztem Retro **gesunken** (Verbesserung); eine Bahn, die **fällt**, bedeutet **gestiegen** (Reverted/Verschlechterung). Mittellinie + Y-Richtungssinn sind in der View **erläutert** (Legende/Achsenbeschriftung).
   - **Eine Bahn je Eintrag in `lanes[]`**, gezeichnet als Linienzug über ihre `points[]`.
7. **Bahnen nicht allein über Farbe (A11y):** Jede Bahn trägt ein **Text-Label** (Bahn-`label`, z.B. „coder", „spring-boot-3") direkt an der Linie und/oder einen **Form-Marker** an den Datenpunkten, sodass die Bahnen **ohne** Farbe unterscheidbar sind. Datenpunkte sind mit zugänglichem Text beschrieben (z.B. `<title>`/`aria-label`: Bahn, Lauf, Momentum, beitragende Regeln).
8. **Skills-Platzhalter (Asymmetrie):** Liefert die Antwort für `category=skills` `lanes: []` mit einem `placeholder`-String, zeigt die View einen **erkennbaren Platzhalter** „— noch keine Messmethode für Skill-Güte" (oder den gelieferten `placeholder`) statt eines leeren Boards — **kein** Crash, **kein** totes Feld, konsistent mit dem `metric: null`-Muster aus [[retro-view-frontend]]. Der Skills-Radio-Button **bleibt** wählbar (Symmetrie der drei Artefakt-Typen).
9. **Leerzustand (Phase 0):** Liefert die Antwort `empty: true` / `lanes: []` / `runs: []` (für `knowledge`/`agents`), zeigt die View einen erkennbaren Hinweis „Noch keine Trenddaten" statt eines leeren Bildschirms — **kein** Crash.
10. **Erster Datenpunkt auf der Mittellinie:** Eine Bahn, deren erster Punkt `momentum = 0` ist, wird auf der Mittellinie verankert; eine Bahn mit nur einem Punkt zeigt einen Punkt-Marker (keine Linie, kein Delta) — kein Fehler (Verhalten aus [[retro-trend-backend]] AC5).
11. **Fehlerzustand:** Schlägt der Fetch fehl, zeigt die View eine erkennbare Fehlermeldung (`role="alert"`), ohne die Shell zu brechen; die übrige Shell und die Radio-Gruppe bleiben bedienbar.
12. Aus der Retro-Trend-Ansicht funktionieren Home/Rückkehr zum Panel und der Wechsel zu jeder anderen Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** (Einstieg) — Der TeamView-Kopfbereich zeigt einen **dritten markanten „Retro-Trend"-Link/Button** (neben „Team" und „Retro"); Aktivierung per Maus **und** per Tastatur (Tab + Enter/Space) navigiert auf `#/retro-trend`. Das Einstiegs-Panel behält **genau sechs** Kacheln — **kein** 7. Tile, **kein** zusätzlicher TILES-Eintrag.
- **AC2** (Routing/Deep-Link) — Die Route `retro-trend` ist in `useHashRouter.js` (`VIEWS` + Doc-Kommentar `#/retro-trend`) registriert; `#/retro-trend` öffnet per Deep-Link direkt die Retro-Trend-Ansicht, und die App-Shell rendert bei `view === 'retro-trend'` `<RetroTrendView … />`. `RetroTrendView` wird **nicht** in `TILES` aufgenommen.
- **AC3** (Browser-Verlauf) — Browser-Zurück/Vor navigiert entlang des besuchten Verlaufs (z.B. `#/team` ⇄ `#/retro-trend`); eine unbekannte Route zeigt das Einstiegs-Panel statt eines toten Bildschirms (unverändert aus [[app-shell-navigation]]).
- **AC4** (Kategorie-Radios + Laden) — Die View zeigt **drei** Radio-Buttons „Knowledge Packs" / „Agent-Defs" / „Skills" in einer `role="radiogroup"`; **Knowledge Packs** ist die Default-Auswahl und wird beim Öffnen **einmalig** über `GET /api/retro/trend?category=knowledge` geladen. Jeder Wechsel lädt `GET /api/retro/trend?category=<gewählt>`; während des Ladens ist ein Lade-Zustand erkennbar (`aria-busy`/`aria-live`); ein überholter Wechsel überschreibt das aktuelle Ergebnis nicht (Stale-Response-Guard).
- **AC5** (Momentum-Board) — Die View rendert ein **inline-SVG** Bump-/Slope-Chart mit einer sichtbaren **Mittellinie (0)**, der X-Achse aus `runs[]` (chronologisch aufsteigend) und **einer Linie je Bahn** aus `lanes[]`. Steigende Bahn = Verbesserung (Defektrate gesunken), fallende Bahn = Verschlechterung; die Bedeutung der Y-Richtung ist in der View erläutert (Legende/Achse).
- **AC6** (A11y — Bahnen nicht nur über Farbe) — Jede Bahn ist über ein **Text-Label** an der Linie und/oder **Form-Marker** an den Punkten **ohne** Farbe unterscheidbar; Datenpunkte tragen zugänglichen Text (`<title>`/`aria-label` mit Bahn, Lauf, Momentum). Die Radio-Gruppe ist mit **Pfeiltasten** und **Tab** bedienbar, mit sichtbaren Fokusringen; Touch-Targets der Radios ≥ 44 px; ein `aria-live`-Bereich meldet den Ladezustand.
- **AC7** (Skills-Platzhalter) — Bei `category=skills` (Antwort `lanes: []` + `placeholder`) zeigt die View einen erkennbaren Platzhalter („— noch keine Messmethode für Skill-Güte" o.ä.) statt eines leeren Boards; der Skills-Radio-Button bleibt wählbar; **kein** Crash, **kein** totes Feld.
- **AC8** (Leerzustand) — Bei `empty: true` / leeren `lanes`+`runs` (Phase 0) zeigt die View einen erkennbaren Hinweis „Noch keine Trenddaten" statt eines leeren Bildschirms; **kein** Crash.
- **AC9** (Fehlerzustand) — Schlägt der Fetch fehl, zeigt die View eine erkennbare Fehlermeldung (`role="alert"`); die übrige Shell und die Radio-Gruppe bleiben bedienbar.
- **AC10** (Responsiv/Theme) — Layout nebeneinander auf Desktop, gestapelt auf schmalen Viewports; das SVG-Board skaliert responsiv (z.B. `viewBox` + `width:100%`); Dark-Theme-Styles konsistent zu [[retro-view-frontend]]/[[team-view-frontend]] (Hintergründe `#1a1a1a`/`#111`/`#0d0d0d`, Text `#e5e7eb`/`#9ca3af`).
- **AC11** (Security/Floor) — Strikt read-only: die View ruft **ausschliesslich** `GET /api/retro/trend` (hinter dem bestehenden AccessGuard) auf, schreibt **nichts** (kein `baseline.json`/`LEARNINGS.md`) und triggert **nicht** retro/train/teamLeader; **keine** neuen Secrets im Frontend-Bundle; **keine** neue Autorisierung; **kein** `dangerouslySetInnerHTML`/`innerHTML`; **keine** neue externe Chart-/Markdown-/Router-Bibliothek (das Board entsteht aus inline SVG + vorhandenen Mitteln).

## Verträge
- **`client/src/RetroTrendView.jsx`** *(neu)* — View-Komponente; konsumiert `GET /api/retro/trend?category=<knowledge|agents|skills>` aus [[retro-trend-backend]]; Prop `{ onNavigate }`. Rendert Radio-Gruppe + inline-SVG-Momentum-Board + Leer-/Skills-/Fehler-Zustände.
- **`client/src/TeamView.jsx`** — dritter markanter „Retro-Trend"-Link/Button im Kopfbereich (`headerRow`, neben „Team"/„Retro"), aktiviert `onNavigate('retro-trend')`; per Maus **und** Tastatur bedienbar.
- **`client/src/AppShell.jsx`** — Rendering-Zweig `view === 'retro-trend' && <RetroTrendView onNavigate={navigate} />`; **kein** neuer `TILES`-Eintrag (sechs Kacheln bleiben).
- **`client/src/useHashRouter.js`** — `'retro-trend'` im `VIEWS`-Array; Doc-Kommentar `#/retro-trend`.
- **Daten-Shapes** wie in [[retro-trend-backend]] festgelegt: `{ category, empty?, placeholder?, runs: [{ run, date }], lanes: [{ id, label, points: [{ run, date, momentum, contributingRules }] }] }`.

## Edge-Cases & Fehlerverhalten
- `category=skills` → Skills-Platzhalter, Radio bleibt wählbar (AC7).
- `empty: true` / leere `lanes`+`runs` → „Noch keine Trenddaten" (AC8).
- Bahn mit nur einem Punkt → Punkt-Marker auf der Mittellinie, keine Linie, kein Fehler (AC5/§10).
- Fetch-Fehler → Fehlermeldung, Shell + Radios bleiben nutzbar (AC9).
- Schneller Kategorie-Wechsel → veraltete Antwort verworfen (Stale-Response-Guard, AC4).
- Sehr viele Bahnen/Läufe → SVG bleibt lesbar (Labels nicht überlappend stapeln; Board scrollt/skaliert), Liste bleibt bedienbar.
- Direkter Deep-Link `#/retro-trend` ohne Access-Cookie → bestehende Access-Mauer greift vor dem Frontend (unverändert).
- Unbekannte Route bleibt Panel-Fallback (unverändert aus [[app-shell-navigation]]).

## NFRs
- **A11y (WCAG 2.1 AA):** siehe AC6 — Bahnen nicht allein über Farbe (Labels/Marker), Radio-Gruppe per Pfeiltasten/Tab, sichtbare Fokusringe, Touch-Targets ≥ 44 px, `aria-live` für Ladezustand.
- **Sicherheit (Floor):** siehe AC11 — read-only, nur `/api/retro/trend` hinter AccessGuard, keine Secrets, kein `dangerouslySetInnerHTML`/`innerHTML`, keine externe Lib, kein Trigger von retro/train/teamLeader.
- **Performance:** Default-Kategorie einmalig laden; je Radio-Wechsel ein Fetch; SVG-Board client-seitig gerendert (keine Schwergewichts-Lib).
- **Konsistenz:** Dark-Theme + responsives Layout + Touch-Targets analog [[retro-view-frontend]]/[[team-view-frontend]].

## Nicht-Ziele
- **Kein** Editieren/Schreiben von `LEARNINGS.md`/`baseline.json` (strikt read-only).
- **Kein** Triggern von retro/train/teamLeader aus dieser View.
- **Kein** Live-Chart/Echtzeit-Update (Wochen-Trend, wenige Punkte; lädt on-demand).
- **Kein** Modal-Einstieg; **kein** 7. Tile; **kein** neuer TILES-Eintrag.
- **Keine** erfundene Skill-Metrik (Platzhalter offen ausgewiesen, AC7).
- **Keine** externe Chart-/Markdown-/Router-Bibliothek; **keine** Secrets im Bundle.

## Abhängigkeiten
- [[retro-trend-backend]] (`GET /api/retro/trend`) — **muss zuerst** vorliegen.
- [[retro-view-frontend]] (View-/Badge-/Platzhalter-Muster, Stale-Response-Guard, „Retro"-Link als Vorlage für den dritten Link).
- [[team-view-frontend]] (TeamView-Kopfbereich `headerRow` wird um den „Retro-Trend"-Link erweitert).
- [[app-shell-navigation]] (Routing, Home/Navigation, Browser-Verlauf, Panel-Fallback) — wird erweitert, nicht ersetzt; sechs Kacheln unverändert.
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
