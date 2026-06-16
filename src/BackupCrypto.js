/**
 * BackupCrypto.js — GPG-symmetrischer Verschlüsselungs-Wrapper (Backup-Engine, S-140).
 *
 * Kapselt den einzigen GPG-Aufruf der Backup-Engine. Die Passphrase (Master-Key) wird
 * NICHT über Argv übergeben — sie fließt über stdin via `--passphrase-fd 0`
 * (AC7 / Security-Floor: kein Secret in Argv/Log/Prozess-Listing).
 *
 * Boundary-Vertrag:
 *   - encrypt(passphrase, plaintextBuffer) → Buffer (GPG-AES256-Container)
 *   - decrypt(passphrase, ciphertextBuffer) → Buffer (Klartext)
 *   - Passphrase erscheint NIEMALS in Argv, Log, Fehlertext oder Rückgabewert.
 *
 * GPG-Optionen:
 *   --batch                   nicht-interaktiv
 *   --yes                     überschreibe Output ohne Prompt
 *   --pinentry-mode loopback  leitet Passphrase-Abfrage auf --passphrase-fd um
 *   --passphrase-fd 0         liest Passphrase von stdin (fd 0)
 *   --symmetric               symmetrische Verschlüsselung
 *   --cipher-algo AES256      expliziter Algorithmus
 *   --armor                   ASCII-armor Output (portabel)
 *   --output -                Output auf stdout
 *   --decrypt                 Entschlüsseln (statt Verschlüsseln)
 *
 * @module BackupCrypto
 */

import { spawn } from 'node:child_process';

/** Timeout für einen einzelnen GPG-Aufruf (ms). */
const GPG_TIMEOUT_MS = 30_000;

/**
 * Prüft ob gpg im PATH verfügbar ist.
 * Gibt true zurück wenn ja, false wenn nicht.
 * @returns {Promise<boolean>}
 */
export async function isGpgAvailable() {
  return new Promise((resolve) => {
    const child = spawn('gpg', ['--version'], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Verschlüsselt `plaintextBuffer` GPG-symmetrisch mit `passphrase` als Passphrase.
 * Die Passphrase wird über stdin (fd 0) übergeben — NIEMALS über Argv.
 *
 * @param {string} passphrase - Master-Key (nicht geloggt, nicht in Argv)
 * @param {Buffer} plaintextBuffer - zu verschlüsselnder Klartext
 * @returns {Promise<Buffer>} verschlüsselter GPG-ASCII-armor-Container
 * @throws {Error} errorClass: 'gpg-encrypt-failed' bei GPG-Fehler oder Timeout
 */
export async function encrypt(passphrase, plaintextBuffer) {
  return _runGpg(
    [
      '--batch',
      '--yes',
      '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0',
      '--symmetric',
      '--cipher-algo', 'AES256',
      '--armor',
      '--output', '-',
    ],
    passphrase,
    plaintextBuffer,
    'gpg-encrypt-failed',
  );
}

/**
 * Entschlüsselt `ciphertextBuffer` (GPG-ASCII-armor) mit `passphrase`.
 * Die Passphrase wird über stdin (fd 0) übergeben — NIEMALS über Argv.
 *
 * @param {string} passphrase - Master-Key (nicht geloggt, nicht in Argv)
 * @param {Buffer} ciphertextBuffer - GPG-verschlüsselter Buffer
 * @returns {Promise<Buffer>} entschlüsselter Klartext
 * @throws {Error} errorClass: 'gpg-decrypt-failed' bei GPG-Fehler, falschem Key oder Timeout
 */
export async function decrypt(passphrase, ciphertextBuffer) {
  return _runGpg(
    [
      '--batch',
      '--yes',
      '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0',
      '--decrypt',
      '--output', '-',
    ],
    passphrase,
    ciphertextBuffer,
    'gpg-decrypt-failed',
  );
}

/**
 * Interne Hilfsfunktion: GPG-Prozess spawnen, Passphrase + Daten über stdin übergeben,
 * stdout als Buffer einsammeln.
 *
 * AC7 (Security-Floor):
 *   - passphrase erscheint NICHT im spawn()-Argv-Array
 *   - Fehlertext enthält NICHT die Passphrase
 *   - stderr wird NICHT nach außen weitergegeben (kann Passphrase-Fragmente enthalten)
 *
 * @param {string[]} args - GPG-Argumente (OHNE Passphrase)
 * @param {string} passphrase - Master-Key (via stdin, nicht in args)
 * @param {Buffer} inputData - Daten die auf stdin geschrieben werden (nach Passphrase + Newline)
 * @param {string} errorClass - Fehlerklasse für den geworfenen Error
 * @returns {Promise<Buffer>}
 */
async function _runGpg(args, passphrase, inputData, errorClass) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // AC7: passphrase erscheint NICHT im Argv-Array — wird via stdin übergeben
      child = spawn('gpg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = new Error(`[BackupCrypto] GPG-Spawn fehlgeschlagen: ${err.message}`);
      e.errorClass = errorClass;
      return reject(e);
    }

    const outChunks = [];
    // stderr sammeln für Diagnose — aber NICHT nach außen weitergeben (AC7)
    const errChunks = [];

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    // Timeout-Guard
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const e = new Error('[BackupCrypto] GPG-Timeout nach 30 s');
      e.errorClass = errorClass;
      reject(e);
    }, GPG_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      // AC7: Fehlertext enthält NICHT die Passphrase
      const e = new Error(`[BackupCrypto] GPG-Prozess-Fehler: ${err.message}`);
      e.errorClass = errorClass;
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(outChunks));
      } else {
        // AC7: stderr (kann Passphrase-Fragmente enthalten) wird NICHT nach außen weitergegeben
        // Nur Exit-Code ist sicher zu loggen
        const e = new Error(`[BackupCrypto] GPG beendete mit Exit-Code ${code}`);
        e.errorClass = errorClass;
        reject(e);
      }
    });

    // stdin: erst Passphrase + Newline (für --passphrase-fd 0), dann Eingabedaten
    // GPG liest die Passphrase bis zum ersten Newline von fd 0.
    // AC7: Passphrase wird via stdin geliefert, NICHT via Argv
    try {
      child.stdin.write(passphrase + '\n');
      child.stdin.write(inputData);
      child.stdin.end();
    } catch {
      // stdin bereits geschlossen (race nach Kill) — ignorieren
    }
  });
}
