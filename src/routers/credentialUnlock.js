/**
 * Router-Wrapper: Credential-Unlock (Bitwarden).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: POST /api/settings/credential-unlock
 */
import { credentialUnlockRouter } from '../credentialUnlockRouter.js';

export const order = 60;

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore, auditStore: import('../AuditStore.js').AuditStore, bitwardenMasterKeyService: import('../BitwardenMasterKeyService.js').BitwardenMasterKeyService }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore, bitwardenMasterKeyService }) {
  return credentialUnlockRouter(credentialStore, auditStore, bitwardenMasterKeyService);
}
