/**
 * AgentFlowReader — agent-flow Plugin Boundary (read-only, AC1–AC7).
 *
 * Resolves the installed agent-flow plugin root and reads three kinds:
 *   - agents/[star].md           (Frontmatter: name, description, tools, model + body)
 *   - skills/[id]/SKILL.md      (Frontmatter: name, description + body; id = dirname)
 *   - knowledge/ rekursiv inkl. Unterordner, *.md
 *                               (name = first H1 || filename; group = direct subdir || 'core')
 *
 * Plugin-Root resolution (matches docker-entrypoint.sh):
 *   1. ENV-Override: process.env.AGENT_FLOW_PLUGIN_ROOT (if set and non-empty)
 *   2. Newest dir: find $HOME/.claude/plugins/cache/agent-flow -mindepth 2 -maxdepth 2 -type d
 *
 * Security:
 *   - Reads ONLY files under agents/, skills/, knowledge/ of the resolved plugin root.
 *   - :id parameters validated upstream (teamRouter); this reader never takes user input.
 *   - No secrets in output; no writes/executions.
 *
 * Injectable fsDeps for tests (same pattern as WorkspaceScanner).
 *
 * @module AgentFlowReader
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, relative, sep, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Default FS dependencies (real node:fs/promises). */
const defaultFsDeps = { readdir, readFile, stat };

/**
 * Parse YAML-like frontmatter from a Markdown file.
 * Supports simple scalar values and inline arrays: [a, b, c].
 *
 * Returns { frontmatter: {}, body: '' } if no frontmatter present.
 * Never throws — degrades gracefully on malformed input.
 *
 * @param {string} content  Raw file content.
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) {
    return { frontmatter: {}, body: content ?? '' };
  }

  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, '');

  const frontmatter = {};
  for (const rawLine of yamlBlock.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[')) {
      const inner = rawValue.replace(/^\[/, '').replace(/]$/, '');
      if (!inner.trim()) {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = inner.split(',').map((v) => {
          let s = v.trim();
          // Strip surrounding quotes
          if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            s = s.slice(1, -1);
          }
          return s;
        });
      }
    } else {
      // Scalar — strip optional surrounding quotes
      let val = rawValue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }

  return { frontmatter, body };
}

/**
 * Extract the first H1 heading from Markdown content.
 *
 * @param {string} content
 * @returns {string|null}  Heading text, or null if none found.
 */
