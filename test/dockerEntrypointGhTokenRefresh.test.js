/**
 * dockerEntrypointGhTokenRefresh.test.js — docker-entrypoint.sh headless
 * GitHub-App-Token background refresh loop.
 *
 * Covers (headless-gh-token-refresh, docs/specs/headless-gh-token-refresh.md):
 *   AC1 — after the existing one-time gh-auth bootstrap and before
 *         `exec node server.js`, the entrypoint starts a background refresh
 *         loop; the refresh interval is configurable via a secret-free env
 *         var (GH_TOKEN_REFRESH_INTERVAL_SECONDS) and defaults to ~45min
 *         (2700s) — strictly below the ~60min token lifetime.
 *   AC2 — every loop iteration re-invokes the SAME ensure-gh-auth.sh (resolved
 *         via the entrypoint's existing plugin-cache-path find-glob, not a
 *         hardcoded path), which updates only the existing gh/git-credential
 *         stores.
 *   AC3 — the loop does not block `exec node server.js`: spawnSync on the
 *         entrypoint returns promptly (regression guard — a naive background
 *         loop that inherits stdout/stderr would keep the pipe open forever
 *         and hang any caller waiting for EOF, e.g. `docker logs` collectors
 *         or this very test's spawnSync call), while the loop keeps running
 *         concurrently and re-authenticates repeatedly over time (regression
 *         guard for the 2026-07-07 incident — a headless drain outliving the
 *         boot token must keep working without manual intervention).
 *   AC4/AC5 (Security) — GPG_PASSPHRASE is never leaked into the refresh
 *         loop's log output; the loop resolves the plugin path exactly like
 *         the existing boot bootstrap (no new/hardcoded path).
 *   AC6 (Robustheit) — a failing refresh (ensure-gh-auth.sh exits non-zero)
 *         logs a clear, secret-free warning and the loop keeps running
 *         afterwards (next interval retried) — no crash, server keeps
 *         running.
 *
 * AC7 (isAuthError/AUTH_ERROR_PATTERN unchanged) is a static/unit-level
 * property of src/HeadlessRunnerCore.js, not observable via this
 * entrypoint-execution test — verified separately by inspection (no code
 * touched by this story).
 *
 * Strategy:
 *   - Real execution of docker-entrypoint.sh via child_process.spawnSync
 *     (same pattern as dockerEntrypointOauthToken.test.js /
 *     dockerEntrypointPluginUpdate.test.js) with a stubbed `claude` CLI, a
 *     stub `server.js` that exits immediately, and a stubbed
 *     ensure-gh-auth.sh whose invocations are logged to a file.
 *   - Crucially: spawnSync itself is the AC3 regression guard — if the
 *     background loop inherited the parent's stdout/stderr pipe (instead of
 *     redirecting to its own log file, as implemented), spawnSync would hang
 *     until the process.env-controlled timeout, since the pipe's write end
 *     would never see EOF while the detached loop keeps running. A short
 *     GH_TOKEN_REFRESH_INTERVAL_SECONDS (1s) plus a short poll-wait after
 *     spawnSync returns lets the test observe multiple loop iterations via
 *     the dedicated refresh-log file ($HOME/.claude/gh-token-refresh.log)
 *     without needing to wait anywhere near the real ~45min default.
 *   - Cleanup: best-effort pkill of any lingering stub ensure-gh-auth.sh /
 *     loop processes after each test (the loop is intentionally infinite).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(process.cwd(), 'docker-entrypoint.sh');

const CLAUDE_STUB = `#!/bin/bash
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  exit 0
fi
exit 0
`;

const SERVER_STUB = `console.log('[stub-server] started');\nprocess.exit(0);\n`;

let workDir, binDir, homeDir, pluginScriptsDir;

function makeEnsureGhAuthStub({ fail = false } = {}) {
  const callsLog = join(workDir, 'refresh-calls.log');
  if (fail) {
    return `#!/bin/bash
echo "called $(date +%s%N)" >> "${callsLog}"
echo "ensure-gh-auth-stub: simulated failure (network down)" >&2
exit 1
`;
  }
  return `#!/bin/bash
echo "called $(date +%s%N)" >> "${callsLog}"
echo "gh-auth-refresh-stub-ok"
exit 0
`;
}

function writeEnsureGhAuthStub(opts) {
  const scriptPath = join(pluginScriptsDir, 'ensure-gh-auth.sh');
  writeFileSync(scriptPath, makeEnsureGhAuthStub(opts));
  chmodSync(scriptPath, 0o755);
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const refreshCallsLog = () => readLines(join(workDir, 'refresh-calls.log'));
const refreshLogFile = () => join(homeDir, '.claude', 'gh-token-refresh.log');
const refreshLogContent = () => {
  try {
    return readFileSync(refreshLogFile(), 'utf8');
  } catch {
    return '';
  }
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'entrypoint-ghrefresh-test-work-'));
  binDir = mkdtempSync(join(tmpdir(), 'entrypoint-ghrefresh-test-bin-'));
  homeDir = mkdtempSync(join(tmpdir(), 'entrypoint-ghrefresh-test-home-'));
  mkdirSync(join(homeDir, '.claude'), { recursive: true });

  pluginScriptsDir = join(homeDir, '.claude', 'plugins', 'cache', 'agent-flow', 'agent-flow', 'fakeversion123', 'scripts');
  mkdirSync(pluginScriptsDir, { recursive: true });

  writeFileSync(join(workDir, 'server.js'), SERVER_STUB);

  const claudeStubPath = join(binDir, 'claude');
  writeFileSync(claudeStubPath, CLAUDE_STUB);
  chmodSync(claudeStubPath, 0o755);
});

afterEach(() => {
  // Best-effort: the background refresh loop is intentionally infinite —
  // kill any stray stub processes so they don't leak across test files.
  // `pkill` may not exist in every environment (e.g. minimal sandboxes
  // without procps) — swallow that case silently, it's a cleanup nicety,
  // not a test assertion.
  try {
    execSync(`command -v pkill >/dev/null 2>&1 && pkill -f "${pluginScriptsDir}/ensure-gh-auth.sh" ; command -v pkill >/dev/null 2>&1 && pkill -f "gh_token_refresh_loop" ; true`);
  } catch { /* no-op */ }
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
    timeout: 8000,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('docker-entrypoint.sh — headless gh-auth background refresh loop (AC1-AC6)', () => {
  it('AC1/AC3: spawnSync returns promptly — the background loop does not block exec node server.js or hang the caller', () => {
    writeEnsureGhAuthStub({ fail: false });
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '2' });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
    expect(res.stdout).toMatch(/starting background gh-auth refresh loop/);
  });

  it('AC1: default interval is ~45min (2700s) when GH_TOKEN_REFRESH_INTERVAL_SECONDS is unset', () => {
    writeEnsureGhAuthStub({ fail: false });
    const res = runEntrypoint({});
    expect(res.stdout).toMatch(/interval: 2700s/);
  });

  it('AC1: interval is configurable via GH_TOKEN_REFRESH_INTERVAL_SECONDS', () => {
    writeEnsureGhAuthStub({ fail: false });
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '3' });
    expect(res.stdout).toMatch(/interval: 3s/);
  });

  it('AC2/AC3: the loop re-invokes ensure-gh-auth.sh repeatedly in the background (regression: outlives the boot token)', async () => {
    writeEnsureGhAuthStub({ fail: false });
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '1' });
    expect(res.status).toBe(0);
    await sleep(3500);
    const calls = refreshCallsLog();
    // At least 2 loop-driven refresh calls within ~3.5s at a 1s interval
    // proves periodic re-invocation, not just a single one-shot call.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(refreshLogContent()).toMatch(/gh-auth refresh: fresh GitHub-App token minted/);
  }, 10000);

  it('AC6: a failing refresh logs a clear, secret-free warning and the loop keeps retrying (no crash)', async () => {
    writeEnsureGhAuthStub({ fail: true });
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '1' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
    await sleep(3500);
    const calls = refreshCallsLog();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(refreshLogContent()).toMatch(/WARNING.*gh-auth refresh failed/i);
  }, 10000);

  it('AC4/AC5: GPG_PASSPHRASE never appears in the refresh-loop log file', async () => {
    writeEnsureGhAuthStub({ fail: false });
    const passphrase = 'super-secret-master-passphrase-xyz';
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '1', GPG_PASSPHRASE: passphrase });
    expect(res.status).toBe(0);
    await sleep(1500);
    expect(refreshLogContent()).not.toContain(passphrase);
    expect(res.stdout).not.toContain(passphrase);
    expect(res.stderr).not.toContain(passphrase);
  }, 10000);

  it('AC6: ensure-gh-auth.sh missing (plugin path changed) — loop warns and keeps the server alive, no crash', async () => {
    // No pluginScriptsDir stub written at all — find() resolves nothing.
    rmSync(pluginScriptsDir, { recursive: true, force: true });
    const res = runEntrypoint({ GH_TOKEN_REFRESH_INTERVAL_SECONDS: '1' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[stub-server\] started/);
    await sleep(2500);
    expect(refreshLogContent()).toMatch(/WARNING.*gh-auth refresh skipped/i);
  }, 10000);
});
