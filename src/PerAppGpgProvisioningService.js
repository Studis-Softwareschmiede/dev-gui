/**
 * PerAppGpgProvisioningService — Kern-Dienst für die per-App-GPG-Passphrasen-
 * Provisionierung (docs/specs/per-app-gpg-passphrase-provisioning.md, F-073/
 * S-335/S-336; Naht-Architektur ADR-021 in docs/architecture.md).
 *
 * Erzeugt (falls nötig) eine kryptografisch starke Zufalls-Passphrase je App und
 * hinterlegt sie idempotent als Bitwarden-Item `env.gpg-passphrase-<app>`. Zwei
 * Aufruf-Pfade, geteilte Idempotenz-Garantie (Spec §"Provisionierungs-Dienst"):
 *   - `provision(app, opts)` — Nach-Provisionierung bestehender Apps (S-335,
 *     AC10-Endpunkt): erzeugt die Passphrase SELBST, legt das Item an.
 *   - `withScaffoldPassphrase(app, fn, opts)` — Auto-Provisionierung nach
 *     erfolgreichem `new-project`-Scaffold-Abschluss (S-336, AC4-AC6, ADR-021):
 *     erzeugt die Passphrase VOR dem Scaffold, reicht sie über eine transiente
 *     `0600`-Datei an `fn({ gpgPassFilePath })` (Scaffold-Lauf mit
 *     `GPG_PASS_FILE=<pfad>`, typischerweise `HeadlessNewProjectRunner#run`)
 *     und legt das Bitwarden-Item NACH Scaffold-Erfolg mit DERSELBEN Passphrase
 *     an (AC6 — kein Delegieren an `provision()`s eigene Generierung, sonst
 *     Wert-Divergenz zwischen `.env.gpg` und Bitwarden-Item). Die Rückgabe
 *     trägt zusätzlich ein explizites, nicht überladenes `scaffoldOk`-Flag
 *     (S-387-Fund, `docs/specs/obsidian-question-catalog.md` AC14): `true`
 *     genau dann, wenn der eingereichte `fn`-Aufruf selbst erfolgreich
 *     durchlief — UNABHÄNGIG vom `result`-Wert (der auch die
 *     Bitwarden-Teil-Ergebnisse `access-not-ready`/`already-exists`/`failed`
 *     NACH erfolgreichem Scaffold codiert). `result !== 'failed'` allein ist
 *     KEIN zuverlässiger Scaffold-Erfolgs-Indikator — Aufrufer, die wissen
 *     müssen, ob der Scaffold selbst lief (z.B. `ObsidianTargetPreparer`),
 *     müssen `scaffoldOk` auswerten, nicht `result`.
 *   - `itemExistsFor(app, opts)` — read-only Existenz-Abfrage (S-373, AC16):
 *     nutzt denselben `itemExists`-Pfad (bw get), mutiert nichts, legt nichts
 *     an, liefert NIE einen Passphrasen-Wert — nur `{ exists, reason? }`.
 *
 * Boundary-Disziplin: spricht NICHT selbst mit `bw` — nutzt ausschließlich die
 * Session des bestehenden `BitwardenDeployLoginService` (dessen `openSession()`
 * öffnet/schließt die isolierte bw-Session; `itemExists`/`createItem` sind dort
 * ergänzt, Technik wiederverwendet aus `BitwardenMasterKeyService#bwCreateItem`).
 * Damit bleibt EINE einzige Komponente, die tatsächlich `bw` spawnt (NFR
 * "Boundary-Disziplin").
 *
 * Security (Spec S1/S2/S4/S9):
 *   - AC1: Passphrase via `crypto.randomBytes` (>= 32 Byte), base64url-kodiert
 *     (url-/shell-sicher). Existiert nur transient im Prozess + in der
 *     bw-create-Anfrage — NIE in Log/Audit/Response/WS/Argv/Bundle.
 *   - AC2: Existenz-Check ZUERST (`itemExists`) — existiert das Item bereits,
 *     KEIN Überschreiben, KEINE neue Passphrase erzeugt/geleakt (No-Op).
 *   - AC3: Zugangs-Gate — `openSession()` wirft `access-incomplete` VOR jedem
 *     bw-Spawn, wenn der Deploy-Zugang nicht `ready` ist (BitwardenDeployAccessStore).
 *   - AC5 (S-336): die transiente `GPG_PASS_FILE`-Datei liegt in einem eigenen
 *     `0700`-`mkdtemp`-Verzeichnis, ist `0600` und wird `finally` — Erfolg UND
 *     Fehler — garantiert gelöscht (kein verwaistes Klartext-Artefakt).
 *   - AC8: Rückgabe ist geheimnisfrei — nur `{ result, reason? }`.
 *   - AC9: Audit-First — Aktion `deploy:gpg-provision:<app>` VOR jeder
 *     Provisionierung, ohne Werte; schlägt der Audit-Write fehl, unterbleibt
 *     die Provisionierung (`result: "failed"`).
 *
 * @module PerAppGpgProvisioningService
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Item-Namens-Konvention (identisch zur Deploy-Abruf-Konvention, AC15 [[deploy-bitwarden-gpg-injection]]). */
const ITEM_PREFIX = 'env.gpg-passphrase-';

