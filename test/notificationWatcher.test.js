/**
 * notificationWatcher.test.js — Tests für NotificationWatcher (S-184, AC6–AC9 + S-286, AC8–AC12).
 *
 * Covers (push-notifications S-184):
 *   AC6  — Übergangs-Erkennung: Done-Übergang feuert; unverändert feuert nicht;
 *           Snapshot-Persistenz überlebt Neustart (kein Re-Fire); mehrere Übergänge
 *           im selben Scan → mehrere Sends; NotifyService-Fehler crasht Watcher nicht
 *   AC7  — Baseline-Erststart: erster Scan sendet nichts; danach feuern neue Übergänge
 *   AC8  — Ereignis-Mapping & Gating: story_done / story_blocked / feature_done;
 *           enabled=false → kein Versand (aber Snapshot-Update);
 *           Ereignis nicht in settings.events → kein Versand
 *   AC9  — Nachrichteninhalt: Projekt-Slug, Item-ID, Titel, Ereignistyp (Emoji/Titel)
 *
 * Covers (board-live-sse S-286):
 *   AC8  — Projekt-Slugs mit verändertem Story-Status-Abbild erkennen + broadcast je Projekt
 *   AC9  — Baseline-Scan löst KEIN SSE-Event aus
 *   AC10 — SSE-Invalidierung unabhängig vom ntfy-Gating (auch bei enabled=false)
 *   AC11 — Broadcast läuft auch nach explizitem rescan über denselben Codepfad
 *   AC12 — boardEventHub optional injiziert; null-tolerant degradation
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  buildBaseline,
  buildNotificationPayload,
  detectTransitions,
  detectChangedProjects,
  NotificationWatcher,
  readSnapshot,
  resolveSnapshotFilePath,
  writeSnapshot,
} from '../src/NotificationWatcher.js';

// ── Fixture-Helpers ───────────────────────────────────────────────────────────

function makeProject({ slug = 'dev-gui', project_slug = 'dev-gui', features = [] } = {}) {
  return { slug, project_slug, features };
}

function makeFeature({ id = 'F-1', title = 'Feature 1', stories = [], _orphaned = false } = {}) {
  return { id, title, stories, _orphaned };
}

function makeStory({ id = 'S-1', title = 'Story 1', status = 'To Do' } = {}) {
  return { id, title, status };
}

function makeIndex(projects) {
  return projects;
}

// ── AC6: Übergangs-Erkennung (detectTransitions) ─────────────────────────────

describe('AC6 — detectTransitions: Übergangs-Erkennung', () => {
  it('Done-Übergang: war To Do, ist jetzt Done → story_done Event', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [makeStory({ id: 'S-1', status: 'Done' })],
        })],
      }),
    ]);
    const oldSnapshot = { stories: { 'dev-gui::S-1': 'To Do' }, features: {} };

    const { events } = detectTransitions(index, oldSnapshot);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('story_done');
    expect(events[0].id).toBe('S-1');
  });

  it('unverändert Done → KEIN Event (kein Re-Fire bei gleichem Status)', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [makeStory({ id: 'S-1', status: 'Done' })],
        })],
      }),
    ]);
    // S-1 war bereits Done im Snapshot
    const oldSnapshot = { stories: { 'dev-gui::S-1': 'Done' }, features: {} };

    const { events } = detectTransitions(index, oldSnapshot);

    expect(events).toHaveLength(0);
  });

  it('Erster Scan (kein Snapshot): kein Event (Baseline-Phase handled in check())', () => {
    // detectTransitions selbst: wenn prevStatus === undefined → kein Event
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [makeStory({ id: 'S-1', status: 'Done' })],
        })],
      }),
    ]);
    const emptySnapshot = { stories: {}, features: {} };

    const { events } = detectTransitions(index, emptySnapshot);

    // Da prevStatus = undefined, kein Event (nur buildBaseline produziert hier den Erststand)
    expect(events).toHaveLength(0);
  });

  it('Done→To Do→Done: erneuter Übergang feuert erneut (gewolltes Verhalten)', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [makeStory({ id: 'S-1', status: 'Done' })],
        })],
      }),
    ]);
    // Snapshot zeigt 'To Do' (S-1 wurde re-opened und jetzt wieder Done)
    const oldSnapshot = { stories: { 'dev-gui::S-1': 'To Do' }, features: {} };

    const { events } = detectTransitions(index, oldSnapshot);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('story_done');
  });

  it('mehrere Übergänge im selben Scan → je Übergang ein Event (kein Verschlucken)', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [
            makeStory({ id: 'S-1', status: 'Done' }),
            makeStory({ id: 'S-2', status: 'Blocked' }),
          ],
        })],
      }),
    ]);
    const oldSnapshot = {
      stories: { 'dev-gui::S-1': 'In Progress', 'dev-gui::S-2': 'To Do' },
      features: {},
    };

    const { events } = detectTransitions(index, oldSnapshot);

    expect(events).toHaveLength(2);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('story_done');
    expect(eventTypes).toContain('story_blocked');
  });

  it('Snapshot wird immer aktualisiert (auch ohne Übergang)', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          stories: [makeStory({ id: 'S-1', status: 'In Progress' })],
        })],
      }),
    ]);
    const oldSnapshot = { stories: { 'dev-gui::S-1': 'In Progress' }, features: {} };

    const { newSnapshot } = detectTransitions(index, oldSnapshot);

    expect(newSnapshot.stories['dev-gui::S-1']).toBe('In Progress');
  });

  it('Fehler-Boards (project.error) werden übersprungen — kein Snapshot-Update', () => {
    const index = makeIndex([
      { slug: 'bad-project', error: 'board.yaml fehlt', features: [] },
    ]);
    const oldSnapshot = { stories: {}, features: {} };

    const { events, newSnapshot } = detectTransitions(index, oldSnapshot);

    expect(events).toHaveLength(0);
    // Kein Story aus Fehler-Board im neuen Snapshot
    expect(Object.keys(newSnapshot.stories)).toHaveLength(0);
  });

  it('Cross-Projekt-Kollision: gleiche Feature-ID in zwei Projekten feuert NICHT im Dauertakt', () => {
    // Realer Bug: dev-gui UND agent-flow haben beide ein "F-001". Ohne Projekt-Namespace
    // kollidierten die Snapshot-Keys → der Eintrag kippte jeden Scan hin und her und
    // feuerte feature_done jede Minute erneut.
    const index = makeIndex([
      { slug: 'dev-gui', project_slug: 'dev-gui', features: [
        makeFeature({ id: 'F-001', stories: [makeStory({ id: 'S-1', status: 'In Progress' })] }), // NICHT komplett
      ] },
      { slug: 'agent-flow', project_slug: 'agent-flow', features: [
        makeFeature({ id: 'F-001', stories: [makeStory({ id: 'S-1', status: 'Done' })] }), // komplett, schon bekannt
      ] },
    ]);
    const snapshot = {
      stories: { 'dev-gui::S-1': 'In Progress', 'agent-flow::S-1': 'Done' },
      features: { 'dev-gui::F-001': false, 'agent-flow::F-001': true },
    };

    // Erster Lauf: nichts geändert → kein Event; Einträge bleiben projekt-getrennt
    const r1 = detectTransitions(index, snapshot);
    expect(r1.events).toHaveLength(0);
    expect(r1.newSnapshot.features['dev-gui::F-001']).toBe(false);
    expect(r1.newSnapshot.features['agent-flow::F-001']).toBe(true);

    // Zweiter Lauf gegen den aktualisierten Snapshot: weiterhin KEIN Re-Fire (kein Dauertakt)
    const r2 = detectTransitions(index, r1.newSnapshot);
    expect(r2.events).toHaveLength(0);
  });
});

// ── AC7: Baseline ohne Flut ───────────────────────────────────────────────────

describe('AC7 — Baseline-Erststart sendet nichts', () => {
  it('buildBaseline: erstellt Snapshot ohne Events (alle Status erfasst)', () => {
    const index = makeIndex([
      makeProject({
        features: [makeFeature({
          id: 'F-1',
          stories: [
            makeStory({ id: 'S-1', status: 'Done' }),
            makeStory({ id: 'S-2', status: 'In Progress' }),
          ],
        })],
      }),
    ]);

    const baseline = buildBaseline(index);

    expect(baseline.stories['dev-gui::S-1']).toBe('Done');
    expect(baseline.stories['dev-gui::S-2']).toBe('In Progress');
    expect(Object.keys(baseline.stories)).toHaveLength(2);
  });

  it('check() beim ersten Aufruf (leerer Disk-Snapshot): sendet NICHTS, schreibt Baseline', async () => {
    const sendFn = jest.fn();

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          features: [makeFeature({
            id: 'F-1',
            stories: [makeStory({ id: 'S-100', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true, server: 'https://ntfy.sh', topic: 'test', events: ['story_done'], priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      await watcher.check();

      // Baseline-Scan: kein Versand
      expect(sendFn).not.toHaveBeenCalled();
      // Snapshot wurde geschrieben
      expect(fsDeps.writeFile).toHaveBeenCalled();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('check() zweiter Aufruf (nach Baseline): feuert für neue Übergänge', async () => {
    const sendFn = jest.fn(async () => ({ ok: true }));

    let callCount = 0;
    const mockBoardAggregator = {
      getIndex: jest.fn(async () => {
        callCount++;
        // Erster Aufruf: S-1 In Progress (Baseline)
        // Zweiter Aufruf: S-1 Done (echter Übergang)
        const status = callCount === 1 ? 'In Progress' : 'Done';
        return makeIndex([
          makeProject({
            features: [makeFeature({
              id: 'F-1',
              stories: [makeStory({ id: 'S-1', status })],
            })],
          }),
        ]);
      }),
    };

    const fsDeps = {
      readFile: jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true, server: 'https://ntfy.sh', topic: 'test', events: ['story_done'], priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      // Erster check() → Baseline (kein Send)
      await watcher.check();
      expect(sendFn).not.toHaveBeenCalled();

      // Zweiter check() → S-1 jetzt Done → story_done Event
      await watcher.check();
      expect(sendFn).toHaveBeenCalledTimes(1);
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });
});

// ── AC6: Snapshot-Persistenz ──────────────────────────────────────────────────

describe('AC6 — Snapshot-Persistenz: kein Re-Fire nach Neustart', () => {
  it('readSnapshot: gibt leeren Snapshot + found=false bei ENOENT zurück', async () => {
    const fsDeps = {
      readFile: jest.fn(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const { snapshot, found } = await readSnapshot(fsDeps);
      expect(snapshot).toEqual({ stories: {}, features: {} });
      expect(found).toBe(false);
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('readSnapshot: gibt persistierten Snapshot + found=true zurück', async () => {
    const stored = { stories: { 'dev-gui::S-5': 'Done' }, features: { 'dev-gui::F-2': true } };
    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify(stored)),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const { snapshot, found } = await readSnapshot(fsDeps);
      expect(snapshot.stories['dev-gui::S-5']).toBe('Done');
      expect(snapshot.features['dev-gui::F-2']).toBe(true);
      expect(found).toBe(true);
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('Neustart-Simulation: Watcher lädt Snapshot von Disk und feuert nicht erneut', async () => {
    const sendFn = jest.fn(async () => ({ ok: true }));

    // "Auf Disk" persistierter Snapshot: S-1 ist bereits Done
    const diskSnapshot = { stories: { 'dev-gui::S-1': 'Done' }, features: { 'dev-gui::F-1': true } };

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          features: [makeFeature({
            id: 'F-1',
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify(diskSnapshot)),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true, server: 'https://ntfy.sh', topic: 'test', events: ['story_done', 'feature_done'], priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      await watcher.check();

      // S-1 ist im Snapshot bereits Done → kein Re-Fire
      expect(sendFn).not.toHaveBeenCalled();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });
});

// ── AC8: Ereignis-Mapping & Gating ───────────────────────────────────────────

describe('AC8 — Ereignis-Mapping', () => {
  it('→ Done ⇒ story_done', () => {
    const index = makeIndex([makeProject({
      features: [makeFeature({ stories: [makeStory({ id: 'S-1', status: 'Done' })] })],
    })]);
    const { events } = detectTransitions(index, { stories: { 'dev-gui::S-1': 'In Progress' }, features: {} });
    expect(events[0].eventType).toBe('story_done');
  });

  it('→ Blocked ⇒ story_blocked', () => {
    const index = makeIndex([makeProject({
      features: [makeFeature({ stories: [makeStory({ id: 'S-1', status: 'Blocked' })] })],
    })]);
    const { events } = detectTransitions(index, { stories: { 'dev-gui::S-1': 'To Do' }, features: {} });
    expect(events[0].eventType).toBe('story_blocked');
  });

  it('Feature komplett (alle Kinder Done) ⇒ feature_done', () => {
    const index = makeIndex([makeProject({
      features: [makeFeature({
        id: 'F-1',
        stories: [
          makeStory({ id: 'S-1', status: 'Done' }),
          makeStory({ id: 'S-2', status: 'Done' }),
        ],
      })],
    })]);
    // Snapshot: F-1 war noch NICHT komplett
    const oldSnapshot = {
      stories: { 'dev-gui::S-1': 'In Progress', 'dev-gui::S-2': 'Done' },
      features: { 'dev-gui::F-1': false },
    };
    const { events } = detectTransitions(index, oldSnapshot);
    const featDone = events.find((e) => e.eventType === 'feature_done');
    expect(featDone).toBeDefined();
    expect(featDone.id).toBe('F-1');
  });

  it('Feature-done NICHT wenn noch nicht alle Kinder Done', () => {
    const index = makeIndex([makeProject({
      features: [makeFeature({
        id: 'F-1',
        stories: [
          makeStory({ id: 'S-1', status: 'Done' }),
          makeStory({ id: 'S-2', status: 'In Progress' }), // noch nicht Done
        ],
      })],
    })]);
    const oldSnapshot = {
      stories: { 'dev-gui::S-1': 'In Progress', 'dev-gui::S-2': 'In Progress' },
      features: { 'dev-gui::F-1': false },
    };
    const { events } = detectTransitions(index, oldSnapshot);
    const featDone = events.find((e) => e.eventType === 'feature_done');
    expect(featDone).toBeUndefined();
  });
});

describe('AC8 — Gating: enabled=false / Ereignis nicht aktiviert', () => {
  it('enabled=false → kein Versand, aber Snapshot-Update', async () => {
    const sendFn = jest.fn(async () => ({ ok: true }));

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify({ stories: { 'dev-gui::S-1': 'In Progress' }, features: {} })),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: false, // disabled
          server: 'https://ntfy.sh', topic: 'test', events: ['story_done'], priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      await watcher.check();

      // Kein Versand
      expect(sendFn).not.toHaveBeenCalled();
      // Aber Snapshot wurde aktualisiert (damit nach Einschalten keine alten Übergänge nachfeuern)
      expect(fsDeps.writeFile).toHaveBeenCalled();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('Ereignis nicht in settings.events → kein Versand', async () => {
    const sendFn = jest.fn(async () => ({ ok: true }));

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify({ stories: { 'dev-gui::S-1': 'In Progress' }, features: {} })),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true,
          server: 'https://ntfy.sh', topic: 'test',
          events: ['story_blocked'], // story_done NICHT aktiviert
          priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      await watcher.check();

      expect(sendFn).not.toHaveBeenCalled();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });
});

// ── AC6: NotifyService-Fehler crasht Watcher nicht ───────────────────────────

describe('AC6 — NotifyService-Fehler crasht den Watcher nicht', () => {
  it('sendNotification wirft → check() resolved trotzdem (no throw)', async () => {
    const sendFn = jest.fn(async () => {
      throw new Error('ntfy network error');
    });

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify({ stories: { 'dev-gui::S-1': 'In Progress' }, features: {} })),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true, server: 'https://ntfy.sh', topic: 'test', events: ['story_done'], priority: null,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      let threw = false;
      try {
        await watcher.check();
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(sendFn).toHaveBeenCalled();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('Board-Scan-Fehler → check() resolved ohne Snapshot-Update', async () => {
    const sendFn = jest.fn();
    const writeFileFn = jest.fn(async () => {});

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => {
        throw new Error('board scan failed');
      }),
    };

    const watcher = new NotificationWatcher({
      boardAggregator: mockBoardAggregator,
      credentialStore: null,
      readNotificationSettings: jest.fn(async () => ({
        enabled: true, server: 'https://ntfy.sh', topic: 'test', events: ['story_done'], priority: null,
      })),
      sendNotificationFn: sendFn,
      fsDeps: {
        readFile: jest.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
        writeFile: writeFileFn,
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      },
    });

    let threw = false;
    try {
      await watcher.check();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(sendFn).not.toHaveBeenCalled();
    // Kein Snapshot-Update bei Board-Scan-Fehler
    expect(writeFileFn).not.toHaveBeenCalled();
  });
});

// ── AC9: Nachrichteninhalt ─────────────────────────────────────────────────────

describe('AC9 — Nachrichteninhalt: buildNotificationPayload', () => {
  it('story_done: Titel enthält ✅, Slug, ID und "fertig"; Body = Story-Titel', () => {
    const payload = buildNotificationPayload('story_done', 'dev-gui', 'S-181', 'My Story Title');
    expect(payload.title).toContain('✅');
    expect(payload.title).toContain('dev-gui');
    expect(payload.title).toContain('S-181');
    expect(payload.title).toContain('fertig');
    expect(payload.message).toBe('My Story Title');
  });

  it('story_blocked: Titel enthält ⛔, Slug, ID und "blockiert"; Body = Story-Titel', () => {
    const payload = buildNotificationPayload('story_blocked', 'my-project', 'S-42', 'Blocked Story');
    expect(payload.title).toContain('⛔');
    expect(payload.title).toContain('my-project');
    expect(payload.title).toContain('S-42');
    expect(payload.title).toContain('blockiert');
    expect(payload.message).toBe('Blocked Story');
  });

  it('feature_done: Titel enthält ✅, Slug, ID und "komplett"; Body = Feature-Titel', () => {
    const payload = buildNotificationPayload('feature_done', 'dev-gui', 'F-7', 'My Feature');
    expect(payload.title).toContain('✅');
    expect(payload.title).toContain('dev-gui');
    expect(payload.title).toContain('F-7');
    expect(payload.title).toContain('komplett');
    expect(payload.message).toBe('My Feature');
  });

  it('title=null: fallback auf Item-ID als Body', () => {
    const payload = buildNotificationPayload('story_done', 'dev-gui', 'S-99', null);
    expect(payload.message).toBe('S-99');
  });

  it('sendNotification wird mit korrektem Slug, ID und Ereignistyp aufgerufen', async () => {
    const sendFn = jest.fn(async () => ({ ok: true }));

    const mockBoardAggregator = {
      getIndex: jest.fn(async () => makeIndex([
        makeProject({
          slug: 'dev-gui',
          project_slug: 'dev-gui',
          features: [makeFeature({
            id: 'F-1',
            stories: [makeStory({ id: 'S-181', title: 'Finish this story', status: 'Done' })],
          })],
        }),
      ])),
    };

    const fsDeps = {
      readFile: jest.fn(async () => JSON.stringify({ stories: { 'dev-gui::S-181': 'In Progress' }, features: { 'dev-gui::F-1': false } })),
      writeFile: jest.fn(async () => {}),
      rename: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      chmod: jest.fn(async () => {}),
      unlink: jest.fn(async () => {}),
    };

    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';
    try {
      const watcher = new NotificationWatcher({
        boardAggregator: mockBoardAggregator,
        credentialStore: null,
        readNotificationSettings: jest.fn(async () => ({
          enabled: true,
          server: 'https://ntfy.sh',
          topic: 'board-alerts',
          events: ['story_done'],
          priority: 4,
        })),
        sendNotificationFn: sendFn,
        fsDeps,
      });

      await watcher.check();

      expect(sendFn).toHaveBeenCalledTimes(1);
      const [config, payload] = sendFn.mock.calls[0];
      // Config
      expect(config.server).toBe('https://ntfy.sh');
      expect(config.topic).toBe('board-alerts');
      expect(config.priority).toBe(4);
      // Payload (AC9)
      expect(payload.title).toContain('✅');
      expect(payload.title).toContain('dev-gui');
      expect(payload.title).toContain('S-181');
      expect(payload.message).toBe('Finish this story');
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });
});

// ── resolveSnapshotFilePath ───────────────────────────────────────────────────

describe('resolveSnapshotFilePath', () => {
  it('gibt null zurück wenn CRED_STORE_DIR nicht gesetzt', () => {
    const origCredStoreDir = process.env.CRED_STORE_DIR;
    delete process.env.CRED_STORE_DIR;
    try {
      expect(resolveSnapshotFilePath()).toBeNull();
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      }
    }
  });

  it('gibt korrekten Pfad zurück wenn CRED_STORE_DIR gesetzt', () => {
    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/data/cred';
    try {
      const path = resolveSnapshotFilePath();
      expect(path).toContain('notification-watcher-snapshot.json');
      expect(path).toContain('/data/cred');
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });
});

// ── writeSnapshot ─────────────────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('schreibt Snapshot atomar (writeFile → chmod → rename)', async () => {
    const origCredStoreDir = process.env.CRED_STORE_DIR;
    process.env.CRED_STORE_DIR = '/some/dir';

    const calls = [];
    const fsDeps = {
      writeFile: jest.fn(async () => calls.push('writeFile')),
      chmod: jest.fn(async () => calls.push('chmod')),
      rename: jest.fn(async () => calls.push('rename')),
      mkdir: jest.fn(async () => calls.push('mkdir')),
      unlink: jest.fn(async () => {}),
    };

    try {
      await writeSnapshot({ stories: { 'dev-gui::S-1': 'Done' }, features: {} }, fsDeps);
      expect(calls).toContain('writeFile');
      expect(calls).toContain('rename');
      // rename kommt nach writeFile
      expect(calls.indexOf('rename')).toBeGreaterThan(calls.indexOf('writeFile'));
    } finally {
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      } else {
        delete process.env.CRED_STORE_DIR;
      }
    }
  });

  it('gibt Warnung aus wenn CRED_STORE_DIR nicht gesetzt (kein Crash)', async () => {
    const origCredStoreDir = process.env.CRED_STORE_DIR;
    delete process.env.CRED_STORE_DIR;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let threw = false;
      try {
        await writeSnapshot({ stories: {}, features: {} });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      if (origCredStoreDir !== undefined) {
        process.env.CRED_STORE_DIR = origCredStoreDir;
      }
    }
  });
});

// ── AC8–AC12: SSE-Producer-Naht (board-live-sse S-286) ───────────────────────

describe('AC8–AC12 — SSE-Producer-Naht (board-live-sse)', () => {
  // ── AC8: detectChangedProjects ────────────────────────────────────────────

  describe('AC8 — detectChangedProjects: Projekt-Slugs mit verändertem Abbild', () => {
    it('erkennt Projekt mit geändertem Story-Status', () => {
      const index = makeIndex([
        makeProject({
          slug: 'dev-gui',
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ]);
      const oldSnapshot = { stories: { 'dev-gui::S-1': 'To Do' }, features: {} };

      const changed = detectChangedProjects(index, oldSnapshot);

      expect(changed.has('dev-gui')).toBe(true);
      expect(changed.size).toBe(1);
    });

    it('ignoriert Projekte ohne Veränderung', () => {
      const index = makeIndex([
        makeProject({
          slug: 'dev-gui',
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
      ]);
      const oldSnapshot = { stories: { 'dev-gui::S-1': 'Done' }, features: {} };

      const changed = detectChangedProjects(index, oldSnapshot);

      expect(changed.size).toBe(0);
    });

    it('erkennt Projekt mit hinzugefügter Story', () => {
      const index = makeIndex([
        makeProject({
          slug: 'dev-gui',
          features: [makeFeature({
            stories: [
              makeStory({ id: 'S-1', status: 'To Do' }),
              makeStory({ id: 'S-2', status: 'To Do' }), // neue Story
            ],
          })],
        }),
      ]);
      const oldSnapshot = { stories: { 'dev-gui::S-1': 'To Do' }, features: {} };

      const changed = detectChangedProjects(index, oldSnapshot);

      expect(changed.has('dev-gui')).toBe(true);
    });

    it('erkennt Projekt mit entfernter Story', () => {
      const index = makeIndex([
        makeProject({
          slug: 'dev-gui',
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'To Do' })],
          })],
        }),
      ]);
      // S-2 war im Snapshot, ist jetzt weg
      const oldSnapshot = { stories: {
        'dev-gui::S-1': 'To Do',
        'dev-gui::S-2': 'Done',
      }, features: {} };

      const changed = detectChangedProjects(index, oldSnapshot);

      expect(changed.has('dev-gui')).toBe(true);
    });

    it('behandelt mehrere Projekte korrekt', () => {
      const index = makeIndex([
        makeProject({
          slug: 'dev-gui',
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'Done' })],
          })],
        }),
        makeProject({
          slug: 'agent-flow',
          features: [makeFeature({
            stories: [makeStory({ id: 'S-1', status: 'To Do' })],
          })],
        }),
      ]);
      const oldSnapshot = { stories: {
        'dev-gui::S-1': 'To Do',     // changed
        'agent-flow::S-1': 'To Do',  // unchanged
      }, features: {} };

      const changed = detectChangedProjects(index, oldSnapshot);

      expect(changed.has('dev-gui')).toBe(true);
      expect(changed.has('agent-flow')).toBe(false);
      expect(changed.size).toBe(1);
    });
  });

  // ── AC9: Baseline-Scan löst KEIN SSE-Event aus ──────────────────────────

  describe('AC9 — Baseline-Scan löst KEIN SSE-Event aus', () => {
    it('erster check() broadcastet nichts', async () => {
      const mockBoardAggregator = {
        getIndex: jest.fn(async () =>
          makeIndex([
            makeProject({
              features: [makeFeature({
                stories: [makeStory({ id: 'S-1', status: 'Done' })],
              })],
            }),
          ])
        ),
      };

      const mockHub = { broadcast: jest.fn() };
      const fsDeps = {
        readFile: jest.fn(async () => {
          throw new Error('ENOENT');
        }),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: true,
            events: [],
          })),
          boardEventHub: mockHub,
          fsDeps,
        });

        await watcher.check();

        // Hub sollte NICHT aufgerufen werden (Baseline)
        expect(mockHub.broadcast).toHaveBeenCalledTimes(0);
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });
  });

  // ── AC10: SSE-Invalidierung unabhängig vom ntfy-Gating ──────────────────

  describe('AC10 — SSE-Invalidierung unabhängig vom ntfy-Gating', () => {
    it('broadcastet auch wenn enabled=false', async () => {
      // Setup: Baseline mit To Do; dann geändert zu Done
      const mockBoardAggregator = {
        getIndex: jest
          .fn()
          .mockImplementationOnce(async () =>
            // Erster check(): Baseline-Scan → Index mit To Do
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'To Do' })],
                })],
              }),
            ])
          )
          .mockImplementationOnce(async () =>
            // Zweiter check(): Index mit Done → Change erkannt
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'Done' })],
                })],
              }),
            ])
          ),
      };

      const mockHub = { broadcast: jest.fn() };
      const fsDeps = {
        readFile: jest
          .fn()
          .mockImplementationOnce(async () => {
            // Erster check(): kein Snapshot auf Disk → ENOENT
            throw new Error('ENOENT');
          }),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: false, // ← ntfy disabled
            server: 'https://ntfy.sh',
            topic: 'alerts',
            events: ['story_done'],
          })),
          sendNotificationFn: jest.fn(),
          boardEventHub: mockHub,
          fsDeps,
        });

        // First check to establish baseline
        await watcher.check();
        mockHub.broadcast.mockClear();

        // Second check with change
        await watcher.check();

        // SSE sollte trotzdem gebroadcasted werden (AC10)
        expect(mockHub.broadcast).toHaveBeenCalledTimes(1);
        expect(mockHub.broadcast).toHaveBeenCalledWith({ slug: 'dev-gui' });
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });

    it('SSE-Fehler crasht nicht den check()', async () => {
      const mockBoardAggregator = {
        getIndex: jest
          .fn()
          .mockImplementationOnce(async () =>
            // Erster check(): Baseline-Scan → Index mit To Do
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'To Do' })],
                })],
              }),
            ])
          )
          .mockImplementationOnce(async () =>
            // Zweiter check(): Index mit Done → Change erkannt
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'Done' })],
                })],
              }),
            ])
          ),
      };

      const mockHub = {
        broadcast: jest.fn(() => {
          throw new Error('Broadcast failed');
        }),
      };

      const fsDeps = {
        readFile: jest
          .fn()
          .mockImplementationOnce(async () => {
            // Erster check(): kein Snapshot auf Disk → ENOENT
            throw new Error('ENOENT');
          }),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: true,
            events: [],
          })),
          boardEventHub: mockHub,
          fsDeps,
        });

        // First check to establish baseline
        await watcher.check();
        mockHub.broadcast.mockClear();

        // Second check: SSE wird versucht, aber sollte nicht crashen
        let threw = false;
        try {
          await watcher.check();
        } catch {
          threw = true;
        }

        expect(threw).toBe(false);
        expect(mockHub.broadcast).toHaveBeenCalled();
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });
  });

  // ── AC11: Broadcast läuft auch nach explizitem rescan ──────────────────

  describe('AC11 — Broadcast läuft auch nach explizitem rescan über denselben Codepfad', () => {
    it('check() kann manuell aufgerufen werden (z.B. nach rescan)', async () => {
      const mockBoardAggregator = {
        getIndex: jest
          .fn()
          .mockImplementationOnce(async () =>
            // Erster check(): Baseline-Scan → Index mit To Do
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'To Do' })],
                })],
              }),
            ])
          )
          .mockImplementationOnce(async () =>
            // Zweiter check(): Index mit Done → Change erkannt
            makeIndex([
              makeProject({
                features: [makeFeature({
                  stories: [makeStory({ id: 'S-1', status: 'Done' })],
                })],
              }),
            ])
          ),
      };

      const mockHub = { broadcast: jest.fn() };
      const fsDeps = {
        readFile: jest
          .fn()
          .mockImplementationOnce(async () => {
            // Erster check(): kein Snapshot auf Disk → ENOENT
            throw new Error('ENOENT');
          }),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: true,
            events: [],
          })),
          boardEventHub: mockHub,
          fsDeps,
        });

        // First check to establish baseline
        await watcher.check();
        mockHub.broadcast.mockClear();

        // Manual check() call (simulating rescan)
        await watcher.check();

        expect(mockHub.broadcast).toHaveBeenCalledWith({ slug: 'dev-gui' });
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });
  });

  // ── AC12: boardEventHub optional injiziert ───────────────────────────────

  describe('AC12 — boardEventHub optional injiziert; null-tolerant', () => {
    it('funktioniert ohne boardEventHub (null)', async () => {
      const existingSnapshot = {
        stories: { 'dev-gui::S-1': 'To Do' },
        features: {},
      };

      const mockBoardAggregator = {
        getIndex: jest.fn(async () =>
          makeIndex([
            makeProject({
              features: [makeFeature({
                stories: [makeStory({ id: 'S-1', status: 'Done' })],
              })],
            }),
          ])
        ),
      };

      const fsDeps = {
        readFile: jest.fn(async () => JSON.stringify(existingSnapshot)),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: true,
            events: [],
          })),
          boardEventHub: null, // ← null (AC12)
          fsDeps,
        });

        // First check to establish baseline
        await watcher.check();

        // Second check: sollte nicht crashen, auch ohne Hub
        let threw = false;
        try {
          await watcher.check();
        } catch {
          threw = true;
        }

        expect(threw).toBe(false);
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });

    it('funktioniert ohne boardEventHub (undefined)', async () => {
      const existingSnapshot = {
        stories: { 'dev-gui::S-1': 'To Do' },
        features: {},
      };

      const mockBoardAggregator = {
        getIndex: jest.fn(async () =>
          makeIndex([
            makeProject({
              features: [makeFeature({
                stories: [makeStory({ id: 'S-1', status: 'Done' })],
              })],
            }),
          ])
        ),
      };

      const fsDeps = {
        readFile: jest.fn(async () => JSON.stringify(existingSnapshot)),
        writeFile: jest.fn(async () => {}),
        rename: jest.fn(async () => {}),
        mkdir: jest.fn(async () => {}),
        chmod: jest.fn(async () => {}),
        unlink: jest.fn(async () => {}),
      };

      const origCredStoreDir = process.env.CRED_STORE_DIR;
      process.env.CRED_STORE_DIR = '/tmp';
      try {
        const watcher = new NotificationWatcher({
          boardAggregator: mockBoardAggregator,
          credentialStore: null,
          readNotificationSettings: jest.fn(async () => ({
            enabled: true,
            events: [],
          })),
          // boardEventHub omitted (undefined)
          fsDeps,
        });

        // First check to establish baseline
        await watcher.check();

        // Second check: sollte nicht crashen, auch ohne Hub
        let threw = false;
        try {
          await watcher.check();
        } catch {
          threw = true;
        }

        expect(threw).toBe(false);
      } finally {
        if (origCredStoreDir !== undefined) {
          process.env.CRED_STORE_DIR = origCredStoreDir;
        } else {
          delete process.env.CRED_STORE_DIR;
        }
      }
    });
  });
});
