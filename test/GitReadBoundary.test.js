/**
 * GitReadBoundary.test.js — Unit-Tests für die read-only Git-Lesezugriffs-
 * Boundary (docs/specs/drain-origin-progress-sync.md).
 *
 * Covers (drain-origin-progress-sync):
 *   AC1 — fetchOrigin(): read-only `git fetch origin` non-fatal bei Fehler
 *          (`{ok:false}`); "kein Remote konfiguriert" wird NICHT als Fetch-
 *          Fehler behandelt (Edge-Case: Working-Tree ist bereits Wahrheit,
 *          `{ok:true, fetched:false}` — keine dauerhafte Unverifiziert-Falle
 *          für Projekte/Tests ohne `origin`). NIEMALS eine mutierende
 *          Git-Operation (`pull`/`merge`/`checkout`/`reset`/`clean`/`stash`) —
 *          das Modul kennt diese Kommandos schlicht nicht (Code-Audit unten).
 *   AC2 — resolveTruthRef(): ancestry-basiert (`merge-base --is-ancestor`);
 *          `ahead:true` NUR wenn Upstream existiert UND HEAD echter Vorfahr
 *          UND HEAD != Upstream-SHA; sonst (kein Upstream, HEAD==origin, HEAD
 *          voraus, Kommando-Fehler) `ahead:false` (Working-Tree bleibt Quelle).
 *          readFileAtRef()/listFilesAtRef(): `git show`/`git ls-tree` read-only,
 *          fehlende Datei/Verzeichnis → `null`/`[]`, kein Crash.
 *   AC7 — Alle vier Methoden werfen NIE — jeder Kommando-Fehler wird zu einem
 *          definierten Rückgabewert normalisiert (Fetch-/Ref-Lese-Fehler
 *          Edge-Cases der Spec, non-fatal/degradierend).
 *
 * Testet über einen injizierten `gitExec`-Fake (kein echter `git`-Kindprozess,
 * NFR Testbarkeit) — verifiziert zusätzlich die exakten Argument-Arrays je
 * Kommando (Sicherheits-Floor: nur die vier dokumentierten read-only Git-
 * Subkommandos, Array-Argumente statt Shell-String).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { GitReadBoundary, createGitRefFsDeps } from '../src/GitReadBoundary.js';

/** Baut einen gitExec-Fake, der Aufrufe protokolliert + über eine Mapping-Fn antwortet. */
function makeGitExec(responder) {
  const calls = [];
  const gitExec = async (args, opts) => {
    calls.push({ args, opts });
    return responder(args, opts);
  };
  return { gitExec, calls };
}

const REPO = '/workspace/some-project';

