/**
 * CostModeDriftNotice.jsx — nicht-modale Drift-Meldung + Vorher/Nachher-Übersicht
 * für die Cost-Mode-Modellprüfung beim Dispatch (docs/specs/cost-mode-model-check.md
 * AC4/AC5 — Frontend-Anteil, S-228).
 *
 * Wird eingeblendet, wenn ein Board-/Flow-Dispatch (manueller „Board abarbeiten"-
 * Knopf) eine Drift erkannt hat und dazu eine `checkId` geliefert hat (das
 * POST /api/projects/:slug/drain-Feld `costModeCheckId`). Die Komponente pollt
 * den Status-Endpunkt (GET /api/cost-mode/check/:checkId, S-211) und zeigt:
 *   - während der Curator läuft: die kurze Meldung „Modell veraltet — wird
 *     aufgefrischt" (NICHT-modal, blockiert nichts, AC5).
 *   - nach Abschluss mit Änderung: eine Vorher/Nachher-Übersicht (bisheriges
 *     `last_curated`-Signal vs. neues) plus die grobe GUI-lokale Tier-/Modell-
 *     Orientierung aus `COST_MODE_INFO` (die maßgebliche Matrix lebt in
 *     agent-flow, A2 — hier nur Anzeige-Orientierung).
 *   - nach Abschluss ohne Änderung: „bereits aktuell — keine Änderung"; die
 *     „veraltet"-Meldung wird damit aufgelöst (AC3-Analogon).
 *   - bei Fehlschlag/verlorenem Job: „Auffrischen fehlgeschlagen" bzw. still
 *     ausgeblendet — nie blockierend (AC5).
 *
 * NICHT-BLOCKIEREND (AC5): rein additive, begleitende Anzeige. Der Drain läuft
 * unabhängig weiter — diese Komponente steuert ihn nicht und wartet auf nichts.
 *
 * A11y (WCAG 2.1 AA): role=status + aria-live=polite; die Bedeutung wird immer
 * TEXTLICH getragen (nicht nur über Farbe); KEIN dangerouslySetInnerHTML; keine
 * Secrets (`before`/`after` enthalten nur das nicht-geheime `last_curated`-Datum).
 *
 * Poll-Robustheit (coder-Lesson 2026-07-01): ein Nicht-200 (z.B. 404 nach
 * Registry-Verlust/Server-Neustart) wird NICHT wie „noch running" behandelt —
 * der Loop stoppt dann (kein endloses stilles Pollen) und blendet die Meldung aus.
 *
 * @param {{
 *   checkId: string,
 *   fetchFn?: typeof fetch,
 *   pollIntervalMs?: number,
 *   maxPolls?: number,
 * }} props
 */

import { useState, useEffect } from 'react';
import { COST_MODES, COST_MODE_INFO } from './costMode.js';

/** Default Poll-Abstand (ms). */
const DEFAULT_POLL_INTERVAL_MS = 3000;
/** Sicherheits-Cap gegen endloses Pollen (der Curator terminiert normal von selbst). */
const DEFAULT_MAX_POLLS = 60;

/**
 * @param {string|null|undefined} lastCurated
 * @returns {string}  anzeigbares Datum oder „unbekannt".
 */
function fmtCurated(lastCurated) {
  return typeof lastCurated === 'string' && lastCurated ? lastCurated : 'unbekannt';
}

