/**
 * ClaudeAuthBadge.jsx — Panel-Statusanzeige „Claude-Auth: ok / abgelaufen"
 * (docs/specs/claude-auth-health.md AC5, AC6).
 *
 * Eigenständige, additive Komponente — analog zur bestehenden GitHub-/CI-
 * Statusanzeige (`GET /api/status`) und zum bestehenden Badge-Muster
 * `NightWatchStatusBadge.jsx` (taktgeber-nachtwaechter AC17): eigenes Polling
 * über einen injizierbaren `fetchFn`, kein Umbau der bestehenden Ansicht.
 *
 * Zustände (AC5):
 *   - `expired` — auffällige Badge „Claude-Auth: abgelaufen" + Erneuerungs-
 *     Hinweis (`claude setup-token`, Claude-Abo nötig).
 *   - `ok`      — neutral/unauffällig (kein Alarm).
 *   - `unknown` — dezenter neutraler Hinweis (kein roter Alarm).
 *
 * Graceful degradation (Edge-Case „/api/status-Fehler im Frontend"): bei
 * Netzwerkfehler oder unerwarteter Antwortform bleibt die Badge unsichtbar
 * (kein Crash, kein irreführender Platzhalter) — analog `NightWatchStatusBadge`.
 *
 * Security (Floor, AC6): kein Token-Wert — nur `claudeAuth`/`lastCheckedAt`
 * aus der Response werden gelesen.
 *
 * A11y (WCAG 2.1 AA): `role="status"` (impliziter aria-live Bereich), Text-
 * Label trägt die volle Bedeutung — Statusfarbe ist nie die einzige
 * Bedeutungsquelle.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useCallback } from 'react';

/** Klartext-Hinweis bei erkanntem Auth-Fehler (AC5 — Erneuerungs-Anleitung). */
const RENEWAL_HINT = 'Token via claude setup-token erneuern (Claude-Abo nötig)';

async function fetchClaudeAuthStatus(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const STATUS_STYLE = {
  ok: {
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
  expired: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 10,
    background: '#2a0d0d',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
    flexShrink: 0,
  },
  unknown: {
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

export function ClaudeAuthBadge({ fetchFn }) {
  // null = noch nicht geladen oder Fehler → unsichtbar (graceful degradation)
  const [claudeAuth, setClaudeAuth] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchClaudeAuthStatus(fetchFn);
      if (data?.claudeAuth === 'ok' || data?.claudeAuth === 'expired' || data?.claudeAuth === 'unknown') {
        setClaudeAuth(data.claudeAuth);
      } else {
        setClaudeAuth(null); // unerwartete Antwortform → unsichtbar (kein Crash)
      }
    } catch {
      setClaudeAuth(null); // Netzwerkfehler → neutral degradiert (kein roter Alarm)
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
  }, [load]);

  if (!claudeAuth) return null;

  const text = `Claude-Auth: ${claudeAuth === 'ok' ? 'ok' : claudeAuth === 'expired' ? 'abgelaufen' : 'unbekannt'}`;
  const ariaLabel = claudeAuth === 'expired' ? `${text} — ${RENEWAL_HINT}` : text;

  return (
    <span role="status" aria-label={ariaLabel} style={STATUS_STYLE[claudeAuth]}>
      {text}
      {claudeAuth === 'expired' && <span style={styles.hint}> — {RENEWAL_HINT}</span>}
    </span>
  );
}

const styles = {
  hint: {
    fontWeight: 400,
    marginLeft: 4,
  },
};