describe('GitReadBoundary — fetchOrigin (AC1)', () => {
  it('returns ok:true, fetched:true on a successful fetch (remote exists)', async () => {
    const { gitExec, calls } = makeGitExec((args) => {
      if (args[0] === 'remote') return { stdout: 'https://github.com/x/y.git\n', stderr: '' };
      if (args[0] === 'fetch') return { stdout: '', stderr: '' };
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.fetchOrigin(REPO);

    expect(result).toEqual({ ok: true, fetched: true });
    expect(calls[0].args).toEqual(['remote', 'get-url', 'origin']);
    expect(calls[1].args).toEqual(['fetch', '--quiet', 'origin']);
    expect(calls[1].opts.cwd).toBe(REPO);
  });

  it('returns ok:true, fetched:false when no origin remote is configured (edge-case: no fetch source that could be staler)', async () => {
    const { gitExec, calls } = makeGitExec((args) => {
      if (args[0] === 'remote') throw new Error("error: No such remote 'origin'");
      throw new Error('unexpected command — fetch must NOT be attempted without a remote');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.fetchOrigin(REPO);

    expect(result).toEqual({ ok: true, fetched: false });
    expect(calls).toHaveLength(1); // no fetch attempted
  });

  it('returns ok:false on a genuine fetch failure (remote exists but unreachable/offline/timeout) — non-fatal, never throws', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'remote') return { stdout: 'https://github.com/x/y.git\n', stderr: '' };
      if (args[0] === 'fetch') throw new Error('unable to access: Could not resolve host');
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.fetchOrigin(REPO);

    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  it('sanity: this module never PASSES a mutating git subcommand to gitExec (Trauma-Leitplanke)', async () => {
    // Prüft die tatsächlichen gitExec()-Aufrufe (nicht die Prosa der Doku-
    // Kommentare, die die verbotenen Kommandos zu Recht als Negativ-Beispiel
    // NENNEN) — Regressionsschutz: jeder git-Subcommand-String, der als
    // erstes Argument eines gitExec([...])-Aufrufs im Quelltext auftaucht,
    // muss aus der read-only-Allowlist stammen.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/GitReadBoundary.js', import.meta.url), 'utf8'),
    );
    const allowlist = new Set(['fetch', 'remote', 'rev-parse', 'merge-base', 'show', 'ls-tree']);
    const mutating = new Set(['pull', 'merge', 'checkout', 'reset', 'clean', 'stash']);
    // Matches: this.#gitExec(['<subcommand>', ...
    const invocationRe = /#gitExec\(\[\s*'([a-z-]+)'/g;
    let match;
    let found = 0;
    while ((match = invocationRe.exec(src)) !== null) {
      found += 1;
      const subcommand = match[1];
      expect(mutating.has(subcommand)).toBe(false);
      expect(allowlist.has(subcommand)).toBe(true);
    }
    expect(found).toBeGreaterThan(0); // Sanity: die Regex hat wirklich Aufrufe gefunden.
  });
});

describe('GitReadBoundary — resolveTruthRef (AC2, ancestry-basiert)', () => {
  it('returns ahead:true with the upstream ref when HEAD is a true ancestor of @{u} and HEAD != upstream', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) return { stdout: 'origin/main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'aaa111\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: 'bbb222\n', stderr: '' };
      if (args[0] === 'merge-base') return { stdout: '', stderr: '' }; // exit 0 = ancestor
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.resolveTruthRef(REPO);

    expect(result).toEqual({ ahead: true, ref: 'origin/main' });
  });

  it('returns ahead:false when no upstream is configured (no @{u})', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) throw new Error('no upstream configured');
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.resolveTruthRef(REPO);

    expect(result).toEqual({ ahead: false, ref: null });
  });

  it('returns ahead:false when HEAD == origin (nothing to sync)', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) return { stdout: 'origin/main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'sha123\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: 'sha123\n', stderr: '' };
      throw new Error('merge-base must not be called when HEAD==upstream');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.resolveTruthRef(REPO);

    expect(result).toEqual({ ahead: false, ref: null });
  });

  it('returns ahead:false when local HEAD is AHEAD of (or diverged from) origin — merge-base --is-ancestor fails (direct-Regression-Schutz)', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) return { stdout: 'origin/main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'local999\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: 'remote111\n', stderr: '' };
      if (args[0] === 'merge-base') throw new Error('exit code 1 — not an ancestor');
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const result = await boundary.resolveTruthRef(REPO);

    expect(result).toEqual({ ahead: false, ref: null });
  });

  it('never throws on a detached-HEAD-like generic failure (rev-parse HEAD fails)', async () => {
    const { gitExec } = makeGitExec((args) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) return { stdout: 'origin/main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') throw new Error('detached or corrupt');
      throw new Error('unexpected command');
    });
    const boundary = new GitReadBoundary({ gitExec });

    await expect(boundary.resolveTruthRef(REPO)).resolves.toEqual({ ahead: false, ref: null });
  });
});

