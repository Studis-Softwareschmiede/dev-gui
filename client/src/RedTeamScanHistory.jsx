/**
 * RedTeamScanHistory.jsx — „Verlauf"-Aufklapper pro Container (Liste + Detailbericht) +
 * Board-Rückverfolgung (docs/specs/red-team-scan-per-container.md AC14, AC15).
 *
 * Andockpunkt: `VpsView.jsx` `ContainerRow`, neben dem Red-Team-Scan-Knopf (AC10,
 * `RedTeamScanPanel.jsx`) — dieselbe Aufklapper-Konvention wie der bestehende
 * „Container"-Knopf (`aria-expanded`/`aria-controls`, s. `VpsView.jsx`). Sichtbar für
 * JEDEN managed Container (Verlauf ist möglich, sobald mind. ein Scan lief — auch für
 * inzwischen gestoppte Container, s. `ScanResultStore` App-Key = `container.hostname`,
 * NICHT an den laufenden Zustand gekoppelt wie der Scan-Auslöse-Knopf selbst).
 *
 * Covers (red-team-scan-per-container):
 *   AC14 — „Verlauf"-Aufklapper: listet die Läufe des Containers (`GET .../scans`, AC8,
 *          bereits gelandet — S-402) mit Zeitpunkt, Testort, Ampel, Befund-Anzahl+Art,
 *          Bericht-Referenz; Klick auf einen Lauf öffnet den Detailbericht (`GET
 *          .../scans/:scanId`, ebenfalls AC8/S-402).
 *          Präzisierung (S-404, s. auch Spec-Ergänzung docs/specs/red-team-scan-per-container.md):
 *          die kompakte `list()`-Form (S-402, AC8 — bereits vertraglich fixiert UND
 *          getestet: `entry).not.toHaveProperty('reportRef')`, `test/ScanResultStore.test.js`)
 *          liefert WEDER `reportRef` NOCH einen Testort-Wert. Ein Testort-Feld je Zeile
 *          wäre ohnehin redundant — jeder Lauf testet laut AC5 IMMER beide Orte in einem
 *          Job. „Testort" wird deshalb als statischer Text „Direkt + über Cloudflare"
 *          gerendert; „Befund-Anzahl+Art" = `findingCount` + die bereits vorhandene
 *          `ampel`-Kategorie (identisches Vokabular zu AC12, `AMPEL_LABEL`/`AMPEL_STYLE`,
 *          wiederverwendet aus `RedTeamScanPanel.jsx` statt einer zweiten, unabhängig
 *          driftenden Zuordnung — Simplicity-Leiter Stufe 2, coder/R09). „Bericht-Referenz"
 *          ist der Klick-auf-Zeile-Button selbst — er öffnet den Detailbericht (inkl.
 *          `reportRef`-Link, Findings, Ampel) über den bestehenden Detail-Endpunkt. Kein
 *          Backend-Endpunkt/-Feld musste geändert werden (Wiederverwendung der
 *          bestehenden, bereits „Done"/vertraglich fixierten AC8-Endpunkte, S-402).
 *   AC15 — Trägt ein Verlaufseintrag `boardItemIds` (nicht leer), zeigt die Zeile
 *          „daraus wurden N Punkte aufs Board gelegt — Status live vom Board" + je
 *          Board-ID den live gelesenen Status. Live-Lesung OHNE neuen Backend-Endpunkt
 *          (Simplicity-Leiter Stufe 2, coder/R09 — geprüft: ein passender Lese-Pfad
 *          existiert bereits): der `repoSlug` (Board-Projekt-Slug, identisch zu `ziel`
 *          aus AC1) kommt aus dem bereits vorhandenen Detail-Endpunkt (`GET
 *          .../scans/:scanId`, AC8/S-405 — `scan.repoSlug`); der Status je Board-ID kommt
 *          aus dem bereits vorhandenen, read-only `GET /api/board/projects/:slug`
 *          (`src/boardRouter.js`, liefert `features[].stories[].status` — keine eigene
 *          DB, ADR-005-Linie, „live" = jeder Aufklapper-Öffnen-Vorgang liest frisch, kein
 *          Caching über die Komponenten-Lebensdauer hinaus). Best-effort/non-fatal: fehlt
 *          `repoSlug` (älterer/unvollständiger Verlaufseintrag) oder schlägt der
 *          Board-Fetch fehl, zeigt die Zeile die Anzahl weiterhin, aber „Status derzeit
 *          nicht verfügbar" statt zu crashen (Robustheit-NFR der Spec). Board-Projekt-
 *          Fetches werden pro `repoSlug` einmalig gecacht (mehrere Scans desselben
 *          Containers teilen i. d. R. denselben `repoSlug`).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — alle Texte (Titel/Befunde/Status) werden als
 *     reiner React-Text gerendert.
 *   - `reportRef` wird 1:1 vom bereits secret-freien Backend-Contract übernommen (kein
 *     Secret/Token/absoluter Host-Pfad, s. `vpsContainerScanRouter.js` AC22).
 *   - `repoSlug`/Board-`id` werden ausschließlich als Pfad-Segmente in bereits
 *     bestehende, serverseitig validierte Endpunkte eingesetzt — kein Freitext-Schreibpfad.
 *
 * @param {{
 *   provider: string,
 *   serverId: string,
 *   containerId: string,
 *   containerLabel: string,
 *   open: boolean,
 *   fetchFn?: Function,
 * }} props
 *   open — steuert Laden/Rendern; der Aufrufer (`ContainerRow`) hält den Aufklapper-
 *     Zustand selbst (Toggle-Knopf, `aria-expanded`) — analog dem bestehenden
 *     „Container"-Aufklapper-Muster in `VpsView.jsx`.
 *   fetchFn — injectable `fetch` für Tests (default: `globalThis.fetch`).
 */

