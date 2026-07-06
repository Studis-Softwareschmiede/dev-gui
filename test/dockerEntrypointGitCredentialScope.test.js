/**
 * dockerEntrypointGitCredentialScope.test.js — docker-entrypoint.sh git
 * credential-helper scoping (2026-07-06-Vorfall).
 *
 * Covers: die `url."https://x-access-token:${GH_TOKEN}@github.com/...".
 * insteadOf`-Regel darf NICHT mehr auf die gesamte "https://github.com/"-
 * Domain wirken. Eine unscoped Regel bäckt den zum Boot-Zeitpunkt gültigen
 * (nur ~1h haltbaren) GH_TOKEN dauerhaft in JEDEN github.com-Git-Zugriff ein
 * — auch in Projekte, die dev-gui selbst per Git anspricht (z.B. sein
 * eigenes Workspace-Repo) — und überstimmt damit den korrekt und
 * regelmäßig via `ensure-gh-auth.sh`/`gh auth setup-git` erneuerten Login.
 * Symptom: "Invalid username or token" bei Git-Pushes aus länger laufenden
 * Containern, obwohl `gh auth status` einen gültigen, aktiven Login zeigt.
 *
 * Die Regel muss stattdessen exakt auf die eine Adresse begrenzt sein, die
 * für den (chicken-and-egg) Erst-Bootstrap des privaten agent-flow-Plugins
 * gebraucht wird: https://github.com/Studis-Softwareschmiede/agent-flow.
 *
 * Strategy: echte Ausführung von docker-entrypoint.sh via spawnSync (wie
 * dockerEntrypointOauthToken.test.js) mit gestubbtem `claude` + `server.js`,
 * danach das TATSÄCHLICH geschriebene `$HOME/.gitconfig` prüfen.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'node:fs';
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

let workDir, binDir, homeDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'entrypoint-gitcred-test-work-'));
  binDir = mkdtempSync(join(tmpdir(), 'entrypoint-gitcred-test-bin-'));
  homeDir = mkdtempSync(join(tmpdir(), 'entrypoint-gitcred-test-home-'));
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

function readGitConfig() {
  try {
    return readFileSync(join(homeDir, '.gitconfig'), 'utf8');
  } catch {
    return '';
  }
}

describe('docker-entrypoint.sh — git credential insteadOf scoping (2026-07-06-Vorfall)', () => {
  it('GH_TOKEN gesetzt: insteadOf-Regel gilt NUR für den agent-flow-Repo-Pfad, nicht für ganz github.com', () => {
    const res = runEntrypoint({ GH_TOKEN: 'ghs_fake_test_token_123' });
    expect(res.status).toBe(0);
    const gitconfig = readGitConfig();
    expect(gitconfig).toContain('github.com/Studis-Softwareschmiede/agent-flow');
    // Die alte, zu weit gefasste Form darf NICHT mehr vorkommen: eine Regel,
    // die exakt "https://github.com/" (ohne weiteren Pfad) als insteadOf-Ziel
    // hat, würde JEDEN github.com-Zugriff treffen.
    expect(gitconfig).not.toMatch(/insteadof\s*=\s*https:\/\/github\.com\/\s*$/im);
  });

  it('andere github.com-Projekte sind von der Regel NICHT betroffen (kein pauschales insteadOf)', () => {
    runEntrypoint({ GH_TOKEN: 'ghs_fake_test_token_123' });
    const gitconfig = readGitConfig();
    // Eine rein auf "https://github.com/" (Domain-Wurzel) insteadOf lautende
    // Zeile hätte JEDES andere Repo (z.B. .../dev-gui) mit umgeschrieben —
    // das darf nicht mehr passieren.
    const rootDomainRule = /url\s*"https:\/\/x-access-token:[^"]*@github\.com\/"\s*\]\s*\n\s*insteadof\s*=\s*https:\/\/github\.com\/\s*$/im;
    expect(gitconfig).not.toMatch(rootDomainRule);
  });

  it('der Token-Wert wird nicht auf stdout/stderr geloggt', () => {
    const token = 'ghs_fake_test_token_123';
    const res = runEntrypoint({ GH_TOKEN: token });
    expect(res.stdout).not.toContain(token);
    expect(res.stderr).not.toContain(token);
  });

  it('ohne GH_TOKEN: keine insteadOf-Regel wird geschrieben, Boot bleibt unblockiert', () => {
    const res = runEntrypoint({});
    expect(res.status).toBe(0);
    const gitconfig = readGitConfig();
    expect(gitconfig).not.toContain('insteadof');
    expect(res.stdout).toMatch(/\[stub-server\] started/);
  });
});
