---
id: team-detail-scroll
title: Team-Ansicht — Detail-Pane scrollbar (UX-Bugfix)
status: draft
version: 1
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
4. Die Ursache (Befund): Im Flex-Layout (`styles.layout` mit `flexWrap:'wrap'`, `styles.main` mit `overflow:'hidden'`) wird die Höhe der Detail-Spalte im überlaufenden/gewrappten Zustand nicht begrenzt; `styles.detail` hat zwar `overflowY:'auto'`, aber ohne eine durchgängige Höhenbegrenzung (typischerweise fehlendes `minHeight:0` an der Flex-Kette) greift `overflowY` nicht und der Inhalt wächst über den sichtbaren Bereich hinaus statt zu scrollen. Die Lösung stellt die Höhenbegrenzung über die gesamte Flex-Kette sicher, sodass `overflowY:'auto'` am Detail-Pane wirksam wird.

## Acceptance-Kriterien
- **AC1** — Wird im Detail-Pane ein Inhalt gerendert, der höher ist als der verfügbare vertikale Raum, ist der Detail-Pane scrollbar und der **gesamte** Inhalt (inkl. der letzten Zeile/des letzten Blocks) ist durch Scrollen erreichbar; es bleibt **kein** Inhalt unten dauerhaft unerreichbar abgeschnitten.
- **AC2** — Das Scroll-Verhalten gilt **sowohl** im zweispaltigen Desktop-Layout **als auch** im schmalen/gestapelten (gewrappten) Layout. In beiden Zuständen ist der vollständige Detail-Inhalt erreichbar.
- **AC3** — Die bestehende Höhenbegrenzung der Flex-Kette wird so ergänzt, dass `overflowY:'auto'` am Detail-Pane wirksam wird (Befund: durchgängige Höhenbegrenzung / `minHeight:0` an den überlaufenden Flex-Kindern statt unbegrenztem Wachstum). Die Korrektur erfolgt über Layout-/Style-Eigenschaften, nicht durch Entfernen von Inhalt.
- **AC4** (keine Regression) — Die Master-Navigationsliste bleibt sichtbar und nutzbar; läuft sie selbst über, bleibt sie ebenfalls scrollbar. Das zweispaltige Desktop-Layout und der gestapelte Schmal-Zustand aus [[team-view-frontend]] AC9 bleiben erhalten.
- **AC5** (keine Regression) — Alle übrigen Verhaltens-/A11y-Eigenschaften der Team-Ansicht ([[team-view-frontend]] AC1–AC10, insbesondere sichtbare Fokusringe / **kein** `outline:none`, `aria-current`, Tastaturbedienung, Touch-Targets ≥ 44 px) bleiben unverändert erfüllt.

## Verträge
- **`client/src/TeamView.jsx`** — betrifft ausschließlich das `styles`-Objekt (Layout-/Overflow-Eigenschaften der Flex-Kette `main` → `layout` → `nav`/`detail`). Es werden **keine** API-Verträge, Endpunkte oder Daten-Shapes geändert (rein clientseitiger Layout-Fix).
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
