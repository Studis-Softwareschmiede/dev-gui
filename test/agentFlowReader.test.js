/**
 * agentFlowReader.test.js — Tests for AgentFlowReader
 *
 * Covers (team-view-backend):
 *   AC1 — Overview field shapes: id/name/description/model/tools (agents), id/name/description (skills), id/name/group (knowledge); no body field
 *   AC2 — Frontmatter parsing: agents (name, description, tools, model) + skills (name, description)
 *   AC3 — Knowledge: recursive scan, H1 name extraction, filename fallback, group detection incl. subdirs
 *   AC7 — Degradation: no plugin root → empty lists, no crash
 *   AC8 — No secrets in response (overview and detail contain only Markdown content/metadata)
 *
 * Covers (team-detail-related-refs):
 *   AC1 (refs) — Agent detail includes relatedSkills [{id,name}] and relatedKnowledge [{id,name,group}]; deduplicated + stably sorted; empty arrays when none
 *   AC2 (refs) — Frontmatter-first (skills/knowledge field), body-fallback when field absent
 *   AC3 (refs) — Dead-link pruning: non-existent skill/knowledge ids discarded
 *   AC4 (refs) — Skill + knowledge detail include usedByAgents [{id,name}]; deduplicated + stably sorted; empty array when none
 *   AC5 (refs) — Consistency: forward ↔ reverse references agree
 *   AC6 (refs) — Security/Floor: no new paths read outside agents/skills/knowledge; degradation without plugin (empty lists); no crash
 *
 * Strategy:
 *   - Inject fake fsDeps (readFile, readdir, stat) so no real filesystem is touched.
 *   - Use in-memory fixture structures for deterministic tests.
 */

import { describe, it, expect } from '@jest/globals';
import { AgentFlowReader, parseFrontmatter, resolveAgentRefs } from '../src/AgentFlowReader.js';

