/**
 * agentFlowReader.test.js — Tests for AgentFlowReader (team-view-backend)
 *
 * Covers:
 *   AC1 — Overview field shapes: id/name/description/model/tools (agents), id/name/description (skills), id/name/group (knowledge); no body field
 *   AC2 — Frontmatter parsing: agents (name, description, tools, model) + skills (name, description)
 *   AC3 — Knowledge: recursive scan, H1 name extraction, filename fallback, group detection incl. subdirs
 *   AC7 — Degradation: no plugin root → empty lists, no crash
 *   AC8 — No secrets in response (overview and detail contain only Markdown content/metadata)
 *
 * Strategy:
 *   - Inject fake fsDeps (readFile, readdir, stat) so no real filesystem is touched.
 *   - Use in-memory fixture structures for deterministic tests.
 */

import { describe, it, expect } from '@jest/globals';
import { AgentFlowReader, parseFrontmatter } from '../src/AgentFlowReader.js';

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
