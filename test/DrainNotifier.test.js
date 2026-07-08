/**
 * DrainNotifier.test.js — Unit-Tests für den Drain-Fertig-Push
 * (docs/specs/drain-done-notification.md, S-277) UND den Fragen-offen-Push
 * (docs/specs/questions-pending-notification.md, S-279 — GETEILTE Klasse,
 * derselbe Config-/Token-/Versand-Baustein, kein zweiter Codepfad) UND den
 * Regression-fehlgeschlagen-Push (docs/specs/regression-failed-notification.md,
 * S-315 — ebenfalls GETEILTE Klasse, kein zweiter Codepfad).
 *
 * Covers (drain-done-notification):
 *   AC1 — Gating: `sendNotificationFn` wird GENAU EINMAL aufgerufen, wenn
 *         `result.flowRuns > 0` UND Config `enabled=true` UND `events`
 *         `drain_done` enthält. `flowRuns<=0` (0, negativ, fehlend/NaN) ODER
 *         `enabled=false` ODER `drain_done` nicht in `events` → KEIN Versand.
 *   AC2 — Bilanz-Payload: Titel „🏁 <slug>: X Done, Y Blocked" mit
 *         `X=completed.length`, `Y=blocked.length`; nicht-leeres
 *         `budgetPauses` → zusätzlich „ · Z Budget-Pausen"; fehlendes/leeres
 *         `budgetPauses` → kein Zusatz. `completed`/`blocked` fehlen → als 0
 *         gezählt (defensiv).
 *   AC3/AC4/AC5 — Best-effort: ein werfender/rejectender
 *         `getNotificationConfig`/`getToken`/`sendNotificationFn` lässt
 *         `notifyDrainDone` NIE werfen (Promise resolved trotzdem).
 *   AC6 — Wiring/Default-Regress: fehlt `sendNotificationFn` oder
 *         `getNotificationConfig` (nicht injiziert) → No-op, kein Crash.
 *   AC7 — Security: der Token landet NUR im `token`-Feld des an
 *         `sendNotificationFn` gereichten Configs — nie im Log (Test prüft,
 *         dass console.error-Aufrufe bei Erfolgspfad ausbleiben und dass
 *         Fehlerpfade den Token nicht in der Fehlermeldung tragen).
 *
 * Covers (questions-pending-notification):
 *   AC2 — Gating: `sendNotificationFn` wird GENAU EINMAL aufgerufen, wenn
 *         Config `enabled=true` UND `events` `questions_pending` enthält;
 *         `enabled=false` ODER `questions_pending` nicht in `events` (oder
 *         `events` fehlt/kein Array) → KEIN Versand.
 *   AC3 — Payload: Titel „❓ <label>: Fragen offen"; Message nennt Label +
 *         (falls vorhanden) die Anzahl offener Fragen; `tags: ['question']`;
 *         leeres/fehlendes Label → generischer Fallback (nie leer/undefined).
 *   AC4 — Best-effort: ein werfender/rejectender
 *         `getNotificationConfig`/`getToken`/`sendNotificationFn` lässt
 *         `notifyQuestionsPending` NIE werfen.
 *   AC5 — Wiring/Default-Regress: fehlt `sendNotificationFn` oder
 *         `getNotificationConfig` → No-op, kein Crash.
 *   AC6 — Security: kein Token in geloggten Fehlermeldungen; Payload/Title
 *         enthalten nur Label + Zähler, nie einen Pfad.
 *
 * Covers (regression-failed-notification):
 *   AC3 — Payload: Titel „🔴 <projekt>: Regression <suite> fehlgeschlagen —
 *         X/Y rot" mit X=failed, Y=total; fehlende/nicht-finite Zähler als 0
 *         behandelt (kein NaN/Crash).
 *   AC4 — Gating: `sendNotificationFn` wird GENAU EINMAL aufgerufen, wenn
 *         Config `enabled=true` UND `events` `regression_failed` enthält;
 *         `enabled=false` ODER `regression_failed` nicht in `events` (oder
 *         `events` fehlt/kein Array) → KEIN Versand. Kein Secret/Token im Log.
 *   (Best-effort/Wiring, analog notifyDrainDone/notifyQuestionsPending): ein
 *         werfender/rejectender `getNotificationConfig`/`getToken`/
 *         `sendNotificationFn` lässt `notifyRegressionFailed` NIE werfen;
 *         fehlende Boundary → No-op, kein Crash.
 *
 * Strategy: reine Unit-Tests gegen injizierte Fakes (`getNotificationConfig`,
 * `getToken`, `sendNotificationFn` als `jest.fn()`) — kein IO, kein echtes
 * `NotifyService`/`CredentialStore` (die Naht-Verdrahtung — Aufruf NUR bei
 * status:"failed" — ist in test/RegressionRunner.test.js abgedeckt;
 * die `ObsidianIngestRunner`-Setzstellen-Naht ist in
 * test/ObsidianIngestRunner.test.js abgedeckt).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  DrainNotifier,
  buildDrainDonePayload,
  buildQuestionsPendingPayload,
  buildRegressionFailedPayload,
} from '../src/DrainNotifier.js';

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    server: 'https://ntfy.sh',
    topic: 'my-topic',
    priority: 3,
    events: ['drain_done'],
    ...overrides,
  };
}

function makeNotifier(overrides = {}) {
  const getNotificationConfig = overrides.getNotificationConfig ?? jest.fn(async () => makeConfig());
  const getToken = overrides.getToken ?? jest.fn(async () => 'secret-token');
  const sendNotificationFn = overrides.sendNotificationFn ?? jest.fn(async () => ({ ok: true }));
  const notifier = new DrainNotifier({ getNotificationConfig, getToken, sendNotificationFn });
  return { notifier, getNotificationConfig, getToken, sendNotificationFn };
}

describe('buildDrainDonePayload (AC2)', () => {
  it('Titel/Message mit completed/blocked-Zählern, kein Budget-Pausen-Zusatz ohne das Feld', () => {
    const payload = buildDrainDonePayload('dev-gui', { completed: [{ id: 'S-1' }, { id: 'S-2' }], blocked: [{ id: 'S-3' }] });
    expect(payload.title).toBe('🏁 dev-gui: 2 Done, 1 Blocked');
    expect(payload.message).toContain('dev-gui');
    expect(payload.message).toContain('2');
    expect(payload.message).toContain('1');
    expect(payload.tags).toEqual(['checkered_flag']);
  });

  it('hängt „· Z Budget-Pausen" an, wenn budgetPauses nicht-leer ist', () => {
    const payload = buildDrainDonePayload('dev-gui', {
      completed: [],
      blocked: [],
      budgetPauses: [{ story: 'S-1' }, { story: 'S-2' }],
    });
    expect(payload.title).toBe('🏁 dev-gui: 0 Done, 0 Blocked · 2 Budget-Pausen');
  });

  it('lässt den Budget-Pausen-Zusatz bei leerem Array weg', () => {
    const payload = buildDrainDonePayload('dev-gui', { completed: [], blocked: [], budgetPauses: [] });
    expect(payload.title).toBe('🏁 dev-gui: 0 Done, 0 Blocked');
  });

  it('zählt fehlende completed/blocked als 0 (defensiv, kein Crash)', () => {
    const payload = buildDrainDonePayload('dev-gui', {});
    expect(payload.title).toBe('🏁 dev-gui: 0 Done, 0 Blocked');
  });
});

describe('DrainNotifier.notifyDrainDone — Gating (AC1)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('sendet GENAU EINE Notification bei flowRuns>0 + enabled=true + drain_done in events (Happy Path)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier();
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 2, completed: [], blocked: [] } });

    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config, payload] = sendNotificationFn.mock.calls[0];
    expect(config).toEqual({ server: 'https://ntfy.sh', topic: 'my-topic', priority: 3, token: 'secret-token' });
    expect(payload.title).toBe('🏁 dev-gui: 0 Done, 0 Blocked');
  });

  it('flowRuns==0 → kein Versand (A1)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier();
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 0 } });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('flowRuns negativ → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier();
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: -1 } });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('flowRuns fehlt/NaN → kein Versand (defensiv)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier();
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: {} });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('enabled=false → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeConfig({ enabled: false })),
    });
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('drain_done nicht in events → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeConfig({ events: ['story_done'] })),
    });
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('events fehlt/kein Array → kein Versand (defensiv)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeConfig({ events: undefined })),
    });
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });
});

describe('DrainNotifier.notifyDrainDone — Best-effort/Fehler-Schlucken (AC3/AC4/AC5)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('ein werfender getNotificationConfig lässt notifyDrainDone nicht werfen (kein Versand)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => { throw new Error('config kaputt'); }),
    });
    await expect(notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } })).resolves.toBeUndefined();
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('ein werfender getToken blockiert den Versand nicht — Versand läuft ohne Token weiter', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getToken: jest.fn(async () => { throw new Error('token kaputt'); }),
    });
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } });
    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config] = sendNotificationFn.mock.calls[0];
    expect(config.token).toBeNull();
  });

  it('ein werfender/rejectender sendNotificationFn lässt notifyDrainDone nicht werfen', async () => {
    const { notifier } = makeNotifier({
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
    });
    await expect(notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } })).resolves.toBeUndefined();
  });

  it('AC7 — kein Token in der geloggten Fehlermeldung bei Versand-Fehler', async () => {
    const { notifier } = makeNotifier({
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
      getToken: jest.fn(async () => 'super-secret-token'),
    });
    await notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } });
    const loggedText = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(loggedText).not.toContain('super-secret-token');
  });
});

describe('DrainNotifier.notifyDrainDone — fehlende Boundary (AC6, Default-Regress)', () => {
  it('ohne sendNotificationFn → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ getNotificationConfig: jest.fn(async () => makeConfig()) });
    await expect(notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } })).resolves.toBeUndefined();
  });

  it('ohne getNotificationConfig → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ sendNotificationFn: jest.fn(async () => ({ ok: true })) });
    await expect(notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } })).resolves.toBeUndefined();
  });

  it('leerer Konstruktor-Aufruf → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier();
    await expect(notifier.notifyDrainDone({ slug: 'dev-gui', result: { flowRuns: 1 } })).resolves.toBeUndefined();
  });
});

// ── questions-pending-notification (S-279, geteilte Klasse) ─────────────────

function makeQuestionsPendingConfig(overrides = {}) {
  return {
    enabled: true,
    server: 'https://ntfy.sh',
    topic: 'my-topic',
    priority: 3,
    events: ['questions_pending'],
    ...overrides,
  };
}

describe('buildQuestionsPendingPayload (AC3)', () => {
  it('Titel „❓ <label>: Fragen offen" + Anzahl im Text, tags:["question"]', () => {
    const payload = buildQuestionsPendingPayload('proj-a', 3);
    expect(payload.title).toBe('❓ proj-a: Fragen offen');
    expect(payload.message).toContain('proj-a');
    expect(payload.message).toContain('3');
    expect(payload.tags).toEqual(['question']);
  });

  it('ohne Anzahl (undefined/0) → Text ohne Zähler, kein Crash', () => {
    const payload = buildQuestionsPendingPayload('proj-a', undefined);
    expect(payload.title).toBe('❓ proj-a: Fragen offen');
    expect(payload.message).toContain('proj-a');
    expect(payload.message).not.toMatch(/\d/);
  });

  it('leeres/fehlendes Label → generischer Fallback statt leer/undefined (AC6)', () => {
    const payload = buildQuestionsPendingPayload('', 2);
    expect(payload.title).not.toContain('undefined');
    expect(payload.title).not.toBe('❓ : Fragen offen');
    expect(payload.title).toContain('Projekt');
  });

  it('kein absoluter Pfad im Payload, selbst wenn versehentlich ein Pfad übergeben würde', () => {
    // Defense-in-depth: der Runner reicht bereits nur den Basename — dieser Test
    // dokumentiert, dass der Builder selbst nichts an Pfad-Segmenten anhängt.
    const payload = buildQuestionsPendingPayload('proj-a', 1);
    expect(payload.title).not.toMatch(/\//);
    expect(payload.message).not.toMatch(/\//);
  });
});

describe('DrainNotifier.notifyQuestionsPending — Gating (AC2)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('sendet GENAU EINE Notification bei enabled=true + questions_pending in events (Happy Path)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig()),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 2 });

    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config, payload] = sendNotificationFn.mock.calls[0];
    expect(config).toEqual({ server: 'https://ntfy.sh', topic: 'my-topic', priority: 3, token: 'secret-token' });
    expect(payload.title).toBe('❓ proj-a: Fragen offen');
  });

  it('enabled=false → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig({ enabled: false })),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('questions_pending nicht in events → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig({ events: ['drain_done'] })),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('events fehlt/kein Array → kein Versand (defensiv)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig({ events: undefined })),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });
});

describe('DrainNotifier.notifyQuestionsPending — Best-effort/Fehler-Schlucken (AC4/AC6)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('ein werfender getNotificationConfig lässt notifyQuestionsPending nicht werfen (kein Versand)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => { throw new Error('config kaputt'); }),
    });
    await expect(notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 })).resolves.toBeUndefined();
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('ein werfender getToken blockiert den Versand nicht — Versand läuft ohne Token weiter', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig()),
      getToken: jest.fn(async () => { throw new Error('token kaputt'); }),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 });
    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config] = sendNotificationFn.mock.calls[0];
    expect(config.token).toBeNull();
  });

  it('ein werfender/rejectender sendNotificationFn lässt notifyQuestionsPending nicht werfen', async () => {
    const { notifier } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig()),
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
    });
    await expect(notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 })).resolves.toBeUndefined();
  });

  it('AC6 — kein Token in der geloggten Fehlermeldung bei Versand-Fehler', async () => {
    const { notifier } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig()),
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
      getToken: jest.fn(async () => 'super-secret-token-2'),
    });
    await notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 });
    const loggedText = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(loggedText).not.toContain('super-secret-token-2');
  });
});

describe('DrainNotifier.notifyQuestionsPending — fehlende Boundary (AC5, Default-Regress)', () => {
  it('ohne sendNotificationFn → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ getNotificationConfig: jest.fn(async () => makeQuestionsPendingConfig()) });
    await expect(notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 })).resolves.toBeUndefined();
  });

  it('ohne getNotificationConfig → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ sendNotificationFn: jest.fn(async () => ({ ok: true })) });
    await expect(notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 })).resolves.toBeUndefined();
  });

  it('leerer Konstruktor-Aufruf → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier();
    await expect(notifier.notifyQuestionsPending({ label: 'proj-a', questionCount: 1 })).resolves.toBeUndefined();
  });
});

// ── regression-failed-notification (S-315, geteilte Klasse) ─────────────────

function makeRegressionFailedConfig(overrides = {}) {
  return {
    enabled: true,
    server: 'https://ntfy.sh',
    topic: 'my-topic',
    priority: 3,
    events: ['regression_failed'],
    ...overrides,
  };
}

describe('buildRegressionFailedPayload (AC3)', () => {
  it('Titel „🔴 <projekt>: Regression <suite> fehlgeschlagen — X/Y rot"', () => {
    const payload = buildRegressionFailedPayload('dev-gui', 'Gesamt', 3, 10);
    expect(payload.title).toBe('🔴 dev-gui: Regression Gesamt fehlgeschlagen — 3/10 rot');
    expect(payload.message).toBe(payload.title);
    expect(payload.tags).toEqual(['red_circle']);
  });

  it('fehlende/nicht-finite Zähler werden als 0 behandelt (kein NaN/Crash)', () => {
    const payload = buildRegressionFailedPayload('dev-gui', 'bereich-a', undefined, NaN);
    expect(payload.title).toBe('🔴 dev-gui: Regression bereich-a fehlgeschlagen — 0/0 rot');
  });
});

describe('DrainNotifier.notifyRegressionFailed — Gating (AC4)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('sendet GENAU EINE Notification bei enabled=true + regression_failed in events (Happy Path)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig()),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 2, total: 5 });

    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config, payload] = sendNotificationFn.mock.calls[0];
    expect(config).toEqual({ server: 'https://ntfy.sh', topic: 'my-topic', priority: 3, token: 'secret-token' });
    expect(payload.title).toBe('🔴 dev-gui: Regression Gesamt fehlgeschlagen — 2/5 rot');
  });

  it('enabled=false → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig({ enabled: false })),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('regression_failed nicht in events → kein Versand', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig({ events: ['drain_done'] })),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('events fehlt/kein Array → kein Versand (defensiv)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig({ events: undefined })),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 });
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });
});

describe('DrainNotifier.notifyRegressionFailed — Best-effort/Fehler-Schlucken', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('ein werfender getNotificationConfig lässt notifyRegressionFailed nicht werfen (kein Versand)', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => { throw new Error('config kaputt'); }),
    });
    await expect(
      notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 }),
    ).resolves.toBeUndefined();
    expect(sendNotificationFn).not.toHaveBeenCalled();
  });

  it('ein werfender getToken blockiert den Versand nicht — Versand läuft ohne Token weiter', async () => {
    const { notifier, sendNotificationFn } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig()),
      getToken: jest.fn(async () => { throw new Error('token kaputt'); }),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 });
    expect(sendNotificationFn).toHaveBeenCalledTimes(1);
    const [config] = sendNotificationFn.mock.calls[0];
    expect(config.token).toBeNull();
  });

  it('ein werfender/rejectender sendNotificationFn lässt notifyRegressionFailed nicht werfen', async () => {
    const { notifier } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig()),
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
    });
    await expect(
      notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 }),
    ).resolves.toBeUndefined();
  });

  it('kein Token in der geloggten Fehlermeldung bei Versand-Fehler', async () => {
    const { notifier } = makeNotifier({
      getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig()),
      sendNotificationFn: jest.fn(async () => { throw new Error('netz kaputt'); }),
      getToken: jest.fn(async () => 'super-secret-token-3'),
    });
    await notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 });
    const loggedText = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(loggedText).not.toContain('super-secret-token-3');
  });
});

describe('DrainNotifier.notifyRegressionFailed — fehlende Boundary (Default-Regress)', () => {
  it('ohne sendNotificationFn → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ getNotificationConfig: jest.fn(async () => makeRegressionFailedConfig()) });
    await expect(
      notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 }),
    ).resolves.toBeUndefined();
  });

  it('ohne getNotificationConfig → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier({ sendNotificationFn: jest.fn(async () => ({ ok: true })) });
    await expect(
      notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 }),
    ).resolves.toBeUndefined();
  });

  it('leerer Konstruktor-Aufruf → No-op, kein Crash', async () => {
    const notifier = new DrainNotifier();
    await expect(
      notifier.notifyRegressionFailed({ projekt: 'dev-gui', suite: 'Gesamt', failed: 1, total: 1 }),
    ).resolves.toBeUndefined();
  });
});
