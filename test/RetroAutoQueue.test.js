/**
 * @file RetroAutoQueue.test.js — Unit-Tests der seriellen Auto-Retro-Warteschlange
 * (docs/specs/retro-auto-queue.md, Kern-Anteil S-256).
 *
 * Covers (retro-auto-queue): AC1, AC2, AC3, AC4
 *
 *   AC1 — `enqueue(projectPath)` reiht ein und startet die Abarbeitung, falls idle;
 *         global genau **ein** aktiver Lauf (nie zwei gleichzeitig); mehrere
 *         `enqueue` verschiedener Repos → FIFO-Reihenfolge, strikt nacheinander.
 *   AC2 — Dedup: `enqueue` eines bereits pending/aktiven Repos ist idempotent
 *         (kein zweiter Eintrag, kein zweiter Lauf); `isPendingOrActive` spiegelt
 *         den Zustand korrekt.
 *   AC3 — Fehlschlag (Runner-Rejection) stoppt die Queue **nicht**: die Degradation
 *         wird **secret-frei** auditiert (Repo-Slug, KEIN absoluter Host-Pfad), der
 *         Worker fährt mit dem nächsten Repo fort; Audit ist best-effort (ein
 *         Audit-Fehler crasht den Worker nicht).
 *         Hinweis (coder/R05): die Klausel „`ProjectJobLock` im `finally` frei" liegt
 *         im injizierten Runner (S-257, AC5) und ist mit gemocktem Runner hier NICHT
 *         separat prüfbar — die Queue-Seite (weiter trotz Fehlschlag) ist abgedeckt.
 *   AC4 — `getStatus()` liefert `{ active, pending }` als read-only Snapshot ohne
 *         Seiteneffekte; `pending` ist eine Kopie (kein Alias auf den internen State).
 *
 * Kein echter `claude -p`-Lauf: der `retroRunner` ist ein kontrollierbarer Stub
 * (Nicht-Ziel der Spec: kein Live-Lauf im Test-Gate).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { RetroAutoQueue, repoSlug } from '../src/RetroAutoQueue.js';

/** Flush aller pending Microtasks/Immediates (Worker-Fortschritt abwarten). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Kontrollierbarer Fake-Runner: `run(projectPath)` gibt ein Promise zurück, das
 * der Test manuell resolved/rejected. Zeichnet die Aufruf-Reihenfolge auf und
 * misst die **maximale gleichzeitige** In-Flight-Zahl (Serialisierungs-Beweis).
 */
function makeControlledRunner() {
  const calls = [];
  const deferreds = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const runner = {
    calls,
    getMaxInFlight: () => maxInFlight,
    run(projectPath) {
      calls.push(projectPath);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let resolveFn;
      let rejectFn;
      const p = new Promise((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      const settle = (fn) => (arg) => {
        inFlight -= 1;
        fn(arg);
      };
      deferreds.push({ resolve: settle(resolveFn), reject: settle(rejectFn) });
      return p;
    },
  };
  return { runner, deferreds, calls };
}

/** Runner, der SOFORT (resolved) fertig ist — für Reihenfolge-/Fertig-Tests. */
function makeImmediateRunner() {
  const calls = [];
  return {
    calls,
    run: jest.fn(async (projectPath) => {
      calls.push(projectPath);
    }),
  };
}

describe('RetroAutoQueue — Konstruktor-Guard', () => {
  it('wirft ohne retroRunner mit run()', () => {
    expect(() => new RetroAutoQueue({})).toThrow(/retroRunner/);
    expect(() => new RetroAutoQueue({ retroRunner: {} })).toThrow(/retroRunner/);
    expect(() => new RetroAutoQueue({ retroRunner: { run: 'x' } })).toThrow(/retroRunner/);
  });

  it('akzeptiert einen validen retroRunner', () => {
    expect(() => new RetroAutoQueue({ retroRunner: { run: async () => {} } })).not.toThrow();
  });
});

describe('AC1 — serielle FIFO-Abarbeitung, global genau ein aktiver Lauf', () => {
  it('enqueue startet den Lauf sofort, wenn idle', async () => {
    const { runner, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    await flush();

    expect(calls).toEqual(['/repos/a']);
    expect(q.getStatus().active).toBe('/repos/a');
  });

  it('startet NICHT einen zweiten Lauf, solange der erste aktiv ist', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    q.enqueue('/repos/b');
    await flush();

    // Nur A läuft; B wartet in der FIFO.
    expect(calls).toEqual(['/repos/a']);
    expect(q.getStatus()).toEqual({ active: '/repos/a', pending: ['/repos/b'] });

    // A fertig → B wird gezogen.
    deferreds[0].resolve();
    await flush();
    expect(calls).toEqual(['/repos/a', '/repos/b']);
    expect(q.getStatus()).toEqual({ active: '/repos/b', pending: [] });

    deferreds[1].resolve();
    await flush();
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
  });

  it('arbeitet mehrere Repos strikt nacheinander (FIFO) ab — nie zwei gleichzeitig aktiv', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    q.enqueue('/repos/b');
    q.enqueue('/repos/c');
    await flush();

    // Jeweils genau einen Lauf auf einmal terminieren.
    deferreds[0].resolve();
    await flush();
    deferreds[1].resolve();
    await flush();
    deferreds[2].resolve();
    await flush();

    expect(calls).toEqual(['/repos/a', '/repos/b', '/repos/c']);
    // Kern-NFR: zu keinem Zeitpunkt lief mehr als EIN Lauf gleichzeitig.
    expect(runner.getMaxInFlight()).toBe(1);
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
  });

  it('enqueue während aktivem Lauf hängt das Repo hinten an (FIFO)', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    await flush();
    q.enqueue('/repos/b');
    q.enqueue('/repos/c');
    expect(q.getStatus()).toEqual({ active: '/repos/a', pending: ['/repos/b', '/repos/c'] });

    deferreds[0].resolve();
    await flush();
    deferreds[1].resolve();
    await flush();
    deferreds[2].resolve();
    await flush();

    expect(calls).toEqual(['/repos/a', '/repos/b', '/repos/c']);
  });
});

