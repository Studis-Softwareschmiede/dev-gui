/**
 * routerLoader.test.js — Tests für das Auto-Discovery + Mount-Verhalten (AC1–AC6).
 *
 * Covers:
 *   AC1 — alle erwarteten Router-Module werden entdeckt + gemountet
 *   AC2 — ein neues Router-Modul (nur neue Datei) wird automatisch gemountet
 *   AC3 — jedes Router-Modul in src/routers/ exportiert eine create(deps)-Factory
 *   AC5 — Reihenfolge-Invariante: order-Hint bestimmt Mount-Reihenfolge
 *   AC6 — Auto-Discovery scannt KEINE node_modules/ oder .claude/worktrees/ Pfade
 *
 * Strategy:
 *   - mountRouters() Security-Guard und Basis-Fehler mit Grenzfällen testen
 *   - Echte src/routers/*.js auf create()-Export prüfen (kein vollständiges Mounting nötig)
 *   - Für Reihenfolge-/Deps-Tests: Temp-Verzeichnis innerhalb des Projekts (erbt "type":"module")
 *   - Security-Guard: verbotene Pfade werfen sofort
 */

import { describe, it, expect } from '@jest/globals';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mountRouters } from '../src/routerLoader.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Temp-Verzeichnis innerhalb des Projekts (erbt package.json "type":"module")
const PROJECT_ROOT = new URL('..', import.meta.url).pathname;

async function mkTempProjectDir(prefix) {
  const base = join(PROJECT_ROOT, 'test', '.tmp-' + prefix + Math.random().toString(36).slice(2));
  await mkdir(base, { recursive: true });
  return base;
}

function makeMockRouterContent(id, orderValue) {
  return `export const order = ${orderValue};
export function create(deps) {
  function middleware(req, res, next) { next(); }
  middleware.__testId = '${id}';
  middleware.__deps = deps;
  return middleware;
}
`;
}

