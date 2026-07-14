/**
 * PerAppGpgRotationService — sichere Zwei-Phasen-Rotation der per-App-GPG-
 * Passphrase (docs/specs/per-app-gpg-passphrase-rotation.md, F-073/S-338).
 *
 * Goldenes Prinzip (Owner 2026-07-13): **beweisen, umschalten, alt erst am
 * Schluss weg**. Drei Methoden, geteilte Idempotenz-/Sicherheits-Garantien:
 *   - `startRotation(app, opts)`  — Phase (a)+(b): Kandidat ins Feld `naechste`
 *     schreiben, dann eine harte Beweis-Runde (Alt-Decrypt → Neu-Encrypt in
 *     eine NEUE Datei → Probe-Decrypt → Wertgleich-Vergleich) — VOR jeder
 *     Mutation am aktiven Zustand. Jeder Fehlschlag ⇒ Abbruch ohne Änderung
 *     am aktiven `.env.gpg`/Item-Passwortfeld (AC1–AC3, AC10, AC12).
 *   - `commitRotation(app, opts)` — Phase (c): Umschalten (Commit-Punkt).
 *     ZUERST Bitwarden (neu → aktiv, alt → `vorherige`, `naechste` geleert),
 *     DANACH Commit + Push des neu verschlüsselten `.env.gpg` auf den
 *     Default-Branch (kein PR). Scheitert der Git-Schritt, wird die
 *     Bitwarden-Umschaltung zurückgerollt (AC4, AC11, AC13).
 *   - `discardPrevious(app, opts)` — Phase (d): manuelle, explizit bestätigte
 *     Entsorgung des Rollback-Ankers `vorherige` (AC5).
 *
 * `.env.gpg`-Zugriffsweg (AC10): der lokale Workspace-Klon (`WORKSPACE_DIR`)
 * — VOR der Beweis-Runde wird frisch gepullt (wiederverwendet
 * `WorkspaceMutator#pullClone`); Rückschreiben in (c) per direktem
 * Commit + Push (wiederverwendet `WorkspaceMutator#commitAndPushFile`, KEIN
 * PR). Fehlt der Klon → Abbruch VOR (a) (AC12).
 *
 * Zustandslosigkeit zwischen Aufrufen: `startRotation` und `commitRotation`
 * sind SEPARATE Aufrufe (ggf. über einen Server-Neustart hinweg). Der
 * gesamte Zwischenzustand lebt daher extern, nicht im Prozess-Speicher:
 *   - der Kandidat-Wert im Bitwarden-Feld `naechste`,
 *   - die bewiesene Ziphertext-Datei `.env.gpg.next` im Klon.
 * `commitRotation` liest beide beim Aufruf frisch — kein In-Memory-Cache.
 *
 * Boundary-Disziplin: spricht NIE selbst mit `bw` (nutzt ausschließlich die
 * Session des bestehenden `BitwardenDeployLoginService`) und NIE selbst mit
 * `git` (nutzt ausschließlich `WorkspaceMutator#pullClone`/`#commitAndPushFile`).
 * GPG-Ver-/Entschlüsselung nutzt den bestehenden `BackupCrypto`-Wrapper
 * (symmetrisch, Passphrase via stdin — nie Argv).
 *
 * Security (Spec S1–S6, Floor):
 *   - Weder alte noch neue Passphrase noch `.env.gpg`-Klartext erscheint in
 *     Log/Audit/Response/WS/Argv/Bundle (AC7). Rückgabe ist geheimnisfrei:
 *     nur `{ ok, phase?, errorClass?, reason? }`.
 *   - Audit-First: EIN wertfreier Audit-Eintrag je Phase (a/b/c/d, AC6) —
 *     schlägt der Audit-Write fehl, unterbleibt genau diese Phase.
 *   - Alle Datei-Writes atomar (tmp + rename, NFR).
 *
 * @module PerAppGpgRotationService
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { encrypt as gpgEncrypt, decrypt as gpgDecrypt } from './BackupCrypto.js';
import { mintInstallationToken } from './githubAppToken.js';
import { resolveProjectSlug, validateProjectPath, ProjectPathError } from './workspacePath.js';
import { gpgItemNameFor } from './PerAppGpgProvisioningService.js';
import { WorkspaceMutatorError } from './WorkspaceMutator.js';

/** Zeichensatz/Länge für die App-Slug — identisch zu PerAppGpgProvisioningService. */
const APP_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_LEN = 128;

