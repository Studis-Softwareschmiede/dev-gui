---
id: audit-spec-main-pane
title: Audit-Spec-Logbuch in der Haupt-Inhaltsfläche (statt in der schmalen Sidebar)
status: draft
version: 1
---

# Spec: Audit-Spec-Logbuch in der Haupt-Inhaltsfläche  (`audit-spec-main-pane`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Button „Audit-Spec anzeigen" ([[spec-audit-view]] / S-203) rendert das gerenderte `docs/spec-audit.md` heute **innerhalb der schmalen linken Sidebar** direkt unter dem Button — gequetscht und schwer lesbar —, während die **große rechte Haupt-Inhaltsfläche** des Spezifikation-Reiters leer daneben steht („Dokument aus der Navigation auswählen"). Diese Spec verlagert die **Ausgabe** des Logbuchs in genau diese Haupt-Inhaltsfläche (dieselbe Fläche, in der ein aus der Navigation gewähltes Dokument erscheint) — konsistent zur normalen Doku-Anzeige (Breite, Padding, Scroll). Der **Button bleibt** unverändert als kleiner Sekundär-Button in der linken Sidebar; nur die gerenderte Ausgabe wandert nach rechts.

## Verhalten
1. **Button bleibt links.** Der Sekundär-Button „Audit-Spec anzeigen" bleibt an seiner bisherigen Stelle in der linken Sidebar — direkt unterhalb des „Konzept/Spec nachziehen"-Buttons ([[reconcile-trigger]] / S-201). Position, Label und Touch-Target (≥ 44 px) bleiben unverändert. In der Sidebar erscheint **keine** gerenderte Markdown-Ausgabe mehr.
2. **Ausgabe rechts.** Ein Klick lädt das Logbuch (`docs/spec-audit.md`) und rendert es über `MarkdownLite` in der **rechten Haupt-Inhaltsfläche** — derselbe Container, in dem ein per Navigation gewähltes Dokument angezeigt wird, mit derselben Breite, demselben Padding und demselben Scroll-Verhalten.
3. **Umschalten statt Doppelanzeige.** Die Haupt-Inhaltsfläche hat genau eine sichtbare Quelle: entweder das per Navigation gewählte Dokument **oder** das Audit-Logbuch. Ein Klick auf „Audit-Spec anzeigen" setzt die Haupt-Inhaltsfläche auf das Logbuch und **ersetzt/überschreibt** eine ggf. zuvor gewählte Datei (das Dokument ist dann nicht mehr in der Hauptfläche sichtbar).
4. **Zurück zum Dokument.** Ein anschließender Klick auf einen Navigations-Eintrag schaltet die Haupt-Inhaltsfläche wieder auf das gewählte Dokument; das Audit-Logbuch verschwindet aus der Hauptfläche.
5. **Zustände in der Hauptfläche.** Lade-Zustand, der freundliche 404-Hinweis („noch kein Reconcile-Lauf") und die neutrale Fehleranzeige (Netzwerkfehler/500/unerwarteter Status) erscheinen jetzt ebenfalls in der Haupt-Inhaltsfläche (nicht mehr in der Sidebar) — weiterhin per Text erkennbar (nicht nur Farbe), kein Crash, der übrige Reiter bleibt bedienbar.
6. **Automatischer Reload erhalten.** Der automatische Reload nach einem Reconcile-Abschluss ([[reconcile-inline-feedback]] / S-205 AC4) bleibt erhalten: das Logbuch wird genau einmal neu geladen und sein aktualisierter Inhalt erscheint in der Haupt-Inhaltsfläche.
7. **PR-Bezug erhalten.** Der dezente PR-Bezug-Hinweis ([[reconcile-inline-feedback]] / S-205 AC5, best-effort) bleibt erhalten und erscheint zusammen mit dem Logbuch in der Haupt-Inhaltsfläche.

## Acceptance-Kriterien

- **AC1** — Der Sekundär-Button „Audit-Spec anzeigen" bleibt in der linken Sidebar direkt unterhalb des „Konzept/Spec nachziehen"-Buttons (Label, Position und Touch-Target ≥ 44 px unverändert); nach dem Klick erscheint **keine** gerenderte Markdown-Ausgabe des Logbuchs mehr **innerhalb der Sidebar**.
- **AC2** — Ein Klick löst **genau einen** `GET /api/board/projects/<aktiver-slug>/docs/raw?path=docs/spec-audit.md` aus; der zurückgegebene Markdown wird über `MarkdownLite` in der **rechten Haupt-Inhaltsfläche** gerendert und ist dort sichtbar — im selben Content-Container wie ein per Navigation gewähltes Dokument (gleiche Breite/Padding/Scroll).
- **AC3** — Ein Klick auf „Audit-Spec anzeigen", **während** ein per Navigation gewähltes Dokument in der Hauptfläche steht, ersetzt dieses in der Hauptfläche durch das Logbuch; ein **anschließender** Klick auf einen Navigations-Eintrag schaltet die Hauptfläche wieder auf das gewählte Dokument (das Logbuch verschwindet dann aus der Hauptfläche). Es sind nie beide gleichzeitig sichtbar.
- **AC4** — Lade-Zustand (zugänglich, Text), 404 → freundlicher Hinweis „noch kein Reconcile-Lauf" (`role="status"`) und Netzwerkfehler/500/unerwarteter Status → neutrale Fehleranzeige (`role="alert"`) erscheinen jetzt in der **Haupt-Inhaltsfläche**; kein Crash, der übrige Reiter (Sidebar, Navigation, Reconcile-Button) bleibt bedienbar.
- **AC5** — Der automatische Reload nach Reconcile-Abschluss ([[reconcile-inline-feedback]] AC4, `reloadSignal`) lädt das Logbuch weiterhin **genau einmal** neu und surft den aktualisierten Inhalt in die Haupt-Inhaltsfläche; der dezente PR-Bezug-Hinweis ([[reconcile-inline-feedback]] AC5, best-effort, `target="_blank"` mit `rel="noopener noreferrer"`) bleibt erhalten und erscheint zusammen mit dem Logbuch in der Hauptfläche.
- **AC6** — **Security-Floor unverändert:** kein neuer Backend-Endpunkt, fester nicht-nutzergesteuerter Pfad `docs/spec-audit.md` (kein Traversal-Vektor), Rendern **ausschließlich** über `MarkdownLite` (kein fremder Parser, **kein** `dangerouslySetInnerHTML`), keine Secrets im Bundle.
- **AC7** — Die Komponente(n) bleiben **entkoppelt testbar** über die injizierbare `fetchFn` (kein Test hängt an einem realen Reconcile-Lauf/einer realen Datei). Die bestehenden Audit-Tests (`client/src/__tests__/SpecViewAuditSpec.test.jsx`) sind an die neue Ausgabe-Position angepasst; **neue** Tests belegen „Ausgabe erscheint in der Haupt-Inhaltsfläche, **nicht** in der Sidebar" sowie das Umschalten Audit ↔ Navigations-Dokument (AC3).

## Verträge
- **Ort:** `client/src/SpecView.jsx` — die `SpecView`-Komponente (Sidebar/Content-Grid, `styles.sidebar` / `styles.content`) und `AuditSpecView`.
- **Content-Pane-Mechanismus (bestehend, wiederverwenden):** Die rechte Haupt-Inhaltsfläche (`styles.content`, inkl. `styles.markdownWrapper`/`styles.markdown`) rendert heute den Inhalt zu `activePath`. Sie wird um eine **zweite Quelle** erweitert: Audit-Logbuch. Es braucht einen Umschalt-Zustand („welche Quelle zeigt die Hauptfläche": `doc` | `audit`), der beim Klick auf „Audit-Spec anzeigen" auf `audit` und bei einem Navigations-Klick (`handleSelect`) auf `doc` gesetzt wird. Der Audit-Lade-Zustand (`loading`/`notfound`/`error`/`ok`, `content`, PR-Bezug, `requestId`-/`loadingRef`-Guards, `reloadSignal`-Auto-Reload) wird so angeordnet, dass seine **Ausgabe** im Content-Container gerendert wird — der Button-Teil bleibt in der Sidebar. (Umsetzung offen: State-Lift nach `SpecView` oder Render der `AuditSpecView`-Ausgabe in den Content-Container; die Spec schreibt keine Idiome vor.)
- **API (bestehend, unverändert):** `GET /api/board/projects/:slug/docs/raw?path=docs/spec-audit.md` → `200 text/plain` (Roh-Markdown) · `404 {error}` (Datei/Projekt fehlt) · `500` (Serverfehler). **Kein neuer Endpunkt.**
- **Renderer (bestehend, unverändert):** `MarkdownLite` aus `client/src/markdownLite.jsx`.
- **Testbarkeit/Entkopplung:** `fetchFn`-Injektion (Default `globalThis.fetch`), analog zu `ReconcileTrigger`/`AuditSpecView`; Tests in `client/src/__tests__/` im Muster der bestehenden `SpecView`-Tests.

## Edge-Cases & Fehlerverhalten
- Klick auf „Audit-Spec anzeigen" **ohne** zuvor gewähltes Dokument (Hauptfläche zeigt „Dokument aus der Navigation auswählen") → Hauptfläche wechselt direkt auf das Logbuch bzw. dessen Lade-/404-/Fehler-Zustand.
- Auto-Reload (`reloadSignal`) **während** die Hauptfläche das Logbuch zeigt → Inhalt aktualisiert sich in der Hauptfläche (genau ein Reload). Zeigt die Hauptfläche gerade ein Navigations-Dokument, überschreibt der Auto-Reload dessen Anzeige nicht unbemerkt weg von einer aktiven Lese-Aktion mehrfach — der Reload bleibt „genau einmal" (Doppel-Reload-Guard `loadingRef` unverändert).
- Doppelklick / erneuter Klick → nur eine aktive Ladung, keine überlappenden States (letzte Ladung gewinnt, `requestId`-Guard unverändert).
- 404 / leere Datei / Netzwerkfehler → Zustände wie in [[spec-audit-view]], nur in der Hauptfläche statt in der Sidebar.
- Fehlender `projectSlug` → kein Request mit leerem Slug; neutraler/kein Zustand (unverändert).

## NFRs
- **A11y (WCAG 2.1 AA):** Content-Container behält `aria-busy` beim Laden und `aria-live="polite"`; Lade-/404-/Fehler-Zustände per Text erkennbar (nicht nur Farbe), passende ARIA-Rollen (`status`/`alert`); Button-Fokusring nie unterdrückt, Touch-Target ≥ 44 px.
- **Sicherheit (Floor):** siehe AC6 — keine neue Trust-Boundary, fester Pfad, nur `MarkdownLite`, kein `dangerouslySetInnerHTML`.
- **Performance:** Laden nur on-demand beim Klick bzw. beim Auto-Reload nach Reconcile-Abschluss (kein Polling für die Anzeige selbst).

## Nicht-Ziele
- Änderungen am `docs/raw`-Endpunkt, am `MarkdownLite`-Renderer oder am `ReconcileTrigger`.
- Erzeugen/Aktualisieren der `docs/spec-audit.md` selbst (das schreibt der Reconcile-Lauf in agent-flow).
- Neue Layout-Modi, Split-Views oder gleichzeitige Anzeige von Dokument **und** Logbuch nebeneinander — es bleibt bei einer Quelle in der Hauptfläche.
- Editieren/Filtern/Blättern des Logbuchs.

## Abhängigkeiten
- [[spec-audit-view]] (S-203) — der bestehende Button + Lade-/Render-/404-Logik, deren **Ausgabe-Position** diese Spec ändert.
- [[reconcile-inline-feedback]] (S-205) — `reloadSignal`-Auto-Reload (AC4) und PR-Bezug (AC5), die erhalten bleiben.
- [[projekt-spezifikation-anzeige]] (`SpecView`, Content-Pane, `docs/raw`-API, `MarkdownLite`).