/** Zeichensatz/Länge für die App-Slug (Ziel-Slug) — analog PROJECT_SLUG_RE-Konvention im Repo. */
const APP_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const MAX_APP_LEN = 128;

/** Zeichensatz/Länge für den zusammengesetzten Item-Namen — wie das bestehende `gpgBwItem`-Feld (deploymentsRouter). */
const ITEM_NAME_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_ITEM_NAME_LEN = 512;

/** Mindest-Entropie der generierten Passphrase (Bytes) — AC1. */
const MIN_PASSPHRASE_BYTES = 32;

/**
 * Liefert den kanonischen Bitwarden-Item-Namen für eine App (Verträge §, AC15-Konvention).
 * @param {string} app
 * @returns {string}
 */
export function gpgItemNameFor(app) {
  return `${ITEM_PREFIX}${app}`;
}

export class PerAppGpgProvisioningService {
  /** @type {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} */
  #deployLoginService;

  /** @type {import('./AuditStore.js').AuditStore} */
  #auditStore;

  /** @type {{ mkdtemp: Function, writeFile: Function, chmod: Function, rm: Function }} */
  #fsDeps;

  /**
   * @param {object} deps
   * @param {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} deps.deployLoginService
   * @param {import('./AuditStore.js').AuditStore} deps.auditStore
   * @param {object} [deps.fsDeps] - Injectable (Tests): `{ mkdtemp, writeFile, chmod, rm }`
   *   (Default: `node:fs/promises`) — nur für `withScaffoldPassphrase` (AC5-Tempfile).
   */
  constructor({ deployLoginService, auditStore, fsDeps } = {}) {
    if (!deployLoginService || typeof deployLoginService.openSession !== 'function') {
      throw new Error('[PerAppGpgProvisioningService] deployLoginService ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[PerAppGpgProvisioningService] auditStore ist Pflicht');
    }
    this.#deployLoginService = deployLoginService;
    this.#auditStore = auditStore;
    this.#fsDeps = { mkdtemp, writeFile, chmod, rm, ...fsDeps };
  }

  /**
   * Provisioniert (falls nötig) die per-App-GPG-Passphrase in Bitwarden.
   *
   * Ablauf:
   *   1. Input-Validierung (app-Slug + zusammengesetzter Item-Name).
   *   2. Audit-First (AC9) — ohne Werte; Audit-Fehler → `failed`, keine weitere Aktion.
   *   3. Session öffnen (AC3) — Zugang nicht ready → `access-not-ready`, kein bw-Aufruf.
   *   4. Existenz-Check (AC2) — existiert das Item → `already-exists` (No-Op).
   *   5. Sonst: Passphrase erzeugen (AC1) + Item anlegen (AC2) → `created`.
   *
   * @param {string} app - Ziel-Slug (App-Name)
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ result: 'created'|'already-exists'|'access-not-ready'|'failed', reason?: string }>}
   */
  async provision(app, { identity } = {}) {
    const identityStr = identity ?? null;

    // ── Input-Validierung (Security-Floor: untrusted Input vor jedem bw-Sink) ──
    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { result: 'failed', reason: validation.reason };
    }
    const { itemName } = validation;

