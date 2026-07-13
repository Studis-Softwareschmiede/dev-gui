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
 * Covers (docs/specs/per-app-gpg-passphrase-rotation.md, F-073/S-338):
 *   AC1  — `readItemFields`/`updateItemFields`: liest aktives Passwortfeld +
 *          Custom-Felder `naechste`/`vorherige`; schreibt sie get-modify-encode-
 *          edit über `bw get item` → JSON mutieren → `bw encode` (stdin) →
 *          `bw edit item <id>` (stdin) — Werte NIEMALS im Argv.
 *   AC5/AC13 — `updateItemFields(name, { <feld>: null })` entfernt ein Custom-Feld
 *          (Rollback/manuelle Entsorgung); unbeteiligte Felder bleiben unverändert
 *          (voller Read-Modify-Write, kein Teil-Objekt-Überschreiben).
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

// ── per-app-gpg-passphrase-rotation (F-073/S-338 AC1/AC5/AC13): readItemFields/updateItemFields ──

/**
 * Baut einen bw-Spawn-Mock mit einem echten "Item-Store" (login.password + fields[]),
 * der `get item` (voller JSON-Read), `encode` (Roundtrip-Marker) und `edit item`
 * (Roundtrip-Decode + Store-Update) real durchspielt — anders als die `itemExists`-
 * Fixture oben (die nur exitCode prüft), damit das VOLLE `bw get item <id>`-JSON-
 * Schema (login.password, fields: [{name,value,type}]) verifiziert werden kann.
 */
