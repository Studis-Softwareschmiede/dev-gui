/**
 * featureStatus.test.js — geteilte Test-Vektor-Tabelle für die EINE, dependency-
 * freie `computeFeatureStatus`-Pure-Funktion (board-filter-feature-status-
 * consistency AC3, S-241).
 *
 * Covers (board-filter-feature-status-consistency):
 *   AC3 — Eine logische Regel-Quelle (Drift-Gate): `src/featureStatus.js` ist die
 *          EINZIGE Definition; `src/BoardAggregator.js` importiert + re-exportiert
 *          sie unverändert (kein Duplikat). Dieser Test belegt (a) via
 *          Referenz-Identität, dass BEIDE Import-Pfade (`../src/featureStatus.js`
 *          direkt und `../src/BoardAggregator.js` re-export) exakt dieselbe
 *          Funktion liefern (keine zwei Implementierungen, die nur zufällig
 *          übereinstimmen), und (b) via einer geteilten Test-Vektor-Tabelle, dass
 *          diese eine Funktion für dieselbe Story-Menge das laut Vertrag
 *          erwartete Ergebnis liefert (Idee-Ausschluss, Blocked-Prio, jede
 *          weakest-wins-Stufe, Backlog-Default, unbekannter Status, Verworfen).
 *          Die client-seitige Verwendung derselben Funktion (AC1/AC2) wird
 *          zusätzlich integrationsnah in client/src/__tests__/BoardView.test.jsx
 *          (Badge-Rendering aus gefilterten Stories) geprüft.
 *
 * Strategy: reine Funktions-Tests, kein Filesystem/Netzwerk nötig.
 */

import { describe, it, expect } from '@jest/globals';
import { computeFeatureStatus as computeFeatureStatusDirect } from '../src/featureStatus.js';
import { computeFeatureStatus as computeFeatureStatusReExport } from '../src/BoardAggregator.js';

function story(status) {
  return { status };
}

describe('featureStatus — EINE geteilte Regel-Quelle (AC3)', () => {
  it('src/BoardAggregator.js re-exportiert exakt dieselbe Funktionsreferenz wie src/featureStatus.js (kein Duplikat)', () => {
    expect(computeFeatureStatusReExport).toBe(computeFeatureStatusDirect);
  });

  // Geteilte Test-Vektor-Tabelle (AC3): Idee-Ausschluss, Blocked-Prio, jede
  // weakest-wins-Stufe, Backlog-Default, unbekannter Status, Verworfen. Wird
  // gegen BEIDE Import-Pfade geprüft — da es EINE Funktion ist, muss jedes
  // Ergebnis für beide Referenzen identisch sein.
  const vectors = [
    { name: 'leere Story-Liste -> Backlog', stories: [], expected: 'Backlog' },
    { name: 'undefined -> Backlog (defensiv)', stories: undefined, expected: 'Backlog' },
    { name: 'null -> Backlog (defensiv)', stories: null, expected: 'Backlog' },
    { name: 'nur Idee-Stories -> Backlog (V1 Idee-Ausschluss + V4 Default)', stories: [story('Idee'), story('Idee')], expected: 'Backlog' },
    { name: 'Idee + Done -> Done (Idee ausgeschlossen)', stories: [story('Idee'), story('Done')], expected: 'Done' },
    { name: 'To Do + Blocked + Done -> Blocked (V2 höchste Prio)', stories: [story('To Do'), story('Blocked'), story('Done')], expected: 'Blocked' },
    { name: 'Idee + Blocked + Done -> Blocked (Blocked überlebt Idee-Ausschluss)', stories: [story('Idee'), story('Blocked'), story('Done')], expected: 'Blocked' },
    { name: 'weakest-wins: To Do gewinnt gegen In Progress/Done', stories: [story('To Do'), story('In Progress'), story('Done')], expected: 'To Do' },
    { name: 'weakest-wins: In Progress gewinnt gegen In Review/Done', stories: [story('In Progress'), story('In Review'), story('Done')], expected: 'In Progress' },
    { name: 'weakest-wins: In Review gewinnt gegen Done', stories: [story('In Review'), story('Done')], expected: 'In Review' },
    { name: 'weakest-wins: nur Done -> Done', stories: [story('Done'), story('Done')], expected: 'Done' },
    { name: 'unbekannter Status zählt als To Do (V6)', stories: [story('Frobnicating'), story('Done')], expected: 'To Do' },
    { name: 'fehlender Status (null) zählt als To Do (V6)', stories: [story(null), story('Done')], expected: 'To Do' },
    { name: 'Verworfen zählt als Done-äquivalent (V7), Ergebnis-Label bleibt Done', stories: [story('Verworfen'), story('Verworfen')], expected: 'Done' },
    { name: 'Verworfen + To Do -> To Do (Verworfen terminal, überschreibt nicht die schwächere Stufe)', stories: [story('To Do'), story('Verworfen')], expected: 'To Do' },
    { name: 'Verworfen + Blocked -> Blocked (Blocked-Prio bleibt höchste Stufe)', stories: [story('Blocked'), story('Verworfen')], expected: 'Blocked' },
  ];

  for (const v of vectors) {
    it(`(direkt) ${v.name}`, () => {
      expect(computeFeatureStatusDirect(v.stories)).toBe(v.expected);
    });
    it(`(re-export) ${v.name}`, () => {
      expect(computeFeatureStatusReExport(v.stories)).toBe(v.expected);
    });
  }
});
