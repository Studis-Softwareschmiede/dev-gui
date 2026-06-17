/**
 * Router-Wrapper: Backup-Status-Endpunkt (S-143, AC12).
 *
 * GET /api/settings/backup-status
 * Liefert Metadaten des letzten lokalen Backups:
 *   { lastBackup: { at, artefactName, localResult, offHostResult } | null,
 *     offHostType: string|null, offHostEnabled: boolean,
 *     targetConfig: object|null, retentionCount: number }
 *
 * lastBackup.localResult / lastBackup.offHostResult werden aus der Sidecar-Datei
 * (backup-last-result.json, geschrieben von BackupEngine nach jedem Backup) gelesen.
 * Metadaten-only (AC12 / Spec §13): KEIN Master-Key, KEIN Remote-Secret, KEIN Store-Klartext.
 * Kein interner Volume-Pfad (backupDir) in der Response (I1-Fix).
 * Off-Host-Konfiguration aus BackupConfigStore (JSON > Env, Architekt-Entscheid S-143).
 *
 * Factory-Signatur: create(deps) → Express Router
 * Montiert: GET /api/settings/backup-status
 */

import { Router } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBackupDir, resolveRetentionCount, resolveSidecarPath } from '../BackupEngine.js';
import { resolveOffHostConfigAsync } from '../BackupUploader.js';

export const order = 51;

/**
 * Liest die Sidecar-Datei (backup-last-result.json) aus dem Credential-Volume.
 * Metadaten-only: { local, offHost, at } — kein Pfad/Secret/Artefakt-Inhalt.
 * Gibt null zurück wenn Sidecar nicht vorhanden oder nicht lesbar (best-effort).
 *
 * @returns {Promise<{ local: 'ok'|'failed', offHost: 'ok'|'failed'|'disabled', at: string }|null>}
 */
async function readSidecar() {
  const sidecarPath = resolveSidecarPath();
  if (!sidecarPath) return null;
  try {
    const raw = await readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Nur die erlaubten Metadaten-Felder übernehmen (Allowlist, kein Secret-Leak)
    const local = parsed.local === 'ok' || parsed.local === 'failed' ? parsed.local : null;
    const offHost = ['ok', 'failed', 'disabled'].includes(parsed.offHost) ? parsed.offHost : null;
    const at = typeof parsed.at === 'string' ? parsed.at : null;
    if (!local) return null;
    return { local, offHost, at };
  } catch {
    return null; // Nicht vorhanden oder nicht lesbar → still ignorieren
  }
}

/**
 * Liest das neueste Backup-Artefakt aus dem Backup-Verzeichnis (Metadaten-only).
 * Gibt null zurück wenn kein Artefakt vorhanden.
 *
 * @param {string} backupDir
 * @returns {Promise<{ at: string, artefactName: string }|null>}
 */
