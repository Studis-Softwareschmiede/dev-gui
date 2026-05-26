---
id: <feature-slug>          # stabile Spec-ID, kebab-case, z.B. "user-login"
title: <Feature-Titel>
status: draft               # draft | active | superseded
version: 1
---

# Spec: <Feature-Titel>  (`<feature-slug>`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
<1–2 Sätze: was dieses Feature leistet und warum.>

## Verhalten
<Funktionale Regeln / Szenarien (Given–When–Then oder nummerierte Regeln). Beschreibt beobachtbares Verhalten, nicht die Implementierung.>

## Acceptance-Kriterien
<Nummeriert, **testbar** — der Vertrag für `coder` + `tester`. Board-Items referenzieren diese Nummern (z.B. „implements AC1–AC3").>

- **AC1** — <überprüfbare Bedingung>
- **AC2** — <…>

## Verträge
<Inputs/Outputs · API-Endpunkte (Methode, Pfad, Request/Response) · Daten-Schema/Felder. Sprach-neutral.>

## Edge-Cases & Fehlerverhalten
<Grenzfälle, Fehlerpfade, erwartete Fehler-/Statuscodes.>

## NFRs
<Feature-spezifische nicht-funktionale Anforderungen (Performance/Security/A11y), soweit relevant.>

## Nicht-Ziele
<bewusst ausgeschlossen.>

## Abhängigkeiten
<andere Specs (`[[feature-slug]]`) / externe Dienste.>
