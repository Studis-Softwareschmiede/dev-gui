/**
 * DrainAbortRegistry — In-Memory-Registry für kooperative Drain-Abbrüche
 * (docs/specs/drain-stop-control.md AC1, Verträge §DrainAbortRegistry).
 *
 * Hält je aktivem Drain (manuell UND Nacht) `drainId → abortHandle`. Ein
 * `signal(drainId)` markiert den Drain als abzubrechen; `ProjectDrain#runLoop`
 * konsumiert das injizierte Handle (`isAborted()`) am Anfang jeder Runde und
 * beendet sich kooperativ mit `reason: 'aborted'` (AC2 der Spec — KEIN hartes
 * Killen eines laufenden Flow-Kindprozesses, A1).
 *
 * BEWUSST NICHT persistiert (Spec A1/AC1): ein Abbruch gilt nur für den
 * lebenden Prozess — die persistente Spur ist der `aborted`-Status in der
 * `DrainJobRegistry` (drain-restart-robustness AC1). Nach einem Server-
 * Neustart existiert kein Drain-Loop mehr, den man abbrechen könnte.
 *
 * Kein Secret, kein Pfad — Schlüssel sind ausschließlich `drainId`-UUIDs.
 *
 * @module DrainAbortRegistry
 */

/**
 * Erzeugt ein frisches Abort-Handle für einen Drain-Lauf. Das Handle wird
 * (a) unter der `drainId` registriert und (b) als `abortSignal` an
 * `ProjectDrain#drainProject` injiziert.
 *
 * @returns {{ isAborted: () => boolean, abort: () => void }}
 */
export function createAbortHandle() {
  let aborted = false;
  return {
    isAborted: () => aborted,
    abort: () => {
      aborted = true;
    },
  };
}

export class DrainAbortRegistry {
  /** @type {Map<string, { isAborted: () => boolean, abort: () => void }>} */
  #handles = new Map();

  /**
   * Registriert das Abort-Handle eines gestarteten Drains (AC1). Überschreibt
   * einen etwaigen Alt-Eintrag derselben `drainId` (defensiv — `drainId`s
   * sind UUIDs, Kollisionen praktisch ausgeschlossen).
   *
   * @param {string} drainId
   * @param {{ isAborted: () => boolean, abort: () => void }} handle
   */
  register(drainId, handle) {
    if (typeof drainId !== 'string' || drainId === '' || !handle) return;
    this.#handles.set(drainId, handle);
  }

  /**
   * Entfernt den Eintrag bei jedem terminalen Drain-Ende (AC1).
   * @param {string} drainId
   */
  unregister(drainId) {
    this.#handles.delete(drainId);
  }

  /**
   * Markiert den Drain als abzubrechen (AC3). `true` bei Treffer (aktiver
   * Drain), `false` sonst (bereits fertig/unbekannt → Router antwortet 404).
   *
   * @param {string} drainId
   * @returns {boolean}
   */
  signal(drainId) {
    const handle = this.#handles.get(drainId);
    if (!handle) return false;
    try {
      handle.abort();
    } catch {
      return false; // defensives Handle-Verhalten — nie werfen (Robustheits-NFR)
    }
    return true;
  }

  /**
   * Liest den Abbruch-Zustand eines registrierten Drains (Verträge §Registry).
   * @param {string} drainId
   * @returns {boolean}
   */
  isAborted(drainId) {
    const handle = this.#handles.get(drainId);
    if (!handle) return false;
    try {
      return !!handle.isAborted();
    } catch {
      return false;
    }
  }
}
