/**
 * BudgetGuard.js — Konkrete Nacht-Budget-Schutz-Logik
 * (docs/specs/night-budget-guard.md AC9–AC11, S-274 „Wiring"-Story).
 *
 * Kapselt die drei Bausteine, die `ProjectDrain` (S-273, `deps.budgetGuard`)
 * über das sprach-neutrale `BudgetGuard`-Interface (Verträge-Abschnitt der
 * Spec) konsumiert, ohne selbst irgendeine Board-/Board-Writer-Logik zu
 * berühren (reine Politik-Schicht zwischen Messung und Drain):
 *   - [[token-usage-meter]] `getUsage({sinceMs})` — proaktive Verbrauchsmessung.
 *   - `TickerSettingsStore.read()` — `nightBudgetTokens`/`budgetThresholdPercent`
 *     (AC1) UND `window` (für die Fenster-Begrenzung der Messung, s.u.).
 *   - `BUDGET_RESUME_BUFFER_MS` (Default ~5 min, `ProjectDrain.js`, per Env in
 *     `server.js` konfigurierbar, AC10) + der zuletzt reaktiv erkannte
 *     `resetAt` (A1/AC11, gemerkt über `noteReset`).
 *
 * Proaktive Messung „im laufenden Fenster" (Spec Verhalten Punkt 4 —
 * PRÄZISIERUNG, s. docs/specs/night-budget-guard.md Verträge-Abschnitt
 * `BudgetGuard`): gemessen wird der Output-Token-Verbrauch SEIT BEGINN des
 * für `nowMs` aktuell gültigen Nachtfensters (`window.start`), nicht die
 * Lebenszeit-Gesamtsumme über ALLE je geschriebenen Transcripts — sonst wäre
 * das Nacht-Budget nach der ERSTEN Überschreitung dauerhaft (jede folgende
 * Nacht) unbrauchbar, statt sich mit jeder neuen Nacht zurückzusetzen
 * (`nightBudgetTokens` ist explizit ein Nacht-Kontingent, kein
 * Lebenszeit-Limit). Die Fenster-Start-Berechnung ist ein reines Spiegelbild
 * zu `computeWindowEndMs` (`NightWatchScheduler.js`, taktgeber-nachtwaechter
 * AC10) — WIEDERVERWENDET dieselbe TZ-Wandzeit-Logik, keine eigene TZ-Logik
 * (Spec-Vorgabe für `windowEndMs` sinngemäß auf die Fenster-Start-Bestimmung
 * übertragen, Konsistenz-Gebot „nicht duplizieren").
 *
 * Reset-Wissen (A1/AC11): `noteReset(resetAt)` merkt den zuletzt reaktiv
 * erkannten Reset-Zeitpunkt (aus einem `budget-limited`-`FlowRunner`-Ergebnis,
 * s. `ProjectDrain.js`). `checkProactive()` liefert diesen gemerkten Wert als
 * `resumeAt` zurück — `null`, wenn (noch) keine reaktive Meldung dieser Nacht
 * bekannt ist; der Drain führt dann laut AC6 ein sanftes Ende aus statt zu
 * raten. Der **reaktive** Schutz (AC4) selbst läuft unabhängig von dieser
 * Klasse in `ProjectDrain` — er braucht keinen `budgetGuard` (immer aktiv).
 *
 * Robustheit (NFR): ein Fehler beim Settings-Lesen oder bei der Verbrauchs-
 * messung darf NIE den Drain crashen — im Zweifel wird NICHT pausiert
 * (`{pause:false}`), der reaktive Schutz bleibt davon unberührt (AC11).
 *
 * Security (Floor): keine Secrets/Pfade in Rückgabewerten — ausschließlich
 * Zahlen/Booleans/Strings aus einer festen Enum (`reason`).
 *
 * @module BudgetGuard
 */

import { computeWindowEndMs, parseHHMM } from './NightWatchScheduler.js';
import { BUDGET_RESUME_BUFFER_MS } from './ProjectDrain.js';

export { BUDGET_RESUME_BUFFER_MS };

/**
 * Bestimmt die Fenster-Dauer (ms) aus `window.start`/`window.end`
 * (über-Mitternacht-fest: eine Differenz ≤ 0 wird als volle 24h behandelt,
 * analog zur über-Mitternacht-Behandlung in `computeWindowEndMs`).
 *
 * @param {{start:string,end:string}} window
 * @returns {number|null} `null` bei nicht-parsebarem `start`/`end` (defensiv).
 */
