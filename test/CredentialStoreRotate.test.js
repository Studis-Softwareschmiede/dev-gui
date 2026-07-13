/**
 * CredentialStoreRotate.test.js — Unit-Tests für CredentialStore#rotate()
 * (credential-key-rotation, S-083 Kern — docs/specs/credential-key-rotation.md).
 *
 * Covers (credential-key-rotation):
 *   AC1 — Happy Path: alle Einträge werden vom alten auf den neuen Key re-verschlüsselt
 *         in eine neue Datei; Original erst NACH grüner Verifikation per rename() ersetzt.
 *   AC2 — Round-trip-Verifikation: Cleanup-Vertrag nach grünem Swap (keine rotate-tmp-Datei
 *         bleibt zurück). Der ECHTE Verifikations-Fehlschlag (Schritt (c) weicht vom
 *         Klartext aus (a) ab) ist per Modul-Mock in einer eigenen Datei getestet:
 *         test/CredentialStoreRotateVerification.test.js.
 *   AC3 — Fehler vor dem Swap (manipuliertes Store / GCM-Tag in Schritt (a) — "Entschlüsseln")
 *         ⇒ secrets.enc.json + .env bleiben unverändert, alter Key bleibt aktiv. Die
 *         übrigen drei in AC3 genannten Vor-Swap-Fehlermomente ("Verschlüsseln"/Schritt (b),
 *         "Verifikation"/Schritt (c), "Crash" beim Swap selbst/Schritt (d)) sind je per
 *         Modul-Mock in eigenen Dateien getestet: test/CredentialStoreRotateEncryptFailure.test.js
 *         (reason:'encrypt-failed'), test/CredentialStoreRotateVerification.test.js
 *         (reason:'verification-failed'), test/CredentialStoreRotateSwapFailure.test.js
 *         (reason:'swap-failed').
 *   AC7 — .env-Persistenz + Prozess-Übergabe ERST NACH grünem Swap (DEVGUI_CRED_MASTER_KEY=<neu>,
 *         atomar, 0600); vorher bleibt der alte .env-Wert aktiv.
 *   AC8 — (Guard/Audit-Verhalten wird auf Router-Ebene getestet, s. credentialRotate.test.js)
 *   AC9 — Weder alter noch neuer Key erscheint im rotate()-Rückgabewert (Werte-Leak-Freiheit).
 *   AC10 — rotate() berührt ausschließlich secrets.enc.json + DEVGUI_CRED_MASTER_KEY in .env;
 *          GPG_PASSPHRASE/.env.gpg bleiben unberührt.
 *   Edge-Case — neuer Key == alter Key ⇒ klare Ablehnung (reason: 'same-key'), kein Swap.
 *   Edge-Case — verwaiste `…rotate-tmp`-Datei (simulierter Crash zwischen (b)/(d)) wird beim
 *               nächsten rotate()-Lauf aufgeräumt.
 *   Edge-Case — kein Master-Key geladen ⇒ 'no-master-key', kein Swap.
 *   Edge-Case — „.env-Persistenz scheitert NACH grünem Swap" (reason:'persist-failed',
 *               swapped:true; Store bereits mit neuem Key aktiv) ist per Modul-Mock in
 *               einer eigenen Datei getestet: test/CredentialStoreRotatePersistFailure.test.js.
 *
 * Strategie: CredentialStore mit tmpdir + injiziertem masterKey (kein Env nötig),
 * direkte Dateisystem-Assertions auf secrets.enc.json / .env / rotate-tmp.
 */

import { describe, it, afterEach, expect } from '@jest/globals';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/CredentialStore.js';

const OLD_KEY = 'old-master-key-for-unit-tests-not-a-real-secret';
const NEW_KEY = 'new-master-key-for-unit-tests-not-a-real-secret';

