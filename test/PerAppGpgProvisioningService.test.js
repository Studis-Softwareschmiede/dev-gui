/**
 * PerAppGpgProvisioningService.test.js — Unit-Tests für den Kern-Provisionierungs-
 * Dienst (docs/specs/per-app-gpg-passphrase-provisioning.md, F-073/S-335).
 *
 * Covers (per-app-gpg-passphrase-provisioning.md):
 *   AC1 — kryptografisch starke Zufalls-Passphrase (>= 32 Byte, base64url — kein
 *         Standard-Base64-Zeichen); erscheint nie in Response/Audit.
 *   AC2 — idempotente Item-Anlage: fehlendes Item → genau EIN createItem-Aufruf;
 *         vorhandenes Item → No-Op (`already-exists`), KEIN createItem-Aufruf.
 *   AC3 — Zugang nicht ready → `access-not-ready`, KEIN bw-Aufruf (openSession()
 *         wirft `access-incomplete` VOR jeder Session — kein itemExists/createItem).
 *   AC8 — Response ist geheimnisfrei: nur { result, reason? }, nie die Passphrase.
 *   AC9 — Audit-First: Audit-Eintrag `deploy:gpg-provision:<app>` VOR openSession();
 *         schlägt der Audit-Write fehl → `failed`, kein openSession()-Aufruf.
 *   (Security-Floor) Ungültiger App-Slug → `failed`, kein bw-Aufruf, kein Audit.
 *
 * Strategy: deployLoginService.openSession() wird gemockt und liefert eine
 * Session mit itemExists/createItem/close-Spies — kein echtes `bw`.
 */

import { describe, it, expect, jest } from '@jest/globals';

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
