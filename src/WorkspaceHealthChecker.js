/**
 * WorkspaceHealthChecker — read-only Aggregat der Workspace+Board-Konfiguration (AC1/AC2).
 *
 * Spec: workspace-health-hinweis V1
 *
 * 6 Checks (je { key, status, message, fix? }):
 *   mount-exists       — WORKSPACE_DIR (Mount-Ziel) existiert und ist Verzeichnis
 *   mount-nonempty     — Mount enthält mindestens einen Eintrag
 *   board-roots-set    — BOARD_ROOTS ist gesetzt und nicht leer
 *   board-roots-valid  — jeder BOARD_ROOTS-Pfad existiert und ist Verzeichnis
 *   repos-found        — Anzahl gefundener Git-Repos (WorkspaceScanner) > 0
 *   board-projects-found — Anzahl Board-Projekte (BoardAggregator) > 0
 *
 * Gesamt-Status = höchste Schwere (error > warn > ok).
 * Prüffehler → warn (kein Crash).
 * Injizierbare Deps für Tests.
 *
 * Kein Secret im Output (Pfade sind kein Geheimnis — analog AC6 workspace-path-config).
 *
 * @module WorkspaceHealthChecker
 */

import { stat, readdir } from 'node:fs/promises';

/**
 * @typedef {'ok'|'warn'|'error'} CheckStatus
 *
 * @typedef {{
 *   key: string,
 *   status: CheckStatus,
 *   message: string,
 *   fix?: string
 * }} HealthCheck
 *
 * @typedef {{
 *   overall: CheckStatus,
 *   checks: HealthCheck[],
 *   counts: { repos: number, boardProjects: number }
 * }} HealthResult
 */

/** Schwere-Rangfolge für Gesamt-Status-Berechnung. */
const SEVERITY = { ok: 0, warn: 1, error: 2 };

/**
 * Ermittelt den schwersten Status aus einem Array von Checks.
 * @param {HealthCheck[]} checks
 * @returns {CheckStatus}
 */
function computeOverall(checks) {
  let max = 0;
  for (const c of checks) {
    const s = SEVERITY[c.status] ?? 0;
    if (s > max) max = s;
  }
  return max === 2 ? 'error' : max === 1 ? 'warn' : 'ok';
}

/**
 * WorkspaceHealthChecker — read-only Diagnose der Workspace/Board-Konfiguration.
 *
 * @param {object} [options]
 * @param {object} [options.fsDeps]            Injectable fs-Deps (stat, readdir)
 * @param {Function} [options.listClonesFn]    Injectable async fn () => clone[] (WorkspaceScanner.listClones)
 * @param {Function} [options.getIndexFn]      Injectable async fn () => project[] (BoardAggregator.getIndex)
 * @param {Function} [options.getEnv]          Injectable env-Leser (key => string|undefined), default: process.env
 */
export class WorkspaceHealthChecker {
  #fsDeps;
  #listClones;
  #getIndex;
  #getEnv;

  constructor({ fsDeps, listClonesFn, getIndexFn, getEnv } = {}) {
    this.#fsDeps = fsDeps ?? { stat, readdir };
    this.#listClones = listClonesFn ?? (() => Promise.resolve([]));
    this.#getIndex = getIndexFn ?? (() => Promise.resolve([]));
    this.#getEnv = getEnv ?? ((key) => process.env[key]);
  }

