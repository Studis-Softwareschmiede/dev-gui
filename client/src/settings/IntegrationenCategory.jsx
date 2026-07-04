/**
 * IntegrationenCategory.jsx — Kategorie-Wrapper für Integrationen.
 *
 * Enthält (unverändert): ObsidianVaultPathSection
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-obsidian
 *
 * Props:
 *   - obsidianVaultPath: { vaultPath, configured, mountRoot } or null
 *   - obsidianVaultPathError: string or null
 *   - onReload: async () => void
 *   - fetchFn: typeof fetch
 */

import { ObsidianVaultPathSection } from '../ObsidianVaultPathSection.jsx';

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
  loadError: {
    padding: '12px 16px',
    marginBottom: 24,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 14,
  },
};

export function IntegrationenCategory({
  obsidianVaultPath,
  obsidianVaultPathError,
  onReload,
  fetchFn,
}) {
  return (
    <section aria-labelledby="settings-section-obsidian" style={styles.section}>
      <h2 id="settings-section-obsidian" style={styles.sectionHeading}>Obsidian</h2>
      <p style={styles.sectionDesc}>
        Pfad zum lokalen Obsidian-Vault (Ordner mit Unterordner „Projekte") — Grundlage für
        den Projekt-Anlage-Weg aus Obsidian-Notizen.
      </p>
      {obsidianVaultPathError && (
        <p style={styles.loadError} role="alert" aria-live="polite">
          Obsidian-Vault-Pfad konnte nicht geladen werden: {obsidianVaultPathError}
        </p>
      )}
      {obsidianVaultPath && (
        <ObsidianVaultPathSection
          vaultPath={obsidianVaultPath.vaultPath}
          configured={obsidianVaultPath.configured}
          mountRoot={obsidianVaultPath.mountRoot}
          onReload={onReload}
          fetchFn={fetchFn}
        />
      )}
    </section>
  );
}
