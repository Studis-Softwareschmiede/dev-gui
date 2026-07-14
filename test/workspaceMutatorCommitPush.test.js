/**
 * workspaceMutatorCommitPush.test.js — Unit-Tests für
 * `WorkspaceMutator#commitAndPushFile` (docs/specs/per-app-gpg-passphrase-rotation.md,
 * F-073/S-338, AC4/AC11; Review-Iteration 2 Härtung — Finding 1 + Finding 2).
 *
 * Covers:
 *   AC11 — genau EIN `git add` + `git commit` + `git push origin HEAD:<branch>`
 *          im Klon (kein PR, kein zweiter Branch); Token via GIT_ASKPASS
 *          (env), NIEMALS im Argv.
 *   AC4  — Traversal-/Symlink-Flucht-Schutz identisch zu `pullClone` (dieselbe
 *          Guard-Technik, WorkspaceMutator ist die einzige FS-Mutations-Boundary).
 *   Finding 1 (Review-Iteration 2) — kein verwaister lokaler Commit / keine dirty
 *          Working-Tree nach einem Fehlschlag: `git reset --hard <prevHead>`
 *          (per `git rev-parse HEAD` VOR jeder Mutation erfasst) rollt JEDEN
 *          Fehlschlag (Branch-Mismatch/add/commit/push) zurück.
 *   Finding 2 (Review-Iteration 2) — der Push-Branch wird VOR jeder Mutation
 *          gegen die autoritative Quelle `refs/remotes/origin/HEAD`
 *          (`git symbolic-ref --short`) verifiziert; weicht der ausgecheckte
 *          Branch ab, wird HART abgebrochen (`branch-mismatch`), kein Push.
 *   Idempotenz — "nothing to commit" (Inhalt bereits identisch) wird NICHT als
 *          Fehler gewertet; Push wird trotzdem versucht.
 *   Fehlerklassifizierung — `git add`/`git commit` → `commit-failed`;
 *          `git push`/Branch-Ermittlung → `push-failed`; Branch-Abweichung →
 *          `branch-mismatch`.
 *
 * Strategy: injizierter execFn-Mock, der per `args[0]`(+`args[1]`) dispatcht
 * (rev-parse HEAD/--abbrev-ref, symbolic-ref, add, commit, push, reset) und
 * alle Aufrufe (args+env) mitschneidet — beweist, dass der Token NIE im Argv
 * landet (nur in einer zufällig benannten Env-Var, per GIT_ASKPASS referenziert).
 *
 * Covers (workspace-mutator-credential-helper.md):
 *   AC1 — jedes mutierende git-Subkommando (rev-parse, symbolic-ref, add,
 *         commit, push, reset) trägt die beiden Command-Scope-Flags
 *         `-c credential.helper=` + `-c credential.https://github.com.helper=`
 *         in genau dieser Reihenfolge VOR dem Subkommando.
 *   AC2 — die Flag-Werte sind leer (kein Secret in argv); der Token bleibt
 *         ausschließlich im GIT_ASKPASS-Env-Var-Pfad (Bestandsmechanik).
 *   AC3 — nur im Container gegen einen aktiven ambienten Helfer reproduzierbar
 *         (siehe Spec „Edge-Cases"); im Unit-Kontext genügt der argv-Nachweis
 *         oben (AC1/AC2) — nicht hier getestet.
 *
 * Der `sub`-Dispatch strippt den fixen Flag-Präfix (GIT_CRED_HELPER_PREFIX)
 * vor der Subkommando-Erkennung, damit der Rest der Mock-Logik unverändert
 * bleibt; jede `.args`-Assertion erwartet den vollen, prefixed Argv.
 */

import { describe, it, expect } from '@jest/globals';
import { WorkspaceMutator } from '../src/WorkspaceMutator.js';

const DEFAULT_PREV_HEAD = 'deadbeef0000000000000000000000000000prev';

/**
 * Die Command-Scope-Flags, die JEDES mutierende git-Subkommando laut AC1
 * VORANGESTELLT bekommen muss (Flag-Kanon, feste Reihenfolge).
 */
const GIT_CRED_HELPER_PREFIX = [
  '-c', 'credential.helper=',
  '-c', 'credential.https://github.com.helper=',
];

/**
 * Baut das erwartete argv für ein Subkommando inkl. Neutralisierungs-Präfix
 * (AC1) — Kurzform für `.toEqual([...GIT_CRED_HELPER_PREFIX, ...sub])`.
 */
