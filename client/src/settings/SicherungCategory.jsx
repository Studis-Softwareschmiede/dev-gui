/**
 * SicherungCategory.jsx — Kategorie-Wrapper für Sicherung.
 *
 * Enthält (unverändert): BackupSection (inkl. RestoreSection)
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-backup
 *
 * Props:
 *   - credentials: array of credential objects
 *   - onLoad: async () => void (callback when backup settings change)
 *   - fetchFn: typeof fetch
 */

import { BackupSection } from '../BackupSection.jsx';

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

export function SicherungCategory({
  credentials,
  onLoad,
  fetchFn,
}) {
  return (
    <section aria-labelledby="settings-section-backup" style={styles.section}>
      <h2 id="settings-section-backup" style={styles.sectionHeading}>Backup / Sicherung</h2>
      <p style={styles.sectionDesc}>
        Automatische Sicherung des Credential-Stores nach jedem Schreib-Vorgang.
        Remote-Zugangsdaten werden write-only im Credential-Store hinterlegt.
      </p>
      <BackupSection credentials={credentials} onSaved={onLoad} fetchFn={fetchFn} />
    </section>
  );
}
