/**
 * Router-Wrapper: Bitwarden-Deploy-Zugang (Variante B).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/deploy-access[/:field]
 *
 * Spec: docs/specs/deploy-bitwarden-gpg-injection.md (F-072, S-331).
 */
import { bitwardenDeployAccessRouter } from '../bitwardenDeployAccessRouter.js';

export const order = 100;

/**
 * @param {{ bitwardenDeployAccessStore: import('../BitwardenDeployAccessStore.js').BitwardenDeployAccessStore, auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ bitwardenDeployAccessStore, auditStore }) {
  return bitwardenDeployAccessRouter(bitwardenDeployAccessStore, auditStore);
}