    // ── AC9: Audit-First — VOR jeder Provisionierung, ohne Werte ────────────────
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-provision:${app}` });
    } catch {
      return { result: 'failed', reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    // ── AC3: Zugang-Gate — openSession() wirft 'access-incomplete' VOR jedem
    // bw-Spawn, wenn der Deploy-Zugang nicht vollständig/ready ist (kein Teil-Zustand). ──
    let session;
    try {
      session = await this.#deployLoginService.openSession();
    } catch (err) {
      const cls = err?.deployErrorClass ?? 'error';
      if (cls === 'access-incomplete') {
        return {
          result: 'access-not-ready',
          reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
        };
      }
      return { result: 'failed', reason: 'Bitwarden-Login fehlgeschlagen — Zugang prüfen.' };
    }

    try {
      // ── AC2: Existenz-Check ZUERST — existiert das Item bereits → No-Op ──────
      const exists = await session.itemExists(itemName);
      if (exists) {
        return {
          result: 'already-exists',
          reason: `Bitwarden-Item „${itemName}" existiert bereits — unverändert.`,
        };
      }

      // ── AC1: kryptografisch starke Zufalls-Passphrase (>= 32 Byte, url-sicher).
      // Existiert nur transient hier + in der bw-create-Anfrage — nie geloggt/
      // auditiert/zurückgegeben (S1). ──────────────────────────────────────────
      const passphrase = randomBytes(MIN_PASSPHRASE_BYTES).toString('base64url');

      // ── AC2: Item anlegen (bw encode + bw create item via stdin, kein Argv-Wert) ──
      await session.createItem(itemName, passphrase);
      return { result: 'created' };
    } catch (err) {
      const cls = err?.deployErrorClass ?? 'error';
      if (cls === 'access-incomplete') {
        // Edge-Case (Spec §Edge-Cases): Zugang wird zwischen Öffnen und Anlage unready.
        return {
          result: 'access-not-ready',
          reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
        };
      }
      return { result: 'failed', reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' };
    } finally {
      await session.close();
    }
  }

  /**
   * Auto-Provisionierung nach erfolgreichem `new-project`-Scaffold-Abschluss
   * (S-336, AC4-AC6, ADR-021 — die EINE server-seitige Naht). Erzeugt die
   * Passphrase VOR dem Scaffold, reicht sie über eine transiente `0600`-Datei
   * an `fn({ gpgPassFilePath })` (bzw. `fn({})` in den Fallback-Zweigen ohne
   * Datei) und legt — NUR bei Scaffold-Erfolg — das Bitwarden-Item mit
   * DERSELBEN Passphrase an.
   *
   * Ablauf (ADR-021 §Entscheidung, Schritte 1-8):
   *   1. Slug-/Item-Namens-Validierung (identisch `provision()`).
   *   2. Audit-First (AC9) — ohne Werte; Audit-Fehler → `failed`, `fn()` wird
   *      NICHT aufgerufen (kein Scaffold ohne Audit-Beleg).
   *   3. Vor-Prüfung (kurzes bw-Fenster): Zugang-Gate + `itemExists`.
   *      - Zugang unready → `fn({})` (Plugin-Fallback-Scaffold, KEINE Datei/
   *        Item), Ergebnis `access-not-ready`.
   *      - Item existiert bereits (Slug-Kollision) → `fn({})` (KEINE Datei,
   *        sonst Mismatch `.env.gpg` ↔ Item), Ergebnis `already-exists`.
   *   4. Passphrase EINMAL erzeugen (AC1, wie `provision()`).
   *   5. Transiente `0600`-Datei in einem `0700`-`mkdtemp`-Verzeichnis (AC5).
   *   6. `fn({ gpgPassFilePath })` — Scaffold-Lauf mit `GPG_PASS_FILE=<pfad>`.
   *      Scaffold-Fehler (Rejection) → `failed`, KEIN Item (kein Teil-Zustand).
   *   7. Scaffold-Erfolg → idempotente Item-Anlage mit DERSELBEN Passphrase
   *      (AC6). `bw create` schlägt fehl → `failed`, KEIN Teil-Zustand.
   *      Zugang wird zwischen Schritt 3 und hier `unready` → `access-not-ready`.
   *   8. `finally`: Temp-Datei + -Verzeichnis IMMER entfernen (Erfolg UND
   *      Fehler, AC5 — kein verwaistes Klartext-Artefakt).
   *
   * @param {string} app - Ziel-Slug (App-Name)
   * @param {(args: { gpgPassFilePath?: string }) => Promise<*>} fn - Scaffold-
   *   Lauf-Aufrufer (z.B. `HeadlessNewProjectRunner#run`); resolve = Erfolg,
   *   reject = Fehlschlag. Wird IMMER genau einmal aufgerufen (außer bei
   *   Validierungs-/Audit-Fehler, die den Scaffold gar nicht erst starten).
   * @param {{ identity?: string|null }} [opts]
   * @returns {Promise<{ result: 'created'|'already-exists'|'access-not-ready'|'failed', scaffoldOk: boolean, reason?: string }>}
   */
  async withScaffoldPassphrase(app, fn, { identity } = {}) {
    const identityStr = identity ?? null;

    if (typeof fn !== 'function') {
      return { result: 'failed', scaffoldOk: false, reason: 'Interner Fehler — kein Scaffold-Aufrufer übergeben' };
    }

    // ── Input-Validierung (identisch provision()) ────────────────────────────
    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { result: 'failed', scaffoldOk: false, reason: validation.reason };
    }
    const { itemName } = validation;

    // ── AC9: Audit-First — VOR jeder Provisionierung, ohne Werte. Schlägt der
    // Audit-Write fehl, unterbleibt auch der Scaffold-Aufruf (kein Teil-Zustand). ──
    try {
      this.#auditStore.record({ identity: identityStr, command: `deploy:gpg-provision:${app}` });
    } catch {
      return { result: 'failed', scaffoldOk: false, reason: 'Audit-Write fehlgeschlagen — Aktion abgebrochen' };
    }

    // ── Vor-Prüfung: Zugang-Gate + itemExists (kurzes bw-Fenster) ────────────
    let preSession;
    try {
      preSession = await this.#deployLoginService.openSession();
    } catch (err) {
      const cls = err?.deployErrorClass ?? 'error';
      if (cls === 'access-incomplete') {
        const fallback = await this.#runFallbackScaffold(fn);
        return {
          result: 'access-not-ready',
          scaffoldOk: fallback.ok,
          reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
        };
      }
      return { result: 'failed', scaffoldOk: false, reason: 'Bitwarden-Login fehlgeschlagen — Zugang prüfen.' };
    }

    let exists;
    try {
      exists = await preSession.itemExists(itemName);
    } catch (err) {
      const cls = err?.deployErrorClass ?? 'error';
      if (cls === 'access-incomplete') {
        const fallback = await this.#runFallbackScaffold(fn);
        return {
          result: 'access-not-ready',
          scaffoldOk: fallback.ok,
          reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
        };
      }
      return { result: 'failed', scaffoldOk: false, reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' };
    } finally {
      await preSession.close();
    }

    if (exists) {
      // Edge-Case (Spec §Edge-Cases): Slug-Kollision bei echter Erst-Anlage —
      // transiente Passphrase wird verworfen (noch nicht erzeugt), Scaffold
      // läuft OHNE GPG_PASS_FILE (sonst Mismatch .env.gpg ↔ Item).
      const fallback = await this.#runFallbackScaffold(fn);
      return {
        result: 'already-exists',
        scaffoldOk: fallback.ok,
        reason: `Bitwarden-Item „${itemName}" existiert bereits — Scaffold läuft ohne Passphrasen-Durchreichung.`,
      };
    }

    // ── AC1: Passphrase EINMAL erzeugen — dieselbe geht in Datei UND createItem
    // (AC6, kein Delegieren an provision()s eigene Generierung). ─────────────
    const passphrase = randomBytes(MIN_PASSPHRASE_BYTES).toString('base64url');

    // ── AC5: transiente 0600-Datei in einem 0700-mkdtemp-Verzeichnis ────────
    let tmpDir;
    let gpgPassFilePath;
    try {
      tmpDir = await this.#fsDeps.mkdtemp(join(tmpdir(), 'gpg-pass-'));
      gpgPassFilePath = join(tmpDir, 'gpg-pass');
      await this.#fsDeps.writeFile(gpgPassFilePath, passphrase, { encoding: 'utf8', mode: 0o600 });
      await this.#fsDeps.chmod(gpgPassFilePath, 0o600);
    } catch {
      if (tmpDir) await this.#fsDeps.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { result: 'failed', scaffoldOk: false, reason: 'Temporäre Passphrasen-Datei konnte nicht angelegt werden.' };
    }

    try {
      // ── Scaffold-Lauf mit GPG_PASS_FILE — Erfolg = resolve, Fehlschlag = reject ──
      try {
        await fn({ gpgPassFilePath });
      } catch {
        // AC5/Edge-Cases: Scaffold bricht ab, NACHDEM die temp-Datei existiert —
        // die Datei wird trotzdem gelöscht (äußeres finally), kein Item, kein
        // Teil-Zustand. `scaffoldOk: false` — der Scaffold-fn-Aufruf selbst ist
        // gescheitert (S-387-Fund: NICHT aus `result` ableitbar).
        return { result: 'failed', scaffoldOk: false, reason: 'Projekt-Scaffold fehlgeschlagen — keine Provisionierung.' };
      }

      // ── Scaffold-Erfolg → idempotente Item-Anlage MIT DERSELBEN Passphrase (AC6).
      // `scaffoldOk: true` ab hier IMMER — fn() ist bereits erfolgreich durchgelaufen,
      // unabhängig vom weiteren Bitwarden-Teilergebnis (S-387-Fund). ─────────────────
      let postSession;
      try {
        postSession = await this.#deployLoginService.openSession();
      } catch (err) {
        const cls = err?.deployErrorClass ?? 'error';
        if (cls === 'access-incomplete') {
          // Edge-Case (Spec §Edge-Cases): Zugang wird zwischen Vor-Prüfung und
          // Item-Anlage unready. Scaffold ist bereits erfolgreich gelaufen —
          // das .env.gpg existiert, aber ohne Bitwarden-Gegenstück (Nach-
          // Provisionierung kann es später nachrüsten, AC7).
          return {
            result: 'access-not-ready',
            scaffoldOk: true,
            reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
          };
        }
        return { result: 'failed', scaffoldOk: true, reason: 'Bitwarden-Login fehlgeschlagen — Zugang prüfen.' };
      }

      try {
        await postSession.createItem(itemName, passphrase);
        return { result: 'created', scaffoldOk: true };
      } catch (err) {
        const cls = err?.deployErrorClass ?? 'error';
        if (cls === 'access-incomplete') {
          return {
            result: 'access-not-ready',
            scaffoldOk: true,
            reason: 'Bitte zuerst den Deploy-Zugang zu Bitwarden in den Einstellungen hinterlegen.',
          };
        }
        return { result: 'failed', scaffoldOk: true, reason: 'Bitwarden-Provisionierung fehlgeschlagen — Zugang/Verbindung prüfen.' };
      } finally {
        await postSession.close();
      }
    } finally {
      // ── AC5: Datei + Verzeichnis IMMER entfernen — Erfolg UND Fehler ─────────
      await this.#fsDeps.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Read-only Existenz-Abfrage — AC16 (v3, Owner 2026-07-18). Nutzt denselben
   * `itemExists`-Pfad (bw get) wie `provision()`, mutiert NICHTS, legt NICHTS
   * an. KEIN Audit-First (keine Mutation — AccessGuard + CRED_ADMIN_EMAILS im
   * Router genügt als Schutz, Spec-Vertrag "kein Audit-First-Zwang, da keine
   * Mutation"). Ist der Zugang nicht `ready` (oder ein anderer bw-Fehler tritt
   * auf), ist die Existenz UNBEKANNT — die Methode meldet dies geheimnisfrei
   * (`reason: 'access-not-ready'`), OHNE zu raten (kein `exists:true`/`false`
   * als Vermutung).
   *
   * @param {string} app - Ziel-Slug (App-Name)
   * @param {{ identity?: string|null }} [_opts] - Signatur-Parität zu
   *   provision()/withScaffoldPassphrase(); unbenutzt (kein Audit für read-only).
   * @returns {Promise<{ exists: boolean, reason?: 'access-not-ready' }>}
   */
  async itemExistsFor(app, _opts = {}) {
    // ── Input-Validierung (Security-Floor, Defense-in-Depth — Router validiert
    // bereits vorher): ungültiger Slug kann nicht existieren. ────────────────
    const validation = this.#validateApp(app);
    if (!validation.ok) {
      return { exists: false };
    }
    const { itemName } = validation;

    let session;
    try {
      session = await this.#deployLoginService.openSession();
    } catch {
      // Zugang nicht ready ODER anderer Login-Fehler: Existenz unbekannt —
      // geheimnisfrei melden, kein Raten (Spec §"Read-only Existenz-Abfrage").
      return { exists: false, reason: 'access-not-ready' };
    }

    try {
      const exists = await session.itemExists(itemName);
      return { exists };
    } catch {
      return { exists: false, reason: 'access-not-ready' };
    } finally {
      await session.close();
    }
  }

  /**
   * Führt den Scaffold-Fallback-Lauf OHNE `GPG_PASS_FILE` aus (Plugin-Fallback,
   * Spec AC3/Edge-Cases). Der zurückgegebene Provisionierungs-`result`
   * (`access-not-ready`/`already-exists`) ist bereits feststehend — der
   * Fallback-`fn`-Aufruf bleibt zwar best-effort (ein Fehlschlag hier crasht
   * `withScaffoldPassphrase()` nicht, `result` bleibt unverändert), ABER das
   * tatsächliche Gelingen/Scheitern von `fn()` wird über `{ ok }` an den
   * Aufrufer zurückgemeldet (S-387-Fund: `withScaffoldPassphrase()` setzt
   * darüber `scaffoldOk` korrekt statt es implizit als „erfolgreich" zu werten).
   * @param {(args: {}) => Promise<*>} fn
   * @returns {Promise<{ ok: boolean }>}
   */
  async #runFallbackScaffold(fn) {
    try {
      await fn({});
      return { ok: true };
    } catch {
      // best-effort — der Provisionierungs-`result` bleibt unabhängig davon,
      // aber `ok: false` meldet den tatsächlichen Scaffold-Fehlschlag weiter.
      return { ok: false };
    }
  }

  /**
   * Validiert App-Slug + zusammengesetzten Item-Namen (Security-Floor:
   * untrusted Input vor jedem bw-Sink) — geteilt zwischen `provision()` und
   * `withScaffoldPassphrase()`.
   * @param {unknown} app
   * @returns {{ ok: true, itemName: string } | { ok: false, reason: string }}
   */
  #validateApp(app) {
    if (typeof app !== 'string' || !app.trim() || app.length > MAX_APP_LEN || !APP_SLUG_RE.test(app)) {
      return { ok: false, reason: 'Ungültiger App-Slug' };
    }
    const itemName = gpgItemNameFor(app);
    if (itemName.length > MAX_ITEM_NAME_LEN || !ITEM_NAME_RE.test(itemName)) {
      return { ok: false, reason: 'Ungültiger Bitwarden-Item-Name' };
    }
    return { ok: true, itemName };
  }
}
