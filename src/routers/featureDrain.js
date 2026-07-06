/**
 * Router-Wrapper: Feature-Umsetzen-Button (feature-umsetzen-button, Owner-
 * Auftrag 2026-07-06). Factory-Signatur: create(deps) → Express Router.
 * Montiert:
 *   POST /api/board/projects/:slug/features/:featureId/batch
 *     — startet scripts/board-feature-drain.sh <F-###> fire-and-forget
 *       (eigene FeatureDrainRegistry + ProjectJobLock, getrennt von allen
 *       anderen headless-Boundaries — Muster docs/architecture headless-*).
 *   GET  /api/board/projects/:slug/features/:featureId/batch
 *     — liest den autoritativen Zustand (ready|running|done), abgeleitet
 *       aus dem UNGEFILTERTEN Story-Bestand des Features (design.md
 *       „Feature-Umsetzen-Button" Abschnitt 3) + der Registry.
 */
import { Router } from 'express';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { parseYaml } from '../BoardAggregator.js';

export const order = 187;

const FEATURE_ID_RE = /^F-\d+$/;

/**
 * Ungefilterte Kind-Storys eines Features direkt aus den YAML-Dateien lesen
 * (design.md „Feature-Umsetzen-Button" Abschnitt 3 — bewusst NICHT
 * `feature.stories` aus dem BoardAggregator-Index, das ist die im Board ggf.
 * gefilterte Teilmenge). Wiederverwendet `BoardAggregator.parseYaml()` — kein
 * dritter YAML-Parser im Repo.
 * @returns {Promise<Array<{id:string,status:string}>>}
 */
async function readAllFeatureStories(repoPath, featureId) {
  const storiesDir = join(repoPath, 'board', 'stories');
  let files;
  try {
    files = (await readdir(storiesDir)).filter((f) => f.endsWith('.yaml'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let data;
    try {
      data = parseYaml(await readFile(join(storiesDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (data && String(data.parent ?? '').trim() === featureId) {
      out.push({ id: String(data.id ?? ''), status: String(data.status ?? '').trim() });
    }
  }
  return out;
}

function deriveState({ featureDrainRegistry, projectSlug, featureId, stories }) {
  if (featureDrainRegistry.isRunning(projectSlug, featureId)) return 'running';
  if (stories.length === 0) return 'ready'; // Button wird ohnehin nicht gerendert (D2), Wert egal
  const allTerminal = stories.every((s) => s.status === 'Done' || s.status === 'Verworfen');
  return allTerminal ? 'done' : 'ready';
}

/**
 * @param {{
 *   boardAggregator: import('../BoardAggregator.js').BoardAggregator,
 *   featureDrainRegistry: import('../FeatureDrainRegistry.js').FeatureDrainRegistry,
 *   featureDrainRunner: import('../FeatureDrainRunner.js').FeatureDrainRunner,
 *   featureDrainLock: import('../ProjectJobLock.js').ProjectJobLock,
 *   agentFlowReader: import('../AgentFlowReader.js').AgentFlowReader,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ boardAggregator, featureDrainRegistry, featureDrainRunner, featureDrainLock, agentFlowReader }) {
  const router = Router();

  async function findFeature(slug, featureId) {
    const projects = await boardAggregator.getIndex({ includeArchived: true });
    const project = projects.find((p) => p.slug === slug);
    if (!project || project.error) return { project: null, feature: null };
    const feature = (project.features ?? []).find((f) => f.id === featureId) ?? null;
    return { project, feature };
  }

  router.get('/api/board/projects/:slug/features/:featureId/batch', async (req, res) => {
    const { slug, featureId } = req.params;
    if (!FEATURE_ID_RE.test(featureId)) return res.status(400).json({ error: 'ungültige Feature-ID' });
    const { project, feature } = await findFeature(slug, featureId);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (!feature) return res.status(404).json({ error: 'Feature nicht gefunden' });
    const stories = await readAllFeatureStories(project.repo_path, featureId);
    const state = deriveState({ featureDrainRegistry, projectSlug: slug, featureId, stories });
    const job = featureDrainRegistry.getJob(slug, featureId);
    return res.status(200).json({ state, error: job?.status === 'failed' ? job.error : undefined });
  });

  router.post('/api/board/projects/:slug/features/:featureId/batch', async (req, res) => {
    const { slug, featureId } = req.params;
    if (!FEATURE_ID_RE.test(featureId)) return res.status(400).json({ error: 'ungültige Feature-ID' });

    const { project, feature } = await findFeature(slug, featureId);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    if (!feature) return res.status(404).json({ error: 'Feature nicht gefunden' });

    const stories = await readAllFeatureStories(project.repo_path, featureId);
    if (stories.length < 2) {
      return res.status(400).json({
        error: 'Feature hat weniger als 2 Storys — Bündelung bringt hier keinen Vorteil. Bitte einzeln über "Board abarbeiten" verarbeiten.',
      });
    }

    const lockKey = `${slug}:${featureId}`;
    if (!featureDrainLock.tryAcquire(lockKey)) {
      return res.status(409).json({ error: 'Feature-Batch läuft für dieses Feature bereits' });
    }

    let pluginRoot;
    try {
      pluginRoot = await agentFlowReader.resolvePluginRoot();
    } catch {
      pluginRoot = null;
    }
    if (!pluginRoot) {
      featureDrainLock.release(lockKey);
      return res.status(503).json({ error: 'agent-flow-Plugin nicht gefunden' });
    }

    featureDrainRunner.start({
      projectSlug: slug,
      repoPath: project.repo_path,
      featureId,
      appName: req.body?.appName,
      agentFlowScriptsDir: join(pluginRoot, 'scripts'),
    });
    // Lock wird bewusst NICHT hier freigegeben — bleibt für die gesamte
    // Batch-Laufzeit gehalten (verhindert Doppel-Start); Freigabe passiert
    // über den `close`-Handler in FeatureDrainRunner via server.js-Wiring.
    return res.status(202).json({ state: 'running' });
  });

  return router;
}
