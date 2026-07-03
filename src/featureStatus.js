/**
 * featureStatus.js — geteilte, dependency-freie Pure-Funktion zur Feature-Status-
 * Ableitung (feature-status-derivation V1–V7).
 *
 * EINE logische Regel-Quelle (Drift-Gate, board-filter-feature-status-consistency
 * AC3): wird SOWOHL von `src/BoardAggregator.js` (server-seitig, über ALLE
 * Kind-Stories eines Features) ALS AUCH von `client/src/BoardView.jsx`
 * (client-seitig, über die aktuell SICHTBARE/gefilterte Story-Menge, AC1) per
 * direktem Cross-Build-Import verwendet.
 *
 * Enthält bewusst KEINE Node-Builtin- (fs/path/os) oder DOM-Imports — reines
 * ESM ohne externe Abhängigkeit — und ist damit unverändert sowohl im
 * Server-Prozess als auch im Vite-Client-Bundle lauffähig (verifiziert per
 * `npm run build`, board-filter-feature-status-consistency AC3: Cross-Build-
 * Import ist hier praktikabel — kein Client-Duplikat nötig).
 *
 * @module featureStatus
 */

/**
 * Weakest-wins Fortschritts-Ordnung: kleinster Index = schwächste Stufe.
 * `Blocked` ist ein Sonderfall mit höchster Priorität (nicht Teil dieser Skala).
 * `Verworfen` ist KEIN eigener Eintrag dieser Skala — er wird auf denselben
 * (terminalen) Index wie `Done` abgebildet (Done-äquivalent, V7).
 * (feature-status-derivation, Vertrag „Ordnungs-Skala").
 */
const FEATURE_STATUS_ORDER = ['To Do', 'In Progress', 'In Review', 'Done'];

/**
 * Derive a feature status live from its child stories (read-only display value).
 * Reine Funktion — kein Filesystem-/Netzwerk-Zugriff, keine Mutation der Eingabe.
 *
 * Ableitungsregel (Priorität von oben nach unten, feature-status-derivation V1–V7):
 *   1. V1 — Stories mit `status: Idee` vollständig ausschließen (noch nicht committet).
 *   2. V2 — bleibt ≥1 verbleibende Story `Blocked` → `Blocked` (höchste Priorität).
 *   3. V3 — sonst schwächste vorkommende Stufe in
 *           To Do < In Progress < In Review < Done (kleinster Index gewinnt);
 *      V6 — unbekannter/fehlender Story-Status zählt als schwächste Stufe `To Do`.
 *      V7 — `Verworfen` zählt NICHT als unbekannt, sondern als Done-äquivalent
 *           (terminal, gleicher Index wie `Done`); Ergebnis-Label bleibt `Done`
 *           (nie `Verworfen`).
 *   4. V4 — keine verbleibende (nicht-Idee-)Story → `Backlog` (Default).
 *
 * @param {Array<{ status: string|null }>} stories
 * @returns {'Backlog'|'To Do'|'In Progress'|'Blocked'|'In Review'|'Done'}
 */
export function computeFeatureStatus(stories) {
  const list = Array.isArray(stories) ? stories : [];
  // V1: Idee-Stories vollständig ausschließen.
  const counted = list.filter((s) => s && s.status !== 'Idee');
  // V4: keine verbleibende zählbare Story → Backlog.
  if (counted.length === 0) return 'Backlog';
  // V2: Blocked gewinnt (höchste Priorität), überschreibt jede andere Ableitung.
  if (counted.some((s) => s.status === 'Blocked')) return 'Blocked';
  // V3 + V6 + V7: schwächste Stufe; unbekannter/fehlender Status → schwächste Stufe
  // (To Do); `Verworfen` → terminale Stufe (Done-äquivalent, V7).
  const doneIdx = FEATURE_STATUS_ORDER.indexOf('Done');
  let minIdx = doneIdx; // Startwert: 'Done' (stärkste Stufe)
  for (const s of counted) {
    let rank;
    if (s.status === 'Verworfen') {
      rank = doneIdx; // V7: Done-äquivalent, terminal
    } else {
      const idx = FEATURE_STATUS_ORDER.indexOf(s.status);
      rank = idx === -1 ? 0 : idx; // unbekannt/fehlend → schwächste Stufe (To Do)
    }
    if (rank < minIdx) minIdx = rank;
  }
  return FEATURE_STATUS_ORDER[minIdx];
}