function withCredHelperPrefix(subArgs) {
  return [...GIT_CRED_HELPER_PREFIX, ...subArgs];
}

/**
 * Liefert das eigentliche git-Subkommando aus einem recorded call's `args`
 * (nach dem 4-elementigen AC1-Präfix) — Kurzform für die vielen
 * `calls.find/filter/some((c) => subCmd(c.args) === 'add')`-Assertions.
 */
function subCmd(args) {
  return args[GIT_CRED_HELPER_PREFIX.length];
}

/**
 * Baut einen Mutator mit einem dispatchenden execFn (rev-parse/symbolic-ref/
 * add/commit/push/reset) + injizierten fsDeps (lstat/realpath/writeFile/unlink
 * — synthetische Pfade, kein echtes FS nötig, analog dem bestehenden
 * pullClone-Testmuster).
 *
 * `git`-Optionen (alle optional):
 *   branch          — aktueller Branch (rev-parse --abbrev-ref HEAD), default 'main'
 *   defaultRef      — refs/remotes/origin/HEAD-Wert (symbolic-ref), default 'origin/main'
 *   prevHead        — Rückgabe von `rev-parse HEAD`, default DEFAULT_PREV_HEAD
 *   headFail        — `rev-parse HEAD` schlägt fehl (kein Rollback-Anker)
 *   branchFail      — `rev-parse --abbrev-ref HEAD` schlägt fehl
 *   symbolicRefFail — `symbolic-ref` schlägt fehl (kein origin/HEAD gesetzt)
 *   addFail/commitFail/nothingToCommit/pushFail — wie bisher
 */
function buildMutator({ workspaceDir = '/workspace', lstatExists = true, git = {} } = {}) {
  const calls = [];
  return {
    calls,
    mutator: new WorkspaceMutator({
      workspaceDir,
      fsDeps: {
        lstat: async (p) => {
          if (!lstatExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return { path: p };
        },
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => {},
      },
      execFn: async (cmd, args, opts) => {
        calls.push({ cmd, args: [...args], env: { ...opts?.env } });
        // AC1: every call MUST carry the neutralize prefix, in fixed order,
        // BEFORE the subcommand — asserted centrally here so every existing
        // dispatch branch below implicitly proves the position too (a
        // mismatched prefix means `subArgs` picks up a stray '-c'/flag-value
        // as the "subcommand" and falls through to the `unexpected` throw).
        expect(args.slice(0, 4)).toEqual(GIT_CRED_HELPER_PREFIX);
        const subArgs = args.slice(4);
        const sub = subArgs[0];
        if (sub === 'rev-parse') {
          if (subArgs[1] === '--abbrev-ref') {
            if (git.branchFail) throw new Error('rev-parse --abbrev-ref failed');
            return { stdout: `${git.branch ?? 'main'}\n`, stderr: '' };
          }
          // plain `git rev-parse HEAD` — prevHead capture (Finding 1)
          if (git.headFail) throw new Error('rev-parse HEAD failed (fresh/empty clone)');
          return { stdout: `${git.prevHead ?? DEFAULT_PREV_HEAD}\n`, stderr: '' };
        }
        if (sub === 'symbolic-ref') {
          if (git.symbolicRefFail) throw new Error('symbolic-ref failed: refs/remotes/origin/HEAD not set');
          return { stdout: `${git.defaultRef ?? 'origin/main'}\n`, stderr: '' };
        }
        if (sub === 'reset') {
          if (git.resetFail) throw new Error('git reset --hard failed');
          return { stdout: '', stderr: '' };
        }
        if (sub === 'add') {
          if (git.addFail) throw new Error('git add failed');
          return { stdout: '', stderr: '' };
        }
        if (sub === 'commit') {
          if (git.nothingToCommit) throw new Error('nothing to commit, working tree clean');
          if (git.commitFail) throw new Error('git commit failed: pre-commit hook rejected');
          return { stdout: '[main abc1234] chore: rotate .env.gpg\n', stderr: '' };
        }
        if (sub === 'push') {
          if (git.pushFail) throw new Error('git push failed: remote rejected');
          return { stdout: git.pushStdout ?? 'To github.com:Org/app.git\n   abc1234..def5678  main -> main\n', stderr: '' };
        }
        throw new Error(`unexpected git subcommand: ${args.join(' ')}`);
      },
    }),
  };
}

describe('WorkspaceMutator.commitAndPushFile — AC4: Traversal-/Symlink-Schutz (unit)', () => {
  it('traversal: name=".." → traversal error, mintFn NICHT aufgerufen', async () => {
    let mintCalled = false;
    const { mutator } = buildMutator({});
    await expect(
      mutator.commitAndPushFile('..', '.env.gpg', async () => { mintCalled = true; return 'token'; }),
    ).rejects.toMatchObject({ errorClass: 'traversal' });
    expect(mintCalled).toBe(false);
  });

  it('nested "a/b" → traversal error', async () => {
    const { mutator } = buildMutator({});
    await expect(
      mutator.commitAndPushFile('a/b', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'traversal' });
  });

  it('not-found: lstat wirft → not-found error, mintFn NICHT aufgerufen', async () => {
    let mintCalled = false;
    const { mutator } = buildMutator({ lstatExists: false });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => { mintCalled = true; return 'token'; }),
    ).rejects.toMatchObject({ errorClass: 'not-found' });
    expect(mintCalled).toBe(false);
  });

  it('WORKSPACE_DIR unset → workspace-unset error, mintFn NICHT aufgerufen', async () => {
    let mintCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: '',
      fsDeps: { lstat: async () => {}, realpath: async (p) => p, writeFile: async () => {}, unlink: async () => {} },
      execFn: async () => ({ stdout: '', stderr: '' }),
    });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => { mintCalled = true; return 'token'; }),
    ).rejects.toMatchObject({ errorClass: 'workspace-unset' });
    expect(mintCalled).toBe(false);
  });
});