describe('GitReadBoundary — readFileAtRef / listFilesAtRef (AC2 Verträge, read-only Ref-Lese)', () => {
  it('readFileAtRef returns the file content via `git show <ref>:<path>`', async () => {
    const { gitExec, calls } = makeGitExec((args) => {
      expect(args[0]).toBe('show');
      return { stdout: 'status: Done\n', stderr: '' };
    });
    const boundary = new GitReadBoundary({ gitExec });

    const content = await boundary.readFileAtRef(REPO, 'origin/main', 'board/stories/S-1.yaml');

    expect(content).toBe('status: Done\n');
    expect(calls[0].args).toEqual(['show', 'origin/main:board/stories/S-1.yaml']);
  });

  it('readFileAtRef returns null when the file does not exist at the ref (no crash)', async () => {
    const { gitExec } = makeGitExec(() => {
      throw new Error('fatal: path does not exist');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const content = await boundary.readFileAtRef(REPO, 'origin/main', 'board/stories/missing.yaml');

    expect(content).toBeNull();
  });

  it('listFilesAtRef returns repo-relative file paths via `git ls-tree -r --name-only`', async () => {
    const { gitExec, calls } = makeGitExec((args) => {
      expect(args[0]).toBe('ls-tree');
      return { stdout: 'board/stories/S-1.yaml\nboard/stories/S-2.yaml\n', stderr: '' };
    });
    const boundary = new GitReadBoundary({ gitExec });

    const files = await boundary.listFilesAtRef(REPO, 'origin/main', 'board/stories');

    expect(files).toEqual(['board/stories/S-1.yaml', 'board/stories/S-2.yaml']);
    expect(calls[0].args).toEqual(['ls-tree', '-r', '--name-only', 'origin/main', 'board/stories']);
  });

  it('listFilesAtRef returns an empty list when the directory does not exist at the ref (no crash)', async () => {
    const { gitExec } = makeGitExec(() => {
      throw new Error('fatal: not a valid object name');
    });
    const boundary = new GitReadBoundary({ gitExec });

    const files = await boundary.listFilesAtRef(REPO, 'origin/main', 'board/missing-dir');

    expect(files).toEqual([]);
  });
});

describe('createGitRefFsDeps — Git-Ref-Datei-Quelle (AC2 Verträge §Snapshot-Schnittstelle)', () => {
  it('readdir() lists only direct-child .yaml files (relative to the queried dir) via listFilesAtRef', async () => {
    const boundary = {
      listFilesAtRef: jest.fn(async () => [
        'board/stories/S-1.yaml',
        'board/stories/S-2.yaml',
        'board/stories/nested/ignored.yaml', // deeper path — must NOT appear as a direct child
      ]),
    };
    const fsDeps = createGitRefFsDeps(REPO, 'origin/main', boundary);

    const entries = await fsDeps.readdir(`${REPO}/board/stories`, { withFileTypes: true });

    expect(entries.map((e) => e.name).sort()).toEqual(['S-1.yaml', 'S-2.yaml']);
    expect(entries.every((e) => e.isFile() === true)).toBe(true);
    expect(entries.every((e) => e.isDirectory() === false)).toBe(true);
    expect(boundary.listFilesAtRef).toHaveBeenCalledWith(REPO, 'origin/main', 'board/stories');
  });

  it('readdir() without withFileTypes returns plain name strings', async () => {
    const boundary = { listFilesAtRef: jest.fn(async () => ['board/features/F-1.yaml']) };
    const fsDeps = createGitRefFsDeps(REPO, 'origin/main', boundary);

    const names = await fsDeps.readdir(`${REPO}/board/features`, {});

    expect(names).toEqual(['F-1.yaml']);
  });

  it('readFile() returns the ref content for a file under repoPath', async () => {
    const boundary = { readFileAtRef: jest.fn(async () => 'id: S-1\nstatus: Done\n') };
    const fsDeps = createGitRefFsDeps(REPO, 'origin/main', boundary);

    const content = await fsDeps.readFile(`${REPO}/board/stories/S-1.yaml`, 'utf8');

    expect(content).toBe('id: S-1\nstatus: Done\n');
    expect(boundary.readFileAtRef).toHaveBeenCalledWith(REPO, 'origin/main', 'board/stories/S-1.yaml');
  });

  it('readFile() throws an ENOENT-shaped error when the file is absent at the ref (fsDeps.readFile-compatible)', async () => {
    const boundary = { readFileAtRef: jest.fn(async () => null) };
    const fsDeps = createGitRefFsDeps(REPO, 'origin/main', boundary);

    await expect(fsDeps.readFile(`${REPO}/board/stories/missing.yaml`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
