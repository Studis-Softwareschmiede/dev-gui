/**
 * BitwardenMasterKeyServiceArchive.test.js — Unit-Tests für
 * BitwardenMasterKeyService#archiveRotatedKey() + #discardArchivedKeys()
 * (credential-key-rotation v2, S-342 — docs/specs/credential-key-rotation.md).
 *
 * Covers (credential-key-rotation):
 *   AC4/AC11 — archiveRotatedKey(): der neue Key wird der aktive `login.password`-Wert
 *     des Master-Key-Items; der BISHERIGE Item-Wert wird datiert ins Custom-Feld
 *     „Schlüssel-Archiv" angehängt (append, nie überschreiben) — kein Lösch-Call.
 *   AC5 — discardArchivedKeys(): entfernt das Custom-Feld „Schlüssel-Archiv" vollständig,
 *     NUR als expliziter, eigener Aufruf (kein Bestandteil des normalen Rotations-Flows).
 *   AC8 — Audit-First (bitwarden:key-archive / bitwarden:key-archive-discard) vor Ausführung,
 *     ohne Werte; ein fehlgeschlagener Audit-Write verhindert die Aktion.
 *   AC9 — Weder alter noch neuer Key erscheint im Rückgabewert.
 *
 * Strategie: `_spawnBw` mockt `get item` (volles Item-JSON inkl. `fields`), `encode`
 * (Payload wird über opts.input abgefangen — das ist bereits das mutierte Item-JSON,
 * VOR der eigentlichen base64-Kodierung), `edit item`, `logout`. `_spawnBwPtySession`
 * mockt den Login (phase:'done', analog BitwardenMasterKeyService.test.js).
 */

import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/CredentialStore.js';
import { AuditStore } from '../src/AuditStore.js';
import { BitwardenMasterKeyService } from '../src/BitwardenMasterKeyService.js';

const TEST_MASTER_KEY = 'test-bw-archive-key-not-a-real-secret';
const FAKE_EMAIL = 'user@example.com';
const FAKE_PASSWORD = 'super-secret-master-password-bw';
const FAKE_SESSION = 'fake-bw-session-token-abc123xyz789';
const OLD_KEY_VALUE = 'old-master-key-value-currently-active-item';
const NEW_KEY_VALUE = 'new-master-key-value-freshly-rotated-local';
const ITEM_NAME = 'dev-gui-master-key';
const ITEM_ID = 'fake-item-id-1234';
const ARCHIVE_FIELD_NAME = 'Schlüssel-Archiv';

let tmpDir;
let credentialStore;
let auditStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bw-archive-test-'));
  credentialStore = new CredentialStore({
    dir: tmpDir,
    masterKey: TEST_MASTER_KEY,
    envPath: join(tmpDir, '.env'),
  });
  auditStore = new AuditStore();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** PTY-Session-Mock: Login immer erfolgreich (phase:'done'). */
function makePtySessionMock({ loginFails = false } = {}) {
  return jest.fn(async () => {
    if (loginFails) {
      return { phase: 'done', stdout: '', output: 'Username or password is incorrect.', exitCode: 1 };
    }
    return { phase: 'done', stdout: FAKE_SESSION, output: '', exitCode: 0 };
  });
}

/**
 * Mock für `_spawnBw` — deckt `get item`, `encode`, `edit item`, `logout` ab.
 *
 * @param {object} opts
 * @param {object|null} [opts.existingFields] - initiale `fields`-Liste des Items
 * @param {string} [opts.currentPassword]     - aktueller `login.password`-Wert
 * @param {boolean} [opts.itemNotFound]       - true = `get item` liefert "not found"
 * @param {boolean} [opts.editFails]          - true = `bw edit item` schlägt fehl
 */