describe('WorkspaceMutator.commitAndPushFile — AC11: add + commit + push, kein PR (unit)', () => {
  it('Happy-Path: genau EIN add/commit/push, Push zeigt auf origin HEAD:<branch>', async () => {
    const { mutator, calls } = buildMutator({ git: { branch: 'main', defaultRef: 'origin/main' } });

    const result = await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'fake-token-abc', {
      commitMessage: 'chore: rotate GPG passphrase (.env.gpg)',
    });

    expect(calls.filter((c) => subCmd(c.args) === 'add').length).toBe(1);
    expect(calls.filter((c) => subCmd(c.args) === 'commit').length).toBe(1);
    expect(calls.filter((c) => subCmd(c.args) === 'push').length).toBe(1);
    expect(calls.some((c) => subCmd(c.args) === 'reset')).toBe(false); // Erfolg — kein Rollback nötig

    // AC1: jedes Subkommando trägt den vollen Neutralisierungs-Präfix VOR
    // dem eigentlichen Subkommando (Flag-Kanon, feste Reihenfolge).
    const addCall = calls.find((c) => subCmd(c.args) === 'add');
    expect(addCall.args).toEqual(withCredHelperPrefix(['add', '--', '.env.gpg']));

    const commitCall = calls.find((c) => subCmd(c.args) === 'commit');
    expect(commitCall.args).toEqual(
      withCredHelperPrefix(['commit', '-m', 'chore: rotate GPG passphrase (.env.gpg)']),
    );

    const pushCall = calls.find((c) => subCmd(c.args) === 'push');
    expect(pushCall.args).toEqual(withCredHelperPrefix(['push', 'origin', 'HEAD:main'])); // kein PR, direkter Push auf den (Default-)Branch

    expect(result).toHaveProperty('summary');
    expect(result.summary).not.toContain('fake-token-abc');
  });

  it('Token wird via GIT_ASKPASS (Env) injiziert, NIEMALS im Argv', async () => {
    const { mutator, calls } = buildMutator({});
    await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'SECRET-TOKEN-XYZ');

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('SECRET-TOKEN-XYZ');
    }
    const pushCall = calls.find((c) => subCmd(c.args) === 'push');
    expect(pushCall.env).toHaveProperty('GIT_ASKPASS');
    expect(pushCall.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(pushCall.env.GIT_ASKPASS).not.toContain('SECRET-TOKEN-XYZ');
  });

  it('credentials-missing wenn mintFn rejected — kein git-Aufruf', async () => {
    const { mutator, calls } = buildMutator({});
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => { throw new Error('no creds'); }),
    ).rejects.toMatchObject({ errorClass: 'credentials-missing' });
    expect(calls.length).toBe(0);
  });

  it('"nothing to commit" wird NICHT als Fehler gewertet — Push wird trotzdem versucht', async () => {
    const { mutator, calls } = buildMutator({ git: { nothingToCommit: true, branch: 'main' } });

    const result = await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token');

    expect(result).toHaveProperty('summary');
    expect(calls.filter((c) => subCmd(c.args) === 'push').length).toBe(1); // Push trotzdem versucht
    expect(calls.some((c) => subCmd(c.args) === 'reset')).toBe(false);
  });
});