function windowDurationMs(window) {
  const s = parseHHMM(window?.start);
  const e = parseHHMM(window?.end);
  if (!s || !e) return null;
  const startMin = s.hour * 60 + s.minute;
  const endMin = e.hour * 60 + e.minute;
  let diffMin = endMin - startMin;
  if (diffMin <= 0) diffMin += 24 * 60;
  return diffMin * 60_000;
}

/**
 * Bestimmt den ms-Epoch-Zeitpunkt des Beginns des für `nowMs` GÜLTIGEN
 * Nachtfensters — Spiegelbild zu `computeWindowEndMs` (Wiederverwendung
 * derselben TZ-Logik über `computeWindowEndMs` + `windowDurationMs`, statt
 * eine zweite, eigene TZ-Wandzeit-Berechnung zu duplizieren).
 *
 * @param {number} nowMs
 * @param {{start:string,end:string,timezone:string}} [window]
 * @returns {number|null} `null` wenn `window` nicht parsebar ist (defensiv —
 *   der Aufrufer behandelt `null` als "keine Fenster-Begrenzung möglich"
 *   → `sinceMs:null`, [[token-usage-meter]] zählt dann alle Events).
 */
function computeWindowStartMs(nowMs, window) {
  const endMs = computeWindowEndMs(nowMs, window);
  const durationMs = windowDurationMs(window);
  if (endMs === null || durationMs === null) return null;
  return endMs - durationMs;
}

/**
 * @typedef {{
 *   window?: {start:string,end:string,timezone:string},
 *   nightBudgetTokens?: number,
 *   budgetThresholdPercent?: number,
 * }} PartialTickerSettings
 */

/**
 * `BudgetGuard` — konkrete Implementierung des in
 * docs/specs/night-budget-guard.md (Verträge-Abschnitt) beschriebenen
 * `budgetGuard`-Interfaces, injizierbar in `ProjectDrain` (`deps.budgetGuard`).
 */
export class BudgetGuard {
  #tokenUsageMeter;
  #readSettings;
  #budgetResumeBufferMs;
  #sleepFn;
  #now;
  /** @type {number|null} zuletzt reaktiv erkannter Reset-Zeitpunkt (A1/AC11). */
  #resetAt = null;

  /**
   * @param {object} deps
   * @param {{ getUsage: (p: {sinceMs?: number|null}) => Promise<{outputTokens:number}> }} deps.tokenUsageMeter
   *   [[token-usage-meter]] `TokenUsageMeter`-Instanz — proaktive Verbrauchsmessung.
   * @param {() => Promise<PartialTickerSettings>} deps.readSettings
   *   Settings-Quelle (`TickerSettingsStore.read`) — liefert `nightBudgetTokens`,
   *   `budgetThresholdPercent` UND `window` (Fenster-Begrenzung der Messung).
   * @param {number} [deps.budgetResumeBufferMs]  Fortsetzungs-Puffer nach einem
   *   bekannten Reset (A3), Default `BUDGET_RESUME_BUFFER_MS` (~5 min, per Env
   *   in `server.js` konfigurierbar, AC10 — DIESELBE env-abgeleitete Zahl, die
   *   `server.js` auch dem reaktiven Puffer der Nacht-Drain-`ProjectDrain`-
   *   Instanz (`deps.budgetResumeBufferMs`) übergibt, damit beide Pfade nicht
   *   auseinanderdriften).
   * @param {(ms: number) => Promise<void>} [deps.sleepFn]  injizierbar für Tests.
   * @param {() => number} [deps.now]  injizierbare Uhr (ms epoch), Default `Date.now`.
   */
  constructor({ tokenUsageMeter, readSettings, budgetResumeBufferMs = BUDGET_RESUME_BUFFER_MS, sleepFn, now } = {}) {
    this.#tokenUsageMeter = tokenUsageMeter;
    this.#readSettings = readSettings;
    this.#budgetResumeBufferMs = budgetResumeBufferMs >= 0 ? budgetResumeBufferMs : BUDGET_RESUME_BUFFER_MS;
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = now ?? (() => Date.now());
  }

  /**
   * Merkt den zuletzt reaktiv erkannten Reset-Zeitpunkt (A1/AC11) — ein
   * erneuter Aufruf überschreibt einen bereits gemerkten Wert (die jüngste
   * Meldung gewinnt; dieselbe Nacht kann mehrere reaktive Meldungen sehen).
   *
   * @param {number} resetAt  ms epoch
   */
  noteReset(resetAt) {
    if (typeof resetAt === 'number' && Number.isFinite(resetAt)) {
      this.#resetAt = resetAt;
    }
  }

