---
id: team-detail-scroll
title: Team-Ansicht — Detail-Pane scrollbar (UX-Bugfix)
status: draft
version: 2
---

# Spec: Team-Ansicht — Detail-Pane scrollbar (`team-detail-scroll`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Behebt einen UX-Bug der Team-Ansicht ([[team-view-frontend]]): Bei langen Inhalten ist im rechten **Detail-Pane** der untere Teil des gerenderten Markdown-Bodys **nicht erreichbar**, weil der überlaufende Inhalt nicht gescrollt werden kann. Ziel: der **gesamte** Detail-Inhalt ist in **allen** Viewport-Breiten (Desktop zweispaltig wie schmal/gestapelt) durch Scrollen erreichbar — ohne die bestehende [[team-view-frontend]]-Funktionalität oder das Layout (zwei Spalten Desktop, gestapelt schmal) zu brechen.

## Verhalten
1. Öffnet der Nutzer einen Eintrag mit einem Markdown-Body, der höher ist als der verfügbare Detail-Bereich, kann er den **gesamten** Inhalt bis zur letzten Zeile durch Scrollen erreichen. Nichts wird unten dauerhaft abgeschnitten.
2. Das gilt im **Desktop-Zustand** (zwei nebeneinanderliegende Spalten: Nav links, Detail rechts) **und** im **schmalen/gestapelten Zustand** (Spalten umgebrochen/untereinander).
3. Die **Master-Navigationsliste** (links/oben) bleibt unabhängig davon nutzbar und — soweit sie selbst überläuft — ebenfalls scrollbar (bestehendes Verhalten, darf nicht regressieren).
4. Die Ursache (verifizierter Befund, v2): `styles.layout` war eine **`flexWrap:'wrap'`-Row**. Eine wrap-Flex-Zeile bemisst ihre **Cross-Size (Höhe) am Inhalt** — das Detail-Pane wuchs damit auf die volle Content-Höhe, und das `overflow:'hidden'` der Kette **schnitt** den Überhang ab, statt `overflowY:'auto'` greifen zu lassen. `minHeight:0` an den Kindern wirkt in einer Row-Flex nur auf die **Breite**, nicht die Höhe — deshalb blieb der frühere v1-Fix (nur `minHeight:0`) in der echten App wirkungslos (browser-gemessen: `flex-wrap` → `scrollHeight == clientHeight`, `canScroll=false`). Die Lösung ersetzt das wrap-Flex durch ein **CSS-Grid** (`display:'grid'`, `gridTemplateColumns: minmax(…) minmax(0,1fr)`): ein Grid-Track ist durch den Container höhenbegrenzt, sodass jede Spalte (Nav/Detail) eine echte Höhengrenze bekommt und mit `overflowY:'auto'` + `minHeight:0` zuverlässig scrollt (browser-gemessen: Grid → `scrollHeight > clientHeight`, `canScroll=true`, Ende erreichbar).

