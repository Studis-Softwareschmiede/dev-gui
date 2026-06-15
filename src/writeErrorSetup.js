/**
 * writeErrorSetup.js — Shared helper: Workspace write-error → structured setup-Anleitung (AC5).
 *
 * Wenn ein Schreibzugriff in den Workspace fehlschlägt, weil der Ziel-Ordner
 * fehlt (ENOENT), nicht schreibbar (EACCES/EPERM/EROFS) oder dem falschen
 * Owner gehört, liefert diese Funktion eine strukturierte Antwort mit
 * Host-Befehlen, die der Betreiber direkt ausführen kann.
 *
 * Kein Secret im Output (Pfade sind kein Geheimnis, Klartext erlaubt).
 *
 * @module writeErrorSetup
 */

/** Fehlercodes die auf „Workspace nicht bereitgestellt" hinweisen. */
const WRITE_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EROFS']);

/**
 * Klassifiziert einen Systemfehler als Workspace-Write-Fehler.
 *
 * @param {Error|null|undefined} err
 * @returns {boolean}
 */
export function isWorkspaceWriteError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.code ?? '';
  if (WRITE_ERROR_CODES.has(code)) return true;
  // Fallback: Fehlermeldung enthält typische Schreibfehler-Hinweise
  const msg = String(err.message ?? '').toLowerCase();
  return (
    msg.includes('enoent') ||
    msg.includes('eacces') ||
    msg.includes('eperm') ||
    msg.includes('erofs') ||
    msg.includes('permission denied') ||
    msg.includes('read-only file system')
  );
}

/**
 * Baut die Setup-Anleitung für einen fehlgeschlagenen Workspace-Schreibzugriff.
 *
 * @param {object} [options]
 * @param {string} [options.errorMessage]  Klartext-Fehlertext (kein Secret)
 * @returns {{ error: string, setup: { message: string, hostPath: string, commands: string[] } }}
 */
export function buildWriteErrorSetup({ errorMessage } = {}) {
  // WORKSPACE_HOST_DIR ist rein informativ (AC5-Spec) — Platzhalter wenn ungesetzt
  const hostPath = process.env.WORKSPACE_HOST_DIR ?? '<dein-host-workspace-pfad>';
  const hasRealPath = Boolean(process.env.WORKSPACE_HOST_DIR);

  const setupMessage = hasRealPath
    ? `Der Workspace-Ordner auf dem Host (${hostPath}) fehlt oder ist nicht für uid 1000 schreibbar. Führe die folgenden Befehle auf dem Host aus und starte ggf. den Container neu:`
    : `Der Workspace-Ordner fehlt oder ist nicht für uid 1000 schreibbar. ` +
      `Setze WORKSPACE_HOST_DIR in docker-compose.yml, um den genauen Host-Pfad zu sehen. ` +
      `Ersetze <dein-host-workspace-pfad> durch deinen tatsächlichen Host-Pfad und führe die Befehle aus:`;

  const commands = [
    `sudo mkdir -p ${hostPath}`,
    `sudo chown -R 1000:1000 ${hostPath}`,
  ];

  return {
    error: errorMessage ?? 'Workspace-Schreibzugriff fehlgeschlagen',
    setup: {
      message: setupMessage,
      hostPath,
      commands,
    },
  };
}
