/**
 * BitwardenDeployLoginService.test.js — Unit-Tests für den unbeaufsichtigten
 * Bitwarden-Login-Dienst (Variante B, API-Key).
 *
 * Covers (docs/specs/deploy-bitwarden-gpg-injection.md):
 *   AC8  — Login via API-Key + Unlock via Master-Passwort; Secrets NUR via Env,
 *          NIE in Argv (harte Assertion über alle Spawn-Aufrufe).
 *   AC9  — readItemPassword liefert das Passwortfeld; fehlend → item-not-found.
 *   AC10 — validateAccess klassifiziert Fehler (access-incomplete/auth-failed/
 *          unlock-failed/bw-unreachable) ohne Rohtext-Leak.
 *   AC11 — openSession erlaubt mehrere Item-Reads in EINEM Login; close() räumt auf.
 *
 * Covers (docs/specs/per-app-gpg-passphrase-provisioning.md, F-073/S-335):
 *   AC1/AC2 — Item-Anlage-Technik der Session (`itemExists`/`createItem`):
 *             Existenz-Check via `bw get item` (kein Passwort-Read nötig);
 *             Anlage via `bw encode` (stdin) + `bw create item` (stdin) — die
 *             Passphrase erscheint NIEMALS im Argv (harte Assertion).
 *
 * Strategy: injizierter _spawnBw-Mock, der je bw-Kommando ein kanonisches Ergebnis
 * liefert und ALLE Aufrufe (args+env+input) mitschneidet — so lässt sich beweisen,
 * dass kein Geheimnis je im Argv landet.
 */

import { describe, it, beforeEach, afterEach, expect } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { BitwardenDeployAccessStore } from '../src/BitwardenDeployAccessStore.js';
import { BitwardenDeployLoginService } from '../src/BitwardenDeployLoginService.js';

const SECRETS = {
  clientId: 'user.abc123',
  clientSecret: 'cs-SUPER-SECRET',
  masterPassword: 'mp-MASTER-SECRET',
  serverUrl: 'https://vault.example.com',
};
const SESSION_TOKEN = 'SESSIONTOKEN0123456789abcdefABCDEF==';

let storeDir;
let prevEnv;

async function readyStore() {
  const store = new BitwardenDeployAccessStore();
  await store.setField('server_url', SECRETS.serverUrl);
  await store.setField('client_id', SECRETS.clientId);
  await store.setField('client_secret', SECRETS.clientSecret);
  await store.setField('master_password', SECRETS.masterPassword);
  return store;
}

