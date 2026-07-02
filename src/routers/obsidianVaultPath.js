/**
 * Router-Wrapper: Obsidian-Vault-Pfad-Konfiguration (obsidian-vault-config AC1–AC4, AC6, AC7).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/obsidian-vault-path
 */
import { obsidianVaultPathRouter } from '../obsidianVaultPathRouter.js';

export const order = 91;

/**
 * @param {{
 *   credentialStore: import('../CredentialStore.js').CredentialStore,
 *   auditStore: import('../AuditStore.js').AuditStore,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore }) {
  return obsidianVaultPathRouter(credentialStore, auditStore);
}
