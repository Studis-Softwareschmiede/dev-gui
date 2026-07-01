/**
 * dockerEntrypointOauthToken.test.js — docker-entrypoint.sh Claude-Code-OAuth-
 * Token boot warning.
 *
 * Covers (claude-code-oauth-token, docs/specs/claude-code-oauth-token.md):
 *   AC4 — the entrypoint prints a boot-time WARNING on stderr when
 *         CLAUDE_CODE_OAUTH_TOKEN is unset/empty, mentioning both the
 *         variable name and the 401-consequence for /agent-flow:* runs.
 *         The warning is best-effort/non-blocking: the boot step still
 *         exits 0 and the server-start step still runs. When the token IS
 *         set, no warning is printed and the (fake) token value never
 *         appears in stdout/stderr (value is never logged).
 *
 * Strategy:
 *   - Real execution of docker-entrypoint.sh via child_process.spawnSync
 *     (this is the actual entrypoint being run end-to-end), with a stubbed
 *     `claude` CLI on PATH (always reports "not installed" → takes the
 *     install path, irrelevant to this AC but must not abort the script)
 *     and a stub `server.js` in cwd so `exec node server.js` returns
 *     immediately instead of starting the real server.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(process.cwd(), 'docker-entrypoint.sh');

// Minimal claude stub: reports "not installed", install sub-commands succeed.
// The install/update flow itself is out of scope here (covered by
// dockerEntrypointPluginUpdate.test.js) — this stub just needs to not abort
// the script so we can observe the OAuth-token warning + reach server start.
const CLAUDE_STUB = `#!/bin/bash
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  exit 0
fi
exit 0
`;

const SERVER_STUB = `console.log('[stub-server] started');\nprocess.exit(0);\n`;

let workDir, binDir, homeDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'entrypoint-oauth-test-work-'));
  binDir = mkdtempSync(join(tmpdir(), 'entrypoint-oauth-test-bin-'));
  homeDir = mkdtempSync(join(tmpdir(), 'entrypoint-oauth-test-home-'));
  mkdirSync(join(homeDir, '.claude'), { recursive: true });

  writeFileSync(join(workDir, 'server.js'), SERVER_STUB);

  const claudeStubPath = join(binDir, 'claude');
  writeFileSync(claudeStubPath, CLAUDE_STUB);
  chmodSync(claudeStubPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function runEntrypoint(extraEnv) {
  return spawnSync('bash', [ENTRYPOINT], {
    cwd: workDir,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: homeDir,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

describe('docker-entrypoint.sh — CLAUDE_CODE_OAUTH_TOKEN boot warning (AC4)', () => {
  it('unset token: warns on stderr, does not block boot, server still starts', () => {
    const res = runEntrypoint({});
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING.*CLAUDE_CODE_OAUTH_TOKEN.*401/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('empty token: warns on stderr the same way as unset', () => {
    const res = runEntrypoint({ CLAUDE_CODE_OAUTH_TOKEN: '' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING.*CLAUDE_CODE_OAUTH_TOKEN.*401/);
  });

  it('set token: no warning is printed, boot reaches server start', () => {
    const res = runEntrypoint({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake-test-token-xyz' });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN nicht gesetzt/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('the token value is never logged, whether set or unset', () => {
    const token = 'sk-ant-oat01-fake-test-token-xyz';
    const res = runEntrypoint({ CLAUDE_CODE_OAUTH_TOKEN: token });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(token);
    expect(res.stderr).not.toContain(token);
  });
});