  /**
   * Führt alle 6 Health-Checks aus und liefert das Aggregat.
   * Wirft nie (AC1: Prüffehler → warn, kein Crash).
   *
   * @returns {Promise<HealthResult>}
   */
  async check() {
    const checks = [];
    let repoCount = 0;
    let boardProjectCount = 0;

    // ── Check 1: mount-exists ────────────────────────────────────────────────
    const workspaceDir = this.#getEnv('WORKSPACE_DIR') ?? '';
    checks.push(await this.#checkMountExists(workspaceDir));

    // ── Check 2: mount-nonempty ──────────────────────────────────────────────
    checks.push(await this.#checkMountNonempty(workspaceDir));

    // ── Check 3: board-roots-set ─────────────────────────────────────────────
    const boardRootsEnv = this.#getEnv('BOARD_ROOTS') ?? '';
    checks.push(this.#checkBoardRootsSet(boardRootsEnv));

    // ── Check 4: board-roots-valid ───────────────────────────────────────────
    checks.push(await this.#checkBoardRootsValid(boardRootsEnv));

    // ── Check 5: repos-found ─────────────────────────────────────────────────
    try {
      const clones = await this.#listClones();
      repoCount = Array.isArray(clones) ? clones.length : 0;
      checks.push({
        key: 'repos-found',
        status: repoCount > 0 ? 'ok' : 'warn',
        message: repoCount > 0
          ? `${repoCount} Git-Repo(s) im Workspace gefunden.`
          : 'Keine Git-Repos im Workspace gefunden.',
        ...(repoCount === 0 ? {
          fix: 'Klone zunächst ein Repository in den Workspace oder prüfe ob WORKSPACE_DIR korrekt gemountet ist.',
        } : {}),
      });
    } catch (err) {
      checks.push({
        key: 'repos-found',
        status: 'warn',
        message: `Repos konnten nicht aufgelistet werden: ${String(err?.message ?? 'unbekannter Fehler').slice(0, 200)}`,
        fix: 'Prüfe WORKSPACE_DIR und die Dateisystem-Rechte.',
      });
    }

    // ── Check 6: board-projects-found ────────────────────────────────────────
    try {
      const index = await this.#getIndex();
      // Zähle nur valide Projekte (ohne error-Einträge)
      const allProjects = Array.isArray(index) ? index : [];
      boardProjectCount = allProjects.filter((p) => !p.error).length;
      const totalScanned = allProjects.length;

      checks.push({
        key: 'board-projects-found',
        status: boardProjectCount > 0 ? 'ok' : 'warn',
        message: boardProjectCount > 0
          ? `${boardProjectCount} Board-Projekt(e) von ${totalScanned} gescannten Repos gefunden.`
          : 'Keine Board-Projekte (Repos mit board/-Ordner) gefunden.',
        ...(boardProjectCount === 0 ? {
          fix: 'Prüfe ob BOARD_ROOTS korrekt gesetzt ist und auf Repos mit board/-Ordnern zeigt.',
        } : {}),
      });
    } catch (err) {
      checks.push({
        key: 'board-projects-found',
        status: 'warn',
        message: `Board-Projekte konnten nicht abgerufen werden: ${String(err?.message ?? 'unbekannter Fehler').slice(0, 200)}`,
        fix: 'Prüfe BOARD_ROOTS und die Dateisystem-Rechte.',
      });
    }

    const overall = computeOverall(checks);
    return {
      overall,
      checks,
      counts: { repos: repoCount, boardProjects: boardProjectCount },
    };
  }

  // ── Private Check-Methoden ─────────────────────────────────────────────────

  /**
   * mount-exists: WORKSPACE_DIR existiert, ist Verzeichnis, lesbar.
   * @param {string} workspaceDir
   * @returns {Promise<HealthCheck>}
   */
  async #checkMountExists(workspaceDir) {
    if (!workspaceDir) {
      return {
        key: 'mount-exists',
        status: 'error',
        message: 'WORKSPACE_DIR ist nicht gesetzt.',
        fix: 'Setze WORKSPACE_DIR in docker-compose.yml (z.B. WORKSPACE_DIR=/workspace).',
      };
    }

    try {
      const s = await this.#fsDeps.stat(workspaceDir);
      if (!s.isDirectory()) {
        return {
          key: 'mount-exists',
          status: 'error',
          message: `WORKSPACE_DIR '${workspaceDir}' existiert, ist aber kein Verzeichnis.`,
          fix: 'Stelle sicher, dass WORKSPACE_DIR auf ein Verzeichnis zeigt (kein reguläre Datei).',
        };
      }
      return {
        key: 'mount-exists',
        status: 'ok',
        message: `WORKSPACE_DIR '${workspaceDir}' existiert und ist ein Verzeichnis.`,
      };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return {
          key: 'mount-exists',
          status: 'error',
          message: `WORKSPACE_DIR '${workspaceDir}' existiert nicht.`,
          fix: 'Prüfe ob der Host-Volume-Mount in docker-compose.yml korrekt konfiguriert ist.',
        };
      }
      // Prüffehler → warn
      return {
        key: 'mount-exists',
        status: 'warn',
        message: `WORKSPACE_DIR '${workspaceDir}' konnte nicht geprüft werden: ${String(err?.message ?? '').slice(0, 150)}`,
        fix: 'Prüfe die Dateisystem-Rechte für WORKSPACE_DIR.',
      };
    }
  }

  /**
   * mount-nonempty: Mount enthält mindestens einen Eintrag.
   * @param {string} workspaceDir
   * @returns {Promise<HealthCheck>}
   */
  async #checkMountNonempty(workspaceDir) {
    if (!workspaceDir) {
      return {
        key: 'mount-nonempty',
        status: 'error',
        message: 'WORKSPACE_DIR nicht gesetzt — Mount-Inhalt nicht prüfbar.',
      };
    }

    try {
      const entries = await this.#fsDeps.readdir(workspaceDir);
      if (entries.length === 0) {
        return {
          key: 'mount-nonempty',
          status: 'error',
          message: `WORKSPACE_DIR '${workspaceDir}' ist leer.`,
          fix: 'Typisch bei falsch konfiguriertem Host-Volume-Mount: Prüfe den Volume-Eintrag in docker-compose.yml (WORKSPACE_HOST_DIR muss auf einen existierenden Host-Ordner zeigen).',
        };
      }
      return {
        key: 'mount-nonempty',
        status: 'ok',
        message: `WORKSPACE_DIR '${workspaceDir}' enthält ${entries.length} Eintrag/Einträge.`,
      };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return {
          key: 'mount-nonempty',
          status: 'error',
          message: `WORKSPACE_DIR '${workspaceDir}' existiert nicht — kein Mount.`,
          fix: 'Volume-Mount in docker-compose.yml prüfen.',
        };
      }
      return {
        key: 'mount-nonempty',
        status: 'warn',
        message: `WORKSPACE_DIR-Inhalt konnte nicht gelesen werden: ${String(err?.message ?? '').slice(0, 150)}`,
        fix: 'Prüfe die Dateisystem-Rechte für WORKSPACE_DIR.',
      };
    }
  }

