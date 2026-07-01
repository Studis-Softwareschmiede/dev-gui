---
id: spec-audit-view
title: Audit-Spec-Anzeige — Button „Audit-Spec anzeigen" + Anzeige der spec-audit.md
status: draft
version: 1
---

# Spec: Audit-Spec-Anzeige  (`spec-audit-view`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Reconcile-Lauf (`/agent-flow:reconcile`, ausgelöst über [[reconcile-trigger]] / S-201) schreibt ein Logbuch nach `docs/spec-audit.md` — das Protokoll der letzten Doku-Aufhol-Aktionen. Bislang gibt es in der GUI **keinen** Weg, dieses Logbuch einzusehen. Diese Spec ergänzt einen **kleinen Sekundär-Button „Audit-Spec anzeigen"** direkt **unterhalb** des bestehenden „Konzept/Spec nachziehen"-Buttons im Spezifikation-Reiter, der die `docs/spec-audit.md` des aktiven Projekts lädt und rendert.

## Verhalten
1. Im Spezifikation-Reiter (`SpecView`, [[projekt-spezifikation-anzeige]]) erscheint **direkt unterhalb** des `ReconcileTrigger`-Buttons („Konzept/Spec nachziehen", [[reconcile-trigger]] AC1) ein **kleiner Sekundär-Button** mit dem Titel **„Audit-Spec anzeigen"**.
2. **Klick lädt.** Ein Klick lädt über die bestehende Doku-Lese-API `GET /api/board/projects/:slug/docs/raw?path=docs/spec-audit.md` den Roh-Markdown des Logbuchs des aktiven Projekts.
3. **Rendern.** Der geladene Inhalt wird über den vorhandenen `MarkdownLite`-Renderer angezeigt (kein fremder Parser, kein `dangerouslySetInnerHTML`) — konsistent zur bestehenden Doku-Anzeige rechts.
4. **Ladezustand.** Während des Ladens ist ein zugänglicher Lade-/Busy-Zustand sichtbar (Text, nicht nur Farbe); ein Doppelklick löst keinen doppelten „konkurrierenden" Render aus.
5. **Datei fehlt.** Antwortet die API mit `404` (noch kein Reconcile-Lauf, `docs/spec-audit.md` existiert nicht) → ein **freundlicher Hinweis** „noch kein Reconcile-Lauf" (o.ä.) statt einer technischen Fehlermeldung/Crash.
6. **Fehler.** Netzwerkfehler oder `500`/unerwarteter Status → sichtbare, neutrale Fehleranzeige (Text), kein Crash; der Rest des Reiters bleibt bedienbar.

## Acceptance-Kriterien
- **AC1** — Im Spezifikation-Reiter existiert ein **Sekundär-Button** mit Titel/Label **„Audit-Spec anzeigen"**, der **direkt unterhalb** des bestehenden „Konzept/Spec nachziehen"-Buttons (`ReconcileTrigger`) positioniert ist; Touch-Target ≥ 44 px (WCAG 2.1 AA), Zustand per Text/Label erkennbar (nicht nur Farbe).
- **AC2** — Klick auf den Button löst **genau einen** `GET /api/board/projects/<aktiver-slug>/docs/raw?path=docs/spec-audit.md` aus; der zurückgegebene Markdown wird über den vorhandenen `MarkdownLite`-Renderer gerendert und ist sichtbar.
- **AC3** — Antwortet die API mit `404` (Datei fehlt), erscheint ein **freundlicher Hinweis** „noch kein Reconcile-Lauf" (Text, `role="status"` o.ä.) — **keine** rohe Fehlermeldung, **kein** Crash.
- **AC4** — Während des Ladens ist ein zugänglicher Lade-Zustand sichtbar; Netzwerkfehler oder `500`/unerwarteter Status → sichtbare, neutrale Fehleranzeige (`role="alert"` o.ä.), kein Crash, der übrige Reiter bleibt bedienbar.
- **AC5** — Die Komponente ist **entkoppelt testbar** über eine mockbare `fetch`-/`fetchFn`-Injektion (kein Test hängt an einer realen Datei/agent-flow-Antwort); Tests liegen in `client/src/__tests__/` und folgen dem Muster der bestehenden `SpecView`-Tests (`SpecView.test.jsx`, `SpecViewReconcileTrigger.test.jsx`) und decken AC1–AC4 ab (inkl. 404-Fall und Fehlerfall).

## Verträge
- **Ort:** `client/src/SpecView.jsx`, im Sidebar-Block **direkt nach** dem `<ReconcileTrigger …/>` (aktuell ~Zeile 227).
- **API (bestehend, unverändert):** `GET /api/board/projects/:slug/docs/raw?path=docs/spec-audit.md`
  → `200 text/plain; charset=utf-8` (Roh-Markdown) · `404 {error}` (Datei/Projekt nicht gefunden) · `400 {error}` (Pfad-Traversal — hier nicht anwendbar, Pfad ist fest). Kein neuer Endpunkt.
- **Renderer (bestehend):** `MarkdownLite` aus `client/src/markdownLite.jsx` — wird wiederverwendet, nicht geändert.
- **Projekt-Bezug:** `slug` = aktives Projekt (`projectSlug`), wie beim bestehenden Doku-Laden in `SpecView`.
- **Testbarkeit/Entkopplung (SR3):** Der `fetch` ist über einen injizierbaren `fetchFn`-Parameter (Default `window.fetch`) mockbar — analog zum bestehenden `ReconcileTrigger`. Kein dev-gui-Test hängt an einem realen Reconcile-Lauf.

## Edge-Cases & Fehlerverhalten
- `docs/spec-audit.md` fehlt → `404` → freundlicher Hinweis (AC3), kein Fehler-Look.
- Leere Datei (`200`, leerer Body) → leerer, aber valider Render (kein Crash); optional dezenter „leer"-Hinweis.
- Doppelklick / erneuter Klick → nur eine aktive Ladung; kein Race, keine überlappenden States (letzte Ladung gewinnt).
- Fehlender `projectSlug` → Button lädt nicht bzw. neutraler Hinweis (kein Request mit leerem Slug).

## NFRs
- **A11y (WCAG 2.1 AA):** Button mit zugänglichem Namen, sichtbarer Fokusring (kein `outline:none`), Touch-Target ≥ 44 px; Lade-/Fehler-/Leer-Zustände per Text erkennbar (nicht nur Farbe), passende ARIA-Rollen (`status`/`alert`).
- **Sicherheit (Floor):** Kein neuer Backend-Endpunkt, keine neue Trust-Boundary; fester Pfad `docs/spec-audit.md` (kein nutzergesteuerter Pfad → kein Traversal-Vektor). Rendern ausschließlich über `MarkdownLite`, **kein** `dangerouslySetInnerHTML`. Keine Secrets im Bundle.
- **Performance:** Laden nur on-demand beim Klick (kein Polling, kein Auto-Load beim Reiter-Öffnen).

## Nicht-Ziele
- Erzeugen/Aktualisieren der `docs/spec-audit.md` selbst — das schreibt der Reconcile-Lauf in **agent-flow** (Logbuch, [[reconcile-trigger]] Nicht-Ziele); Voraussetzung dafür ist ein aktuelles Plugin ([[plugin-auto-update]]).
- Editieren/Filtern/Blättern des Logbuchs — reine Anzeige.
- Änderungen am `docs/raw`-Endpunkt, am `MarkdownLite`-Renderer oder am `ReconcileTrigger`.

## Abhängigkeiten
- [[reconcile-trigger]] (S-201) — der bestehende Button, **unterhalb** dessen der neue Button gehängt wird; gleiches `fetchFn`-Muster.
- [[projekt-spezifikation-anzeige]] (`SpecView`, Doku-Lade-API `docs/raw`, `MarkdownLite`).
- **[[plugin-auto-update]] (Story A) — funktionale Abhängigkeit (SR3/depends):** Das **reale** Entstehen von `docs/spec-audit.md` setzt einen erfolgreichen Reconcile-Lauf voraus, der wiederum ein **aktuelles** Plugin im Container braucht (Story A). Die **Anzeige-UI selbst ist davon entkoppelt** baubar und testbar (mockbarer `fetch`); der 404-Pfad (AC3) deckt genau den Zustand „noch kein Reconcile-Lauf" ab.