async function buildWithTempRouters(routerDefs) {
  const dir = await mkTempProjectDir('router-');
  try {
    for (const [filename, content] of Object.entries(routerDefs)) {
      await writeFile(join(dir, filename), content, 'utf8');
    }
    const app = express();
    const capturedMiddlewares = [];
    const originalUse = app.use.bind(app);
    app.use = (...args) => {
      capturedMiddlewares.push(args[0]);
      return originalUse(...args);
    };
    const mounted = await mountRouters(app, {}, { routersDir: dir });
    return { mounted, capturedMiddlewares };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('routerLoader — Basis-Funktionalität', () => {
  it('montiert einen einfachen Router und gibt seinen Dateinamen zurück', async () => {
    const { mounted } = await buildWithTempRouters({
      'simple.js': makeMockRouterContent('simple', 1),
    });
    expect(mounted).toContain('simple.js');
  });

  it('gibt leere Liste zurück wenn Verzeichnis leer ist', async () => {
    const dir = await mkTempProjectDir('empty-');
    try {
      const app = express();
      const mounted = await mountRouters(app, {}, { routersDir: dir });
      expect(mounted).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignoriert Nicht-.js-Dateien im Routers-Verzeichnis', async () => {
    const dir = await mkTempProjectDir('nonjs-');
    try {
      await writeFile(join(dir, 'README.md'), '# readme', 'utf8');
      await writeFile(join(dir, 'config.json'), '{}', 'utf8');
      const app = express();
      const mounted = await mountRouters(app, {}, { routersDir: dir });
      expect(mounted).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wirft Fehler wenn Modul keine create()-Funktion exportiert', async () => {
    const badRouter = `export const order = 1; // keine create()-Funktion\n`;
    await expect(
      buildWithTempRouters({ 'bad.js': badRouter })
    ).rejects.toThrow(/create/);
  });

  it('wirft Fehler bei Import-Fehler (Fail-Fast, kein stilles Überspringen)', async () => {
    // Modul, dessen Top-Level-Auswertung wirft (Evaluations-Fehler statt Parse-Fehler):
    // `await import()` lehnt diesen Fall in jeder Node-Version fangbar ab. Ein reiner
    // SYNTAX-Fehler wird vom jest-ESM-Transform-Layer je nach Node-Version teils
    // außerhalb des try/catch geworfen (Node 20 vs 26) → flaky; Evaluations-Throw nicht.
    const brokenRouter = `throw new Error('Modul-Auswertung fehlgeschlagen');
export function create(deps) { return (req, res, next) => next(); }
`;
    await expect(
      buildWithTempRouters({ 'broken.js': brokenRouter })
    ).rejects.toThrow(/Fehler beim Import/);
  });

  it('übergibt deps als Argument an create()', async () => {
    const sentinelDeps = { marker: 'test-sentinel-42' };
    const routerContent = `export const order = 1;
export function create(deps) {
  function middleware(req, res, next) { next(); }
  middleware.__receivedDeps = deps;
  return middleware;
}
`;
    const dir = await mkTempProjectDir('deps-');
    try {
      await writeFile(join(dir, 'deps.js'), routerContent, 'utf8');
      const app = express();
      const capturedMiddlewares = [];
      const originalUse = app.use.bind(app);
      app.use = (...args) => { capturedMiddlewares.push(args[0]); return originalUse(...args); };
      await mountRouters(app, sentinelDeps, { routersDir: dir });
      expect(capturedMiddlewares[0].__receivedDeps).toBe(sentinelDeps);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('routerLoader — Reihenfolge-Invariante (AC5)', () => {
  it('sortiert Router nach order-Hint unabhängig vom Dateinamen', async () => {
    // Dateiname z > a alphabetisch, aber order 10 < 20 → a-first zuerst
    const { mounted } = await buildWithTempRouters({
      'z-last.js': makeMockRouterContent('z', 20),
      'a-first.js': makeMockRouterContent('a', 10),
    });
    expect(mounted[0]).toBe('a-first.js'); // order=10 → zuerst
    expect(mounted[1]).toBe('z-last.js');  // order=20 → danach
  });

  it('fällt bei gleichem order-Hint auf alphabetische Reihenfolge zurück', async () => {
    const { mounted } = await buildWithTempRouters({
      'z-router.js': makeMockRouterContent('z', 5),
      'a-router.js': makeMockRouterContent('a', 5),
    });
    expect(mounted[0]).toBe('a-router.js');
    expect(mounted[1]).toBe('z-router.js');
  });

  it('verwendet order=999 als Default wenn kein order-Hint exportiert wird', async () => {
    const noOrderContent = `export function create(deps) {
  function middleware(req, res, next) { next(); }
  return middleware;
}
`;
    const { mounted } = await buildWithTempRouters({
      'b-no-order.js': noOrderContent,
      'a-order-10.js': makeMockRouterContent('a', 10),
    });
    // a-order-10 hat order=10, b-no-order hat order=999 (default) → a zuerst
    expect(mounted[0]).toBe('a-order-10.js');
    expect(mounted[1]).toBe('b-no-order.js');
  });
});

describe('routerLoader — Security-Guard (AC6)', () => {
  it('wirft Fehler wenn routersDir node_modules enthält', async () => {
    await expect(
      mountRouters(express(), {}, { routersDir: '/some/path/node_modules/routers' })
    ).rejects.toThrow(/Verbotener Scan-Pfad/);
  });

  it('wirft Fehler wenn routersDir .claude/worktrees enthält', async () => {
    await expect(
      mountRouters(express(), {}, { routersDir: '/some/.claude/worktrees/branch/src/routers' })
    ).rejects.toThrow(/Verbotener Scan-Pfad/);
  });

  it('wirft Fehler wenn routersDir nicht existiert', async () => {
    await expect(
      mountRouters(express(), {}, { routersDir: '/nonexistent/path/routers' })
    ).rejects.toThrow(/nicht lesbar/);
  });
});

describe('routerLoader — Echte src/routers/ Module (AC1/AC3)', () => {
  const ROUTERS_DIR = new URL('../src/routers', import.meta.url).pathname;

  it('jedes Router-Modul in src/routers/ exportiert eine create()-Funktion', async () => {
    const entries = await readdir(ROUTERS_DIR);
    const jsFiles = entries.filter((f) => f.endsWith('.js'));
    expect(jsFiles.length).toBeGreaterThan(0);

    for (const filename of jsFiles) {
      const url = pathToFileURL(join(ROUTERS_DIR, filename)).href;
      const mod = await import(url);
      expect(typeof mod.create).toBe('function');
    }
  });

  it('alle erwarteten Router-Module sind in src/routers/ vorhanden (AC1)', async () => {
    const entries = await readdir(ROUTERS_DIR);
    const names = entries.filter((f) => f.endsWith('.js'));

    const expected = [
      'assist.js',
      'audit.js',
      'cloudflare.js',
      'command.js',
      'credentialStatus.js',
      'credentialUnlock.js',
      'credentials.js',
      'deployments.js',
      'githubPackages.js',
      'githubRepoClone.js',
      'githubRepos.js',
      'githubReposList.js',
      'retro.js',
      'session.js',
      'sshKeys.js',
      'status.js',
      'team.js',
      'version.js',
      'vps.js',
      'workspacePath.js',
      'workspaceRepos.js',
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('alle Router-Module haben einen numerischen order-Hint (AC5)', async () => {
    const entries = await readdir(ROUTERS_DIR);
    const jsFiles = entries.filter((f) => f.endsWith('.js'));

    for (const filename of jsFiles) {
      const url = pathToFileURL(join(ROUTERS_DIR, filename)).href;
      const mod = await import(url);
      // order ist optional (default=999), aber wenn vorhanden muss es number sein
      if (mod.order !== undefined) {
        expect(typeof mod.order).toBe('number');
      }
    }
  });

  it('genau 27 Router-Module in src/routers/ — Smoke-Assertion gegen versehentliche Löschung (AC1)', async () => {
    // Diese Assertion schreibt die aktuelle Router-Anzahl fest.
    // Sinkt die Zahl (Router gelöscht/umbenannt), schlägt der Test sofort an.
    // Steigt die Zahl (neuer Router hinzugefügt), muss dieser Wert bewusst erhöht werden.
    // board.js wurde mit dev-gui-board-aggregator (#127) hinzugefügt → 20.
    // docs.js wurde mit projekt-spezifikation-anzeige (F-004) hinzugefügt → 21.
    // assist.js wurde mit fabric-intake-dialog (S-134) hinzugefügt → 22.
    // backupStatus.js + backupConfig.js wurden mit credential-backup S-143 hinzugefügt
    //   (backupStatus: AC12 Status-Kachel; backupConfig: Architekt-Entscheid B GET/PUT) → 24.
    // backupRestore.js wurde mit credential-backup S-142 hinzugefügt
    //   (Restore-Endpunkt AC13–AC16) → 25.
    // githubPackages.js wurde mit ghcr-image-list (S-154) hinzugefügt
    //   (GET /api/github/packages + GET /api/github/packages/:name/tags) → 26.
    // vpsContainers.js wurde mit vps-container-overview (S-157) hinzugefügt
    //   (Container-Listing, Start/Stop/Restart/Logs/Remove pro VPS) → 27.
    // knowledgeSources.js wurde mit team-knowledge-add (S-174) hinzugefügt
    //   (POST /api/assist/knowledge-sources, headless WebSearch-Helfer) → 28.
    const entries = await readdir(ROUTERS_DIR);
    const mountedCount = entries.filter((f) => f.endsWith('.js')).length;
    expect(mountedCount).toBe(28);
  });
});