  /**
   * board-roots-set: BOARD_ROOTS ist gesetzt und nicht leer.
   * @param {string} boardRootsEnv
   * @returns {HealthCheck}
   */
  #checkBoardRootsSet(boardRootsEnv) {
    if (!boardRootsEnv || !boardRootsEnv.trim()) {
      return {
        key: 'board-roots-set',
        status: 'error',
        message: 'BOARD_ROOTS ist nicht gesetzt.',
        fix: 'Auf dem VPS in docker-compose.yml/.env `BOARD_ROOTS=/workspace` setzen (docker-compose.override.yml gilt dort nicht).',
      };
    }
    return {
      key: 'board-roots-set',
      status: 'ok',
      message: `BOARD_ROOTS ist gesetzt: ${boardRootsEnv.slice(0, 200)}`,
    };
  }

  /**
   * board-roots-valid: Jeder BOARD_ROOTS-Pfad existiert und ist Verzeichnis.
   * @param {string} boardRootsEnv
   * @returns {Promise<HealthCheck>}
   */
  async #checkBoardRootsValid(boardRootsEnv) {
    if (!boardRootsEnv || !boardRootsEnv.trim()) {
      return {
        key: 'board-roots-valid',
        status: 'error',
        message: 'BOARD_ROOTS nicht gesetzt — Pfad-Gültigkeit nicht prüfbar.',
      };
    }

    const paths = boardRootsEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const invalidPaths = [];
    for (const p of paths) {
      try {
        const s = await this.#fsDeps.stat(p);
        if (!s.isDirectory()) {
          invalidPaths.push(`'${p}' (kein Verzeichnis)`);
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          invalidPaths.push(`'${p}' (existiert nicht)`);
        } else {
          // Prüffehler → warn (kein Crash)
          return {
            key: 'board-roots-valid',
            status: 'warn',
            message: `BOARD_ROOTS-Pfad '${p}' konnte nicht geprüft werden: ${String(err?.message ?? '').slice(0, 100)}`,
            fix: 'Prüfe die Dateisystem-Rechte für die Board-Roots.',
          };
        }
      }
    }

    if (invalidPaths.length > 0) {
      return {
        key: 'board-roots-valid',
        status: 'error',
        message: `Ungültige BOARD_ROOTS-Pfade: ${invalidPaths.join(', ')}`,
        fix: 'Prüfe ob alle BOARD_ROOTS-Pfade im Container korrekt gemountet sind.',
      };
    }

    return {
      key: 'board-roots-valid',
      status: 'ok',
      message: `Alle ${paths.length} BOARD_ROOTS-Pfad/Pfade gültig.`,
    };
  }
}