describe('AC2 — Dedup pro Repo (idempotent) + isPendingOrActive', () => {
  it('reiht ein bereits pending Repo nicht doppelt ein', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a'); // wird aktiv
    q.enqueue('/repos/b'); // pending
    q.enqueue('/repos/b'); // Dedup — no-op
    q.enqueue('/repos/b'); // Dedup — no-op
    await flush();

    expect(q.getStatus()).toEqual({ active: '/repos/a', pending: ['/repos/b'] });

    deferreds[0].resolve();
    await flush();
    deferreds[1].resolve();
    await flush();

    // B lief genau EINMAL (kein zweiter Lauf trotz Mehrfach-enqueue).
    expect(calls).toEqual(['/repos/a', '/repos/b']);
  });

  it('reiht das gerade aktive Repo nicht erneut ein', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a'); // aktiv
    await flush();
    q.enqueue('/repos/a'); // aktiv → Dedup, kein pending
    await flush();

    expect(q.getStatus()).toEqual({ active: '/repos/a', pending: [] });
    expect(calls).toEqual(['/repos/a']);

    deferreds[0].resolve();
    await flush();
    expect(calls).toEqual(['/repos/a']);
  });

  it('isPendingOrActive spiegelt aktiv/pending/unbekannt korrekt', async () => {
    const { runner } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    expect(q.isPendingOrActive('/repos/a')).toBe(false);

    q.enqueue('/repos/a'); // aktiv
    q.enqueue('/repos/b'); // pending
    await flush();

    expect(q.isPendingOrActive('/repos/a')).toBe(true);
    expect(q.isPendingOrActive('/repos/b')).toBe(true);
    expect(q.isPendingOrActive('/repos/c')).toBe(false);
    expect(q.isPendingOrActive('')).toBe(false);
    expect(q.isPendingOrActive(undefined)).toBe(false);
  });

  it('nach Abschluss ist ein Repo wieder einreihbar', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    await flush();
    deferreds[0].resolve();
    await flush();

    expect(q.isPendingOrActive('/repos/a')).toBe(false);

    q.enqueue('/repos/a'); // erneut
    await flush();
    deferreds[1].resolve();
    await flush();

    expect(calls).toEqual(['/repos/a', '/repos/a']);
  });

  it('enqueue wirft bei ungültigem (nicht-String/leer) Input', () => {
    const { runner } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });
    expect(() => q.enqueue('')).toThrow(/nicht-leeren String/);
    expect(() => q.enqueue('   ')).toThrow(/nicht-leeren String/);
    expect(() => q.enqueue(undefined)).toThrow(/nicht-leeren String/);
    expect(() => q.enqueue(42)).toThrow(/nicht-leeren String/);
  });
});