function makeItemStoreSpawn(initialItems = {}) {
  const store = {};
  for (const [name, item] of Object.entries(initialItems)) {
    store[name] = JSON.parse(JSON.stringify(item));
  }
  const calls = [];
  const spawn = async (args, { env, input } = {}) => {
    calls.push({ args: [...args], env: { ...env }, input });
    const cmd = args[0];
    if (cmd === 'config') return { stdout: '', stderr: '', exitCode: 0 };
    if (cmd === 'login') return { stdout: 'You are logged in!', stderr: '', exitCode: 0 };
    if (cmd === 'unlock') return { stdout: SESSION_TOKEN + '\n', stderr: '', exitCode: 0 };
    if (cmd === 'get' && args[1] === 'item') {
      const name = args[2];
      const item = store[name];
      if (!item) return { stdout: '', stderr: 'Not found.', exitCode: 1 };
      return { stdout: JSON.stringify(item), stderr: '', exitCode: 0 };
    }
    if (cmd === 'encode') {
      return { stdout: `ENCODED[${input}]\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'edit' && args[1] === 'item') {
      const id = args[2];
      const m = /^ENCODED\[([\s\S]*)\]\n?$/.exec(input ?? '');
      if (!m) return { stdout: '', stderr: 'bad encode', exitCode: 1 };
      let updated;
      try {
        updated = JSON.parse(m[1]);
      } catch {
        return { stdout: '', stderr: 'bad json', exitCode: 1 };
      }
      const entry = Object.entries(store).find(([, v]) => v.id === id);
      if (!entry) return { stdout: '', stderr: 'not found', exitCode: 1 };
      store[entry[0]] = updated;
      return { stdout: 'edited ok\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'logout') return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  };
  return { spawn, calls, store };
}

describe('BitwardenDeployLoginService — readItemFields/updateItemFields (F-073/S-338 AC1/AC5/AC13)', () => {
  const ITEM_NAME = 'env.gpg-passphrase-myapp';
  function seedItem() {
    return {
      [ITEM_NAME]: {
        id: 'item-uuid-1',
        name: ITEM_NAME,
        login: { username: '', password: 'ACTIVE-OLD-PASS', uris: [] },
        fields: [{ name: 'foreign-field', value: 'untouched', type: 0 }],
      },
    };
  }

  it('readItemFields: liefert password/naechste/vorherige (naechste/vorherige fehlen → null)', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeItemStoreSpawn(seedItem());
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    const fields = await session.readItemFields(ITEM_NAME);
    await session.close();

    expect(fields).toEqual({ id: 'item-uuid-1', password: 'ACTIVE-OLD-PASS', naechste: null, vorherige: null });
    assertNoSecretInArgv(calls.filter((c) => c.args[0] !== 'get')); // get-item-Argv enthält nur den Item-Namen (kein Geheimnis)
    const getCall = calls.find((c) => c.args[0] === 'get');
    expect(getCall.args).toEqual(['get', 'item', ITEM_NAME]);
  });

  it('readItemFields: fehlendes Item → item-not-found', async () => {
    const store = await readyStore();
    const { spawn } = makeItemStoreSpawn({});
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await expect(session.readItemFields('env.gpg-passphrase-missing')).rejects.toMatchObject({ deployErrorClass: 'item-not-found' });
    await session.close();
  });

  it('updateItemFields: naechste setzen — aktives Passwortfeld/vorherige/fremde Felder unangetastet (AC1)', async () => {
    const store = await readyStore();
    const { spawn, calls, store: items } = makeItemStoreSpawn(seedItem());
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });
    const candidate = 'CANDIDATE-NEW-PASS-VALUE';

    const session = await svc.openSession({});
    await session.updateItemFields(ITEM_NAME, { naechste: candidate });
    await session.close();

    expect(items[ITEM_NAME].login.password).toBe('ACTIVE-OLD-PASS'); // unangetastet
    const fields = items[ITEM_NAME].fields;
    expect(fields.find((f) => f.name === 'naechste').value).toBe(candidate);
    expect(fields.find((f) => f.name === 'foreign-field').value).toBe('untouched'); // fremdes Feld unangetastet
    // Werte NIEMALS im Argv (nur via stdin)
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(candidate);
    }
    const encodeCall = calls.find((c) => c.args[0] === 'encode');
    expect(encodeCall.input).toContain(candidate);
  });

  it('updateItemFields: Umschalten (c) — neu→aktiv, alt→vorherige, naechste geleert (AC4-Naht)', async () => {
    const store = await readyStore();
    const seeded = seedItem();
    seeded[ITEM_NAME].fields.push({ name: 'naechste', value: 'CANDIDATE-VALUE', type: 1 });
    const { spawn, store: items } = makeItemStoreSpawn(seeded);
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await session.updateItemFields(ITEM_NAME, { password: 'CANDIDATE-VALUE', vorherige: 'ACTIVE-OLD-PASS', naechste: null });
    await session.close();

    expect(items[ITEM_NAME].login.password).toBe('CANDIDATE-VALUE');
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'vorherige').value).toBe('ACTIVE-OLD-PASS');
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'naechste')).toBeUndefined(); // AC4: geleert = entfernt
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'foreign-field').value).toBe('untouched');
  });

  it('updateItemFields: { vorherige: null } entfernt NUR das Feld vorherige (AC5 manuelle Entsorgung)', async () => {
    const store = await readyStore();
    const seeded = seedItem();
    seeded[ITEM_NAME].fields.push({ name: 'vorherige', value: 'OLD-ROLLBACK-ANCHOR', type: 1 });
    const { spawn, store: items } = makeItemStoreSpawn(seeded);
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await session.updateItemFields(ITEM_NAME, { vorherige: null });
    await session.close();

    expect(items[ITEM_NAME].fields.find((f) => f.name === 'vorherige')).toBeUndefined();
    expect(items[ITEM_NAME].login.password).toBe('ACTIVE-OLD-PASS'); // unangetastet
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'foreign-field').value).toBe('untouched');
  });

  it('updateItemFields: AC13-Rollback — password/vorherige/naechste in EINEM Aufruf wiederhergestellt', async () => {
    const store = await readyStore();
    const seeded = seedItem();
    seeded[ITEM_NAME].login.password = 'CANDIDATE-VALUE'; // bereits umgeschaltet (Zustand NACH (c))
    seeded[ITEM_NAME].fields.push({ name: 'vorherige', value: 'ACTIVE-OLD-PASS', type: 1 });
    const { spawn, store: items } = makeItemStoreSpawn(seeded);
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    // Rollback auf Zustand VOR (c): alte Passphrase wieder aktiv, neue zurück nach naechste, vorherige geleert.
    await session.updateItemFields(ITEM_NAME, { password: 'ACTIVE-OLD-PASS', vorherige: null, naechste: 'CANDIDATE-VALUE' });
    await session.close();

    expect(items[ITEM_NAME].login.password).toBe('ACTIVE-OLD-PASS');
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'vorherige')).toBeUndefined();
    expect(items[ITEM_NAME].fields.find((f) => f.name === 'naechste').value).toBe('CANDIDATE-VALUE');
  });

  it('updateItemFields: bw edit item fehlgeschlagen → item-update-failed', async () => {
    const store = await readyStore();
    const { spawn } = makeItemStoreSpawn(seedItem());
    const failingSpawn = async (args, opts) => {
      if (args[0] === 'edit') return { stdout: '', stderr: 'edit failed', exitCode: 1 };
      return spawn(args, opts);
    };
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: failingSpawn });

    const session = await svc.openSession({});
    await expect(session.updateItemFields(ITEM_NAME, { naechste: 'x' })).rejects.toMatchObject({ deployErrorClass: 'item-update-failed' });
    await session.close();
  });

  it('updateItemFields: fehlendes Item → item-not-found, kein encode/edit-Aufruf', async () => {
    const store = await readyStore();
    const { spawn, calls } = makeItemStoreSpawn({});
    const svc = new BitwardenDeployLoginService({ accessStore: store, auditStore: auditSpy(), _spawnBw: spawn });

    const session = await svc.openSession({});
    await expect(session.updateItemFields('env.gpg-passphrase-missing', { naechste: 'x' })).rejects.toMatchObject({ deployErrorClass: 'item-not-found' });
    await session.close();

    expect(calls.some((c) => c.args[0] === 'encode')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'edit')).toBe(false);
  });
});
