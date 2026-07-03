---
id: spec-bereich-filter
title: Spezifikation-Reiter — Bereichs-Filter über das Spec-Frontmatter-Feld area
status: active
area: spezifikation
version: 1
---

# Spec: Spezifikation-Reiter — Bereichs-Filter  (`spec-bereich-filter`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).
>
> **Erweitert [[projekt-spezifikation-anzeige]]** (Reiter „Spezifikation", `DocsReader`, Filter V5/AC6) um einen **Bereichs-Filter**.

## Zweck
Der Spezifikation-Reiter ([[projekt-spezifikation-anzeige]]) listet je Projekt alle Specs. Mit den **Bereichs-Features** ([[bereichs-modell]]) tragen Specs künftig ein `area`-Frontmatter-Feld (gestempelt durch [[bereichs-migration-dev-gui]] bzw. bei Neuanlage). Diese Spec ergänzt einen **Bereichs-Filter**, der die Spec-Liste nach diesem `area`-Feld einschränkt — passend zur Board-Strukturkarte, damit man „alle Specs eines Bereichs" sieht.

> **Schema-Herkunft (textueller Verweis, kein depends).** Das `area`-Frontmatter auf Specs wird durch die **agent-flow-Schema-Specs zu Bereichs-Features (Repo agent-flow)** definiert. dev-gui **liest** es (`DocsReader`) und **filtert** darauf; es definiert das Feld nicht neu.

## Verhalten

### V1 — `DocsReader` liest `area` aus dem Spec-Frontmatter
Der bestehende `DocsReader` ([[projekt-spezifikation-anzeige]] V1) parst beim Einlesen jeder Spec zusätzlich das Frontmatter-Feld **`area`** und reicht es in der Doku-Struktur je Spec durch (`area?: <area-id>`). Fehlt das Feld (nicht gestempelte Spec) → `area: null`/undefined (kein Crash), die Spec gilt als „bereichslos".

### V2 — Bereichs-Filter im Spezifikation-Reiter (Frontend)
Der Filterbereich des Spezifikation-Reiters ([[projekt-spezifikation-anzeige]] V5) erhält zusätzlich zum bestehenden Doku-Typ- und Spec-Status-Filter einen **Bereichs-Filter**: eine Mehrfachauswahl der Bereiche (Werte + Labels aus `GET …/areas`, [[bereichs-modell]] V6, sortiert nach `order`) **plus** eine Option **„ohne Bereich"** für Specs ohne `area`. Ist mindestens ein Bereich gewählt, werden nur Specs mit passendem `area` (bzw. bereichslose bei „ohne Bereich") angezeigt; ist nichts gewählt, gelten alle Bereiche (kein Filter). Der Bereichs-Filter kombiniert konjunktiv mit den bestehenden Filtern (Muster wie der Board-Filter/[[projekt-spezifikation-anzeige]] V5).

### V3 — Degradation ohne Bereiche
Sind keine Bereiche vorhanden (leere `areas.yaml`) oder trägt keine Spec ein `area` → der Bereichs-Filter zeigt (nur) „ohne Bereich" bzw. wird leer/ausgeblendet dargestellt; die bestehende Spec-Liste + die übrigen Filter funktionieren unverändert (kein Crash, kein leerer Reiter).

## Acceptance-Kriterien

- **AC1** — `DocsReader` parst je Spec das Frontmatter-Feld `area` und reicht es in der Doku-Struktur durch (`area?`); fehlt es, ist der Wert null/undefined (Spec „bereichslos"), kein Crash. *(V1)*
- **AC2** — Der Spezifikation-Reiter zeigt einen **Bereichs-Filter** (Mehrfachauswahl aus `GET …/areas`, sortiert nach `order`, plus „ohne Bereich"); Auswahl schränkt die Spec-Liste auf passende `area`-Werte ein; leere Auswahl = alle Bereiche; konjunktive Kombination mit Doku-Typ- und Spec-Status-Filter ([[projekt-spezifikation-anzeige]] V5). *(V2)*
- **AC3** — Degradation: ohne Bereiche/`area`-Frontmatter bleibt der Reiter voll funktionsfähig (Bereichs-Filter zeigt nur „ohne Bereich" bzw. ist leer/ausgeblendet), die bestehende Liste + übrige Filter funktionieren unverändert. *(V3)*
- **AC4** — A11y/Sicherheit: der Bereichs-Filter folgt dem bestehenden Filter-Muster (echte Bedienelemente, sprechende `aria-label`, tastaturbedienbar, nicht nur Farbe); read-only (keine Spec-Mutation); keine Secrets in Ausgabe/Log; `area`-Wert sanitisiert dargestellt. *(V1–V3)*

## Verträge

- **`GET /api/board/projects/:slug/docs`** (aus [[projekt-spezifikation-anzeige]]) — je Spec zusätzlich `area?: <area-id>` in der Struktur.
- **`GET /api/board/projects/:slug/areas`** (aus [[bereichs-modell]]) — Bereichsliste (Werte/Labels/Reihenfolge) für den Filter.
- **Spec-Frontmatter (konsumiert, additiv):** `area: <area-id>` (optional). Fehlt es → bereichslos.

## Edge-Cases & Fehlerverhalten
- **Spec ohne `area`** → erscheint unter „ohne Bereich", nicht unter einem konkreten Bereich.
- **`area`-Wert verweist auf einen nicht (mehr) existenten Bereich** → die Spec wird unter diesem (unbekannten) Wert gruppiert bzw. als „ohne Bereich" behandelt (kein Crash); der Filter zeigt bekannte Bereiche + ggf. „ohne Bereich".
- **Leere `areas.yaml`** → nur „ohne Bereich" verfügbar (V3).

## NFRs
- **Security (Floor):** read-only; keine Spec-Mutation aus der GUI; `area`-Wert sanitisiert; keine Secrets.
- **A11y:** konsistent mit dem bestehenden Filter-Muster ([[projekt-spezifikation-anzeige]] V5/[[studis-kanban-board-ux]]).

## Nicht-Ziele
- **Schreiben/Ändern** des `area`-Frontmatters aus der GUI (Stempeln macht [[bereichs-migration-dev-gui]]/`requirement`; Reiter ist read-only).
- **Neu-Definition** des `area`-Frontmatters (agent-flow-Schema).
- **Volltextsuche** (bleibt Nicht-Ziel aus [[projekt-spezifikation-anzeige]]).

## Abhängigkeiten
- [[projekt-spezifikation-anzeige]] (Reiter, `DocsReader`, Filter V5) · [[bereichs-modell]] (`GET …/areas`) · [[bereichs-migration-dev-gui]] (stempelt das `area`-Frontmatter der Bestands-Specs).
- **dev-gui:** `src/DocsReader.js` (`area` parsen), `client/src/BoardView.jsx`/`SpecView.jsx` (Bereichs-Filter im Reiter).
- **agent-flow (textueller Verweis, kein depends):** Schema-Specs zum `area`-Frontmatter (Repo agent-flow).
