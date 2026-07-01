/**
 * NightWatchStatusBadge.jsx — Kompakte Nachtwächter-Statusanzeige (taktgeber-nachtwaechter AC17).
 *
 * Eigenständige, additive Komponente für die Fabrik-Übersicht (RepoOverview.jsx —
 * „Fabrik — Projekt wählen"). RepoOverview.jsx bindet sie nur mit einer Zeile ein
 * (kein Umbau der bestehenden Ansicht).
 *
 * AC17 — „aktiv/pausiert, im/außerhalb Fenster, aktuell laufende Drains":
 *   liest GET /api/settings/ticker/status (S-197, kombiniert die bereits persistierten
 *   Ticker-Settings enabled/window (S-194) mit `withinWindow` und der Anzahl aktuell
 *   laufender NightWatchScheduler-Drains).
 *
 * Graceful degradation: bei Netzwerkfehler oder unerwarteter Antwortform bleibt die
 * Badge unsichtbar (kein Crash, kein irreführender Platzhalter) — analog dem
 * `workspaceHealth`-Muster in SettingsView.jsx.
 *
 * Security (Floor): keine Secrets — reine Status-/Konfigurationswerte.
 *
 * A11y: role=status, aria-label trägt den vollständigen Text (Statusfarbe ist nie
 * die einzige Bedeutungsquelle, docs/design.md §Accessibility).
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useCallback } from 'react';

async function fetchTickerStatus(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/ticker/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function NightWatchStatusBadge({ fetchFn }) {
  const [status, setStatus] = useState(null); // null = noch nicht geladen oder Fehler → unsichtbar

  const load = useCallback(async () => {
    try {
      const data = await fetchTickerStatus(fetchFn);
      // Defensiv: nur bei erkennbarer Form anzeigen (kein Crash bei unerwarteter Antwort).
      if (typeof data?.enabled === 'boolean' && data.window) {
        setStatus(data);
      } else {
        setStatus(null);
      }
    } catch {
      setStatus(null);
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
  }, [load]);

  if (!status) return null;

  const { enabled, window: win, withinWindow, activeDrains } = status;

  let text;
  if (!enabled) {
    text = 'Nachtwächter: pausiert';
  } else {
    text = `Nachtwächter: aktiv, Fenster ${win.start}–${win.end} (${withinWindow ? 'im Fenster' : 'außerhalb Fenster'})`;
    if (Number.isInteger(activeDrains) && activeDrains > 0) {
      text += ` · ${activeDrains} Drain${activeDrains === 1 ? '' : 's'} aktiv`;
    }
  }

  return (
    <span role="status" aria-label={text} style={enabled ? styles.on : styles.off}>
      {text}
    </span>
  );
}

const styles = {
  on: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 10,
    background: '#0d1a0d',
    border: '1px solid #166534',
    color: '#86efac',
    flexShrink: 0,
  },
  off: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 10,
    background: '#1e293b',
    border: '1px solid #374151',
    color: '#9ca3af',
    flexShrink: 0,
  },
};
