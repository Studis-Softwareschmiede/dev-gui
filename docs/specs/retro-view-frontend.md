---
id: retro-view-frontend
title: Retro-Sichtbarkeit — Frontend (RetroView + #/retro + Link im TeamView-Header)
status: draft
area: retro-lernen
version: 1
---

# Spec: Retro-Sichtbarkeit — Frontend (`retro-view-frontend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer`.

## Zweck
Eine read-only **Retro-Ansicht** in der dev-gui-Shell, die die Self-Improvement-Historie der Fabrik (retro/train/teamLeader) als **Master-Detail**-Oberfläche sichtbar macht: links eine Liste der Läufe (Datum absteigend, Lauf-Name, Quelle-Badge, kleine Zähler), rechts ein **Retro-Report** des gewählten Laufs, gegliedert in Agenten / Skills / Knowledge — je Eintrag Regel, Status-Badge, Provenance und — falls vorhanden — Metrik. Erreichbar über die **eigene Hash-Route `#/retro`** (deep-linkbar, Browser-Back/Forward) und einen **markanten „Retro"-Link im Kopfbereich der TeamView**. **Kein Modal, kein 7. Tile.** Konsumiert die Endpunkte aus [[retro-view-backend]].

## Verhalten
1. **Einstieg:** Der Kopfbereich der TeamView (`client/src/TeamView.jsx`, beim `<h1>Team</h1>`) enthält einen **markanten Link/Button „Retro"**. Aktivierung (Maus **oder** Tastatur) navigiert auf `#/retro` (`onNavigate('retro')`). Das Einstiegs-Panel bleibt bei **sechs** Kacheln — **kein** 7. Tile wird hinzugefügt.
2. **Routing:** Die Route `retro` ist im `VIEWS`-Array von `useHashRouter.js` (+ Doc-Kommentar `#/retro`) registriert; die App-Shell rendert bei `view === 'retro'` `<RetroView … />`. Da `RetroView` **nicht** aus `TILES` kommt, erscheint sie weder als Panel-Kachel noch zwingend als NavBar-Link — der Einstieg ist der TeamView-Header.
3. **Deep-Link & Verlauf:** `#/retro` öffnet die View direkt; Browser-Zurück/Vor navigiert entlang des besuchten Verlaufs (z.B. `#/team` ⇄ `#/retro`); eine unbekannte Route fällt weiter auf das Panel zurück (geerbt aus [[app-shell-navigation]]).
4. Beim Öffnen lädt die View **einmalig** die Übersicht von `GET /api/retro/runs` und zeigt während des Ladens einen Lade-Zustand (`aria-busy`/`aria-live`).
5. **Master (links):** eine Navigationsliste der Läufe, **absteigend nach Datum** sortiert. Jeder Eintrag zeigt **Datum**, **Lauf-Name** (Slug), eine **Quelle-Badge** (retro / train / teamLeader / other) und **kleine Zähler** aus `counts` (z.B. „2 Knowledge · 1 Agent"). Einträge sind tastatur-navigierbar (Enter/Space aktiviert); der aktive Eintrag trägt `aria-current`.
6. **Auswahl:** Aktiviert der Nutzer einen Lauf (Maus **oder** Tastatur), lädt die View den Report über `GET /api/retro/runs/:slug` und zeigt ihn im Detail-Pane.
7. **Detail (rechts) — „Retro-Report":** prägnant, gegliedert in **drei Sektionen** Agenten / Skills / Knowledge. Je Eintrag: **Regel** (Ein-Satz-Zusammenfassung), **Status-Badge**, **Provenance** (Quelle-Spalte) und — falls die Metrik vorhanden ist (`metric != null`) — **Metrik** (`rate_per_100ep`, `baseline → neu`, Status). Auf Lauf-Ebene wird der **Status-Mix** (`statusMix`) angezeigt. Eine Sektion ohne Einträge wird weggelassen.
8. **Leere Metrik (Phase 0):** Liefert der Report `metric: null` für einen Eintrag, zeigt die View statt der Metrik einen klar erkennbaren Platzhalter „— noch keine Messdaten" (oder gleichwertig) — **kein** leeres/totes Feld, **kein** Crash.
9. **Leerzustand:** Liefert `GET /api/retro/runs` eine leere Liste, zeigt die View einen erkennbaren Hinweis (z.B. „Noch keine Self-Improvement-Läufe") statt eines leeren Bildschirms.
10. **Fehlerzustand:** Schlägt ein Fetch fehl, zeigt die View eine erkennbare Fehlermeldung, ohne die Shell zu brechen; die übrige Shell bleibt bedienbar.
11. Aus der Retro-Ansicht funktionieren Home/Rückkehr zum Panel und der Wechsel zu jeder anderen Ansicht (geerbt aus [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** (Einstieg) — Der TeamView-Kopfbereich zeigt einen **markanten „Retro"-Link/Button**; Aktivierung per Maus **und** per Tastatur (Tab + Enter/Space) navigiert auf `#/retro`. Das Einstiegs-Panel behält **genau sechs** Kacheln — **kein** 7. Tile, **kein** zusätzlicher TILES-Eintrag.
- **AC2** (Routing/Deep-Link) — Die Route `retro` ist in `useHashRouter.js` (`VIEWS` + Doc-Kommentar `#/retro`) registriert; `#/retro` öffnet per Deep-Link direkt die Retro-Ansicht, und die App-Shell rendert bei `view === 'retro'` `<RetroView … />`. `RetroView` wird **nicht** in `TILES` aufgenommen.
- **AC3** (Browser-Verlauf) — Browser-Zurück/Vor navigiert entlang des besuchten Verlaufs (z.B. `#/team` ⇄ `#/retro`); eine unbekannte Route zeigt das Einstiegs-Panel statt eines toten Bildschirms (unverändert aus [[app-shell-navigation]]).
- **AC4** (Master-Liste) — Beim Öffnen ruft die View `GET /api/retro/runs` **genau einmal** auf und zeigt links die Läufe **absteigend nach Datum**; jeder Eintrag zeigt **Datum**, **Lauf-Name**, **Quelle-Badge** und **Zähler** aus `counts`. Während des Ladens ist ein Lade-Zustand für Screenreader erkennbar (`aria-busy`/`aria-live`).
- **AC5** (Auswahl/Report) — Aktiviert der Nutzer einen Lauf (Maus **oder** Tastatur), ruft die View `GET /api/retro/runs/:slug` auf und zeigt im Detail-Pane den Report in **drei Sektionen** Agenten / Skills / Knowledge; je Eintrag **Regel**, **Status-Badge**, **Provenance**; auf Lauf-Ebene den **Status-Mix**. Sektionen ohne Einträge werden weggelassen. Der aktive Listeneintrag trägt `aria-current`.
- **AC6** (Metrik-Anzeige) — Ist `metric != null`, zeigt der Eintrag `rate_per_100ep`, `baseline → neu` und Status; ist `metric == null` (Phase 0), zeigt die View einen erkennbaren Platzhalter („— noch keine Messdaten" o.ä.) statt eines leeren Feldes — **kein** Crash.
- **AC7** (Leerzustand) — Liefert `GET /api/retro/runs` eine leere Liste, zeigt die View einen erkennbaren Hinweis statt eines leeren Bildschirms und stürzt nicht ab.
- **AC8** (Fehlerzustand) — Schlägt ein Fetch fehl, zeigt die View eine erkennbare Fehlermeldung; die übrige Shell bleibt bedienbar.
- **AC9** (A11y, WCAG 2.1 AA) — Lauf-Liste semantisch ausgezeichnet (Liste/Landmark); sichtbare Fokusringe (kein `outline:none`); Touch-Targets ≥ 44 px; `aria-current` auf dem aktiven Lauf; Tastaturbedienung (Tab + Enter/Space) für Liste **und** „Retro"-Link; Status-/Quelle-Badges so gestaltet, dass die **Bedeutung nicht allein über Farbe** transportiert wird (Text/Label vorhanden).
- **AC10** (Responsiv/Theme) — Zwei Spalten auf Desktop, gestapelt auf schmalen Viewports; Dark-Theme-Styles konsistent zu bestehenden Views (Master-Detail-Muster der TeamView; Hintergründe `#1a1a1a`/`#111`/`#0d0d0d`, Text `#e5e7eb`/`#9ca3af`).
- **AC11** (Security/Floor) — Keine neuen Secrets im Frontend-Bundle; die View ruft ausschließlich die `/api/retro/*`-Endpunkte hinter dem bestehenden AccessGuard auf; **keine** neue Autorisierung; **kein** `dangerouslySetInnerHTML`/`innerHTML`; **keine** neue externe Markdown-/Router-Bibliothek (Regel-Text wird als Text/React-Elemente gerendert).

## Verträge
- **`client/src/RetroView.jsx`** — Master-Detail-Komponente im Muster von `TeamView.jsx`; konsumiert `GET /api/retro/runs` (Übersicht) und `GET /api/retro/runs/:slug` (Report) aus [[retro-view-backend]]; Prop `{ onNavigate }`.
- **`client/src/TeamView.jsx`** — markanter „Retro"-Link/Button im Kopfbereich (beim `<h1>Team</h1>`), aktiviert `onNavigate('retro')`; per Maus **und** Tastatur bedienbar.
- **`client/src/AppShell.jsx`** — Rendering-Zweig `view === 'retro' && <RetroView onNavigate={navigate} />`; **kein** neuer `TILES`-Eintrag (sechs Kacheln bleiben).
- **`client/src/useHashRouter.js`** — `'retro'` im `VIEWS`-Array; Doc-Kommentar `#/retro`.
- **Daten-Shapes** wie in [[retro-view-backend]] festgelegt (Übersicht ohne Regeltext; Report mit `agents`/`skills`/`knowledge`-Sektionen + `metric|null`).

## Edge-Cases & Fehlerverhalten
- Leere `runs`-Liste → Leerzustands-Hinweis (AC7).
- Report-Fetch eines Laufs scheitert → Fehlermeldung im Detail-Pane, Liste bleibt nutzbar (AC8).
- `metric: null` (Phase 0) → Platzhalter statt leerem Feld (AC6).
- Sektion ohne Einträge → weggelassen (AC5).
- Sehr langer Report → Detail-Pane scrollt; Liste bleibt sichtbar (Desktop) bzw. stapelt (schmal).
- Direkter Deep-Link `#/retro` ohne Access-Cookie → bestehende Access-Mauer greift vor dem Frontend (unverändert).
- Unbekannte Route bleibt Panel-Fallback (unverändert aus [[app-shell-navigation]]).

## NFRs
- **A11y (WCAG 2.1 AA):** siehe AC9.
- **Sicherheit (Floor):** siehe AC11 — keine Secrets, kein `dangerouslySetInnerHTML`/`innerHTML`, keine externe Lib, nur `/api/retro/*` hinter AccessGuard, keine neue Autorisierung.
- **Performance:** Übersicht einmalig laden; Report on-demand pro Auswahl.
- **Konsistenz:** Dark-Theme + Master-Detail-Muster + Touch-Targets analog [[team-view-frontend]].

## Nicht-Ziele
- **Kein** Editieren/Schreiben von `LEARNINGS.md`/Metriken (strikt read-only).
- **Kein** Triggern von retro/train/teamLeader aus dieser View.
- **Kein** Modal-Einstieg; **kein** 7. Tile; **kein** neuer TILES-Eintrag.
- **Keine** externe Markdown-/Router-Bibliothek; **keine** neue DB.
- **Keine** Secrets im Bundle.

## Abhängigkeiten
- [[retro-view-backend]] (`GET /api/retro/runs`, `GET /api/retro/runs/:slug`) — **muss zuerst** vorliegen.
- [[team-view-frontend]] (TeamView-Kopfbereich wird um den „Retro"-Link erweitert; Master-Detail-Muster als Vorlage).
- [[app-shell-navigation]] (Routing, Home/Navigation, Browser-Verlauf, Panel-Fallback) — wird erweitert, nicht ersetzt; sechs Kacheln unverändert.
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
