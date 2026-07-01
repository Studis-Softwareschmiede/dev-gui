/**
 * ClaudeAuthHealthService — Boot- + periodische Auth-Probe für die Container-
 * `claude`-Anmeldung (docs/specs/claude-auth-health.md AC1–AC6).
 *
 * Ergänzt Stufe 2 zur Stufe-1-401-Erkennung im Headless-Reconcile-Runner
 * ([[headless-reconcile-runner]] AC6): statt erst beim Scheitern eines echten
 * Laufs zu bemerken, dass die Container-Anmeldung abgelaufen ist, prüft dieser
 * Dienst BEIM BOOT und danach PERIODISCH (konfigurierbares Intervall), ob
 * `claude` sich headless anmelden kann — bevor jemand einen Job startet.
 *
 * Getrennt vom interaktiven PTY-Pfad (analog HeadlessReconcileRunner AC7):
 * dieser Dienst spawnt einen eigenen, sehr kurzlebigen `claude`-Kindprozess
 * (kein Import von PtyManager/PtySessionRegistry/CommandService).
 *
 * Zustand (AC1, AC3): `ok` | `expired` | `unknown` + `lastCheckedAt` (ISO-String
 * oder `null` vor der ersten Probe).
 *   - `ok`      — Probe erfolgreich (sauberer Exit 0, kein 401-Signal).
 *   - `expired` — 401 / "Invalid authentication credentials" erkannt (Exit-Code
 *     ODER erfasster stdout/stderr — Vorrang vor Exit 0, wiederverwendet
 *     `isAuthError` aus `HeadlessReconcileRunner.js`, keine Duplizierung).
 *   - `unknown` — nicht-Auth-Fehler (`claude` nicht im PATH, Timeout, u.ä.) —
 *     KEIN Fehlalarm "expired" (AC3).
 *
 * Terminierung (AC2): `setTimeout`-Kette (kein `setInterval`, kein Drift,
 * Muster [[taktgeber-nachtwaechter]] / `NightWatchScheduler.js`) mit
 * injizierbaren `setTimeoutFn`/`clearTimeoutFn`. Kein Overlap (Edge-Case
 * „Läuft eine Probe noch, wird keine zweite parallel gestartet"): die Kette
 * plant den nächsten Tick erst NACH Abschluss der laufenden Probe; ein
 * zusätzliches `#probing`-Flag schützt zusätzlich gegen einen direkten
 * Doppel-Aufruf von `probeOnce()`.
 *
 * Boot-Verhalten (AC1, Edge-Case „Probe-Fehler beim Boot"): `start()` löst die
 * erste Probe über die `setTimeout`-Kette mit `delayMs=0` aus — blockiert den
 * Server-Boot nie (fire-and-forget, best-effort).
 *
 * Security (Floor, AC6):
 *   - Kein Token-Wert in Log/Response — `getState()` liefert ausschließlich
 *     `{ claudeAuth, lastCheckedAt }`.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` in der Child-Env (wiederverwendet
 *     `buildChildEnv` aus `HeadlessReconcileRunner.js` — keine Duplizierung
 *     der Env-Allowlist), `ANTHROPIC_API_KEY` bleibt blockiert (Trust-Boundary).
 *   - argv als Array, kein Shell-Interpolation (security/R03).
 *
 * Injectable (Test-Entkopplung, SR3): `probeFn` (Default: `defaultProbe`,
 * `node:child_process` `spawn`), `setTimeoutFn`/`clearTimeoutFn` — kein Test
 * benötigt einen echten `claude`-Lauf (AC6).
 *
 * @module ClaudeAuthHealthService
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { buildChildEnv, isAuthError } from './HeadlessReconcileRunner.js';

/** Default Probe-Intervall (ms) — konfigurierbar über CLAUDE_AUTH_PROBE_INTERVAL_MS. */
export const DEFAULT_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** Timeout für den einzelnen Probe-Kindprozess (leichtgewichtiger Ping, kurz). */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000; // 10s

/**
 * Führt den default headless-`claude`-Auth-Ping aus (AC1, AC3).
 * Minimaler `claude -p`-Aufruf, dessen einziges Interesse „anmelden ja/nein" ist.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] - injectable spawn (default: node:child_process spawn).
 * @param {number} [opts.timeoutMs] - Runaway-Timeout für diesen einzelnen Ping.
 * @returns {Promise<'ok'|'expired'|'unknown'>}
 */
