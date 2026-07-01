/**
 * TokenLimitWatcher.test.js — Unit-Tests für die Token-/Usage-Limit-Erkennung
 * + Reset-Wartelogik (docs/specs/taktgeber-nachtwaechter.md).
 *
 * Covers (taktgeber-nachtwaechter):
 *   AC13 — Erkennung konto-weit: PTY-Output wird auf die Limit-Meldung samt
 *          Reset-Zeitpunkt geprüft. Mehrere reale Meldungs-Varianten (12h
 *          "3am (Europe/Zurich)", 24h "at 15:45", 12h mit Minuten "3:15pm",
 *          ohne Zeitzonen-Angabe, mit abweichender IANA-Zone), heute-vs-
 *          morgen-Rollover je nach `nowMs`, über PTY-Chunk-Grenzen
 *          gesplittete Meldung, Negativfälle (normaler Output triggert
 *          NICHT, Keyword ohne parsbare Zeit triggert NICHT — kein
 *          Fehlalarm). Proximity-Regression (Iteration 2, coder.md Lesson
 *          2026-07-01): Keyword und Reset-Zeit-Ausdruck aus zwei
 *          unabhängigen, weit auseinanderliegenden Textstellen im
 *          rollierenden Puffer → KEIN Fehlalarm; die EIGENE Quelldatei
 *          `src/TokenLimitWatcher.js` (enthält "session limit"/"usage
 *          limit" UND mehrere "resets …am"-Beispiele in der Modul-Doku, an
 *          weit auseinanderliegenden Stellen) via `feed()` in kleinen
 *          Chunks durchgeschickt → KEIN Fehlalarm; echte, zusammenhängende
 *          Meldung bleibt weiterhin erkannt (auch über 2 Chunks gesplittet).
 *   AC14 — Wartelogik: `waitForReset()` wartet bis Reset + 1 min Puffer
 *          (injizierte Clock/Sleep, kein echtes Warten), danach Zustand
 *          zurückgesetzt ("fortsetzen"); liegt der Reset NACH
 *          `windowEndMs` → kein Warten (`reason:'exceeds-window'`); kein
 *          aktueller Limit-Zustand → sofort `reason:'not-limited'`;
 *          Reset bereits in der Vergangenheit (Verarbeitungs-Latenz) →
 *          Wartezeit auf 0 geklemmt, nicht negativ.
 *          Pure Helper `zonedWallTimeToUtc`/`isValidIanaTimeZone` zusätzlich
 *          direkt getestet (Zeitzonen-Konvertierung ist die Grundlage der
 *          Rollover-Entscheidung).
 *
 * Strategy: pure Funktionen (`parseTokenLimitMessage`, `zonedWallTimeToUtc`,
 * `isValidIanaTimeZone`) direkt mit fixen Referenzdaten getestet (Januar —
 * DST-frei für Europe/Zurich UND America/New_York, damit Offsets
 * deterministisch bekannt sind: CET=UTC+1, EST=UTC-5). `TokenLimitWatcher`
 * gegen eine Mini-Fake-EventEmitter (on/off) für `attach()`/`detachAll()`,
 * sowie `feed()` direkt für Chunk-Splitting-Tests. `waitForReset()` immer
 * mit injiziertem `sleepFn`/`now` — kein echtes Warten in der Testsuite.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TokenLimitWatcher,
  parseTokenLimitMessage,
  zonedWallTimeToUtc,
  isValidIanaTimeZone,
  DEFAULT_TIMEZONE,
  DEFAULT_RESET_BUFFER_MS,
} from '../src/TokenLimitWatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWN_SOURCE_PATH = path.join(__dirname, '..', 'src', 'TokenLimitWatcher.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Januar 2026 — DST-frei für Europe/Zurich (CET, UTC+1) und America/New_York (EST, UTC-5). */
const JAN15_00UTC = Date.UTC(2026, 0, 15, 0, 0, 0); // = 2026-01-15 01:00 CET