## Acceptance-Kriterien
- **AC1** — Wird im Detail-Pane ein Inhalt gerendert, der höher ist als der verfügbare vertikale Raum, ist der Detail-Pane scrollbar und der **gesamte** Inhalt (inkl. der letzten Zeile/des letzten Blocks) ist durch Scrollen erreichbar; es bleibt **kein** Inhalt unten dauerhaft unerreichbar abgeschnitten.
- **AC2** — Das `styles.layout` ist ein **CSS-Grid** (`display:'grid'`), **nicht** `flexWrap:'wrap'` (Regressions-Schutz: eine wrap-Row bemisst ihre Höhe am Inhalt und macht overflow-Scrolling unmöglich). Das Scroll-Verhalten gilt im zweispaltigen Desktop-Layout; auf schmalen Viewports bleiben die Spalten erhalten und der vollständige Detail-Inhalt bleibt erreichbar.
- **AC3** — Die Höhenkette ist durchgängig geschlossen: `minHeight:0` am Layout-Grid sowie an Nav und Detail (Grid-Items defaulten auf `min-height:auto` = inhaltsbasiert; `minHeight:0` erlaubt das Schrumpfen unter die Content-Höhe), zusammen mit `overflow:'hidden'` an der Kette und `overflowY:'auto'` an Nav/Detail. Die Korrektur erfolgt über Layout-/Style-Eigenschaften, nicht durch Entfernen von Inhalt.
- **AC4** (keine Regression) — Die Master-Navigationsliste bleibt sichtbar und nutzbar; läuft sie selbst über, bleibt sie ebenfalls scrollbar. Das zweispaltige Desktop-Layout aus [[team-view-frontend]] AC9 bleibt erhalten.
- **AC5** (keine Regression) — Alle übrigen Verhaltens-/A11y-Eigenschaften der Team-Ansicht ([[team-view-frontend]] AC1–AC10, insbesondere sichtbare Fokusringe / **kein** `outline:none`, `aria-current`, Tastaturbedienung, Touch-Targets ≥ 44 px) bleiben unverändert erfüllt.
- **AC6** (reale Verifikation — Pflicht) — Da jsdom **keine** Layout-Engine hat, beweisen Style-Property-Assertions allein **nicht**, dass der Inhalt scrollbar ist (genau diese Lücke ließ den v1-Fix als „grün" durchgehen, während die App kaputt war). Der Fix MUSS in einem **echten Browser** (z. B. headless Chrome gegen den gebauten App-Stand) verifiziert werden: am Detail-Pane gilt nach dem Laden eines langen Inhalts `scrollHeight > clientHeight` (`canScroll=true`) **und** nach `scrollTop = max` ist das Inhaltsende erreicht (`endVisible=true`). Die jsdom-Tests dürfen die Style-Eigenschaften prüfen, ersetzen aber **nicht** diese reale Messung.

## Verträge
- **`client/src/TeamView.jsx`** — betrifft das `styles`-Objekt (Höhenkette `main` → `layout` → `nav`/`detail`; `layout` als CSS-Grid). Es werden **keine** API-Verträge, Endpunkte oder Daten-Shapes geändert (rein clientseitiger Layout-Fix).
- **`client/src/AppShell.jsx`** — `styles.viewPort` erhält `minHeight:0`, damit das Zwischenglied der Höhenkette die scrollbaren Kind-Bereiche nicht über die Shell hinaus wachsen lässt.
- **Kein** neuer Endpunkt, **keine** neue Abhängigkeit, **keine** externe Bibliothek.

## Edge-Cases & Fehlerverhalten
- Sehr langer Body (viele Überschriften/Code-Blöcke) → Detail-Pane scrollt bis zum Ende; Nav bleibt sichtbar (Desktop) bzw. gestapelt (schmal).
- Sehr kurzer Body (kein Überlauf) → kein erzwungener Scrollbalken, kein abgeschnittener Inhalt; Layout unverändert.
- Gleichzeitig lange Nav **und** langer Body → beide Bereiche unabhängig scrollbar, keiner schiebt den anderen aus dem Viewport.
- Schmaler Viewport (gewrappt/gestapelt) → der gesamte (untere) Detail-Inhalt bleibt durch Scrollen erreichbar.

## NFRs
- **A11y:** Scrollbarer Bereich bleibt tastaturzugänglich; sichtbare Fokusringe und alle [[team-view-frontend]]-A11y-Garantien bleiben erhalten (kein `outline:none`).
- **Konsistenz:** Dark-Theme-Styles und Touch-Targets unverändert; reine Layout-Korrektur ohne visuelle Umgestaltung.
- **Sicherheit (Floor):** unberührt — keine neuen Secrets, keine neuen Aufrufe, kein `dangerouslySetInnerHTML`.

## Nicht-Ziele
- **Keine** funktionale Erweiterung des Detail-Panes (das ist [[team-detail-related-refs]]).
- **Keine** Änderung an Backend/Endpunkten/Daten-Shapes.
- **Keine** visuelle Umgestaltung über die Scroll-Korrektur hinaus.

## Abhängigkeiten
- [[team-view-frontend]] (die Team-Ansicht, deren Detail-Pane korrigiert wird) — wird ergänzt, nicht ersetzt.
