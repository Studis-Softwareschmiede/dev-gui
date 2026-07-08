/**
 * Kindprozess-Helfer (fswatcher-crash-hardening V2 AC8).
 *
 * Läuft AUSSERHALB von Jest (siehe fswatcher-regression-child.mjs Doc-Kommentar
 * für die Begründung — Jest maskiert echte Prozess-Crashs). Verifiziert den
 * `watchWithErrorGuard()`-Adapter (src/BoardAggregator.js), der die V2-Härtung
 * gegen interne FSWatcher-`'error'`-Events trägt (Vorfall 2026-07-07:
 * `Emitted 'error' event on FSWatcher instance`, ausgelöst durch eine intern —
 * durch `recursive: true` — angelegte FSWatcher-Instanz, deren Fehler NICHT
 * über den `for await`-Async-Iterator propagiert wurde).
 *
 * Modi (argv[2]):
 *   (kein Flag)  — UNGUARDED-Baseline: ein roher `node:fs.watch()`-FSWatcher
 *                  (die API, die der Adapter wrapped) OHNE registrierten
 *                  `'error'`-Listener — ein `'error'`-Event darauf crasht den
 *                  Prozess (Node-EventEmitter-Kernverhalten). Demonstriert das
 *                  exakte Fehlerbild, das AC8 verhindert.
 *   "--guarded"  — Treibt `watchWithErrorGuard()` DIREKT über seine PUBLIC
 *                  Async-Iterator-Schnittstelle gegen ein ECHTES,
 *                  verschwindendes Wurzelverzeichnis — der Adapter registriert
 *                  intern einen `'error'`-Listener auf der von ihm erzeugten
 *                  `node:fs.watch()`-Instanz; das MUSS als saubere ENOENT-
 *                  Iterator-Ablehnung enden statt den Prozess zu crashen.
 *
 * Exit-Codes:
 *   0  = Prozess hat überlebt (bei --guarded: UND der Iterator hat sauber mit
 *        ENOENT abgelehnt).
 *   1  = uncaughtException erreichte den Top-Level-Handler (Crash-Pfad).
 *   2  = unhandledRejection erreichte den Top-Level-Handler (Crash-Pfad;
 *        je nach Microtask-/Timer-Kontext des `.emit()`-Aufrufs surfaced Node
 *        denselben zugrunde liegenden Fehler als uncaughtException ODER
 *        unhandledRejection — beide sind das erwartete Crash-Signal der
 *        UNGUARDED-Baseline).
 *   3  = (nur --guarded) Assertion innerhalb des Kindprozesses scheiterte
 *        (Iterator endete nicht / falscher Fehler-Code).
 */
import { watchWithErrorGuard } from '../../src/BoardAggregator.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { watch as watchCallback } from 'node:fs';
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
  const guarded = process.argv.includes('--guarded');
  const root = await mkdtemp(join(tmpdir(), 'fswatch-synthetic-'));
  await mkdir(root, { recursive: true });

  if (guarded) {
    const ac = new AbortController();
    const iterable = watchWithErrorGuard(root, { recursive: true, signal: ac.signal });

    let iteratorEnded = false;
    let iteratorError = null;
    (async () => {
      try {
        for await (const ev of iterable) {
          void ev;
        }
        iteratorEnded = true;
      } catch (err) {
        iteratorError = err;
        iteratorEnded = true;
      }
    })();

    await sleep(300);
    await rm(root, { recursive: true, force: true });
    await sleep(500);

    if (!iteratorEnded) {
      process.stderr.write(
        'ASSERTION_FAILED: watchWithErrorGuard iterator never ended after root vanished\n',
      );
      process.exit(3);
      return;
    }
    if (!iteratorError || iteratorError.code !== 'ENOENT') {
      process.stderr.write(
        `ASSERTION_FAILED: expected ENOENT from watchWithErrorGuard, got ${
          iteratorError && iteratorError.message
        }\n`,
      );
      process.exit(3);
      return;
    }

    ac.abort();
    process.stdout.write('OK\n');
    process.exit(0);
    return;
  }

  // UNGUARDED baseline: a raw FSWatcher (plain node:fs.watch(), the API
  // watchWithErrorGuard wraps) with NO 'error' listener registered — an
  // 'error' event on it is expected to crash the process (Node EventEmitter
  // core behavior: "Unhandled 'error' event"). The synthetic error message
  // matches the 2026-07-07 incident log verbatim ("Emitted 'error' event on
  // FSWatcher instance").
  const w = watchCallback(root, { recursive: true, persistent: true });
  await sleep(200);
  w.emit(
    'error',
    Object.assign(
      new Error(
        `ENOENT: no such file or directory, scandir '${join(root, 'test', '.tmp-router-y8i8og6spkr')}'`,
      ),
      { code: 'ENOENT', syscall: 'scandir' },
    ),
  );
  await sleep(500);
  process.stdout.write('OK (unexpected — should have crashed)\n');
  process.exit(0);
}

main();