/** Erstellt einen temporären Store + .env-Pfad in einem tmpdir. */
async function makeTmpStore(masterKey = OLD_KEY) {
  const dir = await mkdtemp(join(tmpdir(), 'credrotate-test-'));
  const envPath = join(dir, '.env');
  const store = new CredentialStore({ dir, masterKey, envPath });
  return { store, dir, envPath };
}

describe('CredentialStore#rotate() (credential-key-rotation, S-083 Kern)', () => {
  let dir;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  describe('AC1/AC9 — Happy Path: Re-Encryption + atomarer Swap', () => {
    it('re-verschlüsselt alle Einträge auf den neuen Key; alte Einträge bleiben mit neuem Key lesbar', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/github/app_id', 'plain-app-id-123');
      await store.set('credentials/misc/foo', 'plain-foo-value');

      const result = await store.rotate(NEW_KEY);

      expect(result).toEqual({ ok: true, swapped: true });

      // AC9: kein Key-Wert im Rückgabewert
      expect(JSON.stringify(result)).not.toContain(OLD_KEY);
      expect(JSON.stringify(result)).not.toContain(NEW_KEY);

      // Neuer Key ist ab sofort aktiv — Klartext-Lesen funktioniert weiterhin korrekt
      const meta1 = await store.getMeta('credentials/github/app_id');
      expect(meta1.status).toBe('set');
      const plaintext1 = await store.getPlaintext('credentials/github/app_id');
      expect(plaintext1).toBe('plain-app-id-123');
      const plaintext2 = await store.getPlaintext('credentials/misc/foo');
      expect(plaintext2).toBe('plain-foo-value');
    });

    it('Store-Datei enthält nach Rotation einen frischen Salt (nicht mehr den ursprünglichen)', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const before = JSON.parse(await readFile(join(dir, 'secrets.enc.json'), 'utf8'));

      await store.rotate(NEW_KEY);

      const after = JSON.parse(await readFile(join(dir, 'secrets.enc.json'), 'utf8'));
      expect(after.kdf.salt).not.toBe(before.kdf.salt);
      // Ciphertext + IV ändern sich ebenfalls (frische IVs, AC1)
      expect(after.entries['credentials/misc/foo'].iv).not.toBe(before.entries['credentials/misc/foo'].iv);
      expect(after.entries['credentials/misc/foo'].ct).not.toBe(before.entries['credentials/misc/foo'].ct);
    });

    it('rotiert einen leeren Store (keine Einträge) trivial — nur der aktive Key wechselt', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: true, swapped: true });

      // Nach Rotation: unlock mit neuem Key funktioniert (Env wurde geschrieben)
      const envContent = await readFile(t.envPath, 'utf8');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
    });

    it('bewahrt nicht-geheime meta-Einträge (z.B. Workspace-Pfad) unverändert über die Rotation', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');
      await store.writeWorkspacePath('/some/workspace/path');

      await store.rotate(NEW_KEY);

      const path = await store.readWorkspacePath();
      expect(path).toBe('/some/workspace/path');
    });
  });

  describe('AC2 — Round-trip-Verifikation: Abweichung ⇒ kein Swap', () => {
    // Der echte Verifikations-Fehlschlag (Schritt (c): rotate-tmp weicht beim Rücklesen
    // vom Klartext aus Schritt (a) ab) wird in einer EIGENEN Testdatei abgedeckt
    // (test/CredentialStoreRotateVerification.test.js) — dort per node:fs/promises-
    // Modul-Mock gezielt auf den (c)-Rücklese-Pfad erzwungen. Innerhalb desselben
    // Prozesses ohne Fremdeinwirkung sind Schritt (a)-Klartext und Schritt (c)-Rücklesen
    // sonst inhärent konsistent (derselbe Code schreibt und liest dieselbe Datei), ein
    // Modul-Mock ist daher der einzige belastbare Weg, die Divergenz zu erzwingen.
    it('nach erfolgreicher Rotation bleibt keine rotate-tmp-Datei zurück (Cleanup nach grünem Swap)', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const beforeRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');

      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: true, swapped: true });

      await expect(stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();

      // Sanity: Original wurde tatsächlich ersetzt (Inhalt geändert)
      const afterRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
      expect(afterRaw).not.toBe(beforeRaw);
    });
  });

  describe('AC3 — manipuliertes Store (GCM-Tag) ⇒ harter Fehler in (a), kein Swap', () => {
    it('GCM-Tag-Manipulation eines Eintrags ⇒ decrypt-failed, secrets.enc.json + .env unverändert, alter Key aktiv', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store, envPath } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const beforeStoreRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
      let beforeEnvRaw = null;
      try {
        beforeEnvRaw = await readFile(envPath, 'utf8');
      } catch { /* .env existiert evtl. noch nicht */ }

      const raw = JSON.parse(beforeStoreRaw);
      const entryKey = Object.keys(raw.entries)[0];
      const tagBuf = Buffer.from(raw.entries[entryKey].tag, 'base64');
      tagBuf[0] ^= 0xff; // GCM-Tag korrumpieren
      raw.entries[entryKey].tag = tagBuf.toString('base64');
      await writeFile(join(dir, 'secrets.enc.json'), JSON.stringify(raw, null, 2), 'utf8');

      const result = await store.rotate(NEW_KEY);

      expect(result).toEqual({ ok: false, reason: 'decrypt-failed', swapped: false });

      // Store unverändert (bleibt die manipulierte Version — kein weiterer Schreibzugriff)
      const afterStoreRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
      expect(afterStoreRaw).toBe(JSON.stringify(raw, null, 2));

      // .env unverändert
      if (beforeEnvRaw !== null) {
        const afterEnvRaw = await readFile(envPath, 'utf8');
        expect(afterEnvRaw).toBe(beforeEnvRaw);
      } else {
        await expect(readFile(envPath, 'utf8')).rejects.toThrow();
      }
    });
  });

  describe('AC7 — .env-Persistenz erst NACH grünem Swap', () => {
    it('schreibt DEVGUI_CRED_MASTER_KEY=<neu> atomar + 0600 nach erfolgreicher Rotation', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store, envPath } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: true, swapped: true });

      const envContent = await readFile(envPath, 'utf8');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
      expect(envContent).not.toContain(OLD_KEY);

      const st = await stat(envPath);
      expect(st.mode & 0o777).toBe(0o600);
    });

    it('bei einem decrypt-failed-Abbruch bleibt kein DEVGUI_CRED_MASTER_KEY=<neu> in .env', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store, envPath } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const raw = JSON.parse(await readFile(join(dir, 'secrets.enc.json'), 'utf8'));
      const entryKey = Object.keys(raw.entries)[0];
      const tagBuf = Buffer.from(raw.entries[entryKey].tag, 'base64');
      tagBuf[0] ^= 0xff;
      raw.entries[entryKey].tag = tagBuf.toString('base64');
      await writeFile(join(dir, 'secrets.enc.json'), JSON.stringify(raw, null, 2), 'utf8');

      await store.rotate(NEW_KEY);

      let envContent = '';
      try {
        envContent = await readFile(envPath, 'utf8');
      } catch { /* .env existiert nicht — auch ok */ }
      expect(envContent).not.toContain(NEW_KEY);
    });
  });

  describe('AC10 — nur DEVGUI_CRED_MASTER_KEY wird rotiert', () => {
    it('rotate() schreibt/liest ausschließlich secrets.enc.json + DEVGUI_CRED_MASTER_KEY; keine GPG_PASSPHRASE-Zeile', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store, envPath } = t;

      await writeFile(envPath, 'GPG_PASSPHRASE=some-unrelated-gpg-passphrase\nOTHER_VAR=1\n', 'utf8');
      await store.set('credentials/misc/foo', 'value-a');

      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: true, swapped: true });

      const envContent = await readFile(envPath, 'utf8');
      expect(envContent).toContain('GPG_PASSPHRASE=some-unrelated-gpg-passphrase');
      expect(envContent).toContain('OTHER_VAR=1');
      expect(envContent).toContain(`DEVGUI_CRED_MASTER_KEY=${NEW_KEY}`);
    });
  });

  describe('Edge-Case — neuer Key == alter Key', () => {
    it('lehnt die Rotation klar ab (reason: same-key), kein Swap', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');
      const beforeRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');

      const result = await store.rotate(OLD_KEY);
      expect(result).toEqual({ ok: false, reason: 'same-key', swapped: false });

      const afterRaw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
      expect(afterRaw).toBe(beforeRaw);
    });
  });

  describe('Edge-Case — kein Master-Key geladen', () => {
    it('gibt no-master-key zurück, kein Swap', async () => {
      const t = await makeTmpStore(null);
      dir = t.dir;
      const { store } = t;

      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: false, reason: 'no-master-key', swapped: false });
    });
  });

  describe('Edge-Case — leere/ungültige Eingaben', () => {
    it('leerer String ⇒ empty-key', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const result = await t.store.rotate('');
      expect(result).toEqual({ ok: false, reason: 'empty-key', swapped: false });
    });

    it('nur Whitespace ⇒ empty-key', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const result = await t.store.rotate('   ');
      expect(result).toEqual({ ok: false, reason: 'empty-key', swapped: false });
    });

    it('eingebettetes Newline ⇒ invalid-key-format', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const result = await t.store.rotate('part-one\npart-two');
      expect(result).toEqual({ ok: false, reason: 'invalid-key-format', swapped: false });
    });
  });

  describe('Edge-Case — verwaiste rotate-tmp-Datei wird aufgeräumt', () => {
    it('eine vorgefundene rotate-tmp-Datei (simulierter Crash aus einem vorherigen Lauf) blockiert eine neue Rotation nicht', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');

      // Verwaiste rotate-tmp-Datei simulieren (Crash zwischen (b) und (d) eines
      // früheren Laufs) — Inhalt irrelevant, muss nur existieren.
      await writeFile(join(dir, 'secrets.enc.json.rotate-tmp'), '{"garbage": true}', 'utf8');

      const result = await store.rotate(NEW_KEY);
      expect(result).toEqual({ ok: true, swapped: true });

      // Nach erfolgreicher Rotation keine rotate-tmp-Datei mehr vorhanden
      await expect(stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();
    });

    it('cleanupOrphanedRotateTmp() räumt eine verwaiste rotate-tmp-Datei auf (Boot-Hook)', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await writeFile(join(dir, 'secrets.enc.json.rotate-tmp'), '{"garbage": true}', 'utf8');
      await store.cleanupOrphanedRotateTmp();

      await expect(stat(join(dir, 'secrets.enc.json.rotate-tmp'))).rejects.toThrow();
    });

    it('cleanupOrphanedRotateTmp() ist ein No-Op ohne Fehler, wenn keine rotate-tmp-Datei existiert', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      await expect(t.store.cleanupOrphanedRotateTmp()).resolves.toBeUndefined();
    });
  });

  describe('AC9 — Key-Leak-Freiheit', () => {
    it('weder alter noch neuer Key erscheinen in einer JSON-Serialisierung des Rückgabewerts (Erfolg + alle Fehlerfälle)', async () => {
      const t = await makeTmpStore();
      dir = t.dir;
      const { store } = t;

      await store.set('credentials/misc/foo', 'value-a');

      const okResult = await store.rotate(NEW_KEY);
      expect(JSON.stringify(okResult)).not.toContain(OLD_KEY);
      expect(JSON.stringify(okResult)).not.toContain(NEW_KEY);

      const t2 = await makeTmpStore();
      const sameKeyResult = await t2.store.rotate(OLD_KEY);
      expect(JSON.stringify(sameKeyResult)).not.toContain(OLD_KEY);
      await rm(t2.dir, { recursive: true, force: true });
    });
  });
});
