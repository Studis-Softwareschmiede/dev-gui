/**
 * stackValidation — gemeinsame Validierungslogik für Stack-Namen und relative Pfade.
 *
 * Einzige Quelle der Wahrheit (Single Source of Truth) für:
 *   - isValidStackName  — Stack-Namen-Validierung inkl. einheitlichem Längenlimit (64)
 *   - isValidRelativePath — Path-Traversal-Defense für relative Dateipfade
 *
 * Consumer: StackRegistry.js, VpsComposeControl.js
 *
 * Hintergrund (I1, stack-deploy-orchestration Iteration 2):
 *   Beide Module hatten identische Implementierungen dieser Funktionen, aber mit
 *   divergierendem Längenlimit für stackName (StackRegistry: 64, VpsComposeControl: unbegrenzt).
 *   Durch Extraktion in dieses Modul gibt es exakt eine Implementierung — Divergenz-Risiko
 *   beim Zusammenführen in Item C eliminiert.
 *
 * @module validation/stackValidation
 */

/** Maximale Länge eines Stack-Namens (einheitlich für Registry und Compose-Control). */
export const MAX_STACK_NAME_LEN = 64;

/** Erlaubte Zeichen für Stack-Namen: alphanumerisch, Bindestriche, Unterstriche. */
const STACK_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validiert einen Stack-Namen gegen Path-Traversal + Shell-Metazeichen + Längenlimit.
 *
 * Regeln:
 *   - Pflichtfeld, darf nicht leer sein
 *   - max. MAX_STACK_NAME_LEN (64) Zeichen
 *   - nur alphanumerische Zeichen, Bindestriche und Unterstriche (kein .., kein /, keine Shell-Metazeichen)
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidStackName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > MAX_STACK_NAME_LEN) return false;
  return STACK_NAME_RE.test(name);
}

/**
 * Validiert einen relativen Dateipfad (kein absoluter Pfad, keine ..-Segmente).
 * Path-Traversal-Defense-in-Depth.
 *
 * Regeln:
 *   - String, nicht leer
 *   - kein führendes / oder ~
 *   - kein ..-Segment in irgendeiner Position
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isValidRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('~')) return false;
  return p.split('/').every((seg) => seg !== '..');
}
