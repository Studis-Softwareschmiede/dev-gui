/**
 * SettingsView.jsx — Settings-Ansicht: Einstellungen-Gerüst mit vier Sektionen.
 *
 * AC2 — Zeigt einen erkennbaren Titel „Einstellungen".
 * AC4 — Genau vier beschriftete Sektionen: GitHub, Cloudflare, Hetzner / VPS, SSH-Keys.
 *        Jede Sektion trägt eine kurze Beschreibung und einen leeren Platzhalter-Container
 *        (kein Backend-Aufruf, kein Fetch, kein XHR).
 * AC6 — Rückkehr zum Einstiegs-Panel möglich.
 * AC7 — Keine neuen Secrets, keine neuen Backend-Endpunkte, keine Umgehung der Access-Mauer.
 *
 * A11y: WCAG 2.1 AA — Überschriften-Struktur, sichtbarer Fokus, Touch-Target ≥ 44 px.
 *
 * Security (Floor):
 *   - Kein Secret im Frontend-Bundle.
 *   - Kein Backend-Aufruf in diesem Gerüst.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function SettingsView({ onNavigate }) {
  return (
    <main style={styles.view} aria-label="Einstellungen-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Einstellungen</h1>

        {SECTIONS.map(({ id, heading, description }) => (
          <section key={id} aria-labelledby={`settings-section-${id}`} style={styles.section}>
            <h2 id={`settings-section-${id}`} style={styles.sectionHeading}>
              {heading}
            </h2>
            <p style={styles.sectionDesc}>{description}</p>
            <div style={styles.placeholder} aria-label={`${heading} — folgt`}>
              <span style={styles.placeholderText}>folgt</span>
            </div>
          </section>
        ))}

        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          ← Zurück zum Panel
        </button>
      </div>
    </main>
  );
}

/** @type {Array<{ id: string, heading: string, description: string }>} */
const SECTIONS = [
  {
    id: 'github',
    heading: 'GitHub',
    description: 'GitHub-App-Credentials, Token und Organisations-Zugang.',
  },
  {
    id: 'cloudflare',
    heading: 'Cloudflare',
    description: 'API-Token für Tunnel, Access und DNS-Verwaltung.',
  },
  {
    id: 'hetzner',
    heading: 'Hetzner / VPS',
    description: 'Hetzner-API-Key und VPS-Konfiguration für Provisionierung.',
  },
  {
    id: 'ssh-keys',
    heading: 'SSH-Keys',
    description: 'Öffentliche und private SSH-Schlüssel für VPS-Zugang.',
  },
];

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#d4d4d4',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px 24px',
  },
  inner: {
    width: '100%',
    maxWidth: 720,
  },
  title: {
    margin: '0 0 32px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
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
  placeholder: {
    padding: '12px 16px',
    background: '#1a1a1a',
    border: '1px dashed #3a3a3a',
    borderRadius: 4,
  },
  placeholderText: {
    fontSize: 13,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  homeBtn: {
    marginTop: 8,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
};
