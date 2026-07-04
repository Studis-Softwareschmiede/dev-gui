/**
 * DiversesCategory.jsx — Kategorie-Wrapper für Diverses.
 *
 * Enthält (unverändert): MiscSection („Weitere Credentials")
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-misc
 *
 * Props:
 *   - miscItems: array of misc credential objects
 *   - onLoad: async () => void (callback when misc cred is saved)
 */

import { MiscSection } from '../MiscSection.jsx';

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

export function DiversesCategory({
  miscItems,
  onLoad,
}) {
  return (
    <section aria-labelledby="settings-section-misc" style={styles.section}>
      <h2 id="settings-section-misc" style={styles.sectionHeading}>Weitere Credentials</h2>
      <p style={styles.sectionDesc}>Generische Schlüssel/Wert-Einträge für weitere Integrationen.</p>
      <MiscSection miscItems={miscItems} onSaved={onLoad} />
    </section>
  );
}