/** Mini-Fake-EventEmitter (nur on/off/emit) — Muster PtyManager `.on('output', …)`. */
function makeFakeEmitter() {
  const listeners = new Set();
  return {
    on(event, cb) {
      if (event === 'output') listeners.add(cb);
    },
    off(event, cb) {
      if (event === 'output') listeners.delete(cb);
    },
    emit(chunk) {
      for (const cb of [...listeners]) cb(chunk);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

// ── AC13: parseTokenLimitMessage ─────────────────────────────────────────────

describe('taktgeber-nachtwaechter AC13 — parseTokenLimitMessage', () => {
  it('parses "resets 3am (Europe/Zurich)" — today, before 3am local', () => {
    const text = "You've hit your session limit · resets 3am (Europe/Zurich)";
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    expect(result.timezone).toBe('Europe/Zurich');
    // 2026-01-15 03:00 CET = 02:00 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });

  it('rolls over to tomorrow when the named time has already passed today', () => {
    const text = "You've hit your session limit · resets 3am (Europe/Zurich)";
    // now = 2026-01-15 03:00 UTC = 04:00 CET → already past 3am local
    const nowMs = Date.UTC(2026, 0, 15, 3, 0, 0);
    const result = parseTokenLimitMessage(text, { nowMs, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    // 2026-01-16 03:00 CET = 02:00 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 16, 2, 0, 0));
  });

  it('treats "exactly now" as already passed (rolls to tomorrow, not stuck at now)', () => {
    const text = 'Usage limit reached — resets 1am (Europe/Zurich)';
    // now = exactly 2026-01-15 01:00 CET = 2026-01-15 00:00 UTC
    const nowMs = Date.UTC(2026, 0, 15, 0, 0, 0);
    const result = parseTokenLimitMessage(text, { nowMs, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 16, 0, 0, 0)); // tomorrow 01:00 CET
  });

  it('parses 24h "resets at 15:45" without am/pm', () => {
    const text = 'Session limit hit, resets at 15:45';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    // 2026-01-15 15:45 CET = 14:45 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 14, 45, 0));
  });

  it('parses 12h with minutes "resets at 3:15pm"', () => {
    const text = 'Your session limit was hit. Resets at 3:15pm';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    // 15:15 CET = 14:15 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 14, 15, 0));
  });

  it('parses "resets 11pm" without explicit "at" and without tz (falls back to defaultTimezone)', () => {
    const text = 'Usage limit reached, resets 11pm';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    expect(result.timezone).toBe(DEFAULT_TIMEZONE);
    // 23:00 CET = 22:00 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 22, 0, 0));
  });

  it('uses an explicit non-default IANA timezone from the message (America/New_York, EST=UTC-5)', () => {
    const text = 'You hit your session limit · resets 3am (America/New_York)';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    expect(result.timezone).toBe('America/New_York');
    // 2026-01-15 03:00 EST = 08:00 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 8, 0, 0));
  });

  it('midnight edge: "resets 12am" maps to hour 0 (not 12)', () => {
    const text = 'session limit hit, resets 12am (Europe/Zurich)';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    // 2026-01-15 00:00 CET already passed relative to now (01:00 CET) → tomorrow 00:00 CET = 2026-01-15 23:00 UTC
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 23, 0, 0));
  });

  it('noon edge: "resets 12pm" maps to hour 12 (not 24)', () => {
    const text = 'session limit hit, resets 12pm (Europe/Zurich)';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC, defaultTimezone: DEFAULT_TIMEZONE });
    expect(result.matched).toBe(true);
    // 2026-01-15 12:00 CET = 11:00 UTC (still in the future relative to now = 01:00 CET)
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 11, 0, 0));
  });

  it('negative: plain output without any limit keyword never matches (no false alarm)', () => {
    const text = 'Building the project... done. The cache resets every hour.';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it('negative: "rate limit" is not "session/usage limit" — does not match', () => {
    const text = 'Warning: rate limit exceeded, retry later, resets 3am';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
  });

  it('negative: limit keyword present but reset time not parsable → no false alarm', () => {
    const text = "You've hit your session limit. It resets soon, check back later.";
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it('negative: implausible hour (25) is rejected defensively', () => {
    const text = 'session limit hit, resets at 25:00';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
  });

  it('negative: implausible minute (75) is rejected defensively', () => {
    const text = 'session limit hit, resets at 3:75pm';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
  });

  it('is robust against ANSI escape codes interleaved in the message', () => {
    const text = '\x1b[31mYou hit your session limit\x1b[0m · resets 3am (Europe/Zurich)';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(true);
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });

  it('non-string / empty input never throws and never matches', () => {
    expect(parseTokenLimitMessage(undefined).matched).toBe(false);
    expect(parseTokenLimitMessage(null).matched).toBe(false);
    expect(parseTokenLimitMessage('').matched).toBe(false);
  });

  // ── Proximity-Regression (Iteration 2, coder.md Lesson 2026-07-01) ────────
  // Reviewer-Repro: Keyword und "resets …"-Ausdruck aus zwei unabhängigen,
  // thematisch unzusammenhängenden Sätzen im selben Puffer dürfen NICHT
  // kombiniert werden — sonst Fehlalarm (verletzt AC13 "kein Fehlalarm").

  it('negative: keyword and an unrelated "resets …" phrase far apart in the buffer → no false alarm (minimal reviewer repro)', () => {
    const text =
      '...near your session limit for API calls...' +
      'x'.repeat(500) +
      '...the build cache resets 3am daily...';
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it('negative: keyword and reset-time expression exist independently but > proximity window apart → no false alarm', () => {
    const keywordPart = "You've hit your session limit for this billing cycle. ";
    const filler = 'Unrelated build log output. '.repeat(20); // well over 150 chars of unrelated text
    const resetPart = 'Note: the nightly cron job resets at 03:00 for log rotation.';
    const text = keywordPart + filler + resetPart;
    expect(filler.length).toBeGreaterThan(300);
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it('positive control: keyword and reset-time WITHIN proximity still match (not over-corrected)', () => {
    const text = "You've hit your session limit · resets 3am (Europe/Zurich)";
    const result = parseTokenLimitMessage(text, { nowMs: JAN15_00UTC });
    expect(result.matched).toBe(true);
    expect(result.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });
});

// ── Pure Zeitzonen-Helper ────────────────────────────────────────────────────

describe('taktgeber-nachtwaechter AC13/AC14 — zonedWallTimeToUtc / isValidIanaTimeZone', () => {
  it('converts a Zurich wall-clock time (winter, CET=UTC+1) to the correct UTC instant', () => {
    const utc = zonedWallTimeToUtc(2026, 1, 15, 3, 0, 'Europe/Zurich');
    expect(utc).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });

  it('converts a New York wall-clock time (winter, EST=UTC-5) to the correct UTC instant', () => {
    const utc = zonedWallTimeToUtc(2026, 1, 15, 3, 0, 'America/New_York');
    expect(utc).toBe(Date.UTC(2026, 0, 15, 8, 0, 0));
  });

  it('validates known IANA zones and rejects garbage', () => {
    expect(isValidIanaTimeZone('Europe/Zurich')).toBe(true);
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone(null)).toBe(false);
  });
});

// ── TokenLimitWatcher — feed() / attach() ────────────────────────────────────

describe('taktgeber-nachtwaechter AC13 — TokenLimitWatcher.feed()/attach()', () => {
  it('starts with no limit detected', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    expect(watcher.getState()).toEqual({ limited: false, resetAt: null, rawMatch: null, detectedAt: null });
  });

  it('detects a limit message fed as a single chunk', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const state = watcher.getState();
    expect(state.limited).toBe(true);
    expect(state.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
    expect(state.detectedAt).toBe(JAN15_00UTC);
  });

  it('detects a limit message split across two PTY output chunks', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session ");
    expect(watcher.getState().limited).toBe(false); // not yet — message incomplete
    watcher.feed('limit · resets 3am (Europe/Zurich)');
    const state = watcher.getState();
    expect(state.limited).toBe(true);
    expect(state.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });

  it('ignores normal output chunks — never sets limited (no false alarm)', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed('Running tests...\n');
    watcher.feed('All 42 tests passed.\n');
    watcher.feed('The rate limit for the API is 100 req/s.\n');
    expect(watcher.getState().limited).toBe(false);
  });

  it('ignores non-string/empty chunks defensively', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed(null);
    watcher.feed(undefined);
    watcher.feed(42);
    watcher.feed('');
    expect(watcher.getState().limited).toBe(false);
  });

  it('attach() wires feed() to the emitter\'s "output" event; detach stops further updates', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    const emitter = makeFakeEmitter();
    const detach = watcher.attach(emitter);

    expect(emitter.listenerCount()).toBe(1);
    emitter.emit("You've hit your session limit · resets 3am (Europe/Zurich)");
    expect(watcher.getState().limited).toBe(true);

    watcher.clear();
    detach();
    expect(emitter.listenerCount()).toBe(0);
    emitter.emit("You've hit your session limit · resets 4am (Europe/Zurich)");
    // detached → no longer fed
    expect(watcher.getState().limited).toBe(false);
  });

  it('detachAll() removes all listeners registered via attach()', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    const emitterA = makeFakeEmitter();
    const emitterB = makeFakeEmitter();
    watcher.attach(emitterA);
    watcher.attach(emitterB);
    watcher.detachAll();
    expect(emitterA.listenerCount()).toBe(0);
    expect(emitterB.listenerCount()).toBe(0);
  });

  it('clear() resets state and the rolling buffer', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    expect(watcher.getState().limited).toBe(true);
    watcher.clear();
    expect(watcher.getState()).toEqual({ limited: false, resetAt: null, rawMatch: null, detectedAt: null });
  });

  // ── Proximity-Regression (Iteration 2, coder.md Lesson 2026-07-01) ────────

  it('feeding two unrelated far-apart findings (keyword here, "resets …" elsewhere) across chunks never sets limited', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("...near your session limit for API calls...");
    watcher.feed('x'.repeat(2000)); // unrelated filler, well beyond the proximity window
    watcher.feed('...the build cache resets 3am daily...');
    expect(watcher.getState().limited).toBe(false);
  });

  it('feeding its OWN source file (src/TokenLimitWatcher.js) in small PTY-like chunks never triggers a false alarm', () => {
    // Live repro (reviewer, coder.md Lesson 2026-07-01): the module doc
    // itself mentions "session limit"/"usage limit" AND several
    // "resets …am" examples — but at chars-thousands apart, never within
    // the proximity window of a real message. cat/diff of this very file
    // in a PTY must not falsely trip the watcher.
    const ownSource = readFileSync(OWN_SOURCE_PATH, 'utf8');
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    const CHUNK_SIZE = 80;
    for (let i = 0; i < ownSource.length; i += CHUNK_SIZE) {
      watcher.feed(ownSource.slice(i, i + CHUNK_SIZE));
    }
    expect(watcher.getState().limited).toBe(false);
  });

  it('positive control: a real limit message split across two chunks is still detected (proximity fix does not over-correct)', () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session ");
    watcher.feed('limit · resets 3am (Europe/Zurich)');
    const state = watcher.getState();
    expect(state.limited).toBe(true);
    expect(state.resetAt).toBe(Date.UTC(2026, 0, 15, 2, 0, 0));
  });
});

// ── AC14: waitForReset ───────────────────────────────────────────────────────

describe('taktgeber-nachtwaechter AC14 — TokenLimitWatcher.waitForReset()', () => {
  it('returns immediately with reason "not-limited" when no limit is currently detected', async () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const result = await watcher.waitForReset({ sleepFn });
    expect(result).toEqual({ paused: false, reason: 'not-limited', resetAt: null });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('waits until resetAt + 1 minute buffer (default), then clears state', async () => {
    let now = JAN15_00UTC;
    const watcher = new TokenLimitWatcher({ now: () => now });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const resetAt = watcher.getState().resetAt; // 2026-01-15 02:00 UTC

    const sleepFn = jest.fn().mockImplementation(async (ms) => {
      now += ms; // simulate time passing
    });

    const result = await watcher.waitForReset({ sleepFn });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    const waitedMs = sleepFn.mock.calls[0][0];
    expect(waitedMs).toBe(resetAt + DEFAULT_RESET_BUFFER_MS - JAN15_00UTC);
    expect(result).toEqual({ paused: true, resumedAt: resetAt + DEFAULT_RESET_BUFFER_MS });
    expect(watcher.getState().limited).toBe(false); // fortsetzen: Zustand zurückgesetzt
  });

  it('honours a custom bufferMs', async () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const resetAt = watcher.getState().resetAt;

    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const result = await watcher.waitForReset({ sleepFn, bufferMs: 5 * 60_000 });

    expect(sleepFn).toHaveBeenCalledWith(resetAt + 5 * 60_000 - JAN15_00UTC);
    expect(result.resumedAt).toBe(resetAt + 5 * 60_000);
  });

  it('does NOT wait when the reset lies after windowEndMs — returns reason "exceeds-window"', async () => {
    const watcher = new TokenLimitWatcher({ now: () => JAN15_00UTC });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const resetAt = watcher.getState().resetAt;

    const sleepFn = jest.fn();
    // windowEndMs one hour before the reset → out of window
    const result = await watcher.waitForReset({ sleepFn, windowEndMs: resetAt - 60 * 60_000 });

    expect(sleepFn).not.toHaveBeenCalled();
    expect(result).toEqual({ paused: false, reason: 'exceeds-window', resetAt });
    // State is intentionally NOT cleared — the scheduler (S-195) still needs
    // resetAt to decide "stop now, resume next night" (AC14).
    expect(watcher.getState().limited).toBe(true);
  });

  it('waits normally when windowEndMs is after the reset', async () => {
    let now = JAN15_00UTC;
    const watcher = new TokenLimitWatcher({ now: () => now });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const resetAt = watcher.getState().resetAt;

    const sleepFn = jest.fn().mockImplementation(async (ms) => {
      now += ms;
    });
    const result = await watcher.waitForReset({ sleepFn, windowEndMs: resetAt + 60 * 60_000 });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(result.paused).toBe(true);
  });

  it('clamps to a non-negative wait when the reset (+buffer) already lies in the past (processing latency)', async () => {
    // now is already AFTER resetAt + bufferMs by the time waitForReset() runs.
    let now = JAN15_00UTC;
    const watcher = new TokenLimitWatcher({ now: () => now });
    watcher.feed("You've hit your session limit · resets 3am (Europe/Zurich)");
    const resetAt = watcher.getState().resetAt;

    now = resetAt + DEFAULT_RESET_BUFFER_MS + 5 * 60_000; // 5 min past the resume point

    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const result = await watcher.waitForReset({ sleepFn });

    expect(sleepFn).toHaveBeenCalledWith(0); // never negative
    expect(result.paused).toBe(true);
  });
});
