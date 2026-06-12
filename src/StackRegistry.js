/**
 * StackRegistry — Klartext-Registry für StackDefinition-Einträge.
 *
 * Persistenz-Entscheidung (ADR-Platzhalter stack-deploy-orchestration):
 *   Stack-Definitionen sind nicht-geheime Betreiber-Konfiguration (Klartext-Metadatum).
 *   Analog zur Workspace-Pfad-Konfiguration und SSH-Public-Keys werden sie im `meta`-Block
 *   der bestehenden `secrets.enc.json`-Datei des `CredentialStore` abgelegt —
 *   NICHT im verschlüsselten `entries`-Block (stack-deploy-orchestration.md AC1).
 *   Meta-Key-Schema: `stacks/<stackName>`; Wert = JSON-serialisierte StackDefinition.
 *   Begründung: kein eigener Store, kein neues Volume, kein neues Dateiformat;
 *   konsistent mit dem bestehenden Muster für nicht-geheime Betreiber-Konfiguration
 *   (ADR-005/007, ADR-006 „ein Dienst, SDK-frei").
 *
 * StackDefinition (Vertrag aus stack-deploy-orchestration.md):
 * {
 *   stackName: string,
 *   repoUrl: string,
 *   branch: string,
 *   composeFile: string,
 *   overrideFile?: string,
 *   vps: string,
 *   publicServices: [{ service: string, hostname: string }],
 *   tunnelId: string,
 *   secretsSpec?: { generate: string[], required: string[] }
 * }
 *
 * Security (AC1/AC2 stack-deploy-orchestration.md):
 *   - `secretsSpec` enthält ausschließlich Secret-NAMEN, niemals Werte.
 *   - CRUD-Mutationen hinter Access + CRED_ADMIN_EMAILS + Audit-First (im Router).
 *   - Eingaben (stackName, repoUrl, branch, Pfade, hostnames) validiert.
 *
 * @module StackRegistry
 */

import { isValidStackName, isValidRelativePath, MAX_STACK_NAME_LEN } from './validation/stackValidation.js';

/** Maximale Anzahl registrierter Stacks. */
const MAX_STACKS = 100;

/** Maximale Feldlänge für Freitext-Felder (URL, Branch, Pfade). */
const MAX_FIELD_LEN = 512;

/** Maximale Länge einer Tunnel-ID (Cloudflare UUID-Format + Spielraum). */
const MAX_TUNNEL_ID_LEN = 128;

/** Maximale Anzahl publicServices pro Stack. */
const MAX_PUBLIC_SERVICES = 32;

/** Maximale Anzahl Secret-Namen in secretsSpec gesamt. */
const MAX_SECRETS_SPEC_ENTRIES = 64;

/** Erlaubte Zeichen für Secret-Namen (ENV_VAR-Format). */
const SECRET_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Maximale Länge eines Secret-Namens. */
const MAX_SECRET_NAME_LEN = 128;

// ── Eingabe-Validierung ─────────────────────────────────────────────────────────

/**
 * Validiert einen Stack-Namen gegen Path-Traversal + Shell-Metazeichen.
 * Delegiert an isValidStackName aus validation/stackValidation (Single Source of Truth).
 *
 * @param {unknown} name
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateStackName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'stackName ist ein Pflichtfeld und darf nicht leer sein' };
  }
  if (name.length > MAX_STACK_NAME_LEN) {
    return { ok: false, error: `stackName überschreitet Längenlimit (max. ${MAX_STACK_NAME_LEN} Zeichen)` };
  }
  if (!isValidStackName(name)) {
    return { ok: false, error: 'stackName enthält unerlaubte Zeichen (erlaubt: a-z A-Z 0-9 _ -)' };
  }
  return { ok: true };
}

/**
 * Validiert einen Hostname-String (DNS-Zeichensatz).
 * Konsistent mit deploy/hostnameSanitizer.isValidHostname (AC2).
 *
 * @param {unknown} hostname
 * @returns {boolean}
 */
function isValidHostname(hostname) {
  return typeof hostname === 'string' && hostname.length > 0 && /^[a-zA-Z0-9._-]+$/.test(hostname);
}

/**
 * Validiert eine Repo-URL: kein eingebettetes Token/Passwort, keine Shell-Metazeichen.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isValidRepoUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_FIELD_LEN) return false;
  // Shell-Metazeichen verboten (Command-Injection, AC2)
  if (/[;&|`$(){}<>!]/.test(url)) return false;
  // Kein eingebettetes Passwort/Token: https://user:token@host (E3-Schutz)
  if (/https?:\/\/[^@]*:[^@]*@/.test(url)) return false;
  return true;
}

/**
 * Validiert einen Branch-Namen: keine Shell-Metazeichen, kein .. (AC2).
 *
 * @param {unknown} branch
 * @returns {boolean}
 */