// ── parseFrontmatter unit tests ───────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses simple scalar fields', () => {
    const content = '---\nname: My Agent\ndescription: Does stuff\nmodel: claude-3\n---\nBody here.';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('My Agent');
    expect(frontmatter.description).toBe('Does stuff');
    expect(frontmatter.model).toBe('claude-3');
    expect(body).toBe('Body here.');
  });

  it('parses inline array for tools', () => {
    const content = '---\ntools: [Read, Write, Bash]\n---\nBody.';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('parses empty inline array', () => {
    const content = '---\ntools: []\n---\n';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tools).toEqual([]);
  });

  it('returns empty frontmatter when no --- delimiter', () => {
    const content = 'Just a body, no frontmatter.';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a body, no frontmatter.');
  });

  it('returns empty frontmatter when closing --- is missing', () => {
    const content = '---\nname: broken\n';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it('strips surrounding quotes from scalar values', () => {
    const content = '---\nname: "Quoted Name"\ndescription: \'Single Quoted\'\n---\n';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('Quoted Name');
    expect(frontmatter.description).toBe('Single Quoted');
  });

  it('separates body correctly', () => {
    const content = '---\nname: Test\n---\n# Heading\n\nParagraph.';
    const { body } = parseFrontmatter(content);
    expect(body).toBe('# Heading\n\nParagraph.');
  });

  it('handles empty content gracefully', () => {
    const { frontmatter, body } = parseFrontmatter('');
    expect(frontmatter).toEqual({});
    expect(body).toBe('');
  });

  it('handles null content gracefully', () => {
    const { frontmatter, body } = parseFrontmatter(null);
    expect(frontmatter).toEqual({});
    expect(body).toBe('');
  });
});

// ── Fixture builder ───────────────────────────────────────────────────────────

/**
 * Build in-memory file system fixtures.
 *
 * fileMap: { '<path>': '<content>' }
 * dirMap: { '<dir>': [{ name, isDirectory, isFile }] }
 */
function buildFakeFsDeps({ fileMap = {}, dirMap = {} } = {}) {
  return {
    readFile: async (path, _enc) => {
      if (path in fileMap) return fileMap[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
    readdir: async (dir, _opts) => {
      if (dir in dirMap) return dirMap[dir];
      const err = new Error(`ENOENT: ${dir}`);
      err.code = 'ENOENT';
      throw err;
    },
    stat: async (path) => {
      if (path in fileMap) return { mtimeMs: 1000, isFile: () => true, isDirectory: () => false };
      if (path in dirMap) return { mtimeMs: 1000, isFile: () => false, isDirectory: () => true };
      const err = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

/** Create a directory entry object matching the withFileTypes: true API. */
function dirEntry(name) {
  return { name, isDirectory: () => true, isFile: () => false };
}
function fileEntry(name) {
  return { name, isDirectory: () => false, isFile: () => true };
}

const PLUGIN_ROOT = '/fake/plugin';

function makeReader(fileMap, dirMap) {
  const fsDeps = buildFakeFsDeps({ fileMap, dirMap });
  return new AgentFlowReader({
    fsDeps,
    pluginRootResolver: async () => PLUGIN_ROOT,
  });
}

// ── AC2 — Agent Frontmatter Parsing ──────────────────────────────────────────

describe('AC2 — AgentFlowReader: agent frontmatter parsing', () => {
  const agentContent = `---
name: Orchestrator
description: Manages the flow
model: claude-opus-4-5
tools: [Read, Write, Bash, mcp__github]
---
# Orchestrator

This agent orchestrates tasks.
`;

  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/orchestrator.md`]: agentContent,
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('orchestrator.md')],
    },
  );

  it('extracts name from frontmatter', async () => {
    const { agents } = await reader.getOverview();
    expect(agents[0].name).toBe('Orchestrator');
  });

  it('extracts description from frontmatter', async () => {
    const { agents } = await reader.getOverview();
    expect(agents[0].description).toBe('Manages the flow');
  });

  it('extracts model from frontmatter', async () => {
    const { agents } = await reader.getOverview();
    expect(agents[0].model).toBe('claude-opus-4-5');
  });

  it('extracts tools array from frontmatter', async () => {
    const { agents } = await reader.getOverview();
    expect(agents[0].tools).toEqual(['Read', 'Write', 'Bash', 'mcp__github']);
  });

  it('sets id from filename without .md', async () => {
    const { agents } = await reader.getOverview();
    expect(agents[0].id).toBe('orchestrator');
  });

  it('overview agent entry has no body field', async () => {
    const { agents } = await reader.getOverview();
    expect('body' in agents[0]).toBe(false);
  });

  it('getDetail returns body for agent', async () => {
    const detail = await reader.getDetail('agent', 'orchestrator');
    expect(detail).not.toBeNull();
    expect(detail.body).toContain('# Orchestrator');
  });
});

// ── AC2 — Skill Frontmatter Parsing ──────────────────────────────────────────

describe('AC2 — AgentFlowReader: skill frontmatter parsing', () => {
  const skillContent = `---
name: Deploy Skill
description: Deploys the application
---
## Usage

Run /deploy to deploy.
`;

  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/skills/deploy/SKILL.md`]: skillContent,
    },
    {
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('deploy')],
    },
  );

  it('extracts name from skill frontmatter', async () => {
    const { skills } = await reader.getOverview();
    expect(skills[0].name).toBe('Deploy Skill');
  });

  it('extracts description from skill frontmatter', async () => {
    const { skills } = await reader.getOverview();
    expect(skills[0].description).toBe('Deploys the application');
  });

  it('uses directory name as skill id', async () => {
    const { skills } = await reader.getOverview();
    expect(skills[0].id).toBe('deploy');
  });

  it('overview skill entry has no body field', async () => {
    const { skills } = await reader.getOverview();
    expect('body' in skills[0]).toBe(false);
  });

  it('getDetail returns body for skill', async () => {
    const detail = await reader.getDetail('skill', 'deploy');
    expect(detail).not.toBeNull();
    expect(detail.body).toContain('## Usage');
  });
});

// ── AC3 — Knowledge H1/filename/group ─────────────────────────────────────────

describe('AC3 — AgentFlowReader: knowledge name + group', () => {
  const jsContent = `# Knowledge Pack: js

Some content.
`;
  const secContent = `# Security Knowledge

Security guidelines.
`;
  const frameworkContent = `No H1 heading here. Just content.`;

  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/knowledge/js.md`]: jsContent,
      [`${PLUGIN_ROOT}/knowledge/security.md`]: secContent,
      [`${PLUGIN_ROOT}/knowledge/frameworks/spring-boot-3.md`]: frameworkContent,
    },
    {
      [`${PLUGIN_ROOT}/knowledge`]: [
        fileEntry('js.md'),
        fileEntry('security.md'),
        dirEntry('frameworks'),
      ],
      [`${PLUGIN_ROOT}/knowledge/frameworks`]: [
        fileEntry('spring-boot-3.md'),
      ],
    },
  );

  it('uses first H1 as name', async () => {
    const { knowledge } = await reader.getOverview();
    const js = knowledge.find((k) => k.id === 'js');
    expect(js.name).toBe('Knowledge Pack: js');
  });

  it('falls back to filename without .md when no H1', async () => {
    const { knowledge } = await reader.getOverview();
    const fw = knowledge.find((k) => k.id === 'frameworks/spring-boot-3');
    expect(fw.name).toBe('spring-boot-3');
  });

  it('group is "core" for files directly under knowledge/', async () => {
    const { knowledge } = await reader.getOverview();
    const js = knowledge.find((k) => k.id === 'js');
    expect(js.group).toBe('core');
  });

  it('group is the direct subdir name for nested files', async () => {
    const { knowledge } = await reader.getOverview();
    const fw = knowledge.find((k) => k.id === 'frameworks/spring-boot-3');
    expect(fw.group).toBe('frameworks');
  });

  it('overview knowledge entry has no body field', async () => {
    const { knowledge } = await reader.getOverview();
    for (const k of knowledge) {
      expect('body' in k).toBe(false);
    }
  });

  it('getDetail returns raw body for knowledge pack', async () => {
    const detail = await reader.getDetail('knowledge', 'js');
    expect(detail).not.toBeNull();
    expect(detail.body).toContain('Some content.');
  });

  it('getDetail returns body for nested knowledge pack', async () => {
    const detail = await reader.getDetail('knowledge', 'frameworks/spring-boot-3');
    expect(detail).not.toBeNull();
    expect(detail.body).toBe(frameworkContent);
  });
});

// ── AC3 — Knowledge recursive scan ───────────────────────────────────────────

describe('AC3 — AgentFlowReader: knowledge recursive scan includes subdirectories', () => {
  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/knowledge/top.md`]: '# Top Level',
      [`${PLUGIN_ROOT}/knowledge/build/gradle.md`]: '# Gradle Pack',
      [`${PLUGIN_ROOT}/knowledge/migration/flyway.md`]: '# Flyway',
    },
    {
      [`${PLUGIN_ROOT}/knowledge`]: [
        fileEntry('top.md'),
        dirEntry('build'),
        dirEntry('migration'),
      ],
      [`${PLUGIN_ROOT}/knowledge/build`]: [fileEntry('gradle.md')],
      [`${PLUGIN_ROOT}/knowledge/migration`]: [fileEntry('flyway.md')],
    },
  );

  it('finds files in root, build/ and migration/ subdirs', async () => {
    const { knowledge } = await reader.getOverview();
    const ids = knowledge.map((k) => k.id);
    expect(ids).toContain('top');
    expect(ids).toContain('build/gradle');
    expect(ids).toContain('migration/flyway');
  });

  it('all three entries have the correct groups', async () => {
    const { knowledge } = await reader.getOverview();
    const byId = Object.fromEntries(knowledge.map((k) => [k.id, k]));
    expect(byId['top'].group).toBe('core');
    expect(byId['build/gradle'].group).toBe('build');
    expect(byId['migration/flyway'].group).toBe('migration');
  });
});