describe('AC3 — Fehlschlag stoppt die Queue nicht (Degradation), secret-frei auditiert', () => {
  it('ein fehlgeschlagener Lauf (Rejection) blockiert die Queue nicht — nächstes Repo folgt', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    q.enqueue('/repos/b');
    await flush();

    deferreds[0].reject(new Error('timeout')); // A scheitert
    await flush();

    expect(calls).toEqual(['/repos/a', '/repos/b']); // B lief trotzdem
    expect(q.getStatus().active).toBe('/repos/b');

    deferreds[1].resolve();
    await flush();
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
  });

  it('mehrere aufeinanderfolgende Fehlschläge kippen die Queue nicht', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    q.enqueue('/repos/b');
    q.enqueue('/repos/c');
    await flush();

    deferreds[0].reject(new Error('non-zero exit'));
    await flush();
    deferreds[1].reject(new Error('auth-expired'));
    await flush();
    deferreds[2].reject(new Error('spawn ENOENT'));
    await flush();

    expect(calls).toEqual(['/repos/a', '/repos/b', '/repos/c']);
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
  });

  it('auditiert den Fehlschlag secret-frei (Repo-Slug, KEIN absoluter Host-Pfad)', async () => {
    const { runner, deferreds } = makeControlledRunner();
    const auditStore = { record: jest.fn() };
    const q = new RetroAutoQueue({ retroRunner: runner, auditStore, identity: 'ops@example.com' });

    q.enqueue('/Users/secret/host/path/my-project');
    await flush();
    deferreds[0].reject(new Error('boom with /Users/secret/host/path/my-project inside'));
    await flush();

    expect(auditStore.record).toHaveBeenCalledTimes(1);
    const entry = auditStore.record.mock.calls[0][0];
    expect(entry.identity).toBe('ops@example.com');
    expect(entry.command).toContain('run-failed');
    expect(entry.command).toContain('my-project'); // nur der Slug
    // KEIN absoluter Host-Pfad und KEINE Fehler-Rohdaten im Audit-Kommando.
    expect(entry.command).not.toContain('/Users/secret');
    expect(entry.command).not.toContain('boom');
  });

  it('auditiert NICHT bei erfolgreichem Lauf (nur Degradation wird auditiert)', async () => {
    const { runner, deferreds } = makeControlledRunner();
    const auditStore = { record: jest.fn() };
    const q = new RetroAutoQueue({ retroRunner: runner, auditStore });

    q.enqueue('/repos/a');
    await flush();
    deferreds[0].resolve();
    await flush();

    expect(auditStore.record).not.toHaveBeenCalled();
  });

  it('Audit ist best-effort: ein Audit-Fehler crasht den Worker nicht', async () => {
    const { runner, deferreds, calls } = makeControlledRunner();
    const auditStore = {
      record: jest.fn(() => {
        throw new Error('audit backend down');
      }),
    };
    const q = new RetroAutoQueue({ retroRunner: runner, auditStore });

    q.enqueue('/repos/a');
    q.enqueue('/repos/b');
    await flush();
    deferreds[0].reject(new Error('fail')); // A scheitert, Audit wirft
    await flush();

    // Worker lief weiter trotz Audit-Fehler.
    expect(calls).toEqual(['/repos/a', '/repos/b']);
    deferreds[1].resolve();
    await flush();
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
  });

  it('Identity default null, wenn nicht injiziert', async () => {
    const { runner, deferreds } = makeControlledRunner();
    const auditStore = { record: jest.fn() };
    const q = new RetroAutoQueue({ retroRunner: runner, auditStore });

    q.enqueue('/repos/a');
    await flush();
    deferreds[0].reject(new Error('x'));
    await flush();

    expect(auditStore.record.mock.calls[0][0].identity).toBeNull();
  });
});

describe('AC4 — getStatus read-only Snapshot ohne Seiteneffekte', () => {
  it('liefert initial { active: null, pending: [] }', () => {
    const runner = makeImmediateRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });
    expect(q.getStatus()).toEqual({ active: null, pending: [] });
    // Kein Seiteneffekt: getStatus stößt keinen Lauf an.
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('gibt eine Kopie von pending zurück (kein Alias auf den internen State)', async () => {
    const { runner } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a'); // aktiv
    q.enqueue('/repos/b'); // pending
    await flush();

    const snap = q.getStatus();
    snap.pending.push('/repos/injected'); // Mutation der Kopie
    // Interner State bleibt unberührt.
    expect(q.getStatus().pending).toEqual(['/repos/b']);
  });

  it('mehrfaches getStatus verändert den Zustand nicht', async () => {
    const { runner } = makeControlledRunner();
    const q = new RetroAutoQueue({ retroRunner: runner });

    q.enqueue('/repos/a');
    await flush();
    const a = q.getStatus();
    const b = q.getStatus();
    expect(a).toEqual(b);
    expect(a).toEqual({ active: '/repos/a', pending: [] });
  });
});

describe('repoSlug — secret-freier Basename', () => {
  it('reduziert einen absoluten Host-Pfad auf den Basename', () => {
    expect(repoSlug('/Users/alex/Git/foo-bar')).toBe('foo-bar');
  });

  it('lässt einen einfachen Slug unverändert', () => {
    expect(repoSlug('my-project')).toBe('my-project');
  });

  it('fällt bei ungültigem Input auf "unknown" zurück', () => {
    expect(repoSlug('')).toBe('unknown');
    expect(repoSlug(undefined)).toBe('unknown');
    expect(repoSlug(42)).toBe('unknown');
  });

  it('strippt unsichere Zeichen', () => {
    expect(repoSlug('re$po;rm -rf')).not.toMatch(/[^a-zA-Z0-9._-]/);
  });
});