function extractFirstH1(content) {
  // Match lines like: # Some Heading
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Recursively list all *.md files under a directory.
 * Returns absolute paths.
 *
 * @param {string} dir
 * @param {object} fsDeps
 * @returns {Promise<string[]>}
 */
async function walkMd(dir, fsDeps) {
  let entries;
  try {
    entries = await fsDeps.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkMd(fullPath, fsDeps);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * AgentFlowReader reads the installed agent-flow plugin.
 *
 * @param {object} [options]
 * @param {object} [options.fsDeps]
 *   Injectable filesystem helpers: { readdir, readFile, stat }.
 *   Defaults to real node:fs/promises equivalents.
 * @param {Function} [options.pluginRootResolver]
 *   Optional async () => string|null — overrides the default plugin-root detection.
 *   Used in tests to point at a fixture directory.
 */
export class AgentFlowReader {
  #fsDeps;
  #pluginRootResolver;

  constructor({ fsDeps, pluginRootResolver } = {}) {
    this.#fsDeps = fsDeps ?? defaultFsDeps;
    this.#pluginRootResolver = pluginRootResolver ?? null;
  }

  /**
   * Resolve the agent-flow plugin root directory.
   *
   * Priority:
   *   1. ENV AGENT_FLOW_PLUGIN_ROOT (if set and non-empty)
   *   2. Newest dir under $HOME/.claude/plugins/cache/agent-flow (mindepth=2 maxdepth=2)
   *   3. null (degraded — no plugin installed)
   *
   * @returns {Promise<string|null>}
   */
  async resolvePluginRoot() {
    if (this.#pluginRootResolver) {
      try {
        return await this.#pluginRootResolver();
      } catch {
        return null;
      }
    }

    // 1. ENV-Override
    const envOverride = process.env.AGENT_FLOW_PLUGIN_ROOT;
    if (envOverride && envOverride.trim()) {
      return envOverride.trim();
    }

    // 2. Find newest version dir under $HOME/.claude/plugins/cache/agent-flow
    // Structure: $HOME/.claude/plugins/cache/agent-flow/<slug>/<version>/
    // mindepth=2, maxdepth=2  →  we list depth 1 then depth 2
    const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'agent-flow');
    let depth1Entries;
    try {
      depth1Entries = await this.#fsDeps.readdir(cacheBase, { withFileTypes: true });
    } catch {
      return null;
    }

    const candidates = [];
    for (const d1 of depth1Entries) {
      if (!d1.isDirectory()) continue;
      const d1Path = join(cacheBase, d1.name);
      let depth2Entries;
      try {
        depth2Entries = await this.#fsDeps.readdir(d1Path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d2 of depth2Entries) {
        if (!d2.isDirectory()) continue;
        const d2Path = join(d1Path, d2.name);
        try {
          const st = await this.#fsDeps.stat(d2Path);
          candidates.push({ path: d2Path, mtimeMs: st.mtimeMs });
        } catch {
          // skip
        }
      }
    }

    if (candidates.length === 0) return null;
    // Return the newest (latest mtime)
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
  }

  /**
   * List all agents (without body).
   *
   * @param {string} pluginRoot
   * @returns {Promise<Array<{ id, name, description, model, tools }>>}
   */
  async #listAgents(pluginRoot) {
    const agentsDir = join(pluginRoot, 'agents');
    let entries;
    try {
      entries = await this.#fsDeps.readdir(agentsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.replace(/\.md$/, '');
      const filePath = join(agentsDir, entry.name);
      let content;
      try {
        content = await this.#fsDeps.readFile(filePath, 'utf8');
      } catch {
        // unreadable → skip
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      results.push({
        id,
        name: frontmatter.name ?? '',
        description: frontmatter.description ?? '',
        model: frontmatter.model ?? '',
        tools: frontmatter.tools ?? [],
      });
    }

    results.sort((a, b) => a.id.localeCompare(b.id));
    return results;
  }

  /**
   * List all skills (without body).
   *
   * @param {string} pluginRoot
   * @returns {Promise<Array<{ id, name, description }>>}
   */
  async #listSkills(pluginRoot) {
    const skillsDir = join(pluginRoot, 'skills');
    let entries;
    try {
      entries = await this.#fsDeps.readdir(skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const skillFile = join(skillsDir, id, 'SKILL.md');
      let content;
      try {
        content = await this.#fsDeps.readFile(skillFile, 'utf8');
      } catch {
        // unreadable → skip
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      results.push({
        id,
        name: frontmatter.name ?? '',
        description: frontmatter.description ?? '',
      });
    }

    results.sort((a, b) => a.id.localeCompare(b.id));
    return results;
  }

  /**
   * List all knowledge packs (without body).
   *
   * @param {string} pluginRoot
   * @returns {Promise<Array<{ id, name, group }>>}
   */
  async #listKnowledge(pluginRoot) {
    const knowledgeDir = join(pluginRoot, 'knowledge');
    const allFiles = await walkMd(knowledgeDir, this.#fsDeps);

    const results = [];
    for (const filePath of allFiles) {
      const relPath = relative(knowledgeDir, filePath);
      // relPath examples: "js.md", "frameworks/spring-boot-3.md"
      const parts = relPath.split(sep);

      // id = relative path without .md (unique within knowledge/)
      const id = relPath.replace(/\.md$/, '').replace(/\\/g, '/');

      // group = first segment if in a subdir, else 'core'
      const group = parts.length > 1 ? parts[0] : 'core';

      let content;
      try {
        content = await this.#fsDeps.readFile(filePath, 'utf8');
      } catch {
        // unreadable → skip
        continue;
      }

      const h1 = extractFirstH1(content);
      const name = h1 ?? basename(filePath, '.md');

      results.push({ id, name, group });
    }

    // Sort: group first, then name
    results.sort((a, b) => {
      const g = a.group.localeCompare(b.group);
      if (g !== 0) return g;
      return a.name.localeCompare(b.name);
    });
    return results;
  }

  /**
   * Return the overview: all three kinds without body.
   * Degrades to empty lists if plugin root cannot be resolved.
   *
   * @returns {Promise<{ agents: Array, skills: Array, knowledge: Array }>}
   */
  async getOverview() {
    const root = await this.resolvePluginRoot();
    if (!root) {
      return { agents: [], skills: [], knowledge: [] };
    }
    const [agents, skills, knowledge] = await Promise.allSettled([
      this.#listAgents(root),
      this.#listSkills(root),
      this.#listKnowledge(root),
    ]);
    return {
      agents:    agents.status    === 'fulfilled' ? agents.value    : [],
      skills:    skills.status    === 'fulfilled' ? skills.value    : [],
      knowledge: knowledge.status === 'fulfilled' ? knowledge.value : [],
    };
  }

  /**
   * Return meta + body for a single agent.
   *
   * @param {string} pluginRoot
   * @param {string} id  Validated agent id (filename without .md).
   * @returns {Promise<{ id, name, description, model, tools, body }|null>}
   */
  async #getAgent(pluginRoot, id) {
    const agentsDir = join(pluginRoot, 'agents');
    const filePath = join(agentsDir, `${id}.md`);
    // Defense-in-depth: ensure resolved path stays inside agents/
    if (!resolve(filePath).startsWith(resolve(agentsDir) + sep)) {
      return null;
    }
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      id,
      name: frontmatter.name ?? '',
      description: frontmatter.description ?? '',
      model: frontmatter.model ?? '',
      tools: frontmatter.tools ?? [],
      body,
    };
  }

  /**
   * Return meta + body for a single skill.
   *
   * @param {string} pluginRoot
   * @param {string} id  Validated skill id (dirname).
   * @returns {Promise<{ id, name, description, body }|null>}
   */
  async #getSkill(pluginRoot, id) {
    const skillsDir = join(pluginRoot, 'skills');
    const filePath = join(skillsDir, id, 'SKILL.md');
    // Defense-in-depth: ensure resolved path stays inside skills/
    if (!resolve(filePath).startsWith(resolve(skillsDir) + sep)) {
      return null;
    }
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      id,
      name: frontmatter.name ?? '',
      description: frontmatter.description ?? '',
      body,
    };
  }

  /**
   * Return meta + body for a single knowledge pack.
   * id is the relative path without .md (e.g. "js" or "frameworks/spring-boot-3").
   *
   * @param {string} pluginRoot
   * @param {string} id  Validated knowledge id.
   * @returns {Promise<{ id, name, group, body }|null>}
   */
  async #getKnowledge(pluginRoot, id) {
    const knowledgeDir = join(pluginRoot, 'knowledge');
    const filePath = join(knowledgeDir, `${id}.md`);
    // Defense-in-depth: ensure resolved path stays inside knowledge/
    if (!resolve(filePath).startsWith(resolve(knowledgeDir) + sep)) {
      return null;
    }
    let content;
    try {
      content = await this.#fsDeps.readFile(filePath, 'utf8');
    } catch {
      return null;
    }

    // Derive group from id
    const parts = id.split('/');
    const group = parts.length > 1 ? parts[0] : 'core';

    const h1 = extractFirstH1(content);
    const name = h1 ?? basename(id);

    return { id, name, group, body: content };
  }

  /**
   * Return meta + body for a single entry by kind and id.
   * Returns null if not found or root unavailable.
   *
   * @param {'agent'|'skill'|'knowledge'} kind
   * @param {string} id  Pre-validated id.
   * @returns {Promise<object|null>}
   */
  async getDetail(kind, id) {
    const root = await this.resolvePluginRoot();
    if (!root) return null;

    switch (kind) {
      case 'agent':     return this.#getAgent(root, id);
      case 'skill':     return this.#getSkill(root, id);
      case 'knowledge': return this.#getKnowledge(root, id);
      default:          return null;
    }
  }
}
