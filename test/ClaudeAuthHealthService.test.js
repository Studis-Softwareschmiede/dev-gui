/**
 * @file ClaudeAuthHealthService.test.js — Unit tests for the boot + periodic
 * Claude-Auth-Health probe.
 *
 * Covers (claude-auth-health): AC1, AC2, AC3, AC6
 *
 *   AC1 — Boot-Probe läuft genau einmal über einen injizierbaren Runner;
 *         Ergebnis wird als claudeAuth ('ok'|'expired'|'unknown') +
 *         lastCheckedAt festgehalten.
 *   AC2 — Periodische Probe über eine `setTimeout`-Kette mit injizierbaren
 *         Timern; Vorspulen löst genau eine weitere Probe pro Intervall aus
 *         (kein Drift, kein Doppel-Feuer). Overlap: eine laufende Probe wird
 *         nicht doppelt gestartet.
 *   AC3 — 401/"Invalid authentication credentials" → 'expired'; sauberer
 *         Erfolg → 'ok'; nicht-Auth-Fehler (ENOENT/Timeout) → 'unknown'
 *         (kein Fehlalarm "expired").
 *   AC6 — Kein Token-Wert im festgehaltenen Zustand; Probe-Logik ist über
 *         den injizierbaren Runner mockbar (kein echter `claude`-Aufruf hier).
 *
 * `defaultProbe` (AC1, AC3 — echter Kindprozess-Pfad) wird separat mit einem
 * Fake-Child (EventEmitter, Muster HeadlessReconcileRunner.test.js) getestet.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { ClaudeAuthHealthService, defaultProbe, DEFAULT_PROBE_INTERVAL_MS } from '../src/ClaudeAuthHealthService.js';

/** Fake child process — EventEmitter with stdout/stderr sub-emitters + a kill() spy. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Fake injectable timer chain — records scheduled callbacks, no real waiting. */
function makeFakeTimers() {
  let nextId = 1;
  const scheduled = new Map(); // id -> { fn, ms }
  const setTimeoutFn = jest.fn((fn, ms) => {
    const id = nextId++;
    scheduled.set(id, { fn, ms });
    return id;
  });
  const clearTimeoutFn = jest.fn((id) => scheduled.delete(id));
  /** Runs the currently-scheduled callback (if any) and awaits it. */
  async function fire() {
    const entries = [...scheduled.entries()];
    if (entries.length === 0) return;
    const [id, { fn }] = entries[0];
    scheduled.delete(id);
    await fn();
  }
  return { setTimeoutFn, clearTimeoutFn, fire, scheduled };
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── AC1 — Boot-Probe genau einmal ────────────────────────────────────────────

describe('AC1 — Boot-Probe läuft genau einmal, Zustand + lastCheckedAt festgehalten', () => {
  it('ok-Stub-Antwort → Zustand ok, probeFn genau einmal beim Boot aufgerufen', async () => {
    const probeFn = jest.fn().mockResolvedValue('ok');
    const timers = makeFakeTimers();
    const service = new ClaudeAuthHealthService({
      probeFn,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => Date.parse('2026-07-01T10:00:00Z'),
    });

    expect(service.getState()).toEqual({ claudeAuth: 'unknown', lastCheckedAt: null });

    service.start();
    await timers.fire(); // fährt den ersten (delayMs=0) Tick aus

    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      claudeAuth: 'ok',
      lastCheckedAt: '2026-07-01T10:00:00.000Z',
    });
  });

  it('start() ist idempotent (kein zweiter Boot-Tick bei erneutem start())', async () => {
    const probeFn = jest.fn().mockResolvedValue('ok');
    const timers = makeFakeTimers();
    const service = new ClaudeAuthHealthService({
      probeFn,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    service.start();
    service.start(); // erneuter Aufruf vor dem ersten Feuern — muss den ersten Timer ersetzen, nicht duplizieren
    await timers.fire();

    expect(probeFn).toHaveBeenCalledTimes(1);
  });
});

// ── AC2 — periodische Probe, setTimeout-Kette, kein Drift/Doppel-Feuer ──────

describe('AC2 — periodische Probe über setTimeout-Kette (injizierbare Timer)', () => {
  it('ein Intervall-Tick löst genau eine weitere Probe aus (Boot + 1 Intervall = 2 Aufrufe)', async () => {
    const probeFn = jest.fn().mockResolvedValue('ok');
    const timers = makeFakeTimers();
    const service = new ClaudeAuthHealthService({
      probeFn,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    service.start();
    await timers.fire(); // Boot-Tick
    expect(probeFn).toHaveBeenCalledTimes(1);

    await timers.fire(); // erster Intervall-Tick
    expect(probeFn).toHaveBeenCalledTimes(2);

    await timers.fire(); // zweiter Intervall-Tick
    expect(probeFn).toHaveBeenCalledTimes(3);
  });

  it('plant den nächsten Tick mit dem konfigurierten intervalMs (kein Drift)', async () => {
    const probeFn = jest.fn().mockResolvedValue('ok');
    const timers = makeFakeTimers();
    const service = new ClaudeAuthHealthService({
      probeFn,
      intervalMs: 12_345,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    service.start();
    expect(timers.setTimeoutFn).toHaveBeenLastCalledWith(expect.any(Function), 0);
    await timers.fire();
    expect(timers.setTimeoutFn).toHaveBeenLastCalledWith(expect.any(Function), 12_345);
  });

  it('stop() bricht die Kette ab — kein weiterer Tick wird geplant', async () => {
    const probeFn = jest.fn().mockResolvedValue('ok');
    const timers = makeFakeTimers();
    const service = new ClaudeAuthHealthService({
      probeFn,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    service.start();
    service.stop();
    expect(timers.clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(timers.scheduled.size).toBe(0);
  });

  it('Overlap: eine bereits laufende Probe wird nicht doppelt gestartet (probeOnce direkt parallel aufgerufen)', async () => {
    let resolvePending;
    const pending = new Promise((resolve) => { resolvePending = resolve; });
    const probeFn = jest.fn().mockReturnValue(pending);
    const service = new ClaudeAuthHealthService({ probeFn });

    const call1 = service.probeOnce();
    const call2 = service.probeOnce(); // während call1 noch pending ist

    resolvePending('ok');
    await Promise.all([call1, call2]);

    expect(probeFn).toHaveBeenCalledTimes(1); // NICHT 2 — kein Doppel-Feuer
  });
});

// ── AC3 — 401/Invalid credentials → expired; Erfolg → ok; sonstiger Fehler → unknown ──

describe('AC3 — Zustands-Ableitung aus dem Probe-Ergebnis', () => {
  it('probeFn liefert "expired" → Zustand expired', async () => {
    const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockResolvedValue('expired') });
    const state = await service.probeOnce();
    expect(state.claudeAuth).toBe('expired');
  });

  it('probeFn liefert "ok" → Zustand ok', async () => {
    const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockResolvedValue('ok') });
    const state = await service.probeOnce();
    expect(state.claudeAuth).toBe('ok');
  });

  it('probeFn liefert "unknown" (z.B. ENOENT/Timeout) → Zustand unknown, kein Fehlalarm "expired"', async () => {
    const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockResolvedValue('unknown') });
    const state = await service.probeOnce();
    expect(state.claudeAuth).toBe('unknown');
  });

  it('probeFn wirft (unerwarteter Fehler) → Zustand unknown, kein Crash, kein Fehlalarm "expired"', async () => {
    const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockRejectedValue(new Error('boom')) });
    const state = await service.probeOnce();
    expect(state.claudeAuth).toBe('unknown');
  });

  it('probeFn liefert eine unerwartete Zeichenkette → defensiv auf unknown normalisiert', async () => {
    const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockResolvedValue('something-else') });
    const state = await service.probeOnce();
    expect(state.claudeAuth).toBe('unknown');
  });
});

