/**
 * routerLoader.js — konventions-basiertes Auto-Discovery + Mount aller API-Router.
 *
 * Konvention: Jede Datei in src/routers/*.js exportiert:
 *   - `export function create(deps)` → gibt einen Express-Router zurück
 *   - `export const order` (optional, Zahl) → Mount-Reihenfolge-Hint (niedrig = früh)
 *
 * Invarianten (AC5):
 *   - Der /api-AccessGuard MUSS in server.js VOR mountRouters() registriert werden.
 *   - Der SPA-Catch-All MUSS in server.js NACH mountRouters() registriert werden.
 *   - Auto-Discovery scannt KEINE node_modules/ oder .claude/worktrees/ Pfade (AC6).
 *
 * Fehlerverhalten: Ein fehlerhaftes Router-Modul bricht den Boot fail-fast ab
 * (kein stilles Überspringen — ein fehlender Endpunkt soll nie unbemerkt bleiben).
 *
 * @module routerLoader
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Lädt alle Router-Module aus dem Konventions-Verzeichnis und montiert sie auf die Express-App.
 *
 * @param {import('express').Application} app - Express-Anwendung
 * @param {object} deps - Alle Boundary-Abhängigkeiten (Composition-Root aus server.js)
 * @param {object} [options]
 * @param {string} [options.routersDir] - Pfad zum Routers-Verzeichnis (default: src/routers/ relativ zu diesem Modul)
 * @returns {Promise<string[]>} - Liste der gemounteten Router-Modul-Namen (für Logging/Tests)
 */
export async function mountRouters(app, deps, { routersDir } = {}) {
  const dir = routersDir ?? join(new URL('.', import.meta.url).pathname, 'routers');
  const absDir = resolve(dir);

  // Sicherheits-Guard: AC6 — niemals node_modules oder .claude/worktrees scannen.
  // Prüfung auf Pfad-Segmente (mit Slashes) verhindert Fehlalarme bei Verzeichnisnamen
  // wie "node_modules_custom" oder "my.claude" — nur echte Segment-Grenzen zählen.
  const normalised = absDir.replace(/\\/g, '/');
  if (normalised.includes('/node_modules/') || normalised.endsWith('/node_modules') ||
      normalised.includes('/.claude/worktrees/') || normalised.endsWith('/.claude/worktrees')) {
    throw new Error(`routerLoader: Verbotener Scan-Pfad: ${absDir}`);
  }

  let entries;
  try {
    entries = await readdir(absDir);
  } catch (err) {
    throw new Error(`routerLoader: Konventions-Verzeichnis nicht lesbar (${absDir}): ${err.message}`, { cause: err });
  }

  // Nur .js-Dateien
  const jsFiles = entries.filter((f) => f.endsWith('.js'));

  // Module importieren + order-Hint auslesen
  const modules = await Promise.all(
    jsFiles.map(async (filename) => {
      const filePath = join(absDir, filename);
      const fileUrl = pathToFileURL(filePath).href;
      let mod;
      try {
        mod = await import(fileUrl);
      } catch (err) {
        // Fail-fast: kein stilles Überspringen (AC6 / §7 Edge-Cases)
        throw new Error(`routerLoader: Fehler beim Import von ${filename}: ${err.message}`, { cause: err });
      }
      if (typeof mod.create !== 'function') {
        throw new Error(
          `routerLoader: ${filename} exportiert keine create()-Funktion. ` +
            'Jedes Router-Modul MUSS export function create(deps) haben.'
        );
      }
      return {
        name: filename,
        create: mod.create,
        order: typeof mod.order === 'number' ? mod.order : 999,
      };
    })
  );

  // Sortierung nach order-Hint (stabile Reihenfolge)
  modules.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // Router montieren
  const mounted = [];
  for (const { name, create } of modules) {
    let router;
    try {
      router = create(deps);
    } catch (err) {
      throw new Error(`routerLoader: Fehler beim Erstellen des Routers aus ${name}: ${err.message}`, { cause: err });
    }
    app.use(router);
    mounted.push(name);
  }

  return mounted;
}