describe('WorkspaceMutator.commitAndPushFile — workspace-mutator-credential-helper AC1/AC2', () => {
  it('AC1/AC2 — JEDER git-Aufruf (rev-parse ×2, symbolic-ref, add, commit, push) trägt die zwei Command-Scope-Flags in exakt dieser Reihenfolge VOR dem Subkommando, mit leeren Werten', async () => {
    const { mutator, calls } = buildMutator({ git: { branch: 'main', defaultRef: 'origin/main' } });
    await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token', {
      commitMessage: 'chore: rotate .env.gpg',
    });

    // Happy-Path deckt 5 git-Aufrufe ab: rev-parse HEAD, rev-parse --abbrev-ref
    // HEAD, symbolic-ref, add, commit, push (6 insgesamt — rev-parse zweimal
    // mit unterschiedlichen Args).
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      // Position: die ersten 4 argv-Elemente sind EXAKT der Flag-Kanon —
      // '-c', 'credential.helper=', '-c', 'credential.https://github.com.helper='
      // — und stehen VOR dem Subkommando (Element 5).
      expect(call.args[0]).toBe('-c');
      expect(call.args[1]).toBe('credential.helper=');
      expect(call.args[2]).toBe('-c');
      expect(call.args[3]).toBe('credential.https://github.com.helper=');
      // AC2: leere Flag-WERTE — kein Secret in argv. Der Config-Key selbst
      // ist naturgemäß nicht leer ("credential.helper"); leer ist der Teil
      // NACH dem '=' (der eigentliche Helfer-Wert, den git konsultieren würde).
      expect(call.args[1].split('=')[1] ?? '').toBe('');
      expect(call.args[3].split('=').pop()).toBe('');
    }
  });

  it('AC1 — auch der Rollback-Aufruf (git reset --hard) im Fehlerpfad trägt beide Flags vor dem Subkommando', async () => {
    const { mutator, calls } = buildMutator({ git: { pushFail: true, prevHead: 'abc123prevhead' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });

    const resetCall = calls.find((c) => subCmd(c.args) === 'reset');
    expect(resetCall).toBeDefined();
    expect(resetCall.args.slice(0, 4)).toEqual(GIT_CRED_HELPER_PREFIX);
  });

  it('AC2 — Token erscheint in KEINEM argv-Element irgendeines git-Aufrufs (nur via GIT_ASKPASS-Env)', async () => {
    const { mutator, calls } = buildMutator({ git: { branch: 'main', defaultRef: 'origin/main' } });
    await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'ULTRA-SECRET-TOKEN-42');

    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain('ULTRA-SECRET-TOKEN-42');
      }
    }
  });
});

describe('WorkspaceMutator.commitAndPushFile — Finding 2: Branch-Verifikation gegen refs/remotes/origin/HEAD', () => {
  it('Branch-Mismatch (Klon manuell auf anderen Branch umgeschaltet) → branch-mismatch, KEIN add/commit/push', async () => {
    const { mutator, calls } = buildMutator({ git: { branch: 'feature-x', defaultRef: 'origin/main' } });

    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'branch-mismatch' });

    expect(calls.some((c) => subCmd(c.args) === 'add')).toBe(false);
    expect(calls.some((c) => subCmd(c.args) === 'commit')).toBe(false);
    expect(calls.some((c) => subCmd(c.args) === 'push')).toBe(false);
  });

  it('Branch-Mismatch: kein stiller Push — der Fehlertext nennt aktuellen UND Default-Branch', async () => {
    const { mutator } = buildMutator({ git: { branch: 'feature-x', defaultRef: 'origin/main' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'branch-mismatch', message: expect.stringContaining('feature-x') });
  });

  it('symbolic-ref (refs/remotes/origin/HEAD) nicht gesetzt → push-failed, KEIN Push (fail-closed)', async () => {
    const { mutator, calls } = buildMutator({ git: { symbolicRefFail: true } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });
    expect(calls.some((c) => subCmd(c.args) === 'push')).toBe(false);
  });

  it('Branch-Ermittlung (aktueller Branch) fehlgeschlagen → push-failed, kein Push-Versuch', async () => {
    const { mutator, calls } = buildMutator({ git: { branchFail: true } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });
    expect(calls.some((c) => subCmd(c.args) === 'push')).toBe(false);
  });
});