/** Erstellt einen bw-Spawn-Mock + Aufzeichnung. `plan` steuert Fehlschläge. */
function makeSpawn(plan = {}) {
  const calls = [];
  const spawn = async (args, { env, input } = {}) => {
    calls.push({ args: [...args], env: { ...env }, input });
    const cmd = args[0];
    if (cmd === 'config') return { stdout: '', stderr: '', exitCode: 0 };
    if (cmd === 'login') {
      if (plan.loginFail) return { stdout: '', stderr: 'Username or API key is incorrect', exitCode: 1 };
      if (plan.network) return { stdout: '', stderr: 'getaddrinfo ENOTFOUND', exitCode: 1 };
      return { stdout: 'You are logged in!', stderr: '', exitCode: 0 };
    }
    if (cmd === 'unlock') {
      if (plan.unlockFail) return { stdout: '', stderr: 'Invalid master password', exitCode: 1 };
      return { stdout: SESSION_TOKEN + '\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'get') {
      const sub = args[1]; // 'password' | 'item'
      const item = args[2];
      if (sub === 'item') {
        // F-073/S-335 AC2: Existenz-Check — plan.existingItems: Set<string> steuert Treffer.
        if (plan.existingItems instanceof Set && plan.existingItems.has(item)) {
          return { stdout: JSON.stringify([{ id: 'fixture-id', name: item }]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'Not found.', exitCode: 1 };
      }
      if (plan.itemNotFound || item === 'deploy-gpg-missing') {
        return { stdout: '', stderr: 'Not found.', exitCode: 1 };
      }
      return { stdout: `passphrase-for-${item}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'encode') {
      if (plan.encodeFail) return { stdout: '', stderr: 'encode failed', exitCode: 1 };
      return { stdout: `ENCODED[${input}]\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'create') {
      if (plan.createFail) return { stdout: '', stderr: 'create failed', exitCode: 1 };
      return { stdout: 'created ok\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'logout') return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  };
  return { spawn, calls };
}

/** Prüft: kein Geheimnis taucht je im Argv (args) irgendeines Aufrufs auf. */
function assertNoSecretInArgv(calls) {
  const secrets = [SECRETS.clientSecret, SECRETS.masterPassword, SESSION_TOKEN];
  for (const call of calls) {
    const argv = call.args.join(' ');
    for (const secret of secrets) {
      expect(argv).not.toContain(secret);
    }
  }
}

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'bw-deploy-login-test-' + randomBytes(6).toString('hex'));
  await mkdir(storeDir, { recursive: true });
  process.env.CRED_STORE_DIR = storeDir;
});
afterEach(async () => {
  if (prevEnv === undefined) delete process.env.CRED_STORE_DIR; else process.env.CRED_STORE_DIR = prevEnv;
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
});

function auditSpy() {
  const calls = [];
  return { record: (e) => calls.push(e), calls };
}

describe('BitwardenDeployLoginService — Login + Secrets-Hygiene (AC8)', () => {
  it('validateAccess: erfolgreicher Probe-Login; Secrets nur via Env, nie in Argv', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn();
    const audit = auditSpy();
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: audit, _spawnBw: spawn });

    const res = await svc.validateAccess({ identity: 'a@b.ch' });
    expect(res).toEqual({ ok: true });

    // AC8: harte Argv-Hygiene
    assertNoSecretInArgv(calls);
    // Secrets kamen via Env
    const login = calls.find((c) => c.args[0] === 'login');
    expect(login.env.BW_CLIENTID).toBe(SECRETS.clientId);
    expect(login.env.BW_CLIENTSECRET).toBe(SECRETS.clientSecret);
    const unlock = calls.find((c) => c.args[0] === 'unlock');
    expect(unlock.env.BW_PASSWORD).toBe(SECRETS.masterPassword);
    // Audit-First (ohne Werte)
    expect(audit.calls).toEqual([{ identity: 'a@b.ch', command: 'deploy-access:validate' }]);
    // Isolierter APPDATA-Dir gesetzt
    expect(login.env.BITWARDENCLI_APPDATA_DIR).toContain('bw-deploy-');
    // Aufräumen: logout wurde gerufen
    expect(calls.some((c) => c.args[0] === 'logout')).toBe(true);
  });

  it('validateAccess: unvollständiger Zugang → access-incomplete (kein bw-Aufruf)', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', SECRETS.clientId); // secret/master fehlen
    const { spawn, calls } = makeSpawn();
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const res = await svc.validateAccess({ identity: null });
    expect(res).toEqual({ ok: false, errorClass: 'access-incomplete' });
    expect(calls.length).toBe(0);
  });

  it('validateAccess: falscher API-Key → auth-failed; falsches Master-PW → unlock-failed; Netz → bw-unreachable', async () => {
    const store = await readyStore();
    const audit = auditSpy();

    let m = makeSpawn({ loginFail: true });
    let svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: audit, _spawnBw: m.spawn });
    expect(await svc.validateAccess({})).toEqual({ ok: false, errorClass: 'auth-failed' });

    m = makeSpawn({ unlockFail: true });
    svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: audit, _spawnBw: m.spawn });
    expect(await svc.validateAccess({})).toEqual({ ok: false, errorClass: 'unlock-failed' });

    m = makeSpawn({ network: true });
    svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: audit, _spawnBw: m.spawn });
    expect(await svc.validateAccess({})).toEqual({ ok: false, errorClass: 'bw-unreachable' });
  });
});

