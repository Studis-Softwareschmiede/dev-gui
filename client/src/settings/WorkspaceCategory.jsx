/**
 * WorkspaceCategory.jsx — Kategorie-Wrapper für die Workspace-Konfiguration.
 *
 * Enthält (unverändert): WorkspacePathSection
 * AC16: Bestehende id/aria-labelledby-Werte bleiben unverändert.
 *
 * Props:
 *   - workspacePath: { effectivePath, source, mountRoot } oder null
 *   - workspacePathError: string oder null
 *   - workspaceHealth: { … } oder null
 *   - onReload: async () => void
 *   - fetchFn: typeof fetch
 */

import { WorkspacePathSection } from '../WorkspacePathSection.jsx';

const styles = {
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
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
  subSectionHeading: {
    margin: '0 0 6px',
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  subSectionDesc: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
};

export function WorkspaceCategory({
  workspacePath,
  workspacePathError,
  workspaceHealth,
  onReload,
  fetchFn,
}) {
  return (
    <section aria-labelledby="settings-section-workspace" style={styles.section}>
      <h2 id="settings-section-workspace" style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#e5e7eb' }}>
        Workspace
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#9ca3af', lineHeight: 1.5 }}>
        Arbeitsverzeichnis für Klon-, Listing- und Pull-Operationen.
      </p>

      {workspacePathError && (
        <p style={styles.loadError} role="alert" aria-live="polite">
          Workspace-Pfad konnte nicht geladen werden: {workspacePathError}
        </p>
      )}

      {workspacePath && (
        <div>
          <h3 style={styles.subSectionHeading}>Workspace-Pfad</h3>
          <p style={styles.subSectionDesc}>
            Workspace-Root für Klon-, Listing- und Pull-Operationen.
            Muss innerhalb der gemounteten Schranke ({workspacePath.mountRoot || 'WORKSPACE_DIR'}) liegen.
          </p>
          <WorkspacePathSection
            effectivePath={workspacePath.effectivePath}
            source={workspacePath.source}
            mountRoot={workspacePath.mountRoot}
            onReload={onReload}
            fetchFn={fetchFn}
            health={workspaceHealth}
          />
        </div>
      )}
    </section>
  );
}
