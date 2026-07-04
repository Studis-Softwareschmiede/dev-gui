/**
 * BenachrichtigungenCategory.jsx — Kategorie-Wrapper für Benachrichtigungen.
 *
 * Enthält (unverändert): NotificationSection
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-notifications
 *
 * Props:
 *   - notificationsCredMeta: credential metadata object or null
 *   - onCredSaved: async () => void (callback when notification credential changes)
 *   - fetchFn: typeof fetch
 */

import { NotificationSection } from '../NotificationSection.jsx';

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

export function BenachrichtigungenCategory({
  notificationsCredMeta,
  onCredSaved,
  fetchFn,
}) {
  return (
    <section aria-labelledby="settings-section-notifications" style={styles.section}>
      <h2 id="settings-section-notifications" style={styles.sectionHeading}>Benachrichtigungen (ntfy)</h2>
      <p style={styles.sectionDesc}>
        Push-Benachrichtigungen via ntfy bei Board-Ereignissen (Story fertig, blockiert,
        Feature komplett). Token wird write-only im Credential-Store hinterlegt — NIE im Klartext zurückgegeben.
      </p>
      <NotificationSection
        notificationsCredMeta={notificationsCredMeta}
        onCredSaved={onCredSaved}
        fetchFn={fetchFn}
      />
    </section>
  );
}