  /**
   * Proaktive Schwellen-Prüfung VOR jeder Flow-Runde (AC5/AC9 — vom
   * konsumierenden `ProjectDrain` vor jeder Story-Grenze aufgerufen).
   * No-op (`{pause:false}`) wenn `nightBudgetTokens` nicht konfiguriert/`0`
   * ist (A4), die Settings-/Messung fehlschlägt (Robustheit-NFR), oder der
   * gemessene Verbrauch unter der Schwelle liegt.
   *
   * @param {{ nowMs: number }} params
   * @returns {Promise<{ pause: boolean, reason?: 'proactive-threshold', resumeAt?: number|null }>}
   */
  async checkProactive({ nowMs }) {
    let settings;
    try {
      settings = await this.#readSettings();
    } catch {
      return { pause: false }; // Robustheit (NFR): Settings nicht lesbar → nicht pausieren
    }

    const nightBudgetTokens = Number(settings?.nightBudgetTokens);
    if (!Number.isFinite(nightBudgetTokens) || nightBudgetTokens <= 0) {
      return { pause: false }; // A4: proaktiver Schutz aus (kein/0-Budget)
    }
    const thresholdPercentRaw = Number(settings?.budgetThresholdPercent);
    const thresholdPercent =
      Number.isFinite(thresholdPercentRaw) && thresholdPercentRaw > 0 ? thresholdPercentRaw : 85;

    const sinceMs = computeWindowStartMs(nowMs, settings?.window);

    let usage;
    try {
      usage = await this.#tokenUsageMeter.getUsage({ sinceMs });
    } catch {
      return { pause: false }; // Robustheit (NFR): Messfehler → nicht grundlos pausieren
    }
    const consumed = Number(usage?.outputTokens);
    if (!Number.isFinite(consumed)) return { pause: false }; // "Messung nicht möglich" (Edge-Case Spec)

    const threshold = (nightBudgetTokens * thresholdPercent) / 100;
    if (consumed < threshold) return { pause: false };

    return { pause: true, reason: 'proactive-threshold', resumeAt: this.#resetAt };
  }

  /**
   * Wartet auf die Fortsetzung nach einer PROAKTIVEN Budget-Pause (AC6/A1/A2)
   * — wird von `ProjectDrain` NUR für den proaktiven Pfad aufgerufen (der
   * reaktive Pfad wartet mit seinem eigenen `budgetResumeBufferMs` direkt in
   * `ProjectDrain`, s. dortige Modul-Doku).
   *
   * @param {{ resumeAt: number|null, windowEndMs: number|null, nowMs: number }} params
   * @returns {Promise<
   *   { resumed: true, from: number, to: number } |
   *   { resumed: false, reason: 'budget-window-end'|'budget-stop', from: number }
   * >}
   */
  async awaitResume({ resumeAt, windowEndMs, nowMs }) {
    const from = typeof nowMs === 'number' ? nowMs : this.#now();
    // AC6: reason richtet sich NUR danach, ob überhaupt ein Fenster übergeben
    // wurde (Nacht-Drain → 'budget-window-end') oder nicht (manuell/kein
    // Fenster → 'budget-stop') — unabhängig davon, WELCHE der beiden
    // Bedingungen (kein Reset bekannt / Ziel hinter windowEndMs) zutraf.
    const fallbackReason = windowEndMs === null || windowEndMs === undefined ? 'budget-stop' : 'budget-window-end';

    if (typeof resumeAt !== 'number' || !Number.isFinite(resumeAt)) {
      // A1: kein Reset-Zeitpunkt bekannt → nicht raten, sanftes Ende.
      return { resumed: false, reason: fallbackReason, from };
    }

    const target = resumeAt + this.#budgetResumeBufferMs;
    if (windowEndMs !== null && windowEndMs !== undefined && target > windowEndMs) {
      // A2: Fenster-Ende hat Vorrang.
      return { resumed: false, reason: 'budget-window-end', from };
    }

    // Edge-Case "Reset-Zeit in der Vergangenheit": Wartezeit nie negativ.
    const waitMs = Math.max(target - from, 0);
    try {
      await this.#sleepFn(waitMs);
    } catch {
      // Robustheit (NFR): ein Sleep-Fehler darf den Drain nicht crashen.
    }
    return { resumed: true, from, to: this.#now() };
  }
}