async function readLastArtefactMeta(backupDir) {
  let entries;
  try {
    entries = await readdir(backupDir);
  } catch {
    return null; // Verzeichnis nicht vorhanden oder nicht lesbar
  }

  const gpgFiles = entries.filter((f) => f.endsWith('.gpg') && !f.endsWith('.tmp'));
  if (gpgFiles.length === 0) return null;

  // Stat aller Dateien um mtime zu ermitteln (neueste zuerst)
  const withMtime = await Promise.all(
    gpgFiles.map(async (name) => {
      try {
        const s = await stat(join(backupDir, name));
        return { name, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const valid = withMtime.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  if (valid.length === 0) return null;

  const newest = valid[0];
  return {
    artefactName: newest.name,
    at: new Date(newest.mtime).toISOString(),
  };
}

/**
 * @param {object} _deps - Keine benötigten Abhängigkeiten (nur Env-/Filesystem-Zugriff)
 * @returns {import('express').Router}
 */
export function create(_deps) {
  const router = Router();

  /**
   * GET /api/settings/backup-status
   * Liefert Metadaten-only (AC12 / Spec §13: kein Key/Secret/Klartext).
   *
   * I1-Fix: backupDir wird NICHT in der Response zurückgegeben (interner Volume-Pfad
   * gehört nicht in den HTTP-Body — wird im Frontend nicht gerendert).
   *
   * Off-Host-Konfiguration kommt aus BackupConfigStore (JSON > Env, Architekt-Entscheid S-143).
   *
   * Allowlist der zurückgegebenen targetConfig-Felder (I2-Fix: Allowlist statt Blocklist
   * gemäß coder.md Lesson 2026-06-16):
   *   S3 (S3-only seit S-160): endpoint, bucket, prefix, region
   *
   * Response 200:
   *   {
   *     lastBackup: { at: ISO-string, artefactName: string,
   *                   localResult: 'ok'|'failed'|null,
   *                   offHostResult: 'ok'|'failed'|'disabled'|null } | null,
   *     offHostType: 's3'|null,
   *     offHostEnabled: boolean,
   *     targetConfig: { endpoint?, bucket?, prefix?, region? } | null,
   *     retentionCount: number
   *   }
   *
   * lastBackup.localResult / lastBackup.offHostResult: aus Sidecar (backup-last-result.json).
   * null wenn Sidecar noch nicht vorhanden (kein Backup gelaufen seit dieser Version).
   */
  router.get('/api/settings/backup-status', async (req, res) => {
    try {
      const backupDir = resolveBackupDir();
      // Nicht-geheime Off-Host-Konfiguration aus BackupConfigStore (JSON > Env)
      const offHostConfig = await resolveOffHostConfigAsync();
      const offHostType = offHostConfig?.type ?? null;
      const offHostEnabled = offHostConfig !== null;
      // Retention-Anzahl (nicht-geheim)
      const retentionCount = resolveRetentionCount();

      // Letztes Artefakt (Dateiname + mtime) und Sidecar parallel lesen
      const [lastArtefact, sidecar] = await Promise.all([
        readLastArtefactMeta(backupDir),
        readSidecar(),
      ]);

      // lastBackup: Artefakt-Metadaten + Stufen-Ergebnis aus Sidecar (AC12 / I2-Fix)
      // Metadaten-only: kein Pfad/Secret/Artefakt-Inhalt
      const lastBackup = lastArtefact
        ? {
            at: lastArtefact.at,
            artefactName: lastArtefact.artefactName,
            localResult: sidecar?.local ?? null,
            offHostResult: sidecar?.offHost ?? null,
          }
        : null;

      // I2-Fix: Allowlist statt Blocklist — nur explizit erlaubte nicht-geheime Felder.
      // Verhindert dass zukünftig hinzugefügte Felder in resolveOffHostConfigAsync()
      // versehentlich exponiert werden (coder.md Lesson 2026-06-16).
      // S3-only seit S-160: host/port/user (SFTP-Felder) entfernt.
      const ALLOWED_TARGET_CONFIG_KEYS = new Set(['endpoint', 'bucket', 'prefix', 'region']);
      const targetConfig = offHostConfig
        ? Object.fromEntries(
            Object.entries(offHostConfig).filter(([k]) => ALLOWED_TARGET_CONFIG_KEYS.has(k)),
          )
        : null;

      // AC12 / Spec §13: Metadaten-only — kein Secret, kein Key, kein Store-Klartext
      // I1-Fix: backupDir absichtlich NICHT zurückgegeben (interner Volume-Pfad)
      return res.json({
        lastBackup,
        offHostType,
        offHostEnabled,
        targetConfig,   // nicht-geheime Ziel-Konfiguration (Pfad/URL/Bucket/Host)
        retentionCount, // konfigurierte Retention-Anzahl
        // backupDir: absichtlich weggelassen (I1-Fix: interner Pfad gehört nicht in HTTP-Body)
      });
    } catch (err) {
      console.error('[backupStatus] GET failed:', err.message);
      return res.status(500).json({ error: 'Backup-Status nicht abrufbar' });
    }
  });

  return router;
}
