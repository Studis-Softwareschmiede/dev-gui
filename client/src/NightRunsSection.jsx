/**
 * NightRunsSection.jsx — Nacht-Läufe-Sektion (drain-completion-report AC7b).
 *
 * Eigenständige, additive Komponente für die Fabrik-Übersicht (RepoOverview.jsx —
 * „Fabrik — Projekt wählen"), direkt bei der bestehenden Nachtwächter-
 * Statusanzeige (`NightWatchStatusBadge`, taktgeber-nachtwaechter AC17). Zeigt
 * die letzten Drain-Abschlussberichte des Nachtwächters (`trigger:'night'`),
 * damit der Owner morgens sieht, was nachts erledigt wurde.
 *
 * Datenquelle: `GET /api/drain-reports` (drain-completion-report AC4) —
 * unfiltert (alle Projekte, absteigend nach `finishedAt`); hier client-seitig
 * auf `trigger === 'night'` gefiltert (manuelle Läufe erscheinen bereits
 * INLINE am „Board abarbeiten"-Knopf, CockpitView.jsx AC7a — keine Dopplung
 * hier).
 *
 * Je Bericht: Projekt, Zeitpunkt (`finishedAt`, lokal formatiert),
 * „X erledigt / Y blockiert" (IMMER textlich, WCAG 2.1 AA — nie nur Farbe),
 * aufklappbare Story-Liste (`<details>`, ID + Titel). Leere Liste dezent
 * (kurzer Hinweistext statt leerer Fläche).
 *
 * night-budget-guard AC13 (Bericht-Anzeige):
 *   Je Bericht wird zusätzlich `report.budgetPauses` (`{from,to,reason}[]`,
 *   docs/specs/night-budget-guard.md AC12) textlich gerendert — von/bis
 *   (lokal formatiert; `to === null` → „Nacht-Ende") + Grund
 *   (`reactive-limit` → „Session-Limit erreicht", `proactive-threshold` →
 *   „Budget-Schwelle erreicht"). Ein leeres/fehlendes Array (Alt-Berichte vor
 *   S-275) → nichts gerendert (dezent, kein leerer Block). NICHT unit-testbar
 *   ist die reale Zeitzonen-Formatierung (`toLocaleString`, jsdom-Umgebungs-
 *   abhängig) — verifiziert über feste Textteile statt exaktem Format.
 *
 * Graceful degradation: bei Netzwerkfehler oder unerwarteter Antwortform
 * bleibt die Sektion unsichtbar (kein Crash, kein irreführender Platzhalter) —
 * analog `NightWatchStatusBadge.jsx`.
 *
 * Security (Floor): keine Secrets — DrainReportStore hält ausschließlich
 * Slug + Story-ID/Titel + Zähler + Budget-Pausen-Zeitstempel/Grund (s.
 * src/DrainReportStore.js).
 *
 * A11y: <section aria-label>, Zahlen/Status textlich, <details>/<summary>
 * nativ tastaturbedienbar, Touch-Targets ≥ 44px wo interaktiv.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useCallback } from 'react';

async function fetchDrainReports(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/drain-reports');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {string|null|undefined} iso
 * @returns {string}  lokal formatierter Zeitpunkt, oder '—' bei ungültigem Wert
 */