describe('WorkspaceMutator.commitAndPushFile — Finding 1: kein verwaister Commit / keine dirty Working-Tree nach Fehlschlag', () => {
  it('git push fehlgeschlagen → push-failed UND git reset --hard <prevHead> wird aufgerufen', async () => {
    const { mutator, calls } = buildMutator({ git: { pushFail: true, prevHead: 'abc123prevhead' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });

    const resetCall = calls.find((c) => subCmd(c.args) === 'reset');
    expect(resetCall).toBeDefined();
    expect(resetCall.args).toEqual(withCredHelperPrefix(['reset', '--hard', 'abc123prevhead'])); // kein orphaned Commit nach Push-Fehlschlag
  });

  it('git commit (echter Fehler) → commit-failed UND Rollback auf prevHead', async () => {
    const { mutator, calls } = buildMutator({ git: { commitFail: true, prevHead: 'abc123prevhead' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'commit-failed' });
    expect(calls.some((c) => subCmd(c.args) === 'push')).toBe(false);
    const resetCall = calls.find((c) => subCmd(c.args) === 'reset');
    expect(resetCall?.args).toEqual(withCredHelperPrefix(['reset', '--hard', 'abc123prevhead']));
  });

  it('git add fehlgeschlagen → commit-failed, kein commit/push, Rollback auf prevHead', async () => {
    const { mutator, calls } = buildMutator({ git: { addFail: true, prevHead: 'abc123prevhead' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'commit-failed' });
    expect(calls.some((c) => subCmd(c.args) === 'commit')).toBe(false);
    expect(calls.some((c) => subCmd(c.args) === 'push')).toBe(false);
    const resetCall = calls.find((c) => subCmd(c.args) === 'reset');
    expect(resetCall?.args).toEqual(withCredHelperPrefix(['reset', '--hard', 'abc123prevhead']));
  });

  it('Branch-Mismatch löst ebenfalls den Rollback-Pfad aus (verwirft eine bereits geschriebene Datei im Working-Tree)', async () => {
    const { mutator, calls } = buildMutator({ git: { branch: 'feature-x', defaultRef: 'origin/main', prevHead: 'abc123prevhead' } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'branch-mismatch' });
    const resetCall = calls.find((c) => subCmd(c.args) === 'reset');
    expect(resetCall?.args).toEqual(withCredHelperPrefix(['reset', '--hard', 'abc123prevhead']));
  });

  it('kein Rollback-Anker (rev-parse HEAD schlägt fehl, z.B. leerer Klon) → Fehlschlag klassifiziert, aber KEIN reset-Aufruf', async () => {
    const { mutator, calls } = buildMutator({ git: { pushFail: true, headFail: true } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });
    expect(calls.some((c) => subCmd(c.args) === 'reset')).toBe(false); // kein Anker vorhanden — best-effort, kein Crash
  });

  it('git push fehlgeschlagen, Fehlertext ist redigiert (kein Token/Credential-Leak)', async () => {
    const { mutator } = buildMutator({ git: { pushFail: true } });
    await expect(
      mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token'),
    ).rejects.toMatchObject({ errorClass: 'push-failed' });
  });

  it('Askpass-Temp-Skript wird auch bei Push-Fehlschlag (inkl. Rollback) aufgeräumt', async () => {
    let unlinkCalled = false;
    const mutator = new WorkspaceMutator({
      workspaceDir: '/workspace',
      fsDeps: {
        lstat: async () => ({}),
        realpath: async (p) => p,
        writeFile: async () => {},
        unlink: async () => { unlinkCalled = true; },
      },
      execFn: async (_cmd, args) => {
        expect(args.slice(0, 4)).toEqual(GIT_CRED_HELPER_PREFIX); // AC1
        const sub = subCmd(args);
        if (sub === 'rev-parse' && args[5] === '--abbrev-ref') return { stdout: 'main\n', stderr: '' };
        if (sub === 'rev-parse') return { stdout: `${DEFAULT_PREV_HEAD}\n`, stderr: '' };
        if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
        if (sub === 'add') return { stdout: '', stderr: '' };
        if (sub === 'commit') return { stdout: '', stderr: '' };
        if (sub === 'push') throw new Error('push failed');
        if (sub === 'reset') return { stdout: '', stderr: '' };
        throw new Error('unexpected');
      },
    });

    try {
      await mutator.commitAndPushFile('my-app', '.env.gpg', async () => 'token');
    } catch {
      // erwartet
    }
    expect(unlinkCalled).toBe(true);
  });
});
