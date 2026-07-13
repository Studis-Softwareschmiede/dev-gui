/**
 * CredentialStoreRotatePersistFailure.test.js — dedizierter Test für den Spec-Edge-Case
 * „.env-Persistenz scheitert NACH grünem Swap" von CredentialStore#rotate()
 * (credential-key-rotation §Edge-Cases, Fehlerklasse `persist-failed`).
 *
 * Covers (credential-key-rotation):
 *   Edge-Case (§Edge-Cases) — „.env-Persistenz scheitert nach grünem Swap ⇒ Store ist mit
 *     neuem Key in-memory aktiv, ... Aufrufer wird über fehlende Persistenz informiert
 *     (kein stiller Verlust)":
 *     (a) rotate() liefert { ok: false, reason: 'persist-failed', swapped: true }
 *     (b) secrets.enc.json ist zu diesem Zeitpunkt BEREITS mit dem NEUEN Key lesbar
 *         (der atomare Swap (d) ist bereits durchgelaufen — der `.env`-Schreibpfad ist
 *         strikt NACH (d), s. rotate()-Kommentar „AC7: .env-Persistenz ... ERST NACH
 *         grünem Swap")
 *     (c) der in-memory-Key (`getPlaintext()`) ist bereits auf den NEUEN Key aktualisiert
 *         — kein Rückfall auf den alten Key (die Datei akzeptiert ab dem Swap ohnehin nur
 *         noch den neuen Key)
 *
 * Warum eine eigene Datei + Modul-Mock:
 *   `#persistKeyToEnv()` schreibt über `open(<envPath>.cred-tmp, 'w', 0o600)` +
 *   `fd.writeFile()`/`fd.sync()` + `rename()` + `chmod()`. Um GEZIELT NUR den
 *   `.env`-Persistenz-Schritt scheitern zu lassen (nicht den Store-Swap, der ebenfalls
 *   `rename()`/`open()` auf einem ANDEREN Pfad nutzt), wird `open()` selektiv für Pfade
 *   mit dem Suffix `.cred-tmp` (die `.env`-Tmp-Datei-Konvention aus `#persistKeyToEnv()`)
 *   gemockt — jeder andere Pfad (inkl. `secrets.enc.json(.rotate-tmp)`) läuft unverändert
 *   über die echte Implementierung.
 *
 * Der Mock gilt modulweit für diese Testdatei — daher bewusst getrennt von
 * CredentialStoreRotate.test.js (dort ungemockt, echtes Dateisystem für alle anderen ACs).
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as realFsPromises from 'node:fs/promises';

// Modulweiter Mock: `open()` schlägt GEZIELT für die `.env`-Tmp-Datei fehl
// (`#persistKeyToEnv()`-Konvention: `${envPath}.cred-tmp`), simuliert z.B. einen
// Schreibrechte-/Disk-Fehler beim `.env`-Persistenz-Schritt — NACHDEM der Store-Swap
// (secrets.enc.json.rotate-tmp → secrets.enc.json) bereits erfolgreich durchgelaufen ist.
jest.unstable_mockModule('node:fs/promises', () => ({
  ...realFsPromises,
  open: jest.fn((path, ...rest) => {
    if (typeof path === 'string' && path.endsWith('.cred-tmp')) {
      return Promise.reject(new Error('simulated .env write failure (EACCES)'));
    }
    return realFsPromises.open(path, ...rest);
  }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('CredentialStore#rotate() — Edge-Case: .env-Persistenz scheitert NACH grünem Swap', () => {
  it('liefert { ok:false, reason:"persist-failed", swapped:true }; Store bereits mit neuem Key lesbar; in-memory-Key aktualisiert', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const OLD_KEY = 'old-master-key-for-persist-failure-test-not-real';
    const NEW_KEY = 'new-master-key-for-persist-failure-test-not-real';

    const dir = await mkdtemp(join(tmpdir(), 'credrotate-persist-fail-test-'));
    const envPath = join(dir, '.env');
    const store = new CredentialStore({ dir, masterKey: OLD_KEY, envPath });

    await store.set('credentials/misc/foo', 'plain-value-untouched');
    const beforeStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');

    const result = await store.rotate(NEW_KEY);

    // (a) sanitisierte Fehlerklasse — swapped:true unterscheidet diesen Fall von
    // jedem Vor-Swap-Fehlschlag (verification-failed/decrypt-failed/... haben swapped:false)
    // AC12 (v2, S-342): backup läuft NACH masterKeyRaw-Update, also auch im persist-failed-Zweig.
    expect(result).toEqual({ ok: false, reason: 'persist-failed', swapped: true, backup: expect.any(Object) });

    // (b) secrets.enc.json wurde bereits ersetzt (Swap ist der Commit-Punkt VOR dem .env-Schritt)
    const afterStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');
    expect(afterStoreRaw).not.toBe(beforeStoreRaw);

    // Die Datei ist mit dem NEUEN Key unabhängig (per frischem, separatem Store-Handle)
    // entschlüsselbar — ein rein zufällig unveränderter in-memory-State würde das nicht zeigen.
    const independentStoreWithNewKey = new CredentialStore({ dir, masterKey: NEW_KEY, envPath });
    const plaintextViaNewKey = await independentStoreWithNewKey.getPlaintext('credentials/misc/foo');
    expect(plaintextViaNewKey).toBe('plain-value-untouched');

    // Ein frischer Store-Handle mit dem ALTEN Key kann die Datei NICHT mehr entschlüsseln
    // (GCM-Tag-Fehler — die Datei erwartet ab dem Swap ausschließlich den neuen Key)
    const independentStoreWithOldKey = new CredentialStore({ dir, masterKey: OLD_KEY, envPath });
    await expect(independentStoreWithOldKey.getPlaintext('credentials/misc/foo')).rejects.toThrow();

    // (c) der in-memory-Key DES ROTIERENDEN STORE-HANDLES selbst ist bereits aktualisiert —
    // getPlaintext() über denselben `store` funktioniert weiterhin (kein Rückfall auf alt)
    const plaintextViaRotatingHandle = await store.getPlaintext('credentials/misc/foo');
    expect(plaintextViaRotatingHandle).toBe('plain-value-untouched');

    // .env wurde NICHT auf den neuen Key aktualisiert (Persistenz ist gescheitert)
    let envContent = '';
    try {
      envContent = await realFsPromises.readFile(envPath, 'utf8');
    } catch { /* .env existiert nicht — ebenfalls ok, dann ist NEW_KEY sicher nicht enthalten */ }
    expect(envContent).not.toContain(NEW_KEY);

    // Kein Key-Wert im Rückgabewert (Floor/AC9)
    expect(JSON.stringify(result)).not.toContain(OLD_KEY);
    expect(JSON.stringify(result)).not.toContain(NEW_KEY);

    await realFsPromises.rm(dir, { recursive: true, force: true });
  });
});
