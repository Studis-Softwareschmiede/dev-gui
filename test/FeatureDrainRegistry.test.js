/**
 * FeatureDrainRegistry.test.js — Unit-Tests der Feature-Batch-Status-Registry
 * (feature-umsetzen-button, Owner-Auftrag 2026-07-06).
 *
 * Covers: register→running, markDone→done, markFailed→failed+Text,
 * isRunning-Ableitung, Persistenz unter CRED_STORE_DIR (Neustart überlebt),
 * ohne CRED_STORE_DIR reiner In-Memory-Betrieb, korrupte Datei → leerer Cache.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeatureDrainRegistry, resolveFeatureDrainFilePath } from '../src/FeatureDrainRegistry.js';

describe('FeatureDrainRegistry — In-Memory (ohne CRED_STORE_DIR)', () => {
  const origEnv = process.env.CRED_STORE_DIR;
  beforeEach(() => { delete process.env.CRED_STORE_DIR; });
  afterEach(() => { if (origEnv) process.env.CRED_STORE_DIR = origEnv; });

  it('register -> running -> markDone -> done', async () => {
    const reg = new FeatureDrainRegistry();
    await reg.register('dev-gui', 'F-042');
    expect(reg.getJob('dev-gui', 'F-042').status).toBe('running');
    expect(reg.isRunning('dev-gui', 'F-042')).toBe(true);
    await reg.markDone('dev-gui', 'F-042');
    expect(reg.getJob('dev-gui', 'F-042').status).toBe('done');
    expect(reg.isRunning('dev-gui', 'F-042')).toBe(false);
  });

  it('markFailed setzt status + generischen Text', async () => {
    const reg = new FeatureDrainRegistry();
    await reg.register('dev-gui', 'F-042');
    await reg.markFailed('dev-gui', 'F-042', 'Exit-Code 1');
    const job = reg.getJob('dev-gui', 'F-042');
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Exit-Code 1');
  });

  it('unbekannter Job -> getJob null, isRunning false', () => {
    const reg = new FeatureDrainRegistry();
    expect(reg.getJob('dev-gui', 'F-999')).toBeNull();
    expect(reg.isRunning('dev-gui', 'F-999')).toBe(false);
  });

  it('resolveFeatureDrainFilePath() liefert null ohne CRED_STORE_DIR', () => {
    expect(resolveFeatureDrainFilePath()).toBeNull();
  });
});

describe('FeatureDrainRegistry — Persistenz (mit CRED_STORE_DIR)', () => {
  let storeDir;
  const origEnv = process.env.CRED_STORE_DIR;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'feature-drain-registry-'));
    process.env.CRED_STORE_DIR = storeDir;
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
    if (origEnv) process.env.CRED_STORE_DIR = origEnv; else delete process.env.CRED_STORE_DIR;
  });

  it('persistiert atomar und übersteht einen Neustart (zweite Instanz)', async () => {
    const reg1 = new FeatureDrainRegistry();
    await reg1.register('dev-gui', 'F-042');
    await reg1.markDone('dev-gui', 'F-042');

    expect(existsSync(resolveFeatureDrainFilePath())).toBe(true);
    expect(existsSync(`${resolveFeatureDrainFilePath()}.tmp`)).toBe(false);

    const reg2 = new FeatureDrainRegistry();
    expect(reg2.getJob('dev-gui', 'F-042').status).toBe('done');
  });

  it('korrupte Datei -> leerer Cache, kein Crash', () => {
    writeFileSync(resolveFeatureDrainFilePath(), '{not valid json', 'utf8');
    expect(() => new FeatureDrainRegistry()).not.toThrow();
    const reg = new FeatureDrainRegistry();
    expect(reg.getJob('dev-gui', 'F-042')).toBeNull();
  });
});