function isValidBranch(branch) {
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > MAX_FIELD_LEN) return false;
  if (/[;&|`$(){}<>!]/.test(branch)) return false;
  if (/\.\./.test(branch)) return false;
  return true;
}

/**
 * Validiert einen Secret-Namen (ENV_VAR-Format).
 * secretsSpec enthält nur Namen, nie Werte — AC1.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isValidSecretName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SECRET_NAME_LEN) return false;
  return SECRET_NAME_RE.test(name);
}

/**
 * Vollständige Validierung einer StackDefinition (AC2).
 * Gibt validiertes, normalisiertes def-Objekt zurück oder Fehler.
 *
 * @param {unknown} body
 * @returns {{ ok: boolean, def?: object, error?: string }}
 */
export function validateStackDefinition(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request-Body ist Pflicht' };
  }

  const { stackName, repoUrl, branch, composeFile, overrideFile, vps, publicServices, tunnelId, secretsSpec } = body;

  // stackName
  const nameVal = validateStackName(stackName);
  if (!nameVal.ok) return { ok: false, error: nameVal.error };

  // repoUrl
  if (!isValidRepoUrl(repoUrl)) {
    return { ok: false, error: 'repoUrl ist ungültig (keine Shell-Metazeichen, kein eingebettetes Token; max. 512 Zeichen)' };
  }

  // branch
  if (!isValidBranch(branch)) {
    return { ok: false, error: 'branch ist ungültig (keine Shell-Metazeichen, kein ..; max. 512 Zeichen)' };
  }

  // composeFile
  if (!isValidRelativePath(composeFile)) {
    return { ok: false, error: 'composeFile muss ein relativer Pfad ohne .. und ohne führendes / oder ~ sein' };
  }
  if (composeFile.length > MAX_FIELD_LEN) {
    return { ok: false, error: `composeFile überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
  }

  // overrideFile (optional)
  const hasOverride = overrideFile !== undefined && overrideFile !== null && overrideFile !== '';
  if (hasOverride) {
    if (!isValidRelativePath(overrideFile)) {
      return { ok: false, error: 'overrideFile muss ein relativer Pfad ohne .. und ohne führendes / oder ~ sein' };
    }
    if (overrideFile.length > MAX_FIELD_LEN) {
      return { ok: false, error: `overrideFile überschreitet Längenlimit (max. ${MAX_FIELD_LEN} Zeichen)` };
    }
  }

  // vps (VPS-Referenz-String)
  if (typeof vps !== 'string' || vps.length === 0 || vps.length > MAX_FIELD_LEN) {
    return { ok: false, error: 'vps ist ein Pflichtfeld (max. 512 Zeichen)' };
  }
  if (/[;&|`$(){}<>!]/.test(vps)) {
    return { ok: false, error: 'vps enthält unerlaubte Shell-Metazeichen' };
  }

  // publicServices: [{ service, hostname }]
  if (!Array.isArray(publicServices)) {
    return { ok: false, error: 'publicServices muss ein Array sein' };
  }
  if (publicServices.length > MAX_PUBLIC_SERVICES) {
    return { ok: false, error: `publicServices überschreitet Limit (max. ${MAX_PUBLIC_SERVICES} Einträge)` };
  }
  for (let i = 0; i < publicServices.length; i++) {
    const ps = publicServices[i];
    if (!ps || typeof ps !== 'object') {
      return { ok: false, error: `publicServices[${i}] muss ein Objekt sein` };
    }
    if (typeof ps.service !== 'string' || ps.service.length === 0 || ps.service.length > MAX_FIELD_LEN) {
      return { ok: false, error: `publicServices[${i}].service ist ein Pflichtfeld` };
    }
    if (/[;&|`$(){}<>!]/.test(ps.service)) {
      return { ok: false, error: `publicServices[${i}].service enthält unerlaubte Zeichen` };
    }
    if (!isValidHostname(ps.hostname)) {
      return { ok: false, error: `publicServices[${i}].hostname ist ungültig (nur DNS-Zeichensatz: a-z A-Z 0-9 . _ -)` };
    }
  }

  // tunnelId
  // Längen-Limit: Cloudflare-Tunnel-IDs sind UUIDs (36 Zeichen); MAX_TUNNEL_ID_LEN (128) gibt
  // ausreichend Spielraum für UUID + optionale Präfixe, ohne unbegrenzte Eingaben zuzulassen.
  // tunnelId fließt in Item C in Cloudflare-API- und Shell-Pfade → strenge Validierung (AC2/I2).
  if (typeof tunnelId !== 'string' || tunnelId.length === 0 || tunnelId.length > MAX_TUNNEL_ID_LEN) {
    return { ok: false, error: `tunnelId ist ein Pflichtfeld (max. ${MAX_TUNNEL_ID_LEN} Zeichen)` };
  }
  if (/[;&|`$(){}<>!]/.test(tunnelId)) {
    return { ok: false, error: 'tunnelId enthält unerlaubte Shell-Metazeichen' };
  }
  // ../-Segmente verboten (Path-Traversal-Defense, analog isValidBranch — I2)
  if (/\.\./.test(tunnelId)) {
    return { ok: false, error: 'tunnelId darf keine ..-Segmente enthalten' };
  }
  // Leerzeichen verboten (Shell-/Pfad-Injection; analog isValidBranch — I2)
  if (/\s/.test(tunnelId)) {
    return { ok: false, error: 'tunnelId darf keine Leerzeichen oder Whitespace enthalten' };
  }

  // secretsSpec (optional) — AC1: nur Secret-NAMEN, niemals Werte
  let validatedSecretsSpec = undefined;
  if (secretsSpec !== undefined && secretsSpec !== null) {
    if (typeof secretsSpec !== 'object' || Array.isArray(secretsSpec)) {
      return { ok: false, error: 'secretsSpec muss ein Objekt sein' };
    }
    const generate = secretsSpec.generate ?? [];
    const required = secretsSpec.required ?? [];
    if (!Array.isArray(generate)) {
      return { ok: false, error: 'secretsSpec.generate muss ein Array sein' };
    }
    if (!Array.isArray(required)) {
      return { ok: false, error: 'secretsSpec.required muss ein Array sein' };
    }
    if (generate.length + required.length > MAX_SECRETS_SPEC_ENTRIES) {
      return { ok: false, error: `secretsSpec überschreitet Limit (max. ${MAX_SECRETS_SPEC_ENTRIES} Einträge gesamt)` };
    }
    for (const name of generate) {
      if (!isValidSecretName(name)) {
        return { ok: false, error: `secretsSpec.generate enthält ungültigen Namen (nur ENV_VAR-Format: A-Z a-z _ [0-9])` };
      }
    }
    for (const name of required) {
      if (!isValidSecretName(name)) {
        return { ok: false, error: `secretsSpec.required enthält ungültigen Namen (nur ENV_VAR-Format: A-Z a-z _ [0-9])` };
      }
    }
    validatedSecretsSpec = {
      generate: generate.map(String),
      required: required.map(String),
    };
  }

  // Normalisiertes, sicheres def-Objekt zusammenstellen
  const def = {
    stackName: String(stackName),
    repoUrl: String(repoUrl),
    branch: String(branch),
    composeFile: String(composeFile),
    vps: String(vps),
    publicServices: publicServices.map((ps) => ({
      service: String(ps.service),
      hostname: String(ps.hostname),
    })),
    tunnelId: String(tunnelId),
  };

  if (hasOverride) {
    def.overrideFile = String(overrideFile);
  }
  if (validatedSecretsSpec !== undefined) {
    def.secretsSpec = validatedSecretsSpec;
  }

  return { ok: true, def };
}

// ── StackRegistry ──────────────────────────────────────────────────────────────

export class StackRegistry {
  /** @type {import('./CredentialStore.js').CredentialStore} */
  #credentialStore;

  /**
   * @param {import('./CredentialStore.js').CredentialStore} credentialStore
   */
  constructor(credentialStore) {
    if (!credentialStore || typeof credentialStore.listStackMeta !== 'function') {
      throw new Error('[StackRegistry] credentialStore ist Pflicht und muss Stack-Meta-Methoden bereitstellen');
    }
    this.#credentialStore = credentialStore;
  }

  // ── Öffentliche API ──────────────────────────────────────────────────────────

  /**
   * Listet alle registrierten Stack-Definitionen.
   * Klartext-Metadaten — nicht geheim, nicht verschlüsselt (AC1).
   *
   * @returns {Promise<object[]>}
   */
  async list() {
    const entries = await this.#credentialStore.listStackMeta();
    const stacks = [];
    for (const entry of entries) {
      try {
        stacks.push(JSON.parse(entry.value));
      } catch {
        // Korrupter Eintrag überspringen
      }
    }
    return stacks;
  }

  /**
   * Liest eine einzelne Stack-Definition.
   * Gibt null zurück wenn nicht vorhanden.
   *
   * @param {string} stackName
   * @returns {Promise<object|null>}
   */
  async get(stackName) {
    const value = await this.#credentialStore.getStackMeta(stackName);
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /**
   * Legt eine neue Stack-Definition an oder überschreibt eine vorhandene.
   * Prüft das Stack-Limit (MAX_STACKS) bei Neuanlage.
   *
   * @param {object} def - validierte StackDefinition (bereits durch validateStackDefinition geprüft)
   * @returns {Promise<{ updatedAt: string }>}
   */
  async set(def) {
    if (!def || typeof def.stackName !== 'string') {
      throw new Error('[StackRegistry] set(): def.stackName ist Pflicht');
    }
    // Stack-Limit bei Neuanlage prüfen
    const existing = await this.get(def.stackName);
    if (!existing) {
      const all = await this.list();
      if (all.length >= MAX_STACKS) {
        throw new Error(`[StackRegistry] Maximale Stack-Anzahl (${MAX_STACKS}) erreicht`);
      }
    }
    const updatedAt = new Date().toISOString();
    await this.#credentialStore.setStackMeta(def.stackName, JSON.stringify(def), updatedAt);
    return { updatedAt };
  }

  /**
   * Löscht eine Stack-Definition. Idempotent.
   *
   * @param {string} stackName
   * @returns {Promise<void>}
   */
  async delete(stackName) {
    await this.#credentialStore.deleteStackMeta(stackName);
  }
}
