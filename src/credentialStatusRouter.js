/**
 * credentialStatusRouter — Express-Router für den Credential-Bootstrap-Status-Endpunkt
 * (credential-bootstrap-status AC1–AC7; credential-key-status-transparency AC1–AC8).
 *
 * Routes (hinter AccessGuard in server.js):
 *   GET /api/settings/credential-status
 *     → 200 { state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }
 *
 * Security (ADR-007 / credential-bootstrap-status / credential-key-status-transparency):
 *   - Keine Schlüssel/Klartext in Response, Log oder Audit (AC1/AC7).
 *   - keySource ist reines Quellen-Enum — enthält NIEMALS den Key/Wert (AC7).
 *   - Hinter AccessGuard (AC8); im gesperrten Zustand erreichbar — KEIN Credential-/Master-Key-
 *     Voraussetzung, die den Bootstrap blockieren würde (AC8 Anti-Henne-Ei).
 *   - Read-only; kein Audit nötig (kein Mutations-/Geheimnis-Pfad, Spec Verträge).
 *   - Liefert den aktuellen Laufzeit-Zustand des CredentialStore (live, kein Neustart nötig).
 *
 * @module credentialStatusRouter
 */

import { Router } from 'express';

/**
 * @param {import('./CredentialStore.js').CredentialStore} credentialStore
 * @returns {import('express').Router}
 */
export function credentialStatusRouter(credentialStore) {
  const router = Router();

  /**
   * GET /api/settings/credential-status
   *
   * Liefert den aktuellen Lock-Zustand des CredentialStore.
   *
   * Responses:
   *   200 { state: "locked"|"unlocked", hasEncryptedEntries: boolean, keySource: "auto"|"manual"|"none" }
   *   500 { error: string }  — Store nicht lesbar
   *
   * Security: KEIN Schlüssel/Klartext in der Response (AC1/AC7).
   *   keySource ist reines Quellen-Enum (AC7) — niemals der Key selbst.
   * Read-only, kein Audit nötig (Spec: „kein Mutations-/Geheimnis-Pfad").
   * Im gesperrten Zustand erreichbar — kein Master-Key-Voraussetzungs-Gate (AC8).
   */
  router.get('/api/settings/credential-status', async (_req, res) => {
    try {
      const lockState = await credentialStore.getLockState();
      // Nur state + hasEncryptedEntries + keySource — niemals Schlüssel/Klartext (AC1/AC7)
      return res.json({
        state: lockState.state,
        hasEncryptedEntries: lockState.hasEncryptedEntries,
        keySource: lockState.keySource,
      });
    } catch (err) {
      // Interner Fehler — err.message NICHT loggen (kann Secrets enthalten, AC7)
      console.error('[credentialStatusRouter] GET /api/settings/credential-status failed:', err.constructor?.name ?? 'Error');
      return res.status(500).json({ error: 'Credential-Status nicht abrufbar' });
    }
  });

  return router;
}
