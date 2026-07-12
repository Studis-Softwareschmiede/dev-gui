/**
 * BitwardenDeployAccessStore.test.js — Unit-Tests für den 0600-Zugangs-Speicher
 * des unbeaufsichtigten Bitwarden-Deploy-Zugangs (Variante B).
 *
 * Covers (docs/specs/deploy-bitwarden-gpg-injection.md):
 *   AC1 — eine 0600-Datei ${CRED_STORE_DIR}/bitwarden-deploy-access.json, atomar
 *         geschrieben (tmp+rename, kein .tmp-Rest); In-Memory-Degradation +
 *         persisted:false ohne CRED_STORE_DIR (kein Crash).
 *   AC2 — getStatus() ist write-only: je Feld nur {set,updatedAt}, aggregiertes
 *         ready (client_id+client_secret+master_password), KEIN Klartext.
 *   AC3 — setField/clearField mutieren genau ein Feld; getAccessForLogin() liefert
 *         Klartext nur intern; Validierung (unknown-field/empty/too-long).
 *   AC4 — der Speicher ist unabhängig vom CredentialStore/Master-Key (kein Import,
 *         keine Master-Key-Nutzung — struktureller Beleg via Persistenz ohne Key).
 *
 * Strategy: echtes fs gegen ein frisches tmp-CRED_STORE_DIR je Test; ein Neustart
 * wird durch eine zweite Instanz auf derselben Datei simuliert.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  BitwardenDeployAccessStore,
  resolveAccessFilePath,
  ACCESS_FIELDS,
  MAX_ACCESS_VALUE_BYTES,
} from '../src/BitwardenDeployAccessStore.js';

let storeDir;
let prevEnv;

beforeEach(async () => {
  prevEnv = process.env.CRED_STORE_DIR;
  storeDir = join(tmpdir(), 'bw-deploy-access-test-' + randomBytes(6).toString('hex'));
  await mkdir(storeDir, { recursive: true });
  process.env.CRED_STORE_DIR = storeDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.CRED_STORE_DIR;
  else process.env.CRED_STORE_DIR = prevEnv;
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
});

describe('BitwardenDeployAccessStore — Status (AC2, write-only)', () => {
  it('leerer Store: alle Felder unset, ready=false, persisted=true', async () => {
    const store = new BitwardenDeployAccessStore();
    const status = await store.getStatus();
    expect(status.ready).toBe(false);
    expect(status.persisted).toBe(true);
    for (const name of ACCESS_FIELDS) {
      expect(status.fields[name]).toEqual({ set: false, updatedAt: null });
    }
  });

  it('ready erst wenn client_id + client_secret + master_password gesetzt (server_url optional)', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', 'cid');
    await store.setField('client_secret', 'csec');
    expect((await store.getStatus()).ready).toBe(false);
    await store.setField('master_password', 'pw');
    expect((await store.getStatus()).ready).toBe(true);
    // server_url war nie gesetzt — ready trotzdem true
    expect((await store.getStatus()).fields.server_url.set).toBe(false);
  });

  it('Status enthält NIEMALS den Klartext-Wert', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_secret', 'super-geheim-123');
    const status = await store.getStatus();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('super-geheim-123');
    expect(status.fields.client_secret.set).toBe(true);
    expect(typeof status.fields.client_secret.updatedAt).toBe('string');
  });
});

describe('BitwardenDeployAccessStore — Persistenz (AC1)', () => {
  it('schreibt eine 0600-Datei, kein .tmp-Rest, überlebt Neustart', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', 'cid');
    await store.setField('master_password', 'pw');

    const filePath = resolveAccessFilePath();
    const st = await stat(filePath);
    // 0600: nur Eigentümer r/w
    expect(st.mode & 0o777).toBe(0o600);

    // kein liegengebliebenes tmp-File
    const entries = await readdir(storeDir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);

    // Neustart: zweite Instanz liest dieselbe Datei
    const store2 = new BitwardenDeployAccessStore();
    const status2 = await store2.getStatus();
    expect(status2.fields.client_id.set).toBe(true);
    expect(status2.fields.master_password.set).toBe(true);
  });

  it('Datei-Inhalt enthält den Wert (at rest klartext-nah, Spec S6) — Beleg dass getStatus ihn trotzdem nicht leakt', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_secret', 'on-disk-secret');
    const raw = await readFile(resolveAccessFilePath(), 'utf8');
    // at rest liegt der Wert (bewusst, Henne-Ei) — die Boundary schützt nur nach außen
    expect(raw).toContain('on-disk-secret');
  });

  it('ohne CRED_STORE_DIR: In-Memory, persisted=false, kein Crash', async () => {
    delete process.env.CRED_STORE_DIR;
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', 'cid');
    const status = await store.getStatus();
    expect(status.persisted).toBe(false);
    expect(status.fields.client_id.set).toBe(true); // im RAM sichtbar
  });
});

describe('BitwardenDeployAccessStore — Mutation + Validierung (AC3)', () => {
  it('setField/clearField mutieren genau ein Feld; clear idempotent', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', 'cid');
    await store.setField('client_secret', 'csec');
    await store.clearField('client_id');
    const status = await store.getStatus();
    expect(status.fields.client_id.set).toBe(false);
    expect(status.fields.client_secret.set).toBe(true);
    // idempotent: erneutes clear wirft nicht
    await expect(store.clearField('client_id')).resolves.toEqual({ set: false, updatedAt: null });
  });

  it('unbekanntes Feld, leerer Wert, zu langer Wert werfen klassifiziert', async () => {
    const store = new BitwardenDeployAccessStore();
    await expect(store.setField('nope', 'x')).rejects.toThrow('unknown-field');
    await expect(store.setField('client_id', '   ')).rejects.toThrow('empty-value');
    const tooLong = 'x'.repeat(MAX_ACCESS_VALUE_BYTES + 1);
    await expect(store.setField('client_id', tooLong)).rejects.toThrow('value-too-long');
    await expect(store.clearField('nope')).rejects.toThrow('unknown-field');
  });

  it('getAccessForLogin liefert Klartext + ready (nur intern)', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('server_url', 'https://vault.example.com');
    await store.setField('client_id', 'cid');
    await store.setField('client_secret', 'csec');
    await store.setField('master_password', 'pw');
    const access = await store.getAccessForLogin();
    expect(access).toEqual({
      ready: true,
      serverUrl: 'https://vault.example.com',
      clientId: 'cid',
      clientSecret: 'csec',
      masterPassword: 'pw',
    });
  });

  it('getAccessForLogin: ready=false wenn ein Pflichtfeld fehlt', async () => {
    const store = new BitwardenDeployAccessStore();
    await store.setField('client_id', 'cid');
    const access = await store.getAccessForLogin();
    expect(access.ready).toBe(false);
    expect(access.serverUrl).toBeNull();
    expect(access.clientId).toBe('cid');
  });
});