function formatWhen(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/**
 * night-budget-guard AC12/AC13: `budgetPauses[].from`/`.to` sind Epoch-ms
 * (kein ISO-String, s. DrainReportStore-Schema) — eigener Formatter.
 *
 * @param {unknown} ms
 * @returns {string}  lokal formatierter Zeitpunkt, oder '—' bei ungültigem Wert
 */
function formatPauseMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/**
 * night-budget-guard AC13: textliche Übersetzung des Budget-Pausen-Grunds
 * (nie nur ein Code, WCAG 2.1 AA — Zahlen/Status immer textlich).
 *
 * @param {unknown} reason
 * @returns {string}
 */
function formatPauseReason(reason) {
  if (reason === 'reactive-limit') return 'Session-Limit erreicht';
  if (reason === 'proactive-threshold') return 'Budget-Schwelle erreicht';
  return typeof reason === 'string' && reason ? reason : '—';
}

export function NightRunsSection({ fetchFn }) {
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [reports, setReports] = useState([]);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const data = await fetchDrainReports(fetchFn);
      const list = Array.isArray(data?.reports) ? data.reports : [];
      // Nacht-Läufe-Sektion: nur trigger:'night' — manuelle Läufe stehen
      // bereits inline am „Board abarbeiten"-Knopf (AC7a, keine Dopplung).
      setReports(list.filter((r) => r && r.trigger === 'night'));
      setLoadState('ok');
    } catch {
      // Netzwerkfehler/unerwartete Form → Sektion bleibt unsichtbar (defensiv).
      setLoadState('error');
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadState !== 'ok') return null;

  return (
    <section style={styles.section} aria-label="Nacht-Läufe">
      <h2 style={styles.heading}>Nacht-Läufe</h2>
      {reports.length === 0 ? (
        <p style={styles.empty} data-testid="night-runs-empty">
          Noch keine Nacht-Läufe abgeschlossen.
        </p>
      ) : (
        <ul style={styles.list} role="list" aria-label="Letzte Nacht-Läufe" data-testid="night-runs-list">
          {reports.map((r) => (
            <NightRunItem key={r.reportId ?? `${r.project}-${r.finishedAt}`} report={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * @param {{ report: {
 *   reportId?: string, project?: string, finishedAt?: string,
 *   completed?: Array<{id:string,title:string}>,
 *   blocked?: Array<{id:string,title:string}>,
 *   budgetPauses?: Array<{from:number,to:number|null,reason:string}>,
 * } }} props
 */
function NightRunItem({ report }) {
  const completed = Array.isArray(report?.completed) ? report.completed : [];
  const blocked = Array.isArray(report?.blocked) ? report.blocked : [];
  // night-budget-guard AC12/AC13: fehlendes Feld (Alt-Berichte) → [] (kein Crash).
  const budgetPauses = Array.isArray(report?.budgetPauses) ? report.budgetPauses : [];
  const project = typeof report?.project === 'string' && report.project ? report.project : '—';
  const when = formatWhen(report?.finishedAt);
  const summary = `${completed.length} erledigt / ${blocked.length} blockiert`;

  return (
    <li style={styles.item} data-testid="night-run-item">
      <div style={styles.itemHeader}>
        <span style={styles.itemProject}>{project}</span>
        <span style={styles.itemWhen}>{when}</span>
        <span style={styles.itemSummary}>{summary}</span>
      </div>
      {(completed.length > 0 || blocked.length > 0) && (
        <details style={styles.details} data-testid="night-run-details">
          <summary style={styles.summary}>Story-Liste anzeigen</summary>
          <ul style={styles.storyList}>
            {completed.map((s) => (
              <li key={`done-${s?.id}`}>✓ {s?.id} — {s?.title || '—'}</li>
            ))}
            {blocked.map((s) => (
              <li key={`blocked-${s?.id}`}>✗ {s?.id} — {s?.title || '—'}</li>
            ))}
          </ul>
        </details>
      )}
      {/* night-budget-guard AC13: Budget-Pausen textlich, leeres Array → nichts (dezent). */}
      {budgetPauses.length > 0 && (
        <div style={styles.budgetPauses} data-testid="night-run-budget-pauses">
          <span style={styles.budgetPausesLabel}>Budget-Pausen:</span>
          <ul style={styles.budgetPauseList}>
            {budgetPauses.map((p, i) => (
              <li key={i}>
                {formatPauseMs(p?.from)} – {typeof p?.to === 'number' ? formatPauseMs(p.to) : 'Nacht-Ende'}
                {' — '}
                {formatPauseReason(p?.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  section: {
    width: '100%',
    padding: '8px 16px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  heading: {
    fontSize: 12,
    fontWeight: 700,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: 0,
  },

  empty: {
    // #6b7280 on #0d0d0d ≈ 5.1:1 — WCAG AA (dezent, aber lesbar)
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
    margin: 0,
  },

  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  item: {
    fontSize: 12,
    color: '#d1d5db',
    border: '1px solid #1e293b',
    borderRadius: 4,
    padding: '6px 8px',
  },

  itemHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'baseline',
  },

  itemProject: {
    fontFamily: 'monospace',
    fontWeight: 700,
    color: '#e5e7eb',
  },

  itemWhen: {
    fontSize: 11,
    color: '#9ca3af',
  },

  itemSummary: {
    fontSize: 11,
    color: '#93c5fd',
  },

  details: {
    marginTop: 4,
    fontSize: 11,
  },

  summary: {
    color: '#93c5fd',
    cursor: 'pointer',
    minHeight: 24,
  },

  storyList: {
    margin: '4px 0 0',
    paddingLeft: 18,
    color: '#9ca3af',
    lineHeight: 1.6,
  },

  budgetPauses: {
    marginTop: 4,
    fontSize: 11,
  },

  budgetPausesLabel: {
    color: '#fbbf24',
    fontWeight: 700,
  },

  budgetPauseList: {
    margin: '4px 0 0',
    paddingLeft: 18,
    color: '#9ca3af',
    lineHeight: 1.6,
  },
};
