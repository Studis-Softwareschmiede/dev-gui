/**
 * Kindprozess-Helfer (fswatcher-crash-hardening V2 AC11).
 *
 * Läuft AUSSERHALB von Jest, weil Jest's Test-VM einen unbehandelten
 * `uncaughtException`/Fehler, der ausserhalb des unmittelbaren `it()`-Callbacks
 * geworfen wird (z.B. asynchron über einen fs.watch()-Event-Callback), dem
 * gerade laufenden Test zuordnet und den Prozess NICHT beendet — ein echter
 * `process.exit`-Crash (der Vorfall selbst) ist innerhalb von Jest daher NICHT
 * beobachtbar. Dieses Skript bildet den Vorfall 2026-07-07 in einem ECHTEN,
 * eigenständigen Node-Prozess ab: ein rekursiver Watch ist auf einen
 * Repo-artigen Verzeichnisbaum bewaffnet; darunter wird ein Test-Temp-
 * Verzeichnis nach dem Muster `test/.tmp-<zufall>` angelegt und wieder
 * gelöscht (Create/Delete-Zyklus) — exakt der Vorfall-Vektor
 * (`/workspace/dev-gui/test/.tmp-router-y8i8og6spkr`, siehe Vorfall-Log).
 *
 * NUR `BoardAggregator` importiert (keine V2-spezifische `watchWithErrorGuard`-
 * Abhängigkeit) — bewusst so gehalten, damit dieses Skript UNVERÄNDERT auch
 * gegen den V1-Stand (S-280, vor dieser Story) lauffähig ist und dort den
 * Crash reproduziert (Regressions-Barriere-Nachweis, siehe AC11-Testkommentar
 * in test/boardAggregator.test.js).
 *
 * Exit-Codes:
 *   0  = Prozess hat überlebt UND der Watcher-Baustein blieb funktionsfähig
 *        (eine Änderung an einem beobachteten Pfad NACH der Churn-Sequenz
 *        invalidiert den Index weiterhin).
 *   1  = uncaughtException erreichte den Top-Level-Handler (Crash-Pfad).
 *   2  = unhandledRejection erreichte den Top-Level-Handler (Crash-Pfad).
 *   3  = Watcher blieb NICHT funktionsfähig nach der Churn-Sequenz (Assertion
 *        innerhalb des Kindprozesses scheiterte, kein Crash aber kein
 *        korrektes AC11(b)-Verhalten).
 */
import { BoardAggregator } from '../../src/BoardAggregator.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (err) => {
  process.stderr.write(`UNCAUGHT_EXCEPTION: ${err && err.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`UNHANDLED_REJECTION: ${err && err.message}\n`);
  process.exit(2);
});

async function main() {
  // BOARD_ROOTS-Wurzel = Workspace-artige Wurzel (wie /workspace im echten
  // Deployment). Darunter: <root>/probe-repo/ — ein Repo-artiges Verzeichnis
  // (Zwischenebene, wie BoardAggregator.scan() sie erwartet) MIT
  //   - <root>/probe-repo/board/                (index-relevant, beobachtet)
  //   - <root>/probe-repo/test/.tmp-<random>/   (EXAKT der Vorfall-Vektor:
  //     /workspace/dev-gui/test/.tmp-router-y8i8og6spkr, siehe Vorfall-Log)
  const root = await mkdtemp(join(tmpdir(), 'fswatch-regression-'));
  const repoRoot = join(root, 'probe-repo');
  await mkdir(join(repoRoot, 'board'), { recursive: true });
  await writeFile(
    join(repoRoot, 'board', 'board.yaml'),
    'schema_version: 1\nproject_slug: regression-probe\n',
    'utf8',
  );

  const aggregator = new BoardAggregator({ boardRootsEnv: root });
  aggregator.startWatchers();
  await sleep(300);

  // Vorfall 2026-07-07: test/.tmp-router-y8i8og6spkr angelegt + wieder gelöscht
  // unter einem rekursiven Watch. PARALLELE (nicht sequenzielle), tief
  // verschachtelte Create/Delete-Zyklen über MEHRERE Runden — live verifiziert
  // (Node 20, Linux, dieselbe Sandbox-Plattform): eine einzelne Runde mit rein
  // sequenziellen Zyklen trifft das interne Node-Timing-Fenster (Vorfall
  // 2026-07-07, non-native recursive-watch-Emulation) so gut wie nie; mehrere
  // Runden mit PARALLELEN, tief verschachtelten Zyklen treffen es gegen den
  // V1-Stand (S-280) in der Mehrheit der Läufe zuverlässig (>60% Trefferquote
  // in wiederholten lokalen Läufen) — der Kernel-Race selbst bleibt
  // last-/timing-abhängig (Spec-Annahme A7 "plattformnah"), ist aber mit
  // dieser Intensität ausreichend reproduzierbar, um als Regressions-Barriere
  // zu dienen (gegen V2 lief derselbe Ablauf in allen Wiederholungen sauber
  // durch — sowohl weil die AC9-Scope-Verengung `test/.tmp-*` gar nicht erst
  // beobachtet, als auch weil AC8 den Restfall härtet).
  for (let round = 0; round < 5; round++) {
    const jobs = [];
    for (let i = 0; i < 60; i++) {
      const tmpDir = join(
        repoRoot,
        'test',
        `.tmp-router-r${round}-${i}${Math.random().toString(36).slice(2)}`,
      );
      jobs.push(
        (async () => {
          try {
            await mkdir(join(tmpDir, 'a', 'b', 'c'), { recursive: true });
            await writeFile(join(tmpDir, 'a', 'b', 'c', 'file.txt'), 'x', 'utf8');
            await writeFile(join(tmpDir, 'a', 'other.txt'), 'x', 'utf8');
            await rm(tmpDir, { recursive: true, force: true });
          } catch {
            /* transient ENOENT on our OWN mkdir/rm race is not the point here */
          }
        })(),
      );
    }
    await Promise.all(jobs);
    await sleep(50);
  }

  await sleep(1500);

  // Watcher-Baustein bleibt funktionsfähig: eine Änderung an einem
  // BEOBACHTETEN Pfad (board/) invalidiert den Index weiterhin (AC11 (b)).
  // `slug` ist der Repo-VERZEICHNISNAME (nicht `project_slug` aus board.yaml).
  await aggregator.scan();
  const before = await aggregator.getIndex();
  if (!before.some((p) => p.slug === 'probe-repo')) {
    process.stderr.write(
      `ASSERTION_FAILED: probe project not found before mutation (${JSON.stringify(before)})\n`,
    );
    process.exit(3);
    return;
  }

  const secondProjectBoardDir = join(root, 'second-probe', 'board');
  await mkdir(secondProjectBoardDir, { recursive: true });
  await writeFile(
    join(secondProjectBoardDir, 'board.yaml'),
    'schema_version: 1\nproject_slug: second-probe\n',
    'utf8',
  );
  await sleep(700);

  const after = await aggregator.getIndex();
  if (!after.some((p) => p.slug === 'second-probe')) {
    process.stderr.write(
      `ASSERTION_FAILED: watcher did not pick up post-churn change (${JSON.stringify(after)})\n`,
    );
    process.exit(3);
    return;
  }

  aggregator.stopWatchers();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write('OK\n');
  process.exit(0);
}

main();