// ── AC1 — Overview field shapes ───────────────────────────────────────────────

describe('AC1 — Overview: correct field shapes, no body', () => {
  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/coder.md`]: '---\nname: Coder\ndescription: Writes code\nmodel: claude-3\ntools: [Read]\n---\nBody.',
      [`${PLUGIN_ROOT}/skills/review/SKILL.md`]: '---\nname: Review\ndescription: Reviews code\n---\nSkill body.',
      [`${PLUGIN_ROOT}/knowledge/ts.md`]: '# TypeScript\n\nContent.',
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('coder.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('review')],
      [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('ts.md')],
    },
  );

  it('agent entry has id, name, description, model, tools — no body', async () => {
    const { agents } = await reader.getOverview();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toHaveProperty('id');
    expect(agents[0]).toHaveProperty('name');
    expect(agents[0]).toHaveProperty('description');
    expect(agents[0]).toHaveProperty('model');
    expect(agents[0]).toHaveProperty('tools');
    expect(agents[0]).not.toHaveProperty('body');
  });

  it('skill entry has id, name, description — no body', async () => {
    const { skills } = await reader.getOverview();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toHaveProperty('id');
    expect(skills[0]).toHaveProperty('name');
    expect(skills[0]).toHaveProperty('description');
    expect(skills[0]).not.toHaveProperty('body');
  });

  it('knowledge entry has id, name, group — no body', async () => {
    const { knowledge } = await reader.getOverview();
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]).toHaveProperty('id');
    expect(knowledge[0]).toHaveProperty('name');
    expect(knowledge[0]).toHaveProperty('group');
    expect(knowledge[0]).not.toHaveProperty('body');
  });
});

// ── AC7 — Degradation: plugin root missing ────────────────────────────────────

describe('AC7 — AgentFlowReader: no plugin → empty lists, no crash', () => {
  it('getOverview returns empty lists when resolver returns null', async () => {
    const reader = new AgentFlowReader({
      pluginRootResolver: async () => null,
    });
    const result = await reader.getOverview();
    expect(result).toEqual({ agents: [], skills: [], knowledge: [] });
  });

  it('getOverview returns empty lists when resolver throws', async () => {
    const reader = new AgentFlowReader({
      pluginRootResolver: async () => { throw new Error('no plugin'); },
    });
    const result = await reader.getOverview();
    expect(result).toEqual({ agents: [], skills: [], knowledge: [] });
  });

  it('getDetail returns null when plugin root missing', async () => {
    const reader = new AgentFlowReader({
      pluginRootResolver: async () => null,
    });
    const detail = await reader.getDetail('agent', 'orchestrator');
    expect(detail).toBeNull();
  });

  it('getOverview returns empty lists when agents dir missing', async () => {
    const fsDeps = buildFakeFsDeps({
      dirMap: {
        [`${PLUGIN_ROOT}/skills`]: [],
        [`${PLUGIN_ROOT}/knowledge`]: [],
      },
    });
    const reader = new AgentFlowReader({
      fsDeps,
      pluginRootResolver: async () => PLUGIN_ROOT,
    });
    const result = await reader.getOverview();
    expect(result.agents).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.knowledge).toEqual([]);
  });
});

// ── AC8 — Secrets not in response ─────────────────────────────────────────────

describe('AC8 — No secrets in response', () => {
  const sensitiveContent = '---\nname: Agent\ndescription: Normal agent\nmodel: claude-3\ntools: []\n---\n# Agent\nThis is the agent body.';

  const reader = makeReader(
    { [`${PLUGIN_ROOT}/agents/agent.md`]: sensitiveContent },
    { [`${PLUGIN_ROOT}/agents`]: [fileEntry('agent.md')] },
  );

  it('overview response does not contain raw file paths', async () => {
    const overview = await reader.getOverview();
    const json = JSON.stringify(overview);
    expect(json).not.toContain(PLUGIN_ROOT);
  });

  it('detail response body is the raw Markdown content (no path leakage)', async () => {
    const detail = await reader.getDetail('agent', 'agent');
    expect(detail.body).not.toContain(PLUGIN_ROOT);
  });
});

// ── Stable sort ───────────────────────────────────────────────────────────────

describe('Stable alphabetical sort', () => {
  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/zebra.md`]: '---\nname: Zebra\ndescription: Z\nmodel: m\ntools: []\n---\n',
      [`${PLUGIN_ROOT}/agents/alpha.md`]: '---\nname: Alpha\ndescription: A\nmodel: m\ntools: []\n---\n',
      [`${PLUGIN_ROOT}/skills/z-skill/SKILL.md`]: '---\nname: Z\ndescription: Z\n---\n',
      [`${PLUGIN_ROOT}/skills/a-skill/SKILL.md`]: '---\nname: A\ndescription: A\n---\n',
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('zebra.md'), fileEntry('alpha.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('z-skill'), dirEntry('a-skill')],
      [`${PLUGIN_ROOT}/knowledge`]: [],
    },
  );

  it('agents are sorted alphabetically by id', async () => {
    const { agents } = await reader.getOverview();
    expect(agents.map((a) => a.id)).toEqual(['alpha', 'zebra']);
  });

  it('skills are sorted alphabetically by id', async () => {
    const { skills } = await reader.getOverview();
    expect(skills.map((s) => s.id)).toEqual(['a-skill', 'z-skill']);
  });
});

