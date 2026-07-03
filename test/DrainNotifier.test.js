/**
 * DrainNotifier.test.js — Unit-Tests für den Drain-Fertig-Push
 * (docs/specs/drain-done-notification.md, S-277).
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
 * Strategy: reine Unit-Tests gegen injizierte Fakes (`getNotificationConfig`,
 * `getToken`, `sendNotificationFn` als `jest.fn()`) — kein IO, kein echtes
 * `NotifyService`/`CredentialStore` (die Naht-Verdrahtung ist in
 * test/projectDrainRouter.test.js + test/NightWatchScheduler.test.js
 * abgedeckt).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { DrainNotifier, buildDrainDonePayload } from '../src/DrainNotifier.js';

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
