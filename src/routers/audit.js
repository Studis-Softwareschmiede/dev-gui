/**
 * Router-Wrapper: Audit-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/audit
 */
import { auditRouter } from '../AuditStore.js';

/** @param {number} [order] Mount-Reihenfolge-Hint (niedrig = früh) */
export const order = 10;

/**
 * @param {{ auditStore: import('../AuditStore.js').AuditStore }} deps
 * @returns {import('express').Router}
 */
export function create({ auditStore }) {
  return auditRouter(auditStore);
}