// ── AC6 — kein Token-Wert im Zustand; injizierbarer Runner, kein echter Aufruf ──

describe('AC6 — kein Token-Leak im Zustand; injizierbare Probe (kein echter claude-Aufruf)', () => {
  it('getState() enthält niemals einen Token-Wert, auch wenn CLAUDE_CODE_OAUTH_TOKEN gesetzt ist', async () => {
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-super-secret-value';
    try {
      const service = new ClaudeAuthHealthService({ probeFn: jest.fn().mockResolvedValue('ok') });
      await service.probeOnce();
      const stateStr = JSON.stringify(service.getState());
      expect(stateStr).not.toContain('sk-ant-oat01-super-secret-value');
      expect(stateStr).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  it('Default-Intervall ist DEFAULT_PROBE_INTERVAL_MS (24h), wenn kein intervalMs/Env gesetzt ist', async () => {
    const savedEnv = process.env.CLAUDE_AUTH_PROBE_INTERVAL_MS;
    delete process.env.CLAUDE_AUTH_PROBE_INTERVAL_MS;
    try {
      // Kein direkter Getter für intervalMs — indirekt über den geplanten zweiten Tick geprüft.
      const timers = makeFakeTimers();
      const service = new ClaudeAuthHealthService({
        probeFn: jest.fn().mockResolvedValue('ok'),
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });
      service.start();
      await timers.fire();
      expect(timers.setTimeoutFn).toHaveBeenLastCalledWith(expect.any(Function), DEFAULT_PROBE_INTERVAL_MS);
    } finally {
      if (savedEnv === undefined) delete process.env.CLAUDE_AUTH_PROBE_INTERVAL_MS;
      else process.env.CLAUDE_AUTH_PROBE_INTERVAL_MS = savedEnv;
    }
  });
});

// ── defaultProbe — echter Kindprozess-Pfad (Fake-Child, kein echter claude-Aufruf) ──

describe('defaultProbe — AC1/AC3: Fake-Child-Pfad (spawnFn injiziert)', () => {
  it('close(0), kein 401-Signal → resolves "ok"', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    child.stdout.emit('data', 'alles ok\n');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('ok');
  });

  it('close(1) + "401" im stderr → resolves "expired" (Vorrang vor Exit != 0)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    child.stderr.emit('data', 'Error: 401 Invalid authentication credentials\n');
    child.emit('close', 1);
    await expect(promise).resolves.toBe('expired');
  });

  it('close(0) + "Invalid authentication credentials" im stdout → resolves "expired" (Vorrang vor Exit 0)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    child.stdout.emit('data', 'Invalid authentication credentials\n');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('expired');
  });

  it('close(1), keine 401-Signatur → resolves "unknown" (kein Fehlalarm expired)', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    child.stderr.emit('data', 'some other failure\n');
    child.emit('close', 1);
    await expect(promise).resolves.toBe('unknown');
  });

  it('error-Event (z.B. ENOENT, claude nicht im PATH) → resolves "unknown"', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    const err = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);
    await expect(promise).resolves.toBe('unknown');
  });

  it('Timeout (hängender Prozess) → kill(SIGTERM) + resolves "unknown"', async () => {
    jest.useFakeTimers();
    try {
      const child = makeFakeChild();
      const spawnFn = jest.fn(() => child);
      const promise = defaultProbe({ spawnFn, timeoutMs: 5000 });
      jest.advanceTimersByTime(5000);
      await Promise.resolve(); // let the timeout callback's finish() run
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await expect(promise).resolves.toBe('unknown');
    } finally {
      jest.useRealTimers();
    }
  });

  it('spawnFn wirft synchron → resolves "unknown" (kein Crash)', async () => {
    const spawnFn = jest.fn(() => { throw new Error('spawn failed'); });
    await expect(defaultProbe({ spawnFn })).resolves.toBe('unknown');
  });

  it('argv ist ein Array (kein Shell-String) — security/R03', async () => {
    const child = makeFakeChild();
    const spawnFn = jest.fn(() => child);
    const promise = defaultProbe({ spawnFn });
    child.emit('close', 0);
    await promise;
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('-p');
    expect(typeof opts.env).toBe('object');
  });
});