/** Mindest-Entropie der Kandidaten-Passphrase (Bytes) — AC1, identisch zur Provisionierung. */
const MIN_PASSPHRASE_BYTES = 32;

/** Dateinamen im Klon-Root (AC2/AC4/AC10/AC11). */
const ENV_GPG_FILENAME = '.env.gpg';
const ENV_GPG_NEXT_FILENAME = '.env.gpg.next';

export class PerAppGpgRotationService {
  /** @type {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} */
  #deployLoginService;
  /** @type {import('./AuditStore.js').AuditStore} */
  #auditStore;
  /** @type {import('./WorkspaceMutator.js').WorkspaceMutator} */
  #workspaceMutator;
  /** @type {import('./CredentialStore.js').CredentialStore|null} */
  #credentialStore;
  /** @type {Function|null} optionaler async Resolver `() => Promise<{ path, source }>` */
  #workspaceRootResolver;
  /** @type {{ readFile: Function, writeFile: Function, rename: Function, rm: Function, realpath: Function, stat: Function }} */
  #fsDeps;
  /** @type {{ encrypt: Function, decrypt: Function }} */
  #crypto;

  /**
   * @param {object} deps
   * @param {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} deps.deployLoginService
   * @param {import('./AuditStore.js').AuditStore} deps.auditStore
   * @param {import('./WorkspaceMutator.js').WorkspaceMutator} deps.workspaceMutator
   * @param {import('./CredentialStore.js').CredentialStore} [deps.credentialStore] - Pflicht für den Git-Push-Schritt (Token-Minting).
   * @param {Function} [deps.workspaceRootResolver] - Optionaler async Resolver `() => Promise<{ path, source }>` (AC10, pro Operation aufgelöst).
   * @param {object} [deps.fsDeps] - Injectable (Tests): `{ readFile, writeFile, rename, rm, realpath, stat }`.
   * @param {object} [deps.cryptoDeps] - Injectable (Tests): `{ encrypt, decrypt }` (Default: BackupCrypto.js).
   */
  constructor({ deployLoginService, auditStore, workspaceMutator, credentialStore, workspaceRootResolver, fsDeps, cryptoDeps } = {}) {
    if (!deployLoginService || typeof deployLoginService.openSession !== 'function') {
      throw new Error('[PerAppGpgRotationService] deployLoginService ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[PerAppGpgRotationService] auditStore ist Pflicht');
    }
    if (!workspaceMutator || typeof workspaceMutator.pullClone !== 'function' || typeof workspaceMutator.commitAndPushFile !== 'function') {
      throw new Error('[PerAppGpgRotationService] workspaceMutator ist Pflicht');
    }
    this.#deployLoginService = deployLoginService;
    this.#auditStore = auditStore;
    this.#workspaceMutator = workspaceMutator;
    this.#credentialStore = credentialStore ?? null;
    this.#workspaceRootResolver = workspaceRootResolver ?? null;
    this.#fsDeps = { readFile, writeFile, rename, rm, realpath, stat, ...fsDeps };
    this.#crypto = { encrypt: gpgEncrypt, decrypt: gpgDecrypt, ...cryptoDeps };
  }

  /**
   * Phase (a)+(b): Kandidat hinterlegen + Beweis-Runde (AC1–AC3, AC10, AC12).
   *
   * @param {string} app
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ ok: boolean, phase: 'candidate-proved'|'aborted', errorClass?: string, reason?: string }>}
   */
  async startRotation(app, { identity } = {}) {
    const identityStr = identity ?? null;

    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { ok: false, phase: 'aborted', errorClass: 'error', reason: validation.reason };
    }
    const { itemName } = validation;

    // AC12: Klon-Existenz-Check VOR jeder Änderung (vor (a)) — kein Audit,
    // keine Kandidaten-Anlage, keine Bitwarden-Mutation, kein Repo-Zugriff.
    const clone = await this.#resolveClonePath(app);
    if (!clone.ok) {
      return { ok: false, phase: 'aborted', errorClass: 'clone-missing', reason: 'App zuerst in den Workspace klonen.' };
    }
    const { clonePath } = clone;

