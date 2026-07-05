/**
 * UsageOverlay.jsx — Token-Nutzungs-Anzeige (Owner-Ko-Design 2026-07-03/05,
 * "goldene Münze"): Kopfleiste rechts neben dem Zahnrad ein Münz-Icon, Klick
 * öffnet ein Vollbild-Overlay mit dem geschätzten Output-Token-Verbrauch der
 * aktuellen 5h-Session und der laufenden Woche (GET /api/usage).
 *
 * Bewusst nur geschätzte Rohzahlen (kein OAuth-Prozent/Reset-Zeit-Anspruch,
 * s. src/routers/usage.js) — als „geschätzt" gekennzeichnet.
 *
 * A11y: role=dialog/aria-modal, Fokus-Falle, ESC schließt, Schließen-Kreuz
 * oben rechts, Fokus-Rückgabe an den Auslöser (Muster des Bitwarden-Unlock-
 * Dialogs in SettingsView.jsx).
 */
import { useState, useEffect, useRef, useCallback } from 'react';

function formatTokens(n) {
  if (typeof n !== 'number') return '–';
  return n.toLocaleString('de-CH');
}

export function UsageCoinButton({ fetchFn }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(true)}
        aria-label="Token-Nutzung anzeigen"
        title="Token-Nutzung"
        style={styles.coinBtn}
      >
        🪙
      </button>
      {open && (
        <UsageOverlay
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fetchFn={fetchFn}
        />
      )}
    </>
  );
}

function UsageOverlay({ onClose, triggerRef, fetchFn }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef(null);
  const doFetch = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);

  const load = useCallback(async () => {
    if (!doFetch) return;
    setLoading(true); setError('');
    try {
      const res = await doFetch('/api/usage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch {
      setError('Nutzungsdaten konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef?.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={styles.backdrop} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-overlay-title"
        tabIndex={-1}
        style={styles.dialog}
      >
        <div style={styles.header}>
          <h2 id="usage-overlay-title" style={styles.title}>Token-Nutzung</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schliessen"
            style={styles.closeBtn}
          >
            ✕
          </button>
        </div>

        {loading && <p aria-live="polite" style={styles.hint}>Lade…</p>}
        {error && <p role="alert" style={styles.error}>{error}</p>}

        {data && (
          <div>
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Aktuelle Sitzung (~{data.session.windowHours} Std.)</h3>
              <p style={styles.value}>{formatTokens(data.session.outputTokens)} Output-Tokens</p>
            </section>
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Woche (~{data.week.windowDays} Tage)</h3>
              <p style={styles.value}>{formatTokens(data.week.outputTokens)} Output-Tokens</p>
            </section>
            <p style={styles.footnote}>
              Geschätzt aus lokalen Session-Protokollen — keine offiziellen Prozent-/Reset-Zeit-Werte.
              Stand: {new Date(data.generatedAt).toLocaleTimeString('de-CH')}
            </p>
            <button type="button" onClick={load} style={styles.refreshBtn}>Aktualisieren</button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  coinBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    fontSize: 20, lineHeight: 1, padding: '8px 10px', minHeight: 44, minWidth: 44,
  },
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  dialog: {
    background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8,
    padding: 24, width: '100%', maxWidth: 480, color: '#d4d4d4',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { margin: 0, fontSize: 20, fontWeight: 700, color: '#e5e7eb' },
  closeBtn: {
    background: 'transparent', border: 'none', color: '#9ca3af', fontSize: 18,
    cursor: 'pointer', minHeight: 44, minWidth: 44,
  },
  hint: { color: '#9ca3af' },
  error: { color: '#fca5a5' },
  section: { marginBottom: 16 },
  sectionTitle: { margin: '0 0 4px', fontSize: 13, color: '#9ca3af', fontWeight: 600 },
  value: { margin: 0, fontSize: 22, fontWeight: 700, color: '#fbbf24' },
  footnote: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  refreshBtn: {
    marginTop: 12, minHeight: 44, padding: '8px 16px', background: '#1e293b',
    color: '#d4d4d4', border: '1px solid #334155', borderRadius: 6, cursor: 'pointer',
  },
};
