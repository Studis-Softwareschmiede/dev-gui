/**
 * Router-Wrapper: SSH-Key-Verwaltung.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/ssh-keys*, POST /api/settings/ssh-keys/:user/provision,
 *           POST /api/settings/ssh-keys/:user/generate,
 *           GET /api/settings/ssh-keys/:user/private-key/export,
 *           POST /api/settings/ssh-keys/:user/rotate
 */
import { sshKeysRouter } from '../sshKeysRouter.js';

export const order = 70;

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore, auditStore }) {
  return sshKeysRouter(credentialStore, auditStore);
}
