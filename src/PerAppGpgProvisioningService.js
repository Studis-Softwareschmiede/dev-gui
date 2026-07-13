/**
 * PerAppGpgProvisioningService — Kern-Dienst für die per-App-GPG-Passphrasen-
 * Provisionierung (docs/specs/per-app-gpg-passphrase-provisioning.md, F-073/S-335).
 *
 * Erzeugt (falls nötig) eine kryptografisch starke Zufalls-Passphrase je App und
 * hinterlegt sie idempotent als Bitwarden-Item `env.gpg-passphrase-<app>`. Wird
 * sowohl von der Auto-Provisionierung (new-project-Abschluss, künftige Story)
 * als auch von der Nach-Provisionierung (Knopf je App, AC10-Endpunkt) mit
 * DERSELBEN Idempotenz-Garantie aufgerufen (Spec §"Provisionierungs-Dienst").
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
 *   - AC8: Rückgabe ist geheimnisfrei — nur `{ result, reason? }`.
 *   - AC9: Audit-First — Aktion `deploy:gpg-provision:<app>` VOR jeder
 *     Provisionierung, ohne Werte; schlägt der Audit-Write fehl, unterbleibt
 *     die Provisionierung (`result: "failed"`).
 *
 * @module PerAppGpgProvisioningService
 */

import { randomBytes } from 'node:crypto';

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

  /**
   * @param {object} deps
   * @param {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} deps.deployLoginService
   * @param {import('./AuditStore.js').AuditStore} deps.auditStore
   */
  constructor({ deployLoginService, auditStore } = {}) {
    if (!deployLoginService || typeof deployLoginService.openSession !== 'function') {
      throw new Error('[PerAppGpgProvisioningService] deployLoginService ist Pflicht');
    }
    if (!auditStore || typeof auditStore.record !== 'function') {
      throw new Error('[PerAppGpgProvisioningService] auditStore ist Pflicht');
    }
    this.#deployLoginService = deployLoginService;
    this.#auditStore = auditStore;
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
    if (typeof app !== 'string' || !app.trim() || app.length > MAX_APP_LEN || !APP_SLUG_RE.test(app)) {
      return { result: 'failed', reason: 'Ungültiger App-Slug' };
    }
    const itemName = gpgItemNameFor(app);
    if (itemName.length > MAX_ITEM_NAME_LEN || !ITEM_NAME_RE.test(itemName)) {
      return { result: 'failed', reason: 'Ungültiger Bitwarden-Item-Name' };
    }

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
}
