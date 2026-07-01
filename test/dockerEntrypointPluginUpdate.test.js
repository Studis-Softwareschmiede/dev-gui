/**
 * dockerEntrypointPluginUpdate.test.js — docker-entrypoint.sh plugin auto-update
 *
 * Covers (plugin-auto-update spec, docs/specs/plugin-auto-update.md):
 *   - AC1 — installed plugin takes the UPDATE path (marketplace update + plugin
 *           update), not the "already installed, do nothing" no-op; missing
 *           plugin still takes the INSTALL path (marketplace add + install).
 *           The update sub-command MUST use the qualified plugin name
 *           (agent-flow@agent-flow), not the bare name — a regression guard
 *           for a live-verified CRITICAL (bare name fails with exit 1 "not
 *           found" against the real claude CLI, see .claude/lessons/coder.md
 *           2026-07-01).
 *   - AC2 — a failing update/install command is error-isolated: the entrypoint
 *           does not abort, the process reaches (and runs) the server-start step.
 *   - AC3 — idempotent: running the entrypoint twice in a row (already-installed
 *           + successful update both times) never hard-fails.
 *   - AC4 — success prints a "plugin updated"/"plugin installed" marker on
 *           stdout; failure prints a warning on stderr naming /agent-flow:*.
 *   - AC5 — verified at the script-structure/execution level (which CLI
 *           sub-commands actually run for each plugin-state), not via a real
 *           Claude-CLI/plugin-registry integration (out of unit-test scope
 *           per spec §AC5 note).
 *
 * Strategy:
 *   - Real execution of docker-entrypoint.sh via child_process.spawnSync
 *     (HTTP-analog: this is the actual entrypoint being run end-to-end, not a
 *     helper-function unit test) with a stubbed `claude` CLI on PATH whose
 *     behaviour (plugin installed? which sub-commands fail?) is controlled via
 *     env vars, and a stub `server.js` in cwd so `exec node server.js` returns
 *     immediately instead of starting the real server.
 *   - Each invocation of the stub `claude` is appended to a log file so tests
 *     can assert exactly which sub-commands ran (install-path vs. update-path).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(process.cwd(), 'docker-entrypoint.sh');

const CLAUDE_STUB = `#!/bin/bash
# Test stub for the \`claude\` CLI — logs every invocation, exit codes are
# controlled via env vars so tests can simulate success/failure per sub-command.
echo "$*" >> "$CLAUDE_STUB_LOG"
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  if [ "\${CLAUDE_STUB_INSTALLED:-0}" = "1" ]; then
    echo "agent-flow@agent-flow  v1.2.3"
  fi
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "add" ]; then
  exit "\${CLAUDE_STUB_ADD_EXIT:-0}"
fi
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  exit "\${CLAUDE_STUB_INSTALL_EXIT:-0}"
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ]; then
  exit "\${CLAUDE_STUB_MKT_UPDATE_EXIT:-0}"
fi
if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then
  exit "\${CLAUDE_STUB_PLUGIN_UPDATE_EXIT:-0}"
fi
exit 0
`;

const SERVER_STUB = `console.log('[stub-server] started');\nprocess.exit(0);\n`;

let workDir, binDir, homeDir, claudeLog;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'entrypoint-test-work-'));
  binDir = mkdtempSync(join(tmpdir(), 'entrypoint-test-bin-'));
  homeDir = mkdtempSync(join(tmpdir(), 'entrypoint-test-home-'));
  mkdirSync(join(homeDir, '.claude'), { recursive: true });

  writeFileSync(join(workDir, 'server.js'), SERVER_STUB);

  const claudeStubPath = join(binDir, 'claude');
  writeFileSync(claudeStubPath, CLAUDE_STUB);
  chmodSync(claudeStubPath, 0o755);

  claudeLog = join(workDir, 'claude-invocations.log');
  writeFileSync(claudeLog, '');
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
      CLAUDE_STUB_LOG: claudeLog,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function invocations() {
  return readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean);
}

describe('docker-entrypoint.sh — plugin not installed (first-boot install path, AC1)', () => {
  it('runs marketplace add + install, not the update sub-commands', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '0' });
    expect(res.status).toBe(0);
    const log = invocations();
    expect(log.some((l) => l.startsWith('plugin marketplace add'))).toBe(true);
    expect(log.some((l) => l.startsWith('plugin install'))).toBe(true);
    expect(log.some((l) => l.startsWith('plugin marketplace update'))).toBe(false);
    expect(log.some((l) => l.startsWith('plugin update agent-flow'))).toBe(false);
  });

  it('prints a "plugin installed" success marker on stdout (AC4) and reaches server start', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '0' });
    expect(res.stdout).toMatch(/plugin installed/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('on install failure: warns on stderr and still reaches server start (AC2/AC4)', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '0', CLAUDE_STUB_ADD_EXIT: '1' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING.*agent-flow plugin install failed/);
    expect(res.stderr).toMatch(/\/agent-flow:\*/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });
});

describe('docker-entrypoint.sh — plugin already installed (update path, AC1)', () => {
  it('runs marketplace update + plugin update, not the install sub-commands', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1' });
    expect(res.status).toBe(0);
    const log = invocations();
    expect(log.some((l) => l.startsWith('plugin marketplace update'))).toBe(true);
    expect(log.some((l) => l.startsWith('plugin update agent-flow'))).toBe(true);
    expect(log.some((l) => l.startsWith('plugin marketplace add'))).toBe(false);
    expect(log.some((l) => l === 'plugin install agent-flow@agent-flow')).toBe(false);
  });

  it('uses the QUALIFIED plugin name (agent-flow@agent-flow) for the update sub-command, not the bare name (regression guard for S-202 iteration-2 CRITICAL: `claude plugin update agent-flow` fails live with exit 1 "not found")', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1' });
    expect(res.status).toBe(0);
    const log = invocations();
    expect(log.some((l) => l === 'plugin update agent-flow@agent-flow')).toBe(true);
    expect(log.some((l) => l === 'plugin update agent-flow')).toBe(false);
  });

  it('prints a "plugin updated" success marker on stdout (AC4) and reaches server start', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1' });
    expect(res.stdout).toMatch(/plugin updated/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('on marketplace-update failure: warns on stderr, does not abort, server still starts (AC2/AC4)', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1', CLAUDE_STUB_MKT_UPDATE_EXIT: '1' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING.*agent-flow plugin update failed/);
    expect(res.stderr).toMatch(/\/agent-flow:\*/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('on plugin-update failure: warns on stderr, does not abort, server still starts (AC2/AC4)', () => {
    const res = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1', CLAUDE_STUB_PLUGIN_UPDATE_EXIT: '1' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING.*agent-flow plugin update failed/);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });

  it('is idempotent across two consecutive successful runs (AC3)', () => {
    const first = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1' });
    const second = runEntrypoint({ CLAUDE_STUB_INSTALLED: '1' });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toMatch(/plugin updated/);
    expect(second.stdout).toMatch(/plugin updated/);
  });
});
