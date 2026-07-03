/**
 * BudgetGuard.test.js — Unit-Tests für die konkrete Nacht-Budget-Schutz-Logik
 * (docs/specs/night-budget-guard.md AC9–AC11, S-274 „Wiring"-Story).
 *
 * Covers (night-budget-guard):
 *   AC9  — `checkProactive({nowMs})` vergleicht den über [[token-usage-meter]]
 *          gemessenen Output-Token-Verbrauch gegen `nightBudgetTokens ×
 *          budgetThresholdPercent/100` (gelesen aus `TickerSettingsStore`).
 *          `nightBudgetTokens=0`/nicht konfiguriert ⇒ `{pause:false}` (A4,
 *          No-op). Fehler beim Settings-Lesen ODER bei der Verbrauchsmessung
 *          degradieren zu `{pause:false}` (Robustheit-NFR, nicht grundlos
 *          pausieren). `budgetThresholdPercent` fehlt/ungültig → Default 85.
 *   AC10 — `BUDGET_RESUME_BUFFER_MS` ist konstruktor-injizierbar (env-
 *          Konfigurierbarkeit selbst lebt in `server.js`, hier nur der
 *          Verbrauch des injizierten Werts in `awaitResume`). Die proaktive
 *          Messung ("im laufenden Fenster", Präzisierung s. Spec Verträge-
 *          Abschnitt) ist auf das aktuell gültige Nachtfenster begrenzt
 *          (`sinceMs` = Fenster-Start, Wiederverwendung derselben TZ-Logik
 *          wie `computeWindowEndMs` — kein Lebenszeit-Gesamtverbrauch).
 *   AC11 — `noteReset(resetAt)` merkt den zuletzt reaktiv erkannten Reset-
 *          Zeitpunkt; eine nachfolgende `checkProactive()`-Pause liefert ihn
 *          als `resumeAt` zurück (kein Raten, wenn noch keiner bekannt ist —
 *          dann `resumeAt:null`, der Drain führt laut AC6 ein sanftes Ende
 *          aus). `awaitResume` wartet bis `resumeAt + BUDGET_RESUME_BUFFER_MS`,
 *          sofern nicht hinter `windowEndMs` (A2); ohne bekannten `resumeAt`
 *          oder hinter dem Fenster → sanftes Ende (`budget-window-end` mit
 *          Fenster, `budget-stop` ohne, A1/AC6). Wartezeit nie negativ
 *          (Edge-Case "Reset-Zeit in der Vergangenheit").
 *
 * Strategy:
 *   - `tokenUsageMeter`/`readSettings`/`sleepFn`/`now` als schlanke
 *     `jest.fn()`-Stubs — kein echtes IO/Warten, deterministische Uhr.
 *   - TZ-Fixtures (Europe/Zurich, Januar, DST-frei) analog
 *     `NightWatchScheduler.test.js` (`computeWindowEndMs`-Tests) — dieselbe
 *     Konvention, damit die Fenster-Start-Berechnung exakt nachvollziehbar ist.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { BudgetGuard, BUDGET_RESUME_BUFFER_MS } from '../src/BudgetGuard.js';
import { BUDGET_RESUME_BUFFER_MS as PROJECT_DRAIN_BUFFER_MS } from '../src/ProjectDrain.js';

function makeWindow(overrides = {}) {
  return { start: '23:00', end: '07:00', timezone: 'Europe/Zurich', ...overrides };
}

function makeSettings(overrides = {}) {
  return {
    nightBudgetTokens: 1000,
    budgetThresholdPercent: 85,
    window: makeWindow(),
    ...overrides,
  };
}

function makeGuard(overrides = {}) {
  const tokenUsageMeter = overrides.tokenUsageMeter ?? { getUsage: jest.fn(async () => ({ outputTokens: 0 })) };
  const readSettings = overrides.readSettings ?? jest.fn(async () => makeSettings());
  const sleepFn = overrides.sleepFn ?? jest.fn(async () => {});
  const now = overrides.now ?? (() => 0);
  const guard = new BudgetGuard({
    tokenUsageMeter,
    readSettings,
    sleepFn,
    now,
    ...(overrides.budgetResumeBufferMs !== undefined ? { budgetResumeBufferMs: overrides.budgetResumeBufferMs } : {}),
  });
  return { guard, tokenUsageMeter, readSettings, sleepFn };
}

describe('BudgetGuard — module exports', () => {
  it('re-exports BUDGET_RESUME_BUFFER_MS identical to ProjectDrain.js (Single-Source, kein Drift)', () => {
    expect(BUDGET_RESUME_BUFFER_MS).toBe(PROJECT_DRAIN_BUFFER_MS);
    expect(BUDGET_RESUME_BUFFER_MS).toBe(5 * 60 * 1000);
  });
});

describe('BudgetGuard.checkProactive (AC9)', () => {
  it('A4: nightBudgetTokens=0 → {pause:false} (No-op), Meter wird nicht befragt', async () => {
    const { guard, tokenUsageMeter } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 0 })),
    });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result).toEqual({ pause: false });
    expect(tokenUsageMeter.getUsage).not.toHaveBeenCalled();
  });

  it('nightBudgetTokens fehlt/nicht konfiguriert → {pause:false}', async () => {
    const { guard } = makeGuard({ readSettings: jest.fn(async () => ({})) });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result).toEqual({ pause: false });
  });

  it('Verbrauch < Schwelle → {pause:false}', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 849 })) }, // < 850
    });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result).toEqual({ pause: false });
  });

  it('Verbrauch == Schwelle (Grenzfall, "erreicht") → pause:true', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 850 })) },
    });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result.pause).toBe(true);
    expect(result.reason).toBe('proactive-threshold');
  });

  it('Verbrauch > Schwelle → pause:true, resumeAt:null solange kein Reset bekannt (A1)', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 900 })) },
    });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result).toEqual({ pause: true, reason: 'proactive-threshold', resumeAt: null });
  });

  it('nach noteReset(resetAt): eine nachfolgende Pause liefert resumeAt (AC11)', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 900 })) },
    });
    guard.noteReset(123456);
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result).toEqual({ pause: true, reason: 'proactive-threshold', resumeAt: 123456 });
  });

  it('noteReset merkt sich die jüngste Meldung (Überschreiben)', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 900 })) },
    });
    guard.noteReset(100);
    guard.noteReset(200);
    const result = await guard.checkProactive({ nowMs: 0 });
    expect(result.resumeAt).toBe(200);
  });

  it('noteReset ignoriert nicht-numerische/NaN Werte', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => makeSettings({ nightBudgetTokens: 1000, budgetThresholdPercent: 85 })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 900 })) },
    });
    guard.noteReset(NaN);
    guard.noteReset('not-a-number');
    guard.noteReset(undefined);
    const result = await guard.checkProactive({ nowMs: 0 });
    expect(result.resumeAt).toBeNull();
  });

  it('budgetThresholdPercent fehlt/ungültig → Default 85%', async () => {
    const { guard } = makeGuard({
      readSettings: jest.fn(async () => ({ nightBudgetTokens: 1000, window: makeWindow() })),
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 850 })) },
    });
    const result = await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
    expect(result.pause).toBe(true); // 850 >= 1000*85/100
  });

  it('Robustheit: readSettings() wirft → {pause:false} (nicht grundlos pausieren)', async () => {
    const { guard, tokenUsageMeter } = makeGuard({
      readSettings: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    const result = await guard.checkProactive({ nowMs: 0 });
    expect(result).toEqual({ pause: false });
    expect(tokenUsageMeter.getUsage).not.toHaveBeenCalled();
  });

  it('Robustheit: tokenUsageMeter.getUsage() wirft → {pause:false}', async () => {
    const { guard } = makeGuard({
      tokenUsageMeter: {
        getUsage: jest.fn(async () => {
          throw new Error('meter-fehler');
        }),
      },
    });
    const result = await guard.checkProactive({ nowMs: 0 });
    expect(result).toEqual({ pause: false });
  });

  it('"Messung nicht möglich" (outputTokens fehlt/kein Int) → {pause:false}', async () => {
    const { guard } = makeGuard({
      tokenUsageMeter: { getUsage: jest.fn(async () => ({})) },
    });
    const result = await guard.checkProactive({ nowMs: 0 });
    expect(result).toEqual({ pause: false });
  });

  describe('Fenster-Begrenzung der Messung ("im laufenden Fenster", Präzisierung S-274)', () => {
    it('normales Fenster (nicht über Mitternacht): sinceMs = Fenster-Start heute', async () => {
      const { guard, tokenUsageMeter } = makeGuard({
        readSettings: jest.fn(async () => makeSettings({ window: makeWindow({ start: '08:00', end: '17:00' }) })),
      });
      const nowMs = Date.UTC(2026, 0, 15, 11, 0); // 12:00 CET
      await guard.checkProactive({ nowMs });
      expect(tokenUsageMeter.getUsage).toHaveBeenCalledWith({ sinceMs: Date.UTC(2026, 0, 15, 7, 0) }); // 08:00 CET
    });

    it('über-Mitternacht, Abend-Hälfte: sinceMs = heute 23:00 CET', async () => {
      const { guard, tokenUsageMeter } = makeGuard();
      const nowMs = Date.UTC(2026, 0, 15, 22, 30); // 23:30 CET, 15. Jan
      await guard.checkProactive({ nowMs });
      expect(tokenUsageMeter.getUsage).toHaveBeenCalledWith({ sinceMs: Date.UTC(2026, 0, 15, 22, 0) }); // 23:00 CET
    });

    it('über-Mitternacht, Morgen-Hälfte: sinceMs = GESTERN 23:00 CET (Fenster begann letzte Nacht)', async () => {
      const { guard, tokenUsageMeter } = makeGuard();
      const nowMs = Date.UTC(2026, 0, 16, 1, 0); // 02:00 CET, 16. Jan
      await guard.checkProactive({ nowMs });
      expect(tokenUsageMeter.getUsage).toHaveBeenCalledWith({ sinceMs: Date.UTC(2026, 0, 15, 22, 0) }); // 23:00 CET, 15. Jan
    });

    it('ungültige Fenster-Konfig → sinceMs:null (token-usage-meter zählt alle Events, degradiert)', async () => {
      const { guard, tokenUsageMeter } = makeGuard({
        readSettings: jest.fn(async () => makeSettings({ window: { start: 'bad', end: '07:00', timezone: 'Europe/Zurich' } })),
      });
      await guard.checkProactive({ nowMs: Date.UTC(2026, 0, 15, 12, 0) });
      expect(tokenUsageMeter.getUsage).toHaveBeenCalledWith({ sinceMs: null });
    });
  });
});

describe('BudgetGuard.awaitResume (AC6/A1/A2/AC10/AC11)', () => {
  it('kein bekannter resumeAt + windowEndMs gesetzt → sanftes Ende budget-window-end (Nacht-Drain)', async () => {
    const { guard, sleepFn } = makeGuard({ now: () => 5000 });
    const result = await guard.awaitResume({ resumeAt: null, windowEndMs: 999999, nowMs: 1000 });
    expect(result).toEqual({ resumed: false, reason: 'budget-window-end', from: 1000 });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('kein bekannter resumeAt + windowEndMs:null → sanftes Ende budget-stop (manuell/kein Fenster)', async () => {
    const { guard, sleepFn } = makeGuard();
    const result = await guard.awaitResume({ resumeAt: null, windowEndMs: null, nowMs: 1000 });
    expect(result).toEqual({ resumed: false, reason: 'budget-stop', from: 1000 });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('bekannter resumeAt, Ziel innerhalb windowEndMs → wartet bis resumeAt+Puffer, resumed:true', async () => {
    const { guard, sleepFn } = makeGuard({ budgetResumeBufferMs: 10_000, now: () => 999999 });
    const resumeAt = 100_000;
    const nowMs = 90_000;
    const result = await guard.awaitResume({ resumeAt, windowEndMs: 500_000, nowMs });
    expect(sleepFn).toHaveBeenCalledWith(20_000); // (100000+10000) - 90000
    expect(result).toEqual({ resumed: true, from: nowMs, to: 999999 });
  });

  it('A2: Ziel (resumeAt+Puffer) hinter windowEndMs → sanftes Ende budget-window-end, kein Warten', async () => {
    const { guard, sleepFn } = makeGuard({ budgetResumeBufferMs: 10_000 });
    const result = await guard.awaitResume({ resumeAt: 100_000, windowEndMs: 105_000, nowMs: 90_000 });
    // Ziel = 110000 > windowEndMs 105000
    expect(result).toEqual({ resumed: false, reason: 'budget-window-end', from: 90_000 });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('windowEndMs:null (kein Fenster) → wartet regulär bis resumeAt+Puffer, unabhängig vom Ziel', async () => {
    const { guard, sleepFn } = makeGuard({ budgetResumeBufferMs: 10_000, now: () => 42 });
    const result = await guard.awaitResume({ resumeAt: 10_000_000, windowEndMs: null, nowMs: 0 });
    expect(sleepFn).toHaveBeenCalledWith(10_010_000);
    expect(result.resumed).toBe(true);
  });

  it('Edge-Case "Reset-Zeit in der Vergangenheit": Wartezeit nie negativ (0 statt negativ)', async () => {
    const { guard, sleepFn } = makeGuard({ budgetResumeBufferMs: 1000, now: () => 7 });
    const result = await guard.awaitResume({ resumeAt: 100, windowEndMs: null, nowMs: 999_999 }); // Ziel (1100) << nowMs
    expect(sleepFn).toHaveBeenCalledWith(0);
    expect(result.resumed).toBe(true);
  });

  it('Robustheit: ein werfender sleepFn crasht nicht — resumed:true trotzdem', async () => {
    const throwingSleep = jest.fn(async () => {
      throw new Error('sleep-fehler');
    });
    const { guard } = makeGuard({ sleepFn: throwingSleep, now: () => 123 });
    const result = await guard.awaitResume({ resumeAt: 100, windowEndMs: null, nowMs: 0 });
    expect(result).toEqual({ resumed: true, from: 0, to: 123 });
  });

  it('Default budgetResumeBufferMs = BUDGET_RESUME_BUFFER_MS, wenn Konstruktor keinen übergibt', async () => {
    const sleepFn = jest.fn(async () => {});
    const guard = new BudgetGuard({
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 0 })) },
      readSettings: jest.fn(async () => makeSettings()),
      sleepFn,
      now: () => 0,
    });
    await guard.awaitResume({ resumeAt: 0, windowEndMs: null, nowMs: 0 });
    expect(sleepFn).toHaveBeenCalledWith(BUDGET_RESUME_BUFFER_MS);
  });

  it('negativer budgetResumeBufferMs im Konstruktor → fällt auf Default zurück', async () => {
    const sleepFn = jest.fn(async () => {});
    const guard = new BudgetGuard({
      tokenUsageMeter: { getUsage: jest.fn(async () => ({ outputTokens: 0 })) },
      readSettings: jest.fn(async () => makeSettings()),
      budgetResumeBufferMs: -5,
      sleepFn,
      now: () => 0,
    });
    await guard.awaitResume({ resumeAt: 0, windowEndMs: null, nowMs: 0 });
    expect(sleepFn).toHaveBeenCalledWith(BUDGET_RESUME_BUFFER_MS);
  });
});
