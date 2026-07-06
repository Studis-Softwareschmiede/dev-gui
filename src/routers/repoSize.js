/**
 * Router-Wrapper: Repo-Größen-Anzeige — Read + Refresh (repo-size-badge AC4–AC8, S-298).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert:
 *   GET  /api/workspace/repo-sizes[?repo=<slug>]  — read-only, nie blockierend (AC4/AC6)
 *   POST /api/workspace/repo-sizes/refresh { repo } — startet Hintergrund-Messung, antwortet sofort (AC5/AC7)
 *
 * Non-blocking (AC4): kein Endpunkt wartet je auf einen laufenden/neuen Scan.
 * Dedup (AC5): ProjectJobLock (Muster wie manualDrainLock) verhindert einen zweiten
 * gleichzeitigen Scan je Klon — ein zweiter Trigger während eines laufenden Scans
 * ist No-op (koalesziert), kein Fehler.
 * Schwellwert (AC8): GIT_SIZE_WARN_MB (Default 500), pro Response berechnet.
 */
import { Router } from 'express';
import { cloneExists } from '../RepoSizeScanner.js';

export const order = 186;

const DEFAULT_GIT_WARN_MB = 500;

function gitWarnBytes() {
  const raw = Number(process.env.GIT_SIZE_WARN_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_WARN_MB;
  return mb * 1024 * 1024;
}

function toPayload(slug, size) {
  return {
    repo: slug,
    total: size?.total ?? 0,
    git: size?.git ?? 0,
    artifacts: size?.artifacts ?? 0,
    workspace: size?.workspace ?? 0,
    measuredAt: size?.measuredAt ?? null,
    gitWarning: (size?.git ?? 0) > gitWarnBytes(),
  };
}

/**
 * @param {{
 *   repoSizeScanner: import('../RepoSizeScanner.js').RepoSizeScanner,
 *   repoSizeStore: import('../RepoSizeStore.js').RepoSizeStore,
 *   resolveWorkspaceRoot: Function,
 *   repoSizeRefreshLock?: import('../ProjectJobLock.js').ProjectJobLock,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ repoSizeScanner, repoSizeStore, resolveWorkspaceRoot, repoSizeRefreshLock }) {
  const router = Router();
  // Eigene Lock-Instanz falls keine injiziert wurde (Tests injizieren i.d.R. eine eigene).
  const lock = repoSizeRefreshLock;

  function runScanInBackground(slug) {
    if (!lock.tryAcquire(slug)) return; // AC5: bereits ein Scan im Gange — koalesziert, kein Fehler
    Promise.resolve()
      .then(() => repoSizeScanner.scan(slug))
      .then((buckets) => repoSizeStore.record(slug, buckets))
      .catch((err) => {
        // AC5: ein Scan-Fehler lässt übrige Klone unberührt, letzter bekannter Wert bleibt intakt.
        console.error(`[repoSize] Scan fehlgeschlagen für '${slug}':`, err.message);
      })
      .finally(() => lock.release(slug));
  }

  router.get('/api/workspace/repo-sizes', async (req, res) => {
    const filter = typeof req.query?.repo === 'string' ? req.query.repo.trim() : '';
    const all = await repoSizeStore.list();
    const sizes = filter
      ? (all.has(filter) ? [toPayload(filter, all.get(filter))] : [])
      : [...all.entries()].map(([slug, size]) => toPayload(slug, size));
    return res.status(200).json({ sizes });
  });

  router.post('/api/workspace/repo-sizes/refresh', async (req, res) => {
    const slug = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
    if (!slug) {
      return res.status(400).json({ error: 'repo ist erforderlich' });
    }
    const exists = await cloneExists({ slug, workspaceRootResolver: resolveWorkspaceRoot });
    if (!exists) {
      return res.status(404).json({ error: 'Klon nicht gefunden' });
    }
    runScanInBackground(slug); // fire-and-forget, non-blocking (AC4/AC7)
    return res.status(202).json({ repo: slug, status: 'scanning' });
  });

  return router;
}