// ── resolveAgentRefs unit tests ───────────────────────────────────────────────

describe('resolveAgentRefs — unit tests', () => {
  const skillSet     = new Set(['flow', 'train', 'deploy']);
  const knowledgeSet = new Set(['js', 'security', 'frameworks/spring-boot-3']);

  it('body-fallback: detects a skill id that appears as a standalone token', () => {
    const { skillIds } = resolveAgentRefs({}, 'Uses the flow skill.', skillSet, knowledgeSet);
    expect(skillIds).toContain('flow');
  });

  it('body-fallback: does not detect a skill id that appears inside a larger word', () => {
    // "workflow" contains "flow" but must not match because it is not a standalone token
    const { skillIds } = resolveAgentRefs({}, 'This is a workflow tool.', skillSet, knowledgeSet);
    expect(skillIds).not.toContain('flow');
  });

  it('body-fallback: detects knowledge/<path>.md pattern', () => {
    const { knowledgeIds } = resolveAgentRefs(
      {},
      'Load knowledge/js.md for this task.',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toContain('js');
  });

  it('body-fallback: detects knowledge path with ${CLAUDE_PLUGIN_ROOT}/ prefix', () => {
    const { knowledgeIds } = resolveAgentRefs(
      {},
      'Uses ${CLAUDE_PLUGIN_ROOT}/knowledge/security.md',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toContain('security');
  });

  it('body-fallback: detects nested knowledge path', () => {
    const { knowledgeIds } = resolveAgentRefs(
      {},
      'See knowledge/frameworks/spring-boot-3.md for details.',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toContain('frameworks/spring-boot-3');
  });

  it('body-fallback: ignores knowledge path that does not exist in the knowledge set', () => {
    const { knowledgeIds } = resolveAgentRefs(
      {},
      'See knowledge/nonexistent.md for details.',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).not.toContain('nonexistent');
  });

  it('frontmatter takes precedence over body for skills', () => {
    // Frontmatter lists "deploy"; body mentions "flow"
    // → only "deploy" should be in skillIds (frontmatter wins)
    const { skillIds } = resolveAgentRefs(
      { skills: ['deploy'] },
      'Mentions flow in the body.',
      skillSet, knowledgeSet,
    );
    expect(skillIds).toEqual(['deploy']);
    expect(skillIds).not.toContain('flow');
  });

  it('frontmatter takes precedence over body for knowledge', () => {
    // Frontmatter lists "security"; body mentions knowledge/js.md
    // → only "security" should be in knowledgeIds (frontmatter wins)
    const { knowledgeIds } = resolveAgentRefs(
      { knowledge: ['security'] },
      'Load knowledge/js.md for this task.',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toEqual(['security']);
    expect(knowledgeIds).not.toContain('js');
  });

  it('frontmatter: non-existent skill is dropped (AC3)', () => {
    const { skillIds } = resolveAgentRefs(
      { skills: ['flow', 'ghost-skill'] },
      '',
      skillSet, knowledgeSet,
    );
    expect(skillIds).toContain('flow');
    expect(skillIds).not.toContain('ghost-skill');
  });

  it('frontmatter: non-existent knowledge id is dropped (AC3)', () => {
    const { knowledgeIds } = resolveAgentRefs(
      { knowledge: ['js', 'ghost-knowledge'] },
      '',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toContain('js');
    expect(knowledgeIds).not.toContain('ghost-knowledge');
  });

  it('result is deduplicated even if body mentions a path twice', () => {
    const body = 'Load knowledge/js.md and also knowledge/js.md again.';
    const { knowledgeIds } = resolveAgentRefs({}, body, skillSet, knowledgeSet);
    expect(knowledgeIds.filter((id) => id === 'js')).toHaveLength(1);
  });

  it('result is stably sorted alphabetically', () => {
    const body = 'Uses train skill and also flow skill. Loads knowledge/security.md and knowledge/js.md.';
    const { skillIds, knowledgeIds } = resolveAgentRefs({}, body, skillSet, knowledgeSet);
    expect(skillIds).toEqual([...skillIds].sort((a, b) => a.localeCompare(b)));
    expect(knowledgeIds).toEqual([...knowledgeIds].sort((a, b) => a.localeCompare(b)));
  });

  it('returns empty arrays when body has no matches', () => {
    const { skillIds, knowledgeIds } = resolveAgentRefs({}, 'No references here.', skillSet, knowledgeSet);
    expect(skillIds).toEqual([]);
    expect(knowledgeIds).toEqual([]);
  });

  it('frontmatter: accepts bare knowledge id (no path form)', () => {
    const { knowledgeIds } = resolveAgentRefs(
      { knowledge: ['js'] },
      '',
      skillSet, knowledgeSet,
    );
    expect(knowledgeIds).toContain('js');
  });
});

// ── AC1 (refs) — Agent detail relatedSkills/relatedKnowledge ─────────────────

describe('AC1 (refs) — Agent detail: relatedSkills + relatedKnowledge', () => {
  // Agent body mentions "flow" skill and knowledge/js.md
  const agentContent = `---
name: Coder
description: Writes code
model: claude-3
tools: [Read]
---
Uses the flow skill and loads knowledge/js.md for guidance.
`;
  const skillContent   = '---\nname: Flow Skill\ndescription: Flow\n---\nSkill body.';
  const knowledgeContent = '# JavaScript\n\nContent.';

  const reader = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/coder.md`]: agentContent,
      [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: skillContent,
      [`${PLUGIN_ROOT}/knowledge/js.md`]: knowledgeContent,
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('coder.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
      [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
    },
  );

  it('agent detail includes relatedSkills array', async () => {
    const detail = await reader.getDetail('agent', 'coder');
    expect(detail).not.toBeNull();
    expect(Array.isArray(detail.relatedSkills)).toBe(true);
  });

  it('agent detail includes relatedKnowledge array', async () => {
    const detail = await reader.getDetail('agent', 'coder');
    expect(Array.isArray(detail.relatedKnowledge)).toBe(true);
  });

  it('relatedSkills contains the resolved skill with id and name', async () => {
    const detail = await reader.getDetail('agent', 'coder');
    expect(detail.relatedSkills).toEqual([{ id: 'flow', name: 'Flow Skill' }]);
  });

  it('relatedKnowledge contains the resolved knowledge with id, name, group', async () => {
    const detail = await reader.getDetail('agent', 'coder');
    expect(detail.relatedKnowledge).toEqual([{ id: 'js', name: 'JavaScript', group: 'core' }]);
  });

  it('relatedSkills is stably sorted when multiple refs exist', async () => {
    const agentBody = `---
name: Multi Agent
description: Many refs
model: m
tools: []
---
Uses train and also flow skills here.
`;
    const r = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/multi.md`]: agentBody,
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: x\n---\n',
        [`${PLUGIN_ROOT}/skills/train/SKILL.md`]: '---\nname: Train\ndescription: y\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('multi.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow'), dirEntry('train')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const detail = await r.getDetail('agent', 'multi');
    // Sorted by id: "flow" < "train"
    expect(detail.relatedSkills.map((s) => s.id)).toEqual(['flow', 'train']);
  });

  it('relatedSkills and relatedKnowledge are empty arrays when agent has no matching refs', async () => {
    const r = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/empty.md`]: '---\nname: Empty\ndescription: x\nmodel: m\ntools: []\n---\nNo refs here.',
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: x\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('empty.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const detail = await r.getDetail('agent', 'empty');
    expect(detail.relatedSkills).toEqual([]);
    expect(detail.relatedKnowledge).toEqual([]);
  });
});

// ── AC2 (refs) — Frontmatter priority vs. body fallback ──────────────────────

describe('AC2 (refs) — Frontmatter-first, body-fallback', () => {
  // Frontmatter lists "deploy" skill; body mentions "flow" skill
  // → only "deploy" in relatedSkills (frontmatter wins)
  const agentFrontmatterSkills = `---
name: FA
description: x
model: m
tools: []
skills: [deploy]
---
Mentions flow skill in body.
`;
  // Frontmatter lists "security" knowledge; body mentions knowledge/js.md
  // → only "security" in relatedKnowledge (frontmatter wins)
  const agentFrontmatterKnowledge = `---
name: FK
description: x
model: m
tools: []
knowledge: [security]
---
Load knowledge/js.md here.
`;

  const skillFiles = {
    [`${PLUGIN_ROOT}/skills/deploy/SKILL.md`]: '---\nname: Deploy\ndescription: d\n---\n',
    [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]:   '---\nname: Flow\ndescription: f\n---\n',
  };
  const skillDirs = [dirEntry('deploy'), dirEntry('flow')];
  const knowledgeFiles = {
    [`${PLUGIN_ROOT}/knowledge/js.md`]:       '# JS',
    [`${PLUGIN_ROOT}/knowledge/security.md`]: '# Security',
  };

  it('when frontmatter.skills present, uses it and ignores body skill mentions', async () => {
    const r = makeReader(
      {
        ...skillFiles,
        ...knowledgeFiles,
        [`${PLUGIN_ROOT}/agents/fa.md`]: agentFrontmatterSkills,
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('fa.md')],
        [`${PLUGIN_ROOT}/skills`]: skillDirs,
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md'), fileEntry('security.md')],
      },
    );
    const detail = await r.getDetail('agent', 'fa');
    const ids = detail.relatedSkills.map((s) => s.id);
    expect(ids).toContain('deploy');
    expect(ids).not.toContain('flow');
  });

  it('when frontmatter.knowledge present, uses it and ignores body knowledge paths', async () => {
    const r = makeReader(
      {
        ...skillFiles,
        ...knowledgeFiles,
        [`${PLUGIN_ROOT}/agents/fk.md`]: agentFrontmatterKnowledge,
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('fk.md')],
        [`${PLUGIN_ROOT}/skills`]: skillDirs,
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md'), fileEntry('security.md')],
      },
    );
    const detail = await r.getDetail('agent', 'fk');
    const ids = detail.relatedKnowledge.map((k) => k.id);
    expect(ids).toContain('security');
    expect(ids).not.toContain('js');
  });

  it('when no frontmatter.skills, falls back to body scan', async () => {
    const bodyOnly = `---
name: BO
description: x
model: m
tools: []
---
Uses the deploy skill.
`;
    const r = makeReader(
      {
        ...skillFiles,
        ...knowledgeFiles,
        [`${PLUGIN_ROOT}/agents/bo.md`]: bodyOnly,
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('bo.md')],
        [`${PLUGIN_ROOT}/skills`]: skillDirs,
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md'), fileEntry('security.md')],
      },
    );
    const detail = await r.getDetail('agent', 'bo');
    expect(detail.relatedSkills.map((s) => s.id)).toContain('deploy');
  });

  it('when no frontmatter.knowledge, falls back to body scan', async () => {
    const bodyOnly = `---
name: BO2
description: x
model: m
tools: []
---
Loads knowledge/js.md here.
`;
    const r = makeReader(
      {
        ...skillFiles,
        ...knowledgeFiles,
        [`${PLUGIN_ROOT}/agents/bo2.md`]: bodyOnly,
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('bo2.md')],
        [`${PLUGIN_ROOT}/skills`]: skillDirs,
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md'), fileEntry('security.md')],
      },
    );
    const detail = await r.getDetail('agent', 'bo2');
    expect(detail.relatedKnowledge.map((k) => k.id)).toContain('js');
  });
});

// ── AC3 (refs) — Dead-link pruning ───────────────────────────────────────────

describe('AC3 (refs) — Dead-link pruning: non-existent targets are dropped', () => {
  // Agent frontmatter references "ghost-skill" (does not exist) + "flow" (exists)
  const agentContent = `---
name: Pruner
description: x
model: m
tools: []
skills: [flow, ghost-skill]
knowledge: [js, ghost-knowledge]
---
Body.
`;

  const r = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/pruner.md`]: agentContent,
      [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]:   '---\nname: Flow\ndescription: f\n---\n',
      [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('pruner.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
      [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
    },
  );

  it('relatedSkills does not contain the non-existent skill id', async () => {
    const detail = await r.getDetail('agent', 'pruner');
    const ids = detail.relatedSkills.map((s) => s.id);
    expect(ids).not.toContain('ghost-skill');
  });

  it('relatedSkills still contains the valid skill', async () => {
    const detail = await r.getDetail('agent', 'pruner');
    expect(detail.relatedSkills.map((s) => s.id)).toContain('flow');
  });

  it('relatedKnowledge does not contain the non-existent knowledge id', async () => {
    const detail = await r.getDetail('agent', 'pruner');
    const ids = detail.relatedKnowledge.map((k) => k.id);
    expect(ids).not.toContain('ghost-knowledge');
  });

  it('relatedKnowledge still contains the valid knowledge id', async () => {
    const detail = await r.getDetail('agent', 'pruner');
    expect(detail.relatedKnowledge.map((k) => k.id)).toContain('js');
  });

  it('body-fallback: word that looks like a skill id but only appears inside a larger word is not matched', async () => {
    // Body only contains "workflow" — "flow" appears embedded, not standalone.
    // The word-boundary regex must NOT match "flow" inside "workflow".
    const bodyFallback = `---
name: WF
description: x
model: m
tools: []
---
This is a workflow tool.
`;
    const r2 = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/wf.md`]: bodyFallback,
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: f\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('wf.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const detail = await r2.getDetail('agent', 'wf');
    // "flow" must NOT appear because it only occurs inside "workflow" (no standalone occurrence)
    expect(detail.relatedSkills.map((s) => s.id)).not.toContain('flow');
  });
});

// ── AC4 (refs) — usedByAgents on skill/knowledge detail ──────────────────────

describe('AC4 (refs) — Skill/Knowledge detail includes usedByAgents', () => {
  // Agent mentions "flow" skill + knowledge/js.md
  const agentContent = `---
name: Coder
description: Writes code
model: m
tools: []
---
Uses the flow skill and loads knowledge/js.md.
`;

  const r = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/coder.md`]: agentContent,
      [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: f\n---\n',
      [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('coder.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
      [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
    },
  );

  it('skill detail includes usedByAgents array', async () => {
    const detail = await r.getDetail('skill', 'flow');
    expect(detail).not.toBeNull();
    expect(Array.isArray(detail.usedByAgents)).toBe(true);
  });

  it('skill detail usedByAgents contains the agent that references it', async () => {
    const detail = await r.getDetail('skill', 'flow');
    expect(detail.usedByAgents).toEqual([{ id: 'coder', name: 'Coder' }]);
  });

  it('knowledge detail includes usedByAgents array', async () => {
    const detail = await r.getDetail('knowledge', 'js');
    expect(detail).not.toBeNull();
    expect(Array.isArray(detail.usedByAgents)).toBe(true);
  });

  it('knowledge detail usedByAgents contains the agent that references it', async () => {
    const detail = await r.getDetail('knowledge', 'js');
    expect(detail.usedByAgents).toEqual([{ id: 'coder', name: 'Coder' }]);
  });

  it('skill usedByAgents is empty when no agent references it', async () => {
    // Only 'coder' references 'flow' — already tested above; test a skill not referenced by anyone
    const r2 = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/empty.md`]: '---\nname: E\ndescription: x\nmodel: m\ntools: []\n---\nNo skills.',
        [`${PLUGIN_ROOT}/skills/unused/SKILL.md`]: '---\nname: Unused\ndescription: u\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('empty.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('unused')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const sd = await r2.getDetail('skill', 'unused');
    expect(sd.usedByAgents).toEqual([]);
  });

  it('usedByAgents is deduplicated even if an agent appears twice (defensive)', async () => {
    // This shouldn't happen in practice (each agent file is read once), but
    // the sort+dedup logic in #usedByAgents ensures clean output regardless.
    const detail = await r.getDetail('skill', 'flow');
    const ids = detail.usedByAgents.map((a) => a.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('usedByAgents is stably sorted by id', async () => {
    // Two agents both reference "flow": zebra + alpha → sorted alpha, zebra
    const r3 = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/zebra.md`]: '---\nname: Zebra\ndescription: x\nmodel: m\ntools: []\nskills: [flow]\n---\n',
        [`${PLUGIN_ROOT}/agents/alpha.md`]: '---\nname: Alpha\ndescription: x\nmodel: m\ntools: []\nskills: [flow]\n---\n',
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: f\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('zebra.md'), fileEntry('alpha.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const detail = await r3.getDetail('skill', 'flow');
    expect(detail.usedByAgents.map((a) => a.id)).toEqual(['alpha', 'zebra']);
  });
});

// ── AC5 (refs) — Consistency: forward ↔ reverse ──────────────────────────────

describe('AC5 (refs) — Consistency: forward and reverse references agree', () => {
  // Agent "coder" uses "flow" skill and "js" knowledge
  const r = makeReader(
    {
      [`${PLUGIN_ROOT}/agents/coder.md`]: '---\nname: Coder\ndescription: x\nmodel: m\ntools: []\nskills: [flow]\nknowledge: [js]\n---\nBody.',
      [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: f\n---\n',
      [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
    },
    {
      [`${PLUGIN_ROOT}/agents`]: [fileEntry('coder.md')],
      [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow')],
      [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
    },
  );

  it('if agent relatedSkills contains X, then skill X.usedByAgents contains the agent', async () => {
    const agentDetail  = await r.getDetail('agent', 'coder');
    const skillDetail  = await r.getDetail('skill', 'flow');
    const agentHasSkill  = agentDetail.relatedSkills.some((s) => s.id === 'flow');
    const skillHasAgent  = skillDetail.usedByAgents.some((a) => a.id === 'coder');
    expect(agentHasSkill).toBe(true);
    expect(skillHasAgent).toBe(true);
  });

  it('if agent relatedKnowledge contains X, then knowledge X.usedByAgents contains the agent', async () => {
    const agentDetail    = await r.getDetail('agent', 'coder');
    const knowledgeDetail = await r.getDetail('knowledge', 'js');
    const agentHasK      = agentDetail.relatedKnowledge.some((k) => k.id === 'js');
    const knowledgeHasA  = knowledgeDetail.usedByAgents.some((a) => a.id === 'coder');
    expect(agentHasK).toBe(true);
    expect(knowledgeHasA).toBe(true);
  });

  it('if skill is not in agent relatedSkills, agent is not in skill usedByAgents', async () => {
    // Agent uses "flow"; "unused" skill should not be in agent.relatedSkills and agent not in its usedByAgents
    const r2 = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/coder.md`]: '---\nname: Coder\ndescription: x\nmodel: m\ntools: []\nskills: [flow]\n---\nBody.',
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]:   '---\nname: Flow\ndescription: f\n---\n',
        [`${PLUGIN_ROOT}/skills/unused/SKILL.md`]: '---\nname: Unused\ndescription: u\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]: [fileEntry('coder.md')],
        [`${PLUGIN_ROOT}/skills`]: [dirEntry('flow'), dirEntry('unused')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const agentDetail = await r2.getDetail('agent', 'coder');
    const unusedDetail = await r2.getDetail('skill', 'unused');
    expect(agentDetail.relatedSkills.some((s) => s.id === 'unused')).toBe(false);
    expect(unusedDetail.usedByAgents.some((a) => a.id === 'coder')).toBe(false);
  });
});

// ── AC6 (refs) — Security/Floor: degradation without plugin ──────────────────

describe('AC6 (refs) — Security/Floor: degradation without plugin, no crash', () => {
  it('agent detail returns null (404-ready) when plugin root is missing', async () => {
    const noPluginReader = new AgentFlowReader({
      pluginRootResolver: async () => null,
    });
    const detail = await noPluginReader.getDetail('agent', 'coder');
    expect(detail).toBeNull();
  });

  it('skill detail returns null when plugin root is missing', async () => {
    const noPluginReader = new AgentFlowReader({
      pluginRootResolver: async () => null,
    });
    const detail = await noPluginReader.getDetail('skill', 'flow');
    expect(detail).toBeNull();
  });

  it('knowledge detail returns null when plugin root is missing', async () => {
    const noPluginReader = new AgentFlowReader({
      pluginRootResolver: async () => null,
    });
    const detail = await noPluginReader.getDetail('knowledge', 'js');
    expect(detail).toBeNull();
  });

  it('agent detail with empty skills/knowledge dirs returns empty ref lists, no crash', async () => {
    const r = makeReader(
      {
        [`${PLUGIN_ROOT}/agents/coder.md`]: '---\nname: Coder\ndescription: x\nmodel: m\ntools: []\n---\nBody.',
      },
      {
        [`${PLUGIN_ROOT}/agents`]:    [fileEntry('coder.md')],
        [`${PLUGIN_ROOT}/skills`]:    [],
        [`${PLUGIN_ROOT}/knowledge`]: [],
      },
    );
    const detail = await r.getDetail('agent', 'coder');
    expect(detail).not.toBeNull();
    expect(detail.relatedSkills).toEqual([]);
    expect(detail.relatedKnowledge).toEqual([]);
  });

  it('skill detail with no agents returns empty usedByAgents, no crash', async () => {
    const r = makeReader(
      {
        [`${PLUGIN_ROOT}/skills/flow/SKILL.md`]: '---\nname: Flow\ndescription: f\n---\n',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JS',
      },
      {
        [`${PLUGIN_ROOT}/agents`]:    [],
        [`${PLUGIN_ROOT}/skills`]:    [dirEntry('flow')],
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md')],
      },
    );
    const detail = await r.getDetail('skill', 'flow');
    expect(detail).not.toBeNull();
    expect(detail.usedByAgents).toEqual([]);
  });
});

// ── AC1 — Knowledge stable sort: group-first, then name ──────────────────────

describe('AC1 — Knowledge stable sort: group-first, then name within same group', () => {
  // Two entries in DIFFERENT groups: 'core' (group) vs 'frameworks' (group).
  // 'core' < 'frameworks' alphabetically → core entry must come first.
  it('entries in different groups: core group comes before frameworks group', async () => {
    const reader = makeReader(
      {
        [`${PLUGIN_ROOT}/knowledge/frameworks/spring.md`]: '# Spring',
        [`${PLUGIN_ROOT}/knowledge/js.md`]: '# JavaScript',
      },
      {
        [`${PLUGIN_ROOT}/knowledge`]: [fileEntry('js.md'), dirEntry('frameworks')],
        [`${PLUGIN_ROOT}/knowledge/frameworks`]: [fileEntry('spring.md')],
      },
    );
    const { knowledge } = await reader.getOverview();
    // Exact order: core ('js') before frameworks ('frameworks/spring')
    expect(knowledge.map((k) => k.id)).toEqual(['js', 'frameworks/spring']);
  });

  // Two entries in the SAME group → sorted alphabetically by name.
  it('entries in the same group are sorted alphabetically by name', async () => {
    const reader = makeReader(
      {
        [`${PLUGIN_ROOT}/knowledge/frameworks/zebra.md`]: '# Zebra Framework',
        [`${PLUGIN_ROOT}/knowledge/frameworks/alpha.md`]: '# Alpha Framework',
      },
      {
        [`${PLUGIN_ROOT}/knowledge`]: [dirEntry('frameworks')],
        [`${PLUGIN_ROOT}/knowledge/frameworks`]: [
          fileEntry('zebra.md'),
          fileEntry('alpha.md'),
        ],
      },
    );
    const { knowledge } = await reader.getOverview();
    // Both in 'frameworks' group → alphabetical by name: 'Alpha Framework' before 'Zebra Framework'
    expect(knowledge.map((k) => k.name)).toEqual(['Alpha Framework', 'Zebra Framework']);
  });
});

// ── resolvePluginRootContaining — 2026-07-06-Vorfall (feature-umsetzen-button) ──
// Zwei Plugin-Versionsverzeichnisse mit IDENTISCHEM mtime (beide während
// desselben Container-Boot-Updates geschrieben) machten resolvePluginRoot()s
// reine mtime-Sortierung nicht-deterministisch — das ältere Verzeichnis (ohne
// das gesuchte Skript) gewann den Tiebreak, ein Spawn schlug mit Exit 127 fehl.

import { homedir as _homedir } from 'node:os';
import { join as _join } from 'node:path';

describe('resolvePluginRootContaining — Tiebreak-Vorfall 2026-07-06', () => {
  const CACHE_BASE = _join(_homedir(), '.claude', 'plugins', 'cache', 'agent-flow');
  const OLD_VERSION = _join(CACHE_BASE, 'agent-flow', 'old111111111');
  const NEW_VERSION = _join(CACHE_BASE, 'agent-flow', 'new222222222');

  function buildTieFsDeps({ scriptInOld = false, scriptInNew = true, tieMtimes = true } = {}) {
    const dirMap = {
      [CACHE_BASE]: [dirEntry('agent-flow')],
      [_join(CACHE_BASE, 'agent-flow')]: [dirEntry('old111111111'), dirEntry('new222222222')],
    };
    const scriptFiles = new Set();
    if (scriptInOld) scriptFiles.add(_join(OLD_VERSION, 'scripts', 'board-feature-drain.sh'));
    if (scriptInNew) scriptFiles.add(_join(NEW_VERSION, 'scripts', 'board-feature-drain.sh'));

    return {
      readdir: async (dir) => {
        if (dir in dirMap) return dirMap[dir];
        const err = new Error(`ENOENT: ${dir}`); err.code = 'ENOENT'; throw err;
      },
      stat: async (path) => {
        if (path === OLD_VERSION) return { mtimeMs: tieMtimes ? 5000 : 4000 };
        if (path === NEW_VERSION) return { mtimeMs: 5000 };
        const err = new Error(`ENOENT: ${path}`); err.code = 'ENOENT'; throw err;
      },
      access: async (path) => {
        if (scriptFiles.has(path)) return undefined;
        const err = new Error(`ENOENT: ${path}`); err.code = 'ENOENT'; throw err;
      },
      readFile: async () => { throw new Error('nicht relevant für diesen Test'); },
    };
  }

  it('mtime-Gleichstand + Skript nur in der neuen Version -> wählt trotzdem die neue Version', async () => {
    const fsDeps = buildTieFsDeps({ scriptInOld: false, scriptInNew: true, tieMtimes: true });
    const reader = new AgentFlowReader({ fsDeps });
    const root = await reader.resolvePluginRootContaining('scripts/board-feature-drain.sh');
    expect(root).toBe(NEW_VERSION);
  });

  it('Skript in KEINER Version vorhanden -> null (kein Crash)', async () => {
    const fsDeps = buildTieFsDeps({ scriptInOld: false, scriptInNew: false, tieMtimes: true });
    const reader = new AgentFlowReader({ fsDeps });
    const root = await reader.resolvePluginRootContaining('scripts/board-feature-drain.sh');
    expect(root).toBeNull();
  });

  it('Skript in beiden Versionen -> wählt die per mtime neuere', async () => {
    const fsDeps = buildTieFsDeps({ scriptInOld: true, scriptInNew: true, tieMtimes: false });
    const reader = new AgentFlowReader({ fsDeps });
    const root = await reader.resolvePluginRootContaining('scripts/board-feature-drain.sh');
    expect(root).toBe(NEW_VERSION);
  });

  it('AGENT_FLOW_PLUGIN_ROOT-Override hat Vorrang (unverändert zu resolvePluginRoot)', async () => {
    const prev = process.env.AGENT_FLOW_PLUGIN_ROOT;
    process.env.AGENT_FLOW_PLUGIN_ROOT = '/override/path';
    try {
      const reader = new AgentFlowReader({ fsDeps: buildTieFsDeps() });
      const root = await reader.resolvePluginRootContaining('scripts/board-feature-drain.sh');
      expect(root).toBe('/override/path');
    } finally {
      if (prev === undefined) delete process.env.AGENT_FLOW_PLUGIN_ROOT;
      else process.env.AGENT_FLOW_PLUGIN_ROOT = prev;
    }
  });
});
