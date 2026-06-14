/**
 * Router-Wrapper: Credential-Bootstrap-Status.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/settings/credential-status
 */
import { credentialStatusRouter } from '../credentialStatusRouter.js';

export const order = 55;

/**
 * @param {{ credentialStore: import('../CredentialStore.js').CredentialStore }} deps
 * @returns {import('express').Router}
 */
export function create({ credentialStore }) {
  return credentialStatusRouter(credentialStore);
}
