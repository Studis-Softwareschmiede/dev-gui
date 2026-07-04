/**
 * AutomatisierungCategory.jsx — Kategorie-Wrapper für Automatisierung.
 *
 * Enthält (unverändert): NightWatchSettings (inkl. Auto-Retro-Schalter)
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-nightwatch
 *
 * Props:
 *   - fetchFn: typeof fetch
 */

import { NightWatchSettings } from '../NightWatchSettings.jsx';

const styles = {
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: {
    margin: '0 0 8px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  sectionDesc: {
    margin: '0 0 16px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
};

export function AutomatisierungCategory({
  fetchFn,
}) {
  return (
    <section aria-labelledby="settings-section-nightwatch" style={styles.section}>
      <h2 id="settings-section-nightwatch" style={styles.sectionHeading}>Nachtwächter</h2>
      <p style={styles.sectionDesc}>
        Automatisches, nächtliches Leerziehen offener Boards (Nachtfenster, Parallelität,
        Eskalation, Projekt-Auswahl). Liest/schreibt GET/PUT /api/settings/ticker.
      </p>
      <NightWatchSettings fetchFn={fetchFn} />
    </section>
  );
}
