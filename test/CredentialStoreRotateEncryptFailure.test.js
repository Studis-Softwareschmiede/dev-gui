/**
 * CredentialStoreRotateEncryptFailure.test.js — dedizierter Test für einen echten
 * Fehlschlag beim Schreiben der Rotations-Zwischendatei von CredentialStore#rotate()
 * Schritt (b) ("Verschlüsseln") — credential-key-rotation AC3.
 *
 * Covers (credential-key-rotation):
 *   AC3 — Schlägt Schritt (b) ("Verschlüsseln ... in eine NEUE Datei") fehl (hier:
 *         Schreib-I/O-Fehler beim Anlegen von `secrets.enc.json.rotate-tmp`) ⇒ kein
 *         Swap, `secrets.enc.json` + `.env` bleiben unverändert, der alte Key bleibt
 *         aktiv (reason: 'encrypt-failed').
 *
 * Warum eine eigene Datei + Modul-Mock:
 *   `#writeRotateTmp()` öffnet die Zwischendatei via `open(<filePath>.rotate-tmp, 'w', 0o600)`.
 *   Ein echter Schreib-Fehler an dieser Stelle (volles Volume, Berechtigungsfehler) lässt
 *   sich ohne echtes kaputtes Dateisystem nur per gezieltem Modul-Mock erzwingen — analog
 *   CredentialStoreRotateVerification.test.js / CredentialStoreRotatePersistFailure.test.js.
 *   Der Mock trifft ausschließlich `open()`-Aufrufe mit dem `.rotate-tmp`-Suffix (die
 *   `#writeRotateTmp()`-Konvention) — jeder andere `open()`-Aufruf (u.a. `#writeStore()`s
 *   `.tmp`-Suffix, `#persistKeyToEnv()`s `.cred-tmp`-Suffix) läuft unverändert über die
 *   echte Implementierung.
 *
 * Der Mock gilt modulweit für diese Testdatei — daher bewusst getrennt von
 * CredentialStoreRotate.test.js (dort ungemockt, echtes Dateisystem für alle anderen ACs).
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as realFsPromises from 'node:fs/promises';

jest.unstable_mockModule('node:fs/promises', () => ({
  ...realFsPromises,
  open: jest.fn((path, ...rest) => {
    if (typeof path === 'string' && path.endsWith('.rotate-tmp')) {
      return Promise.reject(new Error('ENOSPC: simulated write failure for rotate-tmp'));
    }
    return realFsPromises.open(path, ...rest);
  }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('CredentialStore#rotate() — AC3 echter Fehlschlag beim Schreiben der Rotations-Zwischendatei', () => {
  it('Schreib-Fehler beim Anlegen von rotate-tmp ⇒ encrypt-failed, kein Swap, alter Key bleibt aktiv, .env unverändert', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const OLD_KEY = 'old-master-key-for-encrypt-failure-test-not-real';
    const NEW_KEY = 'new-master-key-for-encrypt-failure-test-not-real';

    const dir = await mkdtemp(join(tmpdir(), 'credrotate-encryptfail-test-'));
    const envPath = join(dir, '.env');
    const store = new CredentialStore({ dir, masterKey: OLD_KEY, envPath });

    await store.set('credentials/misc/foo', 'plain-value-untouched');
    const beforeStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');

    const result = await store.rotate(NEW_KEY);

    expect(result).toEqual({ ok: false, reason: 'encrypt-failed', swapped: false });

    // Kein Swap — Original byte-identisch zum Vorzustand
    const afterStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');
    expect(afterStoreRaw).toBe(beforeStoreRaw);

    // Alter Key bleibt aktiv — Klartext-Lesen funktioniert weiterhin mit dem ALTEN Key
    const plaintext = await store.getPlaintext('credentials/misc/foo');
    expect(plaintext).toBe('plain-value-untouched');

    // .env unverändert (kein DEVGUI_CRED_MASTER_KEY=<neu>)
    let envContent = '';
    try {
      envContent = await realFsPromises.readFile(envPath, 'utf8');
    } catch { /* .env existiert nicht — ebenfalls ok, dann ist NEW_KEY sicher nicht enthalten */ }
    expect(envContent).not.toContain(NEW_KEY);

    // Keine rotate-tmp-Datei zurückgelassen (Cleanup nach Schreib-Fehlschlag)
    await expect(realFsPromises.stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();

    await realFsPromises.rm(dir, { recursive: true, force: true });
  });
});
