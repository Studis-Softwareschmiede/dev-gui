/**
 * IntegrationenCategory.jsx — Kategorie-Wrapper für Integrationen.
 *
 * Enthält (unverändert): ObsidianVaultPathSection
 * AC16: Bestehende id/aria-labelledby-Wert bleibt unverändert:
 *   - settings-section-obsidian
 *
 * S-379 (obsidian-vault-folder-browser): `mountStatus` additiv durchgereicht (AC1/AC7).
 * S-381 (obsidian-vault-config v3, AC8/AC13/AC15): `ObsidianProjekteSubdirSection`
 *   ergänzt — eigener Eintrag „Obsidian-Projekt-Unterordner" in derselben Sektion.
 *   Der Ordner-Browser (AC13) braucht den konfigurierten Vault-Pfad, um das gewählte
 *   Verzeichnis vault-relativ abzuleiten — deshalb wird `obsidianVaultPath` zusätzlich
 *   durchgereicht.
 *
 * Props:
 *   - obsidianVaultPath: { vaultPath, configured, mountStatus, mountRoot } or null
 *   - obsidianVaultPathError: string or null
 *   - obsidianProjekteSubdir: { effective, source, persisted } or null
 *   - obsidianProjekteSubdirError: string or null
 *   - onReload: async () => void
 *   - onReloadProjekteSubdir: async () => void
 *   - fetchFn: typeof fetch
 */

import { ObsidianVaultPathSection } from '../ObsidianVaultPathSection.jsx';
import { ObsidianProjekteSubdirSection } from '../ObsidianProjekteSubdirSection.jsx';

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
  subHeading: {
    margin: '24px 0 8px',
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
  },
};

export function IntegrationenCategory({
  obsidianVaultPath,
  obsidianVaultPathError,
  obsidianProjekteSubdir,
  obsidianProjekteSubdirError,
  onReload,
  onReloadProjekteSubdir,
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
          mountStatus={obsidianVaultPath.mountStatus}
          mountRoot={obsidianVaultPath.mountRoot}
          onReload={onReload}
          fetchFn={fetchFn}
        />
      )}

      {/* obsidian-vault-config v3 (AC8/AC13/AC15, S-381) */}
      <h3 style={styles.subHeading}>Obsidian-Projekt-Unterordner</h3>
      {obsidianProjekteSubdirError && (
        <p style={styles.loadError} role="alert" aria-live="polite">
          Obsidian-Projekt-Unterordner konnte nicht geladen werden: {obsidianProjekteSubdirError}
        </p>
      )}
      {obsidianProjekteSubdir && (
        <ObsidianProjekteSubdirSection
          effective={obsidianProjekteSubdir.effective}
          source={obsidianProjekteSubdir.source}
          persisted={obsidianProjekteSubdir.persisted}
          vaultPath={obsidianVaultPath?.vaultPath ?? null}
          vaultConfigured={Boolean(obsidianVaultPath?.configured)}
          onReload={onReloadProjekteSubdir}
          fetchFn={fetchFn}
        />
      )}
    </section>
  );
}
