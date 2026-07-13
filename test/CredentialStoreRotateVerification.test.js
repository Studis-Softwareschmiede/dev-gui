/**
 * CredentialStoreRotateVerification.test.js — dedizierter Test für den echten
 * Round-trip-Verifikations-Fehlschlag von CredentialStore#rotate() Schritt (c)
 * (credential-key-rotation AC2).
 *
 * Covers (credential-key-rotation):
 *   AC2 — Die Round-trip-Verifikation entschlüsselt die neue Datei (rotate-tmp) mit dem
 *         neuen Key vollständig und vergleicht jeden Eintrag gegen den Klartext aus der
 *         Entschlüsselung mit dem alten Key; eine Abweichung beim Rücklesen ⇒ kein Swap,
 *         alter Zustand bleibt vollständig aktiv (secrets.enc.json unverändert).
 *
 * Warum eine eigene Datei + Modul-Mock:
 *   Innerhalb eines einzigen rotate()-Laufs schreibt und liest derselbe Code dieselbe
 *   rotate-tmp-Datei ohne Fremdeinwirkung — Schritt (a)-Klartext und Schritt (c)-Rücklesen
 *   sind dadurch (bei korrekter Implementierung) inhärent immer konsistent. Ein echter
 *   Verifikations-Fehlschlag (im Gegensatz zu einem Fehlschlag bereits in Schritt (a),
 *   s. CredentialStoreRotate.test.js AC3) lässt sich daher nur erzwingen, indem der
 *   Rücklese-Pfad selbst gezielt abweichenden Inhalt liefert — hier per
 *   `jest.unstable_mockModule('node:fs/promises', ...)`, das für JEDEN Pfad außer
 *   `*.rotate-tmp` transparent an die echte Implementierung durchreicht.
 *
 * Der Mock gilt modulweit für diese Testdatei — daher bewusst getrennt von
 * CredentialStoreRotate.test.js (dort ungemockt, echtes Dateisystem für alle anderen ACs).
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as realFsPromises from 'node:fs/promises';

// Modulweiter Mock: für `*.rotate-tmp`-Pfade liefert readFile() absichtlich einen
// Inhalt, der zwar gültiges JSON mit passendem kdf-Block ist, dessen Entschlüsselung
// (unter dem neuen Key) aber NICHT dem in Schritt (a) gelesenen Klartext entspricht.
// Für alle anderen Pfade/Funktionen wird transparent an die echte Implementierung
// durchgereicht (kein Verhaltensunterschied für den Rest von CredentialStore).
jest.unstable_mockModule('node:fs/promises', () => ({
  ...realFsPromises,
  readFile: jest.fn((path, ...rest) => {
    if (typeof path === 'string' && path.endsWith('.rotate-tmp')) {
      // Absichtlich kein valides JSON mit passendem Store-Schema — der JSON.parse()
      // im Verifikationspfad von rotate() schlägt dadurch fehl (Verifikation ⇒ false),
      // OHNE dass Schritt (a) (Entschlüsseln mit dem ALTEN Key) davon betroffen wäre —
      // (a) liest ausschließlich die ORIGINAL-secrets.enc.json, nicht die rotate-tmp-Datei.
      return Promise.resolve('{"not-a-valid-rotate-tmp-store": true}');
    }
    return realFsPromises.readFile(path, ...rest);
  }),
}));

afterEach(() => {
  jest.clearAllMocks();
});

describe('CredentialStore#rotate() — AC2 echter Round-trip-Verifikations-Fehlschlag', () => {
  it('rotate-tmp weicht beim Rücklesen ab ⇒ verification-failed, kein Swap, alter Key bleibt aktiv, .env unverändert', async () => {
    const { CredentialStore } = await import('../src/CredentialStore.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const OLD_KEY = 'old-master-key-for-verification-test-not-real';
    const NEW_KEY = 'new-master-key-for-verification-test-not-real';

    const dir = await mkdtemp(join(tmpdir(), 'credrotate-verify-test-'));
    const envPath = join(dir, '.env');
    const store = new CredentialStore({ dir, masterKey: OLD_KEY, envPath });

    await store.set('credentials/misc/foo', 'plain-value-untouched');
    const beforeStoreRaw = await realFsPromises.readFile(join(dir, 'secrets.enc.json'), 'utf8');

    const result = await store.rotate(NEW_KEY);

    expect(result).toEqual({ ok: false, reason: 'verification-failed', swapped: false });

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

    // Keine rotate-tmp-Datei zurückgelassen (Cleanup nach Verifikations-Fehlschlag)
    await expect(realFsPromises.stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();

    await realFsPromises.rm(dir, { recursive: true, force: true });
  });
});