    // Zugang-Gate + naechste-Konflikt-Check + aktive Passphrase lesen (Session #1).
    let oldPassphrase;
    {
      let session;
      try {
        session = await this.#deployLoginService.openSession();
      } catch (err) {
        return this.#classifyOpenSessionError(err);
      }
      try {
        const fields = await session.readItemFields(itemName);
        if (fields.naechste) {
          return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Rotation läuft bereits — ein Kandidat ist bereits hinterlegt.' };
        }
        if (!fields.password) {
          return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Aktive Passphrase im Bitwarden-Item nicht gefunden.' };
        }
        oldPassphrase = fields.password;
      } catch (err) {
        return this.#classifySessionError(err);
      } finally {
        await session.close();
      }
    }

    // AC6: Audit-First vor Phase (a).
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-rotate:a:${app}` });
    } catch {
      return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    // AC1: Kandidat erzeugen + in naechste hinterlegen — aktives Passwortfeld
    // und vorherige bleiben unangetastet (Session #2).
    const candidate = randomBytes(MIN_PASSPHRASE_BYTES).toString('base64url');
    {
      let session;
      try {
        session = await this.#deployLoginService.openSession();
      } catch (err) {
        return this.#classifyOpenSessionError(err);
      }
      try {
        await session.updateItemFields(itemName, { naechste: candidate });
      } catch {
        return { ok: false, phase: 'aborted', errorClass: 'bw-update-failed', reason: 'Kandidat konnte nicht in Bitwarden hinterlegt werden.' };
      } finally {
        await session.close();
      }
    }

    // AC6: Audit-First vor Phase (b).
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-rotate:b:${app}` });
    } catch {
      await this.#discardCandidateBestEffort(itemName);
      return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    // AC10: frischer Pull VOR der Beweis-Runde.
    try {
      await this.#workspaceMutator.pullClone(app, () => this.#mintToken());
    } catch {
      await this.#discardCandidateBestEffort(itemName);
      return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Workspace-Klon konnte nicht aktualisiert werden (git pull).' };
    }

    // AC2/AC3: Beweis-Runde (rein dateibasiert, kein bw-Zugriff nötig).
    const proof = await this.#runProofRound(clonePath, oldPassphrase, candidate);
    if (!proof.ok) {
      await this.#discardCandidateBestEffort(itemName);
      return { ok: false, phase: 'aborted', errorClass: proof.errorClass, reason: proof.reason };
    }

    return { ok: true, phase: 'candidate-proved' };
  }

  /**
   * Phase (c): Umschalten (Commit-Punkt) — ZUERST Bitwarden, DANACH Commit +
   * Push (AC4, AC11); scheitert der Git-Schritt, Bitwarden-Rückabwicklung (AC13).
   *
   * @param {string} app
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ ok: boolean, errorClass?: string, reason?: string }>}
   */
  async commitRotation(app, { identity } = {}) {
    const identityStr = identity ?? null;

    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { ok: false, errorClass: 'error', reason: validation.reason };
    }
    const { itemName } = validation;

    const clone = await this.#resolveClonePath(app);
    if (!clone.ok) {
      return { ok: false, errorClass: 'clone-missing', reason: 'App zuerst in den Workspace klonen.' };
    }
    const { clonePath } = clone;

    // Kandidat + aktive Passphrase lesen (Session #1).
    let candidate;
    let oldPassphrase;
    {
      let session;
      try {
        session = await this.#deployLoginService.openSession();
      } catch (err) {
        return { ok: false, ...this.#classifyOpenSessionErrorRaw(err) };
      }
      try {
        const fields = await session.readItemFields(itemName);
        if (!fields.naechste) {
          return { ok: false, errorClass: 'error', reason: 'Kein Rotations-Kandidat vorhanden — zuerst die Beweis-Runde ausführen.' };
        }
        candidate = fields.naechste;
        oldPassphrase = fields.password;
      } catch (err) {
        const { errorClass, reason } = this.#classifySessionError(err);
        return { ok: false, errorClass, reason };
      } finally {
        await session.close();
      }
    }

    // AC10/AC2: der bewiesene Kandidat liegt als .env.gpg.next im Klon.
    const nextPath = join(clonePath, ENV_GPG_NEXT_FILENAME);
    let nextCipher;
    try {
      nextCipher = await this.#fsDeps.readFile(nextPath);
    } catch {
      return { ok: false, errorClass: 'error', reason: 'Kein bewiesener Kandidat im Klon gefunden — Beweis-Runde erneut ausführen.' };
    }

    // AC6: Audit-First vor Phase (c).
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-rotate:c:${app}` });
    } catch {
      return { ok: false, errorClass: 'error', reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    // AC4: ZUERST Bitwarden — neu → aktiv, alt → vorherige, naechste geleert (Session #2).
    {
      let session;
      try {
        session = await this.#deployLoginService.openSession();
      } catch (err) {
        return { ok: false, ...this.#classifyOpenSessionErrorRaw(err) };
      }
      try {
        await session.updateItemFields(itemName, { password: candidate, vorherige: oldPassphrase, naechste: null });
      } catch {
        return { ok: false, errorClass: 'bw-update-failed', reason: 'Bitwarden-Umschaltung fehlgeschlagen — kein Repo-Zugriff, kein Teil-Zustand.' };
      } finally {
        await session.close();
      }
    }

    // AC4/AC11: DANACH das neu verschlüsselte .env.gpg im Klon schreiben + committen + pushen.
    try {
      await this.#writeFileAtomic(join(clonePath, ENV_GPG_FILENAME), nextCipher);
      await this.#workspaceMutator.commitAndPushFile(app, ENV_GPG_FILENAME, () => this.#mintToken(), {
        commitMessage: 'chore: rotate GPG passphrase (.env.gpg)',
      });
    } catch (err) {
      // AC13: Beide-Seiten-Atomarität — Bitwarden-Rückabwicklung (best-effort, Fehler
      // wird geloggt aber überschreibt nicht das primäre Fehlerergebnis). Die
      // Fehlerklasse wird 1:1 durchgereicht, wenn sie im Katalog dieser Spec
      // dokumentiert ist (commit-failed|push-failed|branch-mismatch — Finding 2,
      // Review-Iteration 2); jede andere (WorkspaceMutator-interne, hier praktisch
      // unerreichbare) Klasse fällt sicher auf push-failed zurück.
      const KNOWN_CLASSES = new Set(['commit-failed', 'push-failed', 'branch-mismatch', 'default-branch-undetermined']);
      const rawClass = (err instanceof WorkspaceMutatorError) ? err.errorClass : null;
      const errorClass = KNOWN_CLASSES.has(rawClass) ? rawClass : 'push-failed';
      await this.#rollbackBitwardenBestEffort(itemName, { oldPassphrase, candidate });
      let reason;
      if (errorClass === 'branch-mismatch') {
        reason = 'Workspace-Klon ist nicht auf dem Default-Branch — Rückschreiben abgebrochen, Bitwarden-Umschaltung zurückgerollt.';
      } else if (errorClass === 'default-branch-undetermined') {
        // Ehrliche Meldung statt „push-failed": der Push fand nie statt — der Default-Branch
        // des Klons war nicht ermittelbar (origin/HEAD fehlt und liess sich nicht herstellen).
        reason = 'Default-Branch des Workspace-Klons nicht ermittelbar (origin/HEAD nicht gesetzt) — Rückschreiben abgebrochen, Bitwarden-Umschaltung zurückgerollt.';
      } else {
        reason = 'Rückschreiben des .env.gpg fehlgeschlagen — Bitwarden-Umschaltung zurückgerollt.';
      }
      return { ok: false, errorClass, reason };
    }

    // Erfolg — der bewiesene Kandidat-Artefakt wird nicht mehr gebraucht (best-effort Cleanup).
    await this.#fsDeps.rm(nextPath, { force: true }).catch(() => {});

    return { ok: true };
  }

  /**
   * Phase (d): manuelle, explizit bestätigte Entsorgung des Rollback-Ankers
   * `vorherige` (AC5) — NIE automatisch im Rotations-Flow ausgelöst.
   *
   * @param {string} app
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ ok: boolean, errorClass?: string, reason?: string }>}
   */
  async discardPrevious(app, { identity } = {}) {
    const identityStr = identity ?? null;

    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { ok: false, errorClass: 'error', reason: validation.reason };
    }
    const { itemName } = validation;

    // AC6: Audit-First vor Phase (d).
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-rotate:d:${app}` });
    } catch {
      return { ok: false, errorClass: 'error', reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    let session;
    try {
      session = await this.#deployLoginService.openSession();
    } catch (err) {
      return { ok: false, ...this.#classifyOpenSessionErrorRaw(err) };
    }
    try {
      await session.updateItemFields(itemName, { vorherige: null });
      return { ok: true };
    } catch {
      return { ok: false, errorClass: 'bw-update-failed', reason: 'Rollback-Anker konnte nicht entfernt werden.' };
    } finally {
      await session.close();
    }
  }

  // ── intern ────────────────────────────────────────────────────────────────

  /**
   * Validiert App-Slug + zusammengesetzten Item-Namen — identisch zu
   * PerAppGpgProvisioningService#validateApp (geteilte Konvention, `gpgItemNameFor`).
   * @param {unknown} app
   * @returns {{ ok: true, itemName: string } | { ok: false, reason: string }}
   */
  #validateApp(app) {
    if (typeof app !== 'string' || !app.trim() || app.length > MAX_APP_LEN || !APP_SLUG_RE.test(app)) {
      return { ok: false, reason: 'Ungültiger App-Slug' };
    }
    return { ok: true, itemName: gpgItemNameFor(app) };
  }

  /**
   * Löst + validiert den Workspace-Klon-Pfad der App (AC10/AC12) — wiederverwendet
   * die bestehende Slug→Pfad-Auflösung + Boundary-/Existenz-Validierung
   * (workspacePath.js, dieselbe Guard-Technik wie WsGateway/commandRouter).
   * @param {string} app
   * @returns {Promise<{ ok: true, clonePath: string } | { ok: false }>}
   */
  async #resolveClonePath(app) {
    let mountRoot;
    if (this.#workspaceRootResolver) {
      try {
        const resolved = await this.#workspaceRootResolver();
        mountRoot = resolved?.path;
      } catch {
        mountRoot = undefined;
      }
    }
    if (!mountRoot) mountRoot = process.env.WORKSPACE_DIR ?? '';

    let slugPath;
    try {
      slugPath = resolveProjectSlug(app, { mountRoot });
    } catch {
      return { ok: false };
    }
    if (!slugPath) return { ok: false };

    try {
      const { resolvedPath } = await validateProjectPath(slugPath, {
        mountRoot,
        realpath: this.#fsDeps.realpath,
        stat: this.#fsDeps.stat,
      });
      return { ok: true, clonePath: resolvedPath };
    } catch (err) {
      if (err instanceof ProjectPathError) return { ok: false };
      return { ok: false };
    }
  }

  /**
   * Mintet einen frischen Installation-Token für den git-Schritt (transient,
   * wiederverwendet den geteilten githubAppToken-Helfer, kein zweiter Minting-Pfad).
   * @returns {Promise<string>}
   */
  async #mintToken() {
    if (!this.#credentialStore) {
      throw new Error('CredentialStore nicht konfiguriert');
    }
    return mintInstallationToken(this.#credentialStore);
  }

  /**
   * AC2/AC3: Beweis-Runde — Alt-Decrypt → Neu-Encrypt (NEUE Datei) → Probe-Decrypt
   * → Wertgleich-Vergleich. JEDER Fehlschlag ⇒ kein Teil-Zustand (die neue Datei
   * wird bei einem Fehlschlag wieder entfernt).
   * @param {string} clonePath
   * @param {string} oldPassphrase
   * @param {string} newPassphrase
   * @returns {Promise<{ ok: true } | { ok: false, errorClass: string, reason: string }>}
   */
  async #runProofRound(clonePath, oldPassphrase, newPassphrase) {
    const currentPath = join(clonePath, ENV_GPG_FILENAME);
    const nextPath = join(clonePath, ENV_GPG_NEXT_FILENAME);

    let oldCipher;
    try {
      oldCipher = await this.#fsDeps.readFile(currentPath);
    } catch {
      return { ok: false, errorClass: 'decrypt-old-failed', reason: '.env.gpg im Klon nicht gefunden.' };
    }

    let plaintext;
    try {
      plaintext = await this.#crypto.decrypt(oldPassphrase, oldCipher);
    } catch {
      return { ok: false, errorClass: 'decrypt-old-failed', reason: 'Entschlüsselung mit der aktiven Passphrase fehlgeschlagen.' };
    }

    let newCipher;
    try {
      newCipher = await this.#crypto.encrypt(newPassphrase, plaintext);
    } catch {
      return { ok: false, errorClass: 'encrypt-new-failed', reason: 'Verschlüsselung mit der neuen Passphrase fehlgeschlagen.' };
    }

    try {
      await this.#writeFileAtomic(nextPath, newCipher);
    } catch {
      return { ok: false, errorClass: 'encrypt-new-failed', reason: 'Neue .env.gpg-Datei konnte nicht geschrieben werden.' };
    }

    let probePlaintext;
    try {
      probePlaintext = await this.#crypto.decrypt(newPassphrase, newCipher);
    } catch {
      await this.#fsDeps.rm(nextPath, { force: true }).catch(() => {});
      return { ok: false, errorClass: 'verify-failed', reason: 'Probe-Entschlüsselung der neuen Datei fehlgeschlagen.' };
    }

    if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(probePlaintext) || !plaintext.equals(probePlaintext)) {
      await this.#fsDeps.rm(nextPath, { force: true }).catch(() => {});
      return { ok: false, errorClass: 'verify-failed', reason: 'Klartext-Vergleich nach Neu-Verschlüsselung stimmt nicht überein.' };
    }

    return { ok: true };
  }

  /**
   * Schreibt `buffer` atomar (tmp + rename, NFR) nach `targetPath`.
   * @param {string} targetPath
   * @param {Buffer} buffer
   * @returns {Promise<void>}
   */
  async #writeFileAtomic(targetPath, buffer) {
    const dir = dirname(targetPath);
    const tmpPath = join(dir, `.${basename(targetPath)}.tmp-${randomBytes(6).toString('hex')}`);
    await this.#fsDeps.writeFile(tmpPath, buffer, { mode: 0o600 });
    await this.#fsDeps.rename(tmpPath, targetPath);
  }

  /**
   * Verwirft best-effort einen zuvor geschriebenen Kandidaten (Feld `naechste`
   * leeren) — Spec §Verhalten Schritt 5: "Kandidat verwerfen = Feld naechste
   * leeren". Fehler werden verschluckt (der primäre Fehlerpfad bleibt maßgeblich).
   * @param {string} itemName
   * @returns {Promise<void>}
   */
  async #discardCandidateBestEffort(itemName) {
    let session;
    try {
      session = await this.#deployLoginService.openSession();
      await session.updateItemFields(itemName, { naechste: null });
    } catch {
      // best-effort — der ursprüngliche Fehlerpfad bleibt maßgeblich.
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  /**
   * AC13: rollt die Bitwarden-Umschaltung zurück (Zustand vor (c)) — best-effort,
   * überschreibt nicht das primäre Fehlerergebnis (Rückgabe des Aufrufers).
   * @param {string} itemName
   * @param {{ oldPassphrase: string, candidate: string }} prior
   * @returns {Promise<void>}
   */
  async #rollbackBitwardenBestEffort(itemName, { oldPassphrase, candidate }) {
    let session;
    try {
      session = await this.#deployLoginService.openSession();
      await session.updateItemFields(itemName, { password: oldPassphrase, vorherige: null, naechste: candidate });
    } catch (err) {
      console.error('[PerAppGpgRotationService] AC13-Rollback fehlgeschlagen:', err?.deployErrorClass ?? 'error');
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  /**
   * Klassifiziert einen Fehler aus `deployLoginService.openSession()` (Zugang-Gate).
   * Gibt NUR `{ errorClass, reason }` zurück — der Aufrufer ergänzt `ok`/`phase`
   * passend zum jeweiligen Kontrakt (startRotation kennt `phase`, commitRotation/
   * discardPrevious nicht).
   * @param {Error & { deployErrorClass?: string }} err
   * @returns {{ errorClass: string, reason: string }}
   */
  #classifyOpenSessionErrorRaw(err) {
    const cls = err?.deployErrorClass ?? 'error';
    if (cls === 'access-incomplete') {
      return { errorClass: 'access-not-ready', reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.' };
    }
    return { errorClass: 'error', reason: 'Bitwarden-Login fehlgeschlagen — Zugang prüfen.' };
  }

  /** Wie {@link #classifyOpenSessionErrorRaw}, für `startRotation` (mit `phase: 'aborted'`). */
  #classifyOpenSessionError(err) {
    return { ok: false, phase: 'aborted', ...this.#classifyOpenSessionErrorRaw(err) };
  }

  /**
   * Klassifiziert einen Fehler aus einer bereits offenen bw-Session (Item-Read/-Update).
   * @param {Error & { deployErrorClass?: string }} err
   * @returns {{ ok: false, phase: 'aborted', errorClass: string, reason: string }}
   */
  #classifySessionError(err) {
    const cls = err?.deployErrorClass ?? 'error';
    if (cls === 'access-incomplete') {
      return { ok: false, phase: 'aborted', errorClass: 'access-not-ready', reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.' };
    }
    if (cls === 'item-not-found') {
      return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Bitwarden-Item nicht gefunden — App zuerst provisionieren.' };
    }
    return { ok: false, phase: 'aborted', errorClass: 'error', reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' };
  }
}