export function defaultProbe({ spawnFn = nodeSpawn, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutHandle;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    try {
      child = spawnFn('claude', ['-p', 'ping', '--dangerously-skip-permissions'], {
        env: buildChildEnv(),
      });
    } catch {
      // Synchroner Spawn-Fehler → neutral, kein Fehlalarm (AC3).
      finish('unknown');
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      // Runaway-Schutz: terminieren; Timeout ist kein Auth-Fehler (AC3).
      child.kill('SIGTERM');
      finish('unknown');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      const combined = `${stdout}\n${stderr}`;
      // 401 hat Vorrang vor "sauberem" Exit (Edge-Case „401 + Exit 0", AC3).
      if (isAuthError(code, combined)) {
        finish('expired');
        return;
      }
      if (code === 0) {
        finish('ok');
        return;
      }
      // Nicht-null Exit ohne 401-Signatur → neutral (kein Fehlalarm "expired", AC3).
      finish('unknown');
    });

    child.on('error', () => {
      // z.B. ENOENT (claude nicht im PATH) → neutral, kein Fehlalarm (AC3).
      finish('unknown');
    });
  });
}

/**
 * ClaudeAuthHealthService — hält den Auth-Health-Zustand + treibt die
 * Boot-/periodische Probe (AC1, AC2).
 */
export class ClaudeAuthHealthService {
  #probeFn;
  #intervalMs;
  #setTimeoutFn;
  #clearTimeoutFn;
  #now;
  #state;
  #timer = null;
  #probing = false;

  /**
   * @param {object} [deps]
   * @param {() => Promise<'ok'|'expired'|'unknown'>} [deps.probeFn]
   *   Injizierbare Probe (default: `defaultProbe`).
   * @param {number} [deps.intervalMs]
   *   Probe-Intervall (default: `CLAUDE_AUTH_PROBE_INTERVAL_MS`-Env oder 24h).
   * @param {(fn: Function, ms: number) => *} [deps.setTimeoutFn]
   *   Injizierbares `setTimeout`-Äquivalent (Tests).
   * @param {(handle: *) => void} [deps.clearTimeoutFn]
   *   Injizierbares `clearTimeout`-Äquivalent (Tests).
   * @param {() => number} [deps.now] - injizierbare Uhr (ms epoch), Default `Date.now`.
   */
  constructor({ probeFn, intervalMs, setTimeoutFn, clearTimeoutFn, now } = {}) {
    this.#probeFn = probeFn ?? (() => defaultProbe());
    this.#intervalMs = intervalMs ?? (Number(process.env.CLAUDE_AUTH_PROBE_INTERVAL_MS) || DEFAULT_PROBE_INTERVAL_MS);
    this.#setTimeoutFn = setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeoutFn = clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.#now = now ?? (() => Date.now());
    this.#state = { claudeAuth: 'unknown', lastCheckedAt: null };
  }

  /**
   * Rein lesender Zustands-Snapshot (AC4 — Grundlage für den Status-Endpunkt).
   * Enthält NIEMALS einen Token-Wert (AC6).
   *
   * @returns {{ claudeAuth: 'ok'|'expired'|'unknown', lastCheckedAt: string|null }}
   */
  getState() {
    return { ...this.#state };
  }

  /**
   * Startet die Boot-Probe (genau einmal, AC1) + die periodische `setTimeout`-
   * Kette (AC2). Idempotent — ein laufender Timer wird zuerst gestoppt.
   * Blockiert den Aufrufer NIE (fire-and-forget — Server-Boot wird nicht
   * blockiert, Edge-Case „Probe-Fehler beim Boot").
   */
  start() {
    this.stop();
    this.#scheduleNext(0);
  }

  /** Stoppt die Probe-Kette (graceful shutdown). */
  stop() {
    if (this.#timer !== null) {
      this.#clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
  }

  /** @param {number} delayMs */
  #scheduleNext(delayMs) {
    this.#timer = this.#setTimeoutFn(async () => {
      await this.probeOnce();
      this.#scheduleNext(this.#intervalMs);
    }, delayMs);
    // Blockiert nie den Prozess-Shutdown (Muster NightWatchScheduler/ReconciliationJob).
    if (this.#timer && typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  /**
   * Führt genau eine Probe aus und aktualisiert den Zustand (AC1, AC2, AC3).
   * Skip-if-running (Overlap-Edge-Case): ein bereits laufender Aufruf wird
   * nicht doppelt gestartet — liefert dann den aktuellen (unveränderten)
   * Zustand zurück, ohne `probeFn` erneut aufzurufen.
   *
   * @returns {Promise<{ claudeAuth: 'ok'|'expired'|'unknown', lastCheckedAt: string|null }>}
   */
  async probeOnce() {
    if (this.#probing) return this.getState();
    this.#probing = true;
    try {
      let result;
      try {
        result = await this.#probeFn();
      } catch {
        // Ein Probe-Fehler darf nie einen Fehlalarm "expired" erzeugen (AC3).
        result = 'unknown';
      }
      const claudeAuth = result === 'ok' || result === 'expired' ? result : 'unknown';
      this.#state = { claudeAuth, lastCheckedAt: new Date(this.#now()).toISOString() };
    } finally {
      this.#probing = false;
    }
    return this.getState();
  }
}
