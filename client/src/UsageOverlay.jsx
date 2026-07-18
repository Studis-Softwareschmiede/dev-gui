/**
 * UsageOverlay.jsx — Token-Nutzungs-Anzeige (Owner-Ko-Design 2026-07-03/05,
 * "goldene Münze"): Kopfleiste rechts neben dem Zahnrad ein Münz-Icon, Klick
 * öffnet ein Vollbild-Overlay mit dem Token-/Nutzungsverbrauch der aktuellen
 * 5h-Session und der laufenden Woche (GET /api/usage).
 *
 * Dreistufiges Antwortmodell (docs/specs/usage-official-values.md AC10–AC12,
 * `source` löst das frühere `estimated: true`-Flag ab):
 *   - `source: "official"` — offizielle Anthropic-Werte (Prozent verbraucht +
 *     Reset-Zeitpunkt) für Session, "Alle Modelle" + je Modell, `spend` falls
 *     vorhanden. Reine Durchreichung, keine eigene Berechnung (AC10).
 *   - `source: "estimated"` (Fallback, heutiges Verhalten unverändert) — rohe
 *     Output-Token-Zahlen, klar als „geschätzt" gekennzeichnet, KEINE Prozent-/
 *     Reset-Werte (AC11). Fehlt `source` (Alt-Antwort), wird defensiv wie
 *     `estimated` behandelt.
 *   - `source: "unavailable"` — ehrlicher Fehler-/Leer-Hinweis statt Zahlen
 *     (AC11).
 *
 * A11y (AC12): role=dialog/aria-modal, Fokus-Falle, ESC schließt, Schließen-
 * Kreuz oben rechts, Fokus-Rückgabe an den Auslöser, Aktualisieren-Knopf — in
 * allen drei Zuständen unverändert (Muster des Bitwarden-Unlock-Dialogs in
 * SettingsView.jsx).
 */
import { useState, useEffect, useRef, useCallback } from 'react';

function formatTokens(n) {
  if (typeof n !== 'number') return '–';
  return n.toLocaleString('de-CH');
}

/** Prozentwert lokalisiert (de-CH) formatiert, z.B. "42,5 %". */
function formatPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  return `${n.toLocaleString('de-CH', { maximumFractionDigits: 1 })} %`;
}

/** Reset-Zeitpunkt (ISO-8601) lokalisiert (de-CH) formatiert. */
function formatResetAt(iso) {
  if (typeof iso !== 'string' || !iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * `spend`-Form folgt dem (nicht vertraglich fixierten) Upstream-Endpunkt —
 * defensive Best-effort-Darstellung: bekannte `amountUsd`-Zahl bevorzugt,
 * sonst Roh-Zahl, sonst JSON-Fallback. Liefert `null`, wenn nichts darstellbar ist.
 */
function formatSpend(spend) {
  if (spend === undefined || spend === null) return null;
  if (typeof spend === 'number' && Number.isFinite(spend)) {
    return `${spend.toLocaleString('de-CH', { maximumFractionDigits: 2 })} USD`;
  }
  if (typeof spend === 'object' && typeof spend.amountUsd === 'number') {
    return `${spend.amountUsd.toLocaleString('de-CH', { maximumFractionDigits: 2 })} USD`;
  }
  try {
    return JSON.stringify(spend);
  } catch {
    return null;
  }
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

        {data && data.source === 'official' && (
          <div>
            {data.session && (
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Aktuelle Sitzung (5 Std.)</h3>
                <p style={styles.value}>{formatPercent(data.session.percentUsed)}</p>
                <p style={styles.footnote}>Reset: {formatResetAt(data.session.resetAt)}</p>
              </section>
            )}
            {data.week?.allModels && (
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Woche — Alle Modelle</h3>
                <p style={styles.value}>{formatPercent(data.week.allModels.percentUsed)}</p>
                <p style={styles.footnote}>Reset: {formatResetAt(data.week.allModels.resetAt)}</p>
              </section>
            )}
            {Array.isArray(data.week?.perModel) && data.week.perModel.map((m) => (
              <section style={styles.section} key={m.model}>
                <h3 style={styles.sectionTitle}>Woche — {m.model}</h3>
                <p style={styles.value}>{formatPercent(m.percentUsed)}</p>
                <p style={styles.footnote}>Reset: {formatResetAt(m.resetAt)}</p>
              </section>
            ))}
            {formatSpend(data.spend) && (
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>Guthaben</h3>
                <p style={styles.value}>{formatSpend(data.spend)}</p>
              </section>
            )}
            <p style={styles.footnote}>
              Offizielle Anthropic-Nutzungswerte.
              Stand: {new Date(data.generatedAt).toLocaleTimeString('de-CH')}
            </p>
            <button type="button" onClick={load} style={styles.refreshBtn}>Aktualisieren</button>
          </div>
        )}

        {data && data.source === 'unavailable' && (
          <div>
            <p role="alert" style={styles.error}>
              Nutzungsdaten aktuell nicht verfügbar.
            </p>
            <button type="button" onClick={load} style={styles.refreshBtn}>Aktualisieren</button>
          </div>
        )}

        {data && data.source !== 'official' && data.source !== 'unavailable' && (
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