function makeSpawnMock({
  existingFields = [],
  currentPassword = OLD_KEY_VALUE,
  itemNotFound = false,
  editFails = false,
} = {}) {
  const encodedInputs = [];
  const editCalls = [];

  const fn = jest.fn(async (args, opts) => {
    const cmd = args[0];

    if (cmd === 'get' && args[1] === 'item') {
      if (itemNotFound) {
        return { stdout: '', stderr: 'Not found.', exitCode: 1 };
      }
      const item = {
        id: ITEM_ID,
        name: ITEM_NAME,
        login: { username: '', password: currentPassword, uris: [] },
        fields: existingFields,
      };
      return { stdout: JSON.stringify(item), stderr: '', exitCode: 0 };
    }

    if (cmd === 'encode') {
      // opts.input ist das VOLLE, bereits mutierte Item-JSON (vor der echten Kodierung) —
      // hier für Assertions abgreifen.
      encodedInputs.push(opts?.input);
      return { stdout: 'ZmFrZS1lbmNvZGVkLXBheWxvYWQ=', stderr: '', exitCode: 0 };
    }

    if (cmd === 'edit' && args[1] === 'item') {
      editCalls.push({ itemId: args[2], input: opts?.input });
      if (editFails) {
        return { stdout: '', stderr: 'Edit failed.', exitCode: 1 };
      }
      return { stdout: '{"id":"' + ITEM_ID + '"}', stderr: '', exitCode: 0 };
    }

    if (cmd === 'logout') {
      return { stdout: 'You have logged out.', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: 'unknown command', exitCode: 1 };
  });

  fn.encodedInputs = encodedInputs;
  fn.editCalls = editCalls;
  return fn;
}

function makeService(ptyMock, spawnMock) {
  return new BitwardenMasterKeyService({
    credentialStore,
    auditStore,
    itemName: ITEM_NAME,
    _spawnBwPtySession: ptyMock,
    _spawnBw: spawnMock,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC4/AC11 — archiveRotatedKey()
// ══════════════════════════════════════════════════════════════════════════════

describe('AC4/AC11 — archiveRotatedKey(): neuer Key aktiv + bisheriger Key datiert archiviert', () => {
  it('setzt login.password auf newKey und hängt den BISHERIGEN Item-Wert datiert an ein neues Schlüssel-Archiv-Feld an (kein bestehendes Feld)', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({ existingFields: [], currentPassword: OLD_KEY_VALUE });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: 'admin@test.example.com',
    });

    expect(result).toEqual({ status: 'archived' });

    expect(spawnMock.encodedInputs).toHaveLength(1);
    const mutated = JSON.parse(spawnMock.encodedInputs[0]);
    expect(mutated.login.password).toBe(NEW_KEY_VALUE);

    const archiveField = mutated.fields.find((f) => f.name === ARCHIVE_FIELD_NAME);
    expect(archiveField).toBeDefined();
    expect(archiveField.type).toBe(1); // Hidden
    expect(archiveField.value).toContain(OLD_KEY_VALUE);
    // datiert: enthält einen ISO-Zeitstempel gefolgt vom alten Key
    expect(archiveField.value).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z: old-master-key-value-currently-active-item$/);

    expect(spawnMock.editCalls).toHaveLength(1);
    expect(spawnMock.editCalls[0].itemId).toBe(ITEM_ID);
  });

  it('APPENDET an ein bereits bestehendes Schlüssel-Archiv-Feld — überschreibt frühere Einträge NICHT', async () => {
    const previousEntry = '2026-01-01T00:00:00.000Z: an-even-older-key-value';
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({
      existingFields: [{ name: ARCHIVE_FIELD_NAME, value: previousEntry, type: 1 }],
      currentPassword: OLD_KEY_VALUE,
    });
    const service = makeService(ptyMock, spawnMock);

    await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });

    const mutated = JSON.parse(spawnMock.encodedInputs[0]);
    const archiveField = mutated.fields.find((f) => f.name === ARCHIVE_FIELD_NAME);
    // Alter Eintrag bleibt vollständig erhalten (append, nie überschreiben — AC11)
    expect(archiveField.value).toContain(previousEntry);
    expect(archiveField.value).toContain(OLD_KEY_VALUE);
    expect(archiveField.value.split('\n')).toHaveLength(2);
  });

  it('kein Lösch-Call — nur `get item` + `encode` + `edit item` + `logout`, kein `delete`', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.archiveRotatedKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, newKey: NEW_KEY_VALUE, identity: null });

    const commands = spawnMock.mock.calls.map(([args]) => args[0]);
    expect(commands).not.toContain('delete');
  });

  it('AC8 — Audit-First: Eintrag `bitwarden:key-archive:<item>` ohne Werte, VOR Ausführung', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: 'admin@test.example.com',
    });

    const entries = auditStore.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe(`bitwarden:key-archive:${ITEM_NAME}`);
    expect(entries[0].identity).toBe('admin@test.example.com');
    expect(JSON.stringify(entries[0])).not.toContain(OLD_KEY_VALUE);
    expect(JSON.stringify(entries[0])).not.toContain(NEW_KEY_VALUE);
    // record() lief VOR dem ersten bw-Spawn (Audit-First)
    expect(spawnMock.mock.calls[0][0][0]).toBe('get');
  });

  it('fehlgeschlagener Audit-Write verhindert die Aktion (kein bw-Spawn)', async () => {
    const failingAuditStore = { record: () => { throw new Error('simulated audit failure'); } };
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = new BitwardenMasterKeyService({
      credentialStore,
      auditStore: failingAuditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: ptyMock,
      _spawnBw: spawnMock,
    });

    const result = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ptyMock).not.toHaveBeenCalled();
  });

  it('Item nicht gefunden ⇒ status:error, errorClass:item-not-found', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({ itemNotFound: true });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('item-not-found');
  });

  it('bw edit item fehlgeschlagen ⇒ status:error, errorClass:item-update-failed; Sitzung wird trotzdem beendet', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({ editFails: true });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('item-update-failed');
    const commands = spawnMock.mock.calls.map(([args]) => args[0]);
    expect(commands).toContain('logout');
  });

  it('Login-Fehlschlag ⇒ status:error, kein Item-Zugriff', async () => {
    const ptyMock = makePtySessionMock({ loginFails: true });
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });

    expect(result.status).toBe('error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('AC9 — weder alter noch neuer Key erscheint im Rückgabewert (Erfolg + Fehlerfälle)', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const okResult = await service.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });
    expect(JSON.stringify(okResult)).not.toContain(OLD_KEY_VALUE);
    expect(JSON.stringify(okResult)).not.toContain(NEW_KEY_VALUE);

    const spawnMockNotFound = makeSpawnMock({ itemNotFound: true });
    const service2 = makeService(makePtySessionMock(), spawnMockNotFound);
    const errResult = await service2.archiveRotatedKey({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      newKey: NEW_KEY_VALUE,
      identity: null,
    });
    expect(JSON.stringify(errResult)).not.toContain(NEW_KEY_VALUE);
  });

  it('kein newKey übergeben ⇒ status:error, kein bw-Zugriff', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = makeService(ptyMock, spawnMock);

    const result = await service.archiveRotatedKey({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ptyMock).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC5 — discardArchivedKeys(): permanente Entsorgung, NUR expliziter, eigener Aufruf
// ══════════════════════════════════════════════════════════════════════════════

describe('AC5 — discardArchivedKeys(): explizite, bestätigte Entsorgung des Archiv-Felds', () => {
  it('entfernt das Custom-Feld „Schlüssel-Archiv" vollständig — andere Felder bleiben unangetastet', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({
      existingFields: [
        { name: ARCHIVE_FIELD_NAME, value: '2026-01-01T00:00:00.000Z: some-old-key', type: 1 },
        { name: 'unrelated-field', value: 'keep-me', type: 0 },
      ],
    });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.discardArchivedKeys({
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      identity: 'admin@test.example.com',
    });

    expect(result).toEqual({ status: 'discarded' });

    const mutated = JSON.parse(spawnMock.encodedInputs[0]);
    expect(mutated.fields.find((f) => f.name === ARCHIVE_FIELD_NAME)).toBeUndefined();
    expect(mutated.fields.find((f) => f.name === 'unrelated-field')).toBeDefined();
    // login.password bleibt unverändert (discard rührt den aktiven Key nicht an)
    expect(mutated.login.password).toBe(OLD_KEY_VALUE);

    const entries = auditStore.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe(`bitwarden:key-archive-discard:${ITEM_NAME}`);
  });

  it('AC8 — fehlgeschlagener Audit-Write verhindert die Aktion (kein bw-Spawn)', async () => {
    const failingAuditStore = { record: () => { throw new Error('simulated audit failure'); } };
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock();
    const service = new BitwardenMasterKeyService({
      credentialStore,
      auditStore: failingAuditStore,
      itemName: ITEM_NAME,
      _spawnBwPtySession: ptyMock,
      _spawnBw: spawnMock,
    });

    const result = await service.discardArchivedKeys({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('bw edit item fehlgeschlagen ⇒ status:error, errorClass:item-update-failed', async () => {
    const ptyMock = makePtySessionMock();
    const spawnMock = makeSpawnMock({ editFails: true });
    const service = makeService(ptyMock, spawnMock);

    const result = await service.discardArchivedKeys({ email: FAKE_EMAIL, password: FAKE_PASSWORD, identity: null });

    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('item-update-failed');
  });
});
