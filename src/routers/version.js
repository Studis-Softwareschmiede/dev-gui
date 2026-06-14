/**
 * Router-Wrapper: Build-Version-Endpunkt.
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/version
 */
import { versionRouter } from '../versionRouter.js';

export const order = 150;

/**
 * @param {object} _deps (keine Dependencies benötigt)
 * @returns {import('express').Router}
 */
export function create(_deps) {
  return versionRouter();
}
