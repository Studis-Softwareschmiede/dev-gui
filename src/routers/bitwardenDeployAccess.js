/**
 * Router-Wrapper: Bitwarden-Deploy-Zugang (Variante B).
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET/PUT/DELETE /api/settings/deploy-access[/:field] + POST .../validate
 *
 * Spec: docs/specs/deploy-bitwarden-gpg-injection.md (F-072, S-331/S-332).
 */
import { bitwardenDeployAccessRouter } from '../bitwardenDeployAccessRouter.js';

export const order = 100;

/**
 * @param {{
 *   bitwardenDeployAccessStore: import('../BitwardenDeployAccessStore.js').BitwardenDeployAccessStore,
 *   auditStore: import('../AuditStore.js').AuditStore,
 *   bitwardenDeployLoginService?: import('../BitwardenDeployLoginService.js').BitwardenDeployLoginService,
 * }} deps
 * @returns {import('express').Router}
 */
export function create({ bitwardenDeployAccessStore, auditStore, bitwardenDeployLoginService }) {
  return bitwardenDeployAccessRouter(bitwardenDeployAccessStore, auditStore, bitwardenDeployLoginService);
}
