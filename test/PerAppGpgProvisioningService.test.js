/**
 * PerAppGpgProvisioningService.test.js — Unit-Tests für den Kern-Provisionierungs-
 * Dienst (docs/specs/per-app-gpg-passphrase-provisioning.md, F-073/S-335/S-336;
 * ADR-021 in docs/architecture.md).
 *
 * Covers (per-app-gpg-passphrase-provisioning.md):
 *   AC1 — kryptografisch starke Zufalls-Passphrase (>= 32 Byte, base64url — kein
 *         Standard-Base64-Zeichen); erscheint nie in Response/Audit.
 *   AC2 — idempotente Item-Anlage: fehlendes Item → genau EIN createItem-Aufruf;
 *         vorhandenes Item → No-Op (`already-exists`), KEIN createItem-Aufruf.
 *   AC3 — Zugang nicht ready → `access-not-ready`, KEIN bw-Aufruf (openSession()
 *         wirft `access-incomplete` VOR jeder Session — kein itemExists/createItem).
 *   AC4 (S-336) — `withScaffoldPassphrase(app, fn)`: Scaffold-Erfolg → genau EIN
 *         `createItem`-Aufruf (`created`); Scaffold-Fehlschlag (`fn()` rejected)
 *         → `failed`, KEIN `createItem`-Aufruf (kein Teil-Zustand).
 *   AC5 (S-336) — die Passphrase wird `fn({ gpgPassFilePath })` über eine
 *         TEMPORÄRE `0600`-Datei gereicht (nicht Argv); die Datei existiert
 *         WÄHREND `fn()` läuft und ist danach — AUCH bei Scaffold-Fehlschlag —
 *         garantiert entfernt (`finally`, kein verwaistes Klartext-Artefakt).
 *   AC6 (S-336) — dieselbe (in `withScaffoldPassphrase` erzeugte) Passphrase
 *         steht in der `GPG_PASS_FILE`-Datei UND wird an `createItem` gereicht
 *         (Wert-Identität, kein Delegieren an `provision()`s eigene Generierung).
 *   AC8 — Response ist geheimnisfrei: nur { result, reason? }, nie die Passphrase.
 *   AC9 — Audit-First: Audit-Eintrag `deploy:gpg-provision:<app>` VOR openSession();
 *         schlägt der Audit-Write fehl → `failed`, kein openSession()-Aufruf.
 *   (Security-Floor) Ungültiger App-Slug → `failed`, kein bw-Aufruf, kein Audit.
 *   (Edge-Cases, ADR-021) Zugang unready / Slug-Kollision bei Vor-Prüfung →
 *         `fn({})` (Plugin-Fallback-Scaffold OHNE `gpgPassFilePath`), KEINE
 *         Datei, KEIN Item.
 *
 * Covers (per-app-gpg-passphrase-provisioning.md, v3, S-373):
 *   AC16 — `itemExistsFor(app, opts)`: read-only Existenz-Abfrage über
 *         denselben `itemExists`-Pfad (bw get); vorhandenes Item → `exists:true`;
 *         fehlendes Item → `exists:false`; mutiert nichts (KEIN createItem-
 *         Aufruf); Zugang nicht ready / anderer bw-Fehler → `exists:false,
 *         reason:'access-not-ready'` (kein Raten); ungültiger Slug → `exists:false`,
 *         kein bw-Aufruf; Response enthält nie einen Passphrasen-Wert.
 *
 * Strategy: deployLoginService.openSession() wird gemockt und liefert eine
 * Session mit itemExists/createItem/close-Spies — kein echtes `bw`. Für
 * `withScaffoldPassphrase` wird zusätzlich `fsDeps` (mkdtemp/writeFile/chmod/rm)
 * injiziert, um die Existenz/Löschung der temp-Datei real (echtes `os.tmpdir()`-
 * Verzeichnis) zu verifizieren — kein reiner Mock-Stub ohne FS-Berührung.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFile, stat } from 'node:fs/promises';

import { PerAppGpgProvisioningService, gpgItemNameFor } from '../src/PerAppGpgProvisioningService.js';

function auditSpy(shouldThrow = false) {
  const calls = [];
  return {
    record: (e) => {
      if (shouldThrow) throw new Error('audit write failed');
      calls.push(e);
    },
    calls,
  };
}

function makeSession({ exists = false, createFails = false } = {}) {
  const calls = { itemExists: [], createItem: [], close: 0 };
  const session = {
    itemExists: jest.fn(async (name) => {
      calls.itemExists.push(name);
      return exists;
    }),
    createItem: jest.fn(async (name, pass) => {
      calls.createItem.push({ name, pass });
      if (createFails) {
        const err = new Error('bw create item fehlgeschlagen');
        err.deployErrorClass = 'item-create-failed';
        throw err;
      }
    }),
    close: jest.fn(async () => {
      calls.close += 1;
    }),
  };
  return { session, calls };
}

describe('PerAppGpgProvisioningService — Item-Namens-Konvention', () => {
  it('gpgItemNameFor(app) liefert env.gpg-passphrase-<app>', () => {
    expect(gpgItemNameFor('myapp')).toBe('env.gpg-passphrase-myapp');
  });
});

describe('PerAppGpgProvisioningService — AC1/AC2 (Anlage, Idempotenz)', () => {
  it('fehlendes Item → created, genau EIN createItem-Aufruf mit generierter Passphrase (AC1, >= 32 Byte, base64url)', async () => {
    const { session, calls } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const audit = auditSpy();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: audit });

    const result = await svc.provision('myapp', { identity: 'a@b.ch' });

    expect(result).toEqual({ result: 'created' });
    expect(calls.itemExists).toEqual(['env.gpg-passphrase-myapp']);
    expect(calls.createItem.length).toBe(1);
    expect(calls.createItem[0].name).toBe('env.gpg-passphrase-myapp');

    // AC1: >= 32 Byte Entropie (base64url von 32 Byte ≈ 43 Zeichen), url-/shell-sicher
    const passphrase = calls.createItem[0].pass;
    expect(typeof passphrase).toBe('string');
    expect(passphrase.length).toBeGreaterThanOrEqual(40);
    expect(passphrase).not.toMatch(/[+/=]/); // base64url statt Standard-Base64

    expect(calls.close).toBe(1);

    // AC8: Passphrase erscheint nirgends in Response/Audit
    expect(JSON.stringify(result)).not.toContain(passphrase);
    expect(JSON.stringify(audit.calls)).not.toContain(passphrase);
  });

  it('vorhandenes Item → already-exists (No-Op), KEIN createItem-Aufruf, kein Überschreiben', async () => {
    const { session, calls } = makeSession({ exists: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.provision('myapp', {});

    expect(result.result).toBe('already-exists');
    expect(calls.createItem.length).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('bw-Fehler bei createItem → failed; Session wird trotzdem geschlossen (kein verwaistes Handle)', async () => {
    const { session, calls } = makeSession({ exists: false, createFails: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.provision('myapp', {});

    expect(result.result).toBe('failed');
    expect(calls.close).toBe(1);
  });
});

describe('PerAppGpgProvisioningService — AC3 (Zugang-Gate)', () => {
  it('Zugang nicht ready → access-not-ready, KEIN itemExists/createItem-Aufruf', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.provision('myapp', {});

    expect(result.result).toBe('access-not-ready');
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('anderer Login-Fehler (z.B. bw-unreachable) → failed', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('bw nicht erreichbar');
      err.deployErrorClass = 'bw-unreachable';
      throw err;
    });
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.provision('myapp', {});
    expect(result.result).toBe('failed');
  });
});

describe('PerAppGpgProvisioningService — AC9 (Audit-First)', () => {
  it('Audit-Write fehlgeschlagen → failed, KEIN openSession()-Aufruf (Aktion unterbleibt)', async () => {
    const { session } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const audit = auditSpy(true);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: audit });

    const result = await svc.provision('myapp', {});

    expect(result.result).toBe('failed');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('Audit-Eintrag deploy:gpg-provision:<app> — ohne Werte, VOR Session-Öffnung', async () => {
    const order = [];
    const { session } = makeSession({ exists: false });
    const openSession = jest.fn(async () => {
      order.push('openSession');
      return session;
    });
    const audit = { record: (e) => order.push(`audit:${e.command}`) };
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: audit });

    await svc.provision('myapp', { identity: 'a@b.ch' });

    expect(order[0]).toBe('audit:deploy:gpg-provision:myapp');
    expect(order[1]).toBe('openSession');
  });
});

describe('PerAppGpgProvisioningService — Input-Validierung (Security-Floor)', () => {
  it('ungültiger App-Slug → failed, kein Audit, kein openSession()-Aufruf', async () => {
    const openSession = jest.fn();
    const auditRecord = jest.fn();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: { record: auditRecord } });

    const result = await svc.provision('inv@lid slug', {});

    expect(result.result).toBe('failed');
    expect(openSession).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('leerer/fehlender App-Slug → failed', async () => {
    const openSession = jest.fn();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    expect((await svc.provision('', {})).result).toBe('failed');
    expect((await svc.provision(undefined, {})).result).toBe('failed');
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe('PerAppGpgProvisioningService — Konstruktor-Guards', () => {
  it('wirft ohne deployLoginService', () => {
    expect(() => new PerAppGpgProvisioningService({ auditStore: auditSpy() })).toThrow();
  });

  it('wirft ohne auditStore', () => {
    expect(() => new PerAppGpgProvisioningService({ deployLoginService: { openSession: async () => {} } })).toThrow();
  });
});

describe('PerAppGpgProvisioningService — withScaffoldPassphrase() — AC4/AC5/AC6 (S-336)', () => {
  it('Scaffold-Erfolg → created; GPG_PASS_FILE existiert WÄHREND fn() (0600), ist DANACH entfernt; createItem bekommt DIESELBE Passphrase (AC5/AC6)', async () => {
    const { session, calls } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const audit = auditSpy();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: audit });

    let observedPath;
    let observedContentDuringRun;
    const fn = jest.fn(async ({ gpgPassFilePath }) => {
      observedPath = gpgPassFilePath;
      expect(typeof gpgPassFilePath).toBe('string');
      observedContentDuringRun = await readFile(gpgPassFilePath, 'utf8');
      const st = await stat(gpgPassFilePath);
      // AC5: 0600 (nur Owner lesbar/schreibbar).
      expect(st.mode & 0o777).toBe(0o600);
    });

    const result = await svc.withScaffoldPassphrase('myapp', fn, { identity: 'a@b.ch' });

    expect(result).toEqual({ result: 'created' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.createItem.length).toBe(1);
    expect(calls.createItem[0].name).toBe('env.gpg-passphrase-myapp');

    // AC6: dieselbe Passphrase in Datei UND createItem.
    expect(calls.createItem[0].pass).toBe(observedContentDuringRun);
    expect(observedContentDuringRun.length).toBeGreaterThanOrEqual(40); // AC1: >= 32 Byte base64url
    expect(observedContentDuringRun).not.toMatch(/[+/=]/);

    // AC5: Datei ist NACH dem Lauf garantiert entfernt (kein verwaistes Klartext-Artefakt).
    await expect(stat(observedPath)).rejects.toThrow();

    // Passphrase erscheint nirgends im Response/Audit (AC8).
    expect(JSON.stringify(result)).not.toContain(observedContentDuringRun);
    expect(JSON.stringify(audit.calls)).not.toContain(observedContentDuringRun);
  });

  it('Scaffold-Fehlschlag (fn() rejected) → failed, KEIN createItem-Aufruf; temp-Datei TROTZDEM entfernt (AC5 Fehlerpfad)', async () => {
    const { session, calls } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    let observedPath;
    const fn = jest.fn(async ({ gpgPassFilePath }) => {
      observedPath = gpgPassFilePath;
      // Zum Zeitpunkt des Scaffold-Fehlschlags existiert die Datei noch.
      await expect(stat(gpgPassFilePath)).resolves.toBeDefined();
      throw new Error('scaffold boom');
    });

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('failed');
    expect(calls.createItem.length).toBe(0);
    await expect(stat(observedPath)).rejects.toThrow();
  });

  it('bw-Fehler bei createItem NACH Scaffold-Erfolg → failed; temp-Datei trotzdem entfernt (kein Teil-Zustand)', async () => {
    const { session } = makeSession({ exists: false, createFails: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    let observedPath;
    const fn = jest.fn(async ({ gpgPassFilePath }) => {
      observedPath = gpgPassFilePath;
    });

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('failed');
    await expect(stat(observedPath)).rejects.toThrow();
  });

  it('AC4: genau EIN Provisionierungs-Aufruf pro Scaffold-Erfolg (ein einziger createItem-Call)', async () => {
    const { session, calls } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });
    const fn = jest.fn(async () => {});

    await svc.withScaffoldPassphrase('myapp', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.createItem.length).toBe(1);
  });

  it('Item existiert bereits (Slug-Kollision bei Vor-Prüfung) → already-exists; fn({}) OHNE gpgPassFilePath, KEIN createItem, kein Überschreiben', async () => {
    const { session, calls } = makeSession({ exists: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const fn = jest.fn(async (args) => {
      expect(args).toEqual({});
    });

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('already-exists');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.createItem.length).toBe(0);
  });

  it('Zugang nicht ready (Vor-Prüfung) → access-not-ready; fn({}) OHNE gpgPassFilePath (Plugin-Fallback), KEIN itemExists/createItem', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const fn = jest.fn(async (args) => {
      expect(args).toEqual({});
    });

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('access-not-ready');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('Zugang wird ZWISCHEN Vor-Prüfung und Item-Anlage unready → access-not-ready (Scaffold bereits erfolgreich, kein Teil-Zustand behauptet)', async () => {
    const { session: preSession } = makeSession({ exists: false });
    let callCount = 0;
    const openSession = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) return preSession;
      const err = new Error('unready inzwischen');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });
    const fn = jest.fn(async () => {});

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('access-not-ready');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it('ungültiger App-Slug → failed, fn() wird NICHT aufgerufen, kein bw-Aufruf', async () => {
    const openSession = jest.fn();
    const fn = jest.fn();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.withScaffoldPassphrase('inv@lid slug', fn);

    expect(result.result).toBe('failed');
    expect(fn).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it('Audit-Write fehlgeschlagen → failed, fn() wird NICHT aufgerufen (kein Scaffold ohne Audit-Beleg)', async () => {
    const openSession = jest.fn();
    const fn = jest.fn();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy(true) });

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('failed');
    expect(fn).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it('fn ist Pflicht — ohne Scaffold-Aufrufer → failed (interner Vertragsfehler, kein Crash)', async () => {
    const svc = new PerAppGpgProvisioningService({
      deployLoginService: { openSession: jest.fn() },
      auditStore: auditSpy(),
    });

    const result = await svc.withScaffoldPassphrase('myapp', undefined);

    expect(result.result).toBe('failed');
  });

  it('Temp-Datei kann nicht angelegt werden (mkdtemp-Fehler) → failed, fn() wird NICHT aufgerufen', async () => {
    const { session } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const fsDeps = { mkdtemp: jest.fn(async () => { throw new Error('disk full'); }) };
    const svc = new PerAppGpgProvisioningService({
      deployLoginService: { openSession },
      auditStore: auditSpy(),
      fsDeps,
    });
    const fn = jest.fn();

    const result = await svc.withScaffoldPassphrase('myapp', fn);

    expect(result.result).toBe('failed');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('PerAppGpgProvisioningService — itemExistsFor() — AC16 (v3, S-373)', () => {
  it('vorhandenes Item → { exists: true }, KEIN createItem-Aufruf (read-only)', async () => {
    const { session, calls } = makeSession({ exists: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('myapp', { identity: 'a@b.ch' });

    expect(result).toEqual({ exists: true });
    expect(calls.itemExists).toEqual(['env.gpg-passphrase-myapp']);
    expect(calls.createItem.length).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('fehlendes Item → { exists: false }, KEIN createItem-Aufruf', async () => {
    const { session, calls } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('myapp', {});

    expect(result).toEqual({ exists: false });
    expect(calls.createItem.length).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('Zugang nicht ready → { exists: false, reason: "access-not-ready" }, KEIN itemExists-Aufruf', async () => {
    const openSession = jest.fn(async () => {
      const err = new Error('Deploy-Zugang unvollständig');
      err.deployErrorClass = 'access-incomplete';
      throw err;
    });
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('myapp', {});

    expect(result).toEqual({ exists: false, reason: 'access-not-ready' });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('anderer bw-Fehler bei itemExists → { exists: false, reason: "access-not-ready" } (kein Raten), Session wird geschlossen', async () => {
    const session = {
      itemExists: jest.fn(async () => {
        const err = new Error('bw nicht erreichbar');
        err.deployErrorClass = 'bw-unreachable';
        throw err;
      }),
      close: jest.fn(async () => {}),
    };
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('myapp', {});

    expect(result).toEqual({ exists: false, reason: 'access-not-ready' });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('ungültiger App-Slug → { exists: false }, kein openSession()-Aufruf', async () => {
    const openSession = jest.fn();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('inv@lid slug', {});

    expect(result).toEqual({ exists: false });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('KEIN Audit-Eintrag (read-only, kein Audit-First-Zwang)', async () => {
    const { session } = makeSession({ exists: false });
    const openSession = jest.fn(async () => session);
    const audit = auditSpy();
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: audit });

    await svc.itemExistsFor('myapp', { identity: 'a@b.ch' });

    expect(audit.calls.length).toBe(0);
  });

  it('AC8-Analogie: Response enthält nie einen Passphrasen-artigen Wert (nur exists/reason)', async () => {
    const { session } = makeSession({ exists: true });
    const openSession = jest.fn(async () => session);
    const svc = new PerAppGpgProvisioningService({ deployLoginService: { openSession }, auditStore: auditSpy() });

    const result = await svc.itemExistsFor('myapp', {});

    expect(Object.keys(result).sort()).toEqual(['exists']);
  });
});