import { useState, useEffect, useCallback } from 'react';
import { AMPEL_LABEL, AMPEL_STYLE } from './RedTeamScanPanel.jsx';

/**
 * Formatiert einen ISO-8601-Zeitstempel für die Anzeige — fällt bei ungültigem/
 * fehlendem Wert auf den Roh-String zurück (kein Crash, kein "Invalid Date").
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE');
}

export function RedTeamScanHistory({ provider, serverId, containerId, containerLabel, open, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  const [loadState, setLoadState] = useState('idle'); // idle | loading | ok | error
  const [scans, setScans] = useState([]);
  const [expandedScanId, setExpandedScanId] = useState(null);
  const [detailByScanId, setDetailByScanId] = useState({}); // scanId → { loading, error, scan }
  const [boardProjectBySlug, setBoardProjectBySlug] = useState({}); // slug → { loading, error, stories }

  const scansUrl = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}/scans`;
  const scanDetailUrl = useCallback(
    (scanId) => `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/scans/${encodeURIComponent(scanId)}`,
    [provider, serverId],
  );

  // ── AC14 — Verlaufsliste laden, sobald der Aufklapper geöffnet wird ─────────────
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    async function load() {
      setLoadState('loading');
      let res;
      try {
        res = await fetch_(scansUrl);
      } catch {
        if (!cancelled) setLoadState('error');
        return;
      }
      if (cancelled) return;
      if (res.status !== 200) {
        setLoadState('error');
        return;
      }
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (cancelled) return;
      setScans(Array.isArray(data.scans) ? data.scans : []);
      setLoadState('ok');
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scansUrl]);

  // ── AC14 — Detailbericht eines Laufs laden (Klick auf Zeile) — gecacht je scanId ──
  const loadDetail = useCallback(async (scanId) => {
    setDetailByScanId((prev) => ({ ...prev, [scanId]: { ...(prev[scanId] ?? {}), loading: true } }));
    let res;
    try {
      res = await fetch_(scanDetailUrl(scanId));
    } catch {
      setDetailByScanId((prev) => ({ ...prev, [scanId]: { loading: false, error: true, scan: null } }));
      return;
    }
    if (res.status !== 200) {
      setDetailByScanId((prev) => ({ ...prev, [scanId]: { loading: false, error: true, scan: null } }));
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setDetailByScanId((prev) => ({ ...prev, [scanId]: { loading: false, error: false, scan: data.scan ?? null } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanDetailUrl]);

  const handleRowToggle = useCallback((scanId) => {
    setExpandedScanId((prev) => {
      const next = prev === scanId ? null : scanId;
      return next;
    });
  }, []);

  useEffect(() => {
    if (expandedScanId && !detailByScanId[expandedScanId]) {
      loadDetail(expandedScanId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedScanId]);

  // ── AC15 — Board-Rückverfolgung: für jeden Verlaufseintrag mit boardItemIds den
  // Detailbericht (repoSlug-Quelle) still nachladen, sofern noch nicht geladen. ───────
  useEffect(() => {
    if (!open) return;
    const pending = scans.filter(
      (s) => Array.isArray(s.boardItemIds) && s.boardItemIds.length > 0 && !detailByScanId[s.scanId],
    );
    for (const entry of pending) {
      loadDetail(entry.scanId);
    }
  }, [open, scans, detailByScanId, loadDetail]);

  // ── AC15 — Board-Projekt (Status je Story) je repoSlug einmalig laden ────────────
  useEffect(() => {
    const slugsNeeded = new Set();
    for (const entry of scans) {
      if (!Array.isArray(entry.boardItemIds) || entry.boardItemIds.length === 0) continue;
      const detail = detailByScanId[entry.scanId];
      const repoSlug = detail?.scan?.repoSlug;
      if (repoSlug && !boardProjectBySlug[repoSlug]) slugsNeeded.add(repoSlug);
    }
    if (slugsNeeded.size === 0) return;

    let cancelled = false;
    (async () => {
      for (const slug of slugsNeeded) {
        setBoardProjectBySlug((prev) => ({ ...prev, [slug]: { loading: true, error: false, stories: [] } }));
        let res;
        try {
          res = await fetch_(`/api/board/projects/${encodeURIComponent(slug)}`);
        } catch {
          if (!cancelled) {
            setBoardProjectBySlug((prev) => ({ ...prev, [slug]: { loading: false, error: true, stories: [] } }));
          }
          continue;
        }
        if (res.status !== 200) {
          if (!cancelled) {
            setBoardProjectBySlug((prev) => ({ ...prev, [slug]: { loading: false, error: true, stories: [] } }));
          }
          continue;
        }
        let data = {};
        try { data = await res.json(); } catch { /* ignore */ }
        if (cancelled) continue;
        const stories = (data?.project?.features ?? []).flatMap((f) => f.stories ?? []);
        setBoardProjectBySlug((prev) => ({ ...prev, [slug]: { loading: false, error: false, stories } }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scans, detailByScanId]);

  /**
   * Baut die AC15-Zeile "daraus wurden N Punkte aufs Board gelegt — Status live vom
   * Board" für einen Verlaufseintrag — best-effort, degradiert graceful (nie Crash).
   * @param {{scanId:string, boardItemIds:string[]}} entry
   */
  function renderBoardTraceability(entry) {
    const ids = Array.isArray(entry.boardItemIds) ? entry.boardItemIds : [];
    if (ids.length === 0) return null;

    const detail = detailByScanId[entry.scanId];
    const repoSlug = detail?.scan?.repoSlug ?? null;

    let statusLine = 'Status derzeit nicht verfügbar.';
    if (!detail || detail.loading) {
      statusLine = 'Status wird geladen…';
    } else if (repoSlug) {
      const proj = boardProjectBySlug[repoSlug];
      if (proj?.loading) {
        statusLine = 'Status wird geladen…';
      } else if (proj && !proj.error) {
        const parts = ids.map((id) => {
          const story = proj.stories.find((s) => String(s.id ?? '') === String(id));
          return `${id} (${story?.status ?? 'unbekannt'})`;
        });
        statusLine = parts.join(', ');
      }
    }

    return (
      <p style={styles.boardTrace} data-testid={`redteam-history-board-trace-${entry.scanId}`}>
        daraus wurden {ids.length} Punkte aufs Board gelegt — Status live vom Board: {statusLine}
      </p>
    );
  }

  const historyPanelId = `redteam-history-panel-${containerId}`.replace(/[^a-zA-Z0-9-]/g, '-');

  if (!open) return null;

  return (
    <div style={styles.panel} id={historyPanelId} data-testid="redteam-scan-history">
      <h4 style={styles.heading}>Verlauf: {containerLabel}</h4>

      {loadState === 'loading' && (
        <p role="status" style={styles.hint} data-testid="redteam-history-loading">Verlauf wird geladen…</p>
      )}
      {loadState === 'error' && (
        <p role="alert" style={styles.error} data-testid="redteam-history-error">
          Verlauf konnte nicht geladen werden.
        </p>
      )}
      {loadState === 'ok' && scans.length === 0 && (
        <p style={styles.hint} data-testid="redteam-history-empty">Noch keine Läufe.</p>
      )}

      {loadState === 'ok' && scans.length > 0 && (
        <ul style={styles.list} data-testid="redteam-history-list">
          {scans.map((entry) => {
            const isExpanded = expandedScanId === entry.scanId;
            const detail = detailByScanId[entry.scanId];
            return (
              <li key={entry.scanId} style={styles.listItem}>
                <button
                  type="button"
                  style={styles.rowButton}
                  aria-expanded={isExpanded}
                  aria-controls={`redteam-history-detail-${entry.scanId}`.replace(/[^a-zA-Z0-9-]/g, '-')}
                  onClick={() => handleRowToggle(entry.scanId)}
                  data-testid={`redteam-history-row-${entry.scanId}`}
                >
                  <span style={styles.rowTime}>{formatTimestamp(entry.startedAt)}</span>
                  <span style={styles.rowTestort}>Direkt + über Cloudflare</span>
                  <span
                    style={{ ...styles.ampelBadge, ...(AMPEL_STYLE[entry.ampel] ?? AMPEL_STYLE.gruen) }}
                  >
                    {AMPEL_LABEL[entry.ampel] ?? 'Unbekannter Status'}
                  </span>
                  <span style={styles.rowCount}>{entry.findingCount ?? 0} Befunde</span>
                  <span style={styles.rowReportHint}>{isExpanded ? 'Detailbericht schließen ▲' : 'Detailbericht öffnen ▼'}</span>
                </button>

                {renderBoardTraceability(entry)}

                {isExpanded && (
                  <div
                    id={`redteam-history-detail-${entry.scanId}`.replace(/[^a-zA-Z0-9-]/g, '-')}
                    style={styles.detailBox}
                    data-testid={`redteam-history-detail-${entry.scanId}`}
                  >
                    {(!detail || detail.loading) && (
                      <p role="status" style={styles.hint}>Detailbericht wird geladen…</p>
                    )}
                    {detail && detail.error && (
                      <p role="alert" style={styles.error}>Detailbericht konnte nicht geladen werden.</p>
                    )}
                    {detail && !detail.loading && !detail.error && detail.scan && (
                      <>
                        {detail.scan.reportRef ? (
                          <a
                            href={detail.scan.reportRef}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={styles.reportLink}
                            data-testid={`redteam-history-report-link-${entry.scanId}`}
                          >
                            Vollen Bericht öffnen
                          </a>
                        ) : (
                          <span style={styles.hint} data-testid={`redteam-history-no-report-${entry.scanId}`}>
                            Kein Bericht verfügbar.
                          </span>
                        )}
                        {(detail.scan.findings ?? []).length === 0 ? (
                          <p style={styles.hint}>Keine Befunde erkannt.</p>
                        ) : (
                          <ul style={styles.findingsList}>
                            {(detail.scan.findings ?? []).map((f) => (
                              <li key={f.id} style={styles.findingItem}>
                                <strong>{f.severity ?? '—'}</strong> · {f.titel ?? '(ohne Titel)'} · {f.testort ?? '—'}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Styles (Muster containerStyles/RedTeamScanPanel-Styles, VpsView.jsx) ─────────────

const styles = {
  panel: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '10px 12px',
    marginTop: 6,
    width: '100%',
    boxSizing: 'border-box',
  },
  heading: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 700,
    color: '#c9d1d9',
  },
  hint: {
    margin: '4px 0',
    fontSize: 12,
    color: '#8b949e',
  },
  error: {
    color: '#f87171',
    fontSize: 12,
    padding: '6px 8px',
    background: '#2a1a1a',
    borderRadius: 4,
    border: '1px solid #7f1d1d',
    margin: '4px 0',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  listItem: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 6px',
  },
  rowButton: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    minHeight: 44,
    padding: '4px 6px',
    background: 'transparent',
    color: '#c9d1d9',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
  },
  rowTime: {
    fontFamily: 'monospace',
    color: '#79c0ff',
  },
  rowTestort: {
    color: '#8b949e',
  },
  ampelBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 6,
  },
  rowCount: {
    color: '#c9d1d9',
  },
  rowReportHint: {
    marginLeft: 'auto',
    color: '#93c5fd',
    fontSize: 11,
  },
  boardTrace: {
    margin: '4px 6px',
    fontSize: 11,
    color: '#a5b4fc',
  },
  detailBox: {
    marginTop: 6,
    padding: '6px 8px',
    background: '#0d1117',
    border: '1px solid #21262d',
    borderRadius: 4,
  },
  reportLink: {
    display: 'inline-block',
    marginBottom: 6,
    color: '#60a5fa',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    fontSize: 12,
  },
  findingsList: {
    listStyle: 'none',
    padding: 0,
    margin: '4px 0 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  findingItem: {
    fontSize: 11,
    color: '#d4d4d4',
    padding: '3px 6px',
    background: '#111',
    borderRadius: 4,
  },
};
