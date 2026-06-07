/**
 * GitHubView.jsx — Placeholder view for the GitHub integration.
 *
 * AC3: Renders a clearly marked placeholder (Titel + "folgt"-Hinweis)
 * without any backend calls.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function GitHubView({ onNavigate }) {
  return (
    <main style={styles.view} aria-label="GitHub-Ansicht">
      <div style={styles.content}>
        <h1 style={styles.title}>GitHub</h1>
        <p style={styles.hint}>
          Diese Ansicht ist in Arbeit — folgt in einer nächsten Anforderung.
        </p>
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

const styles = {
  view: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    background: '#1a1a1a',
    color: '#d4d4d4',
    fontFamily: 'system-ui, sans-serif',
  },
  content: {
    textAlign: 'center',
    maxWidth: 480,
    padding: '32px 16px',
  },
  title: {
    margin: '0 0 16px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  hint: {
    margin: '0 0 32px',
    fontSize: 15,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  homeBtn: {
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
