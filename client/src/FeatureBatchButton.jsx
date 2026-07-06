/**
 * FeatureBatchButton.jsx — Feature-Umsetzen-Button, 3 Zustände (Owner-Auftrag
 * 2026-07-06, Designer-Vorgabe docs/design.md „Feature-Umsetzen-Button").
 *
 * Zustand 1 „Bereit": Grün „▶ Umsetzen" — klickbar, öffnet Bestätigungsdialog.
 * Zustand 2 „Läuft":  Orange „⏳ In Progress" — gesperrt.
 * Zustand 3 „Fertig": Rot „✓ Done" — gesperrt (bewusste Owner-Abweichung von
 *   der Ampel-Konvention, s. design.md — nicht diskutieren/ändern).
 *
 * Datenquelle: GET .../batch liefert den autoritativen Zustand (ready|running|
 * done), abgeleitet serverseitig aus dem ungefilterten Story-Bestand (nicht
 * der im Board evtl. gefilterten `feature.stories`-Teilmenge). Polling alle
 * 4s während `running` (D5 lässt SSE/Poll als Architektur-Entscheidung offen —
 * Polling ist die einfachere, hier gewählte Variante).
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const POLL_INTERVAL_MS = 4000;

export function FeatureBatchButton({ feature, projectSlug, fetchFn }) {
  const [state, setState] = useState('ready');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const triggerRef = useRef(null);
  const doFetch = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);

  const loadState = useCallback(async () => {
    if (!doFetch || !projectSlug || !feature?.id) return;
    try {
      const res = await doFetch(`/api/board/projects/${projectSlug}/features/${feature.id}/batch`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.state) setState(data.state);
    } catch {
      // best-effort — Zustand bleibt unverändert bei Netzwerkfehler
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, feature?.id]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    if (state !== 'running') return undefined;
    const id = setInterval(loadState, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state, loadState]);

  const handleConfirm = useCallback(async () => {
    setConfirmOpen(false);
    setState('running'); // optimistisch (design.md Abschnitt 4) — verhindert Doppel-Trigger
    setError('');
    if (!doFetch) return;
    try {
      const res = await doFetch(`/api/board/projects/${projectSlug}/features/${feature.id}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || `HTTP ${res.status}`);
        await loadState(); // autoritativen Zustand nachziehen (z.B. wieder 'ready')
      }
    } catch {
      setError('Start fehlgeschlagen.');
      await loadState();
    }
  }, [doFetch, projectSlug, feature?.id, loadState]);

  const title = feature?.title || feature?.id || '';
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.ready;

  return (
    <div role="status" aria-live="polite" aria-atomic="true" style={styles.liveRegionWrapper}>
      <button
        type="button"
        ref={triggerRef}
        disabled={state !== 'ready'}
        aria-disabled={state !== 'ready'}
        onClick={() => state === 'ready' && setConfirmOpen(true)}
        aria-label={cfg.ariaLabel(title)}
        style={{ ...styles.base, ...cfg.style, cursor: state === 'ready' ? 'pointer' : 'not-allowed' }}
        data-testid={`feature-batch-btn-${feature?.id}`}
        data-state={state}
      >
        <span aria-hidden="true">{cfg.icon}</span> {cfg.text}
      </button>

      {error && (
        <p role="alert" style={styles.errorText}>{error}</p>
      )}

      {confirmOpen && (
        <div style={styles.confirmBox} role="dialog" aria-modal="false" aria-label="Feature-Batch bestätigen">
          <p style={styles.confirmText}>
            Startet die Batch-Verarbeitung aller Storys dieses Features: ein Agent schreibt Code,
            mergt am Ende gebündelt und deployt einmal. Fortfahren?
          </p>
          <div style={styles.confirmBtns}>
            <button type="button" style={styles.btnConfirm} onClick={handleConfirm}>Ja, starten</button>
            <button type="button" style={styles.btnCancel} onClick={() => setConfirmOpen(false)}>Abbrechen</button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATE_CONFIG = {
  ready: {
    text: 'Umsetzen',
    icon: '▶',
    style: { background: '#15803d', color: '#fff' },
    ariaLabel: (title) => `Feature „${title}" umsetzen — verarbeitet alle Storys nacheinander`,
  },
  running: {
    text: 'In Progress',
    icon: '⏳',
    style: { background: '#b45309', color: '#fff' },
    ariaLabel: (title) => `Feature „${title}" — Umsetzung läuft`,
  },
  done: {
    text: 'Done',
    icon: '✓',
    style: { background: '#7f1d1d', color: '#fecaca' },
    ariaLabel: (title) => `Feature „${title}" — abgeschlossen (Done)`,
  },
};

const styles = {
  liveRegionWrapper: { display: 'inline-flex', flexDirection: 'column', gap: 4 },
  base: {
    border: 'none',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    minHeight: 44,
    transition: 'background-color 150ms ease, color 150ms ease',
  },
  errorText: { fontSize: 11, color: '#fca5a5', margin: 0 },
  confirmBox: {
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 4,
  },
  confirmText: { fontSize: 12, color: '#d1d5db', margin: 0, lineHeight: 1.5 },
  confirmBtns: { display: 'flex', gap: 8 },
  btnConfirm: {
    flex: 1, background: '#15803d', color: '#fff', border: 'none', borderRadius: 4,
    padding: '6px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
  },
  btnCancel: {
    flex: 1, background: 'transparent', color: '#9ca3af', border: '1px solid #374151',
    borderRadius: 4, padding: '6px 10px', fontSize: 12, cursor: 'pointer', minHeight: 44,
  },
};
