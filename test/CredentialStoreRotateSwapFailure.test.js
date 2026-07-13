/**
 * CredentialStoreRotateSwapFailure.test.js — dedizierter Test für einen echten
 * Fehlschlag beim atomaren Swap von CredentialStore#rotate() Schritt (d)
 * ("Crash"/I-O-Fehler beim `rename()`) — credential-key-rotation AC1/AC3.
 *
 * Covers (credential-key-rotation):
 *   AC1/AC3 — Schlägt der atomare `rename()` in Schritt (d) fehl (z.B. I/O-Fehler
 *         zwischen grüner Round-trip-Verifikation und Commit), gilt das als "Crash"
 *         im Sinne der Spec-Aufzählung (Entschlüsseln/Verschlüsseln/Verifikation/Crash):
 *         KEIN Swap, `secrets.enc.json` + `.env` bleiben unverändert, der alte Key
 *         bleibt aktiv (reason: 'swap-failed').
 *
 * Warum eine eigene Datei + Modul-Mock:
 *   Ein echter `rename()`-Fehlschlag GENAU an diesem einen Aufruf (Schritt (d): Original
 *   über die bereits verifizierte rotate-tmp-Datei ersetzen) lässt sich ohne kaputtes
 *   Dateisystem nur per gezieltem Modul-Mock erzwingen. Der Mock trifft ausschließlich
 *   `rename()`-Aufrufe, deren QUELL-Pfad auf `.rotate-tmp` endet (die Schritt-(d)-Konvention)
 *   — jeder andere `rename()`-Aufruf (u.a. `#writeStore()`s `.tmp→secrets.enc.json`,
 *   `#persistKeyToEnv()`s `.cred-tmp→.env`, `restore()`s `.restore-tmp→secrets.enc.json`)
 *   läuft unverändert über die echte Implementierung.
 *
 * Der Mock gilt modulweit für diese Testdatei — daher bewusst getrennt von
 * CredentialStoreRotate.test.js (dort ungemockt, echtes Dateisystem für alle anderen ACs).
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as realFsPromises from 'node:fs/promises';

jest.unstable_mockModule('node:fs/promises', () => ({
  ...realFsPromises,
  rename: jest.fn((src, ...rest) => {
    if (typeof src === 'string' && src.endsWith('.rotate-tmp')) {
      return Promise.reject(new Error('EIO: simulated rename failure for rotate-tmp swap'));
    }
    return realFsPromises.rename(src, ...rest);
  }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('CredentialStore#rotate() — AC1/AC3 echter Fehlschlag beim atomaren Swap (Schritt d)', () => {
  it('rename()-Fehler beim Swap ⇒ swap-failed, kein Swap, alter Key bleibt aktiv, .env unverändert', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const OLD_KEY = 'old-master-key-for-swap-failure-test-not-real';
    const NEW_KEY = 'new-master-key-for-swap-failure-test-not-real';

    const dir = await mkdtemp(join(tmpdir(), 'credrotate-swapfail-test-'));
    const envPath = join(dir, '.env');
    const store = new CredentialStore({ dir, masterKey: OLD_KEY, envPath });

    await store.set('credentials/misc/foo', 'plain-value-untouched');
    const beforeStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');

    const result = await store.rotate(NEW_KEY);

    expect(result).toEqual({ ok: false, reason: 'swap-failed', swapped: false });

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

    // Keine rotate-tmp-Datei zurückgelassen (Cleanup nach Swap-Fehlschlag)
    await expect(realFsPromises.stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();

    await realFsPromises.rm(dir, { recursive: true, force: true });
  });
});