export function CostModeDriftNotice({
  checkId,
  fetchFn,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}) {
  // 'running' | 'done' | 'failed' | 'gone'
  const [phase, setPhase] = useState('running');
  const [result, setResult] = useState(null); // { changed?, before?, after? } aus dem Job-Status

  useEffect(() => {
    if (!checkId) return undefined;
    // Bei einem NEUEN checkId frisch mit der „läuft…"-Meldung starten.
    setPhase('running');
    setResult(null);

    let cancelled = false;
    let timer = null;
    let polls = 0;
    const fn = fetchFn ?? globalThis.fetch.bind(globalThis);

    async function poll() {
      polls += 1;
      let res;
      try {
        res = await fn(`/api/cost-mode/check/${encodeURIComponent(checkId)}`);
      } catch {
        // Netzwerkfehler → einmal später erneut versuchen (bis maxPolls).
        schedule();
        return;
      }
      if (cancelled) return;

      // coder-Lesson: 404/Nicht-200 NICHT wie „running" behandeln — sonst endlos.
      if (!res.ok || res.status !== 200) {
        setPhase('gone');
        return;
      }

      let data;
      try {
        data = await res.json();
      } catch {
        setPhase('gone');
        return;
      }
      if (cancelled) return;

      const status = data?.status;
      if (status === 'done') {
        setResult({ changed: data.changed === true, before: data.before, after: data.after });
        setPhase('done');
        return;
      }
      if (status === 'failed') {
        setPhase('failed');
        return;
      }
      if (status === 'running') {
        schedule();
        return;
      }
      // Unbekannter/fehlender Status → nicht endlos pollen (Lesson).
      setPhase('gone');
    }

    function schedule() {
      if (cancelled) return;
      if (polls >= maxPolls) {
        // Sicherheits-Cap: der Job wurde nie terminal — Meldung ausblenden statt spinnen.
        setPhase('gone');
        return;
      }
      timer = setTimeout(poll, pollIntervalMs);
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkId, fetchFn, pollIntervalMs, maxPolls]);

  if (!checkId || phase === 'gone') return null;

  if (phase === 'running') {
    return (
      <div
        role="status"
        aria-live="polite"
        style={styles.running}
        data-testid="cost-mode-drift-notice"
      >
        Modell veraltet — Cost-Mode-Zuordnung wird aufgefrischt…
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div
        role="status"
        aria-live="polite"
        style={styles.failed}
        data-testid="cost-mode-drift-notice"
      >
        Auffrischen der Cost-Mode-Zuordnung fehlgeschlagen — der Vorgang läuft trotzdem weiter.
      </div>
    );
  }

  // phase === 'done'
  const changed = result?.changed === true;
  const beforeCurated = fmtCurated(result?.before?.lastCurated);
  const afterCurated = fmtCurated(result?.after?.lastCurated);

  return (
    <div
      role="status"
      aria-live="polite"
      style={styles.done}
      data-testid="cost-mode-drift-notice"
    >
      <div style={styles.doneHeadline}>
        {changed
          ? 'Cost-Mode-Zuordnung aufgefrischt.'
          : 'Cost-Mode-Zuordnung bereits aktuell — keine Änderung.'}
      </div>

      <div style={styles.beforeAfter} data-testid="cost-mode-drift-beforeafter">
        Modell-Stand bisher: <strong>{beforeCurated}</strong> → neu: <strong>{afterCurated}</strong>
      </div>

      <div style={styles.overviewLabel}>
        Grobe GUI-Orientierung (maßgebliche Matrix in agent-flow):
      </div>
      <ul style={styles.overviewList}>
        {COST_MODES.map((mode) => (
          <li key={mode} style={styles.overviewItem}>
            <span style={styles.overviewMode}>{mode}</span>: {COST_MODE_INFO[mode]?.models ?? '—'}
          </li>
        ))}
      </ul>
    </div>
  );
}

const styles = {
  running: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 10px',
    borderRadius: 8,
    background: '#1e293b',
    border: '1px solid #b45309',
    color: '#fcd34d',
  },
  failed: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 10px',
    borderRadius: 8,
    background: '#1e293b',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
  },
  done: {
    marginTop: 8,
    fontSize: 12,
    padding: '8px 10px',
    borderRadius: 8,
    background: '#0d1a0d',
    border: '1px solid #166534',
    color: '#d1fae5',
  },
  doneHeadline: {
    fontWeight: 700,
    marginBottom: 4,
  },
  beforeAfter: {
    marginBottom: 6,
  },
  overviewLabel: {
    fontWeight: 600,
    marginBottom: 2,
    color: '#a7f3d0',
  },
  overviewList: {
    margin: 0,
    paddingLeft: 16,
  },
  overviewItem: {
    lineHeight: 1.5,
  },
  overviewMode: {
    fontWeight: 600,
  },
};