describe('BitwardenDeployLoginService — Item-Read (AC9/AC11)', () => {
  it('fetchItemPassword liefert die Passphrase; Item-Name in Argv, Passphrase nur im Rückgabewert', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn();
    const audit = auditSpy();
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: audit, _spawnBw: spawn });

    const pass = await svc.fetchItemPassword('deploy-gpg-myapp', { identity: 'a@b.ch' });
    expect(pass).toBe('passphrase-for-deploy-gpg-myapp');
    assertNoSecretInArgv(calls);
    // Item-Name darf im Argv stehen (kein Geheimnis)
    const get = calls.find((c) => c.args[0] === 'get');
    expect(get.args).toEqual(['get', 'password', 'deploy-gpg-myapp']);
    expect(get.env.BW_SESSION).toBe(SESSION_TOKEN);
    // Audit hält den Item-Namen, nie die Passphrase
    expect(audit.calls.some((c) => c.command === 'deploy-access:item-read:deploy-gpg-myapp')).toBe(true);
    expect(JSON.stringify(audit.calls)).not.toContain('passphrase-for');
  });

  it('fehlendes Item → item-not-found', async () => {
    const store = await readyStore();
    const { spawn } = makeSpawn({ itemNotFound: true });
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });
    await expect(svc.fetchItemPassword('deploy-gpg-x', {})).rejects.toMatchObject({ deployErrorClass: 'item-not-found' });
  });

  it('openSession erlaubt mehrere Reads in EINEM Login (AC11)', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn();
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    const p1 = await session.readItemPassword('deploy-gpg-a');
    const p2 = await session.readItemPassword('deploy-gpg-b');
    await session.close();

    expect(p1).toBe('passphrase-for-deploy-gpg-a');
    expect(p2).toBe('passphrase-for-deploy-gpg-b');
    // nur EIN login/unlock für beide Reads
    expect(calls.filter((c) => c.args[0] === 'login').length).toBe(1);
    expect(calls.filter((c) => c.args[0] === 'unlock').length).toBe(1);
    expect(calls.filter((c) => c.args[0] === 'get').length).toBe(2);
  });
});

describe('BitwardenDeployLoginService — Session-Item-Anlage (F-073/S-335 AC1/AC2)', () => {
  it('itemExists: vorhandenes Item → true; kein zweiter Passwort-Read nötig', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn({ existingItems: new Set(['env.gpg-passphrase-myapp']) });
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    const exists = await session.itemExists('env.gpg-passphrase-myapp');
    await session.close();

    expect(exists).toBe(true);
    const getCall = calls.find((c) => c.args[0] === 'get');
    expect(getCall.args).toEqual(['get', 'item', 'env.gpg-passphrase-myapp']);
  });

  it('itemExists: fehlendes Item → false, kein create-Aufruf ausgelöst', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn({ existingItems: new Set() });
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    const exists = await session.itemExists('env.gpg-passphrase-neu');
    await session.close();

    expect(exists).toBe(false);
    expect(calls.some((c) => c.args[0] === 'create')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'encode')).toBe(false);
  });

  it('createItem: encode (stdin) + create item (stdin) — Passphrase NIEMALS in Argv', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn();
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });
    const passphrase = 'SUPER-SECRET-PASSPHRASE-VALUE';

    const session = await svc.openSession({});
    await session.createItem('env.gpg-passphrase-myapp', passphrase);
    await session.close();

    const encodeCall = calls.find((c) => c.args[0] === 'encode');
    const createCall = calls.find((c) => c.args[0] === 'create');
    expect(encodeCall).toBeDefined();
    expect(createCall).toBeDefined();
    expect(createCall.args).toEqual(['create', 'item']);
    // Passphrase geht nur via stdin (input), nie über args (Argv)
    expect(encodeCall.input).toContain(passphrase);
    expect(encodeCall.input).toContain('env.gpg-passphrase-myapp');
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(passphrase);
    }
  });

  it('createItem: bw encode fehlgeschlagen → item-create-failed, kein create-Aufruf', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeSpawn({ encodeFail: true });
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await expect(session.createItem('env.gpg-passphrase-x', 'p')).rejects.toMatchObject({ deployErrorClass: 'item-create-failed' });
    await session.close();

    expect(calls.some((c) => c.args[0] === 'create')).toBe(false);
  });

  it('createItem: bw create item fehlgeschlagen → item-create-failed', async () => {
    const store = await readyStore();
    const { spawn } = makeSpawn({ createFail: true });
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await expect(session.createItem('env.gpg-passphrase-x', 'p')).rejects.toMatchObject({ deployErrorClass: 'item-create-failed' });
    await session.close();
  });
});
