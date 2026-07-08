/**
 * @file LocalDockerControl.test.js — unit tests for `pullAndRecreate()`
 * (docs/specs/regression-run.md AC7).
 *
 * Covers (regression-run): AC7
 *
 *   AC7 — Frisch-Ausrollen: pull + recreate eines PERSISTENTEN lokalen
 *         Preview-Containers (niemals `docker restart`) — Sequenz
 *         `docker pull` → `docker rm -f` → `docker run -d --label
 *         agent-flow.preview=<name> -p hostPort:containerPort --name <name>
 *         image:tag`, danach Readiness-Polling (HTTP-Reachability) statt
 *         fester Sleep-Zeit. Pull-/Start-Fehler werfen einen klassierten
 *         Error (`errorClass`); Readiness-Timeout → `{ ready: false }` (kein
 *         Crash, Aufrufer mappt auf `precondition-error`).
 *
 * Pattern: injizierter `execFn`/`fetchFn` (Muster `runProbe`-Tests via
 * localImageTest.test.js) — kein echtes Docker/Netzwerk nötig.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { LocalDockerControl } from '../src/deploy/LocalDockerControl.js';

describe('LocalDockerControl#pullAndRecreate — regression-run.md AC7', () => {
  it('führt pull -> rm -f -> run -d in dieser Reihenfolge aus, niemals restart (Grep-prüfbar)', async () => {
    const calls = [];
    const execFn = jest.fn(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return '';
    });
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const control = new LocalDockerControl({ execFn, fetchFn });

    const result = await control.pullAndRecreate({
      image: 'ghcr.io/org/app',
      tag: 'latest',
      containerName: 'app-slug',
      hostPort: 8080,
      containerPort: 8080,
    });

    expect(result.ready).toBe(true);
    expect(typeof result.durationMs).toBe('number');

    expect(calls[0]).toEqual(['docker', 'pull', 'ghcr.io/org/app:latest']);
    expect(calls[1]).toEqual(['docker', 'rm', '-f', 'app-slug']);
    expect(calls[2][0]).toBe('docker');
    expect(calls[2]).toContain('run');
    expect(calls[2]).toContain('-d');
    expect(calls[2]).toEqual(expect.arrayContaining(['--label', 'agent-flow.preview=app-slug']));
    expect(calls[2]).toEqual(expect.arrayContaining(['--name', 'app-slug']));
    expect(calls[2]).toEqual(expect.arrayContaining(['-p', '8080:8080']));
    expect(calls[2]).toEqual(expect.arrayContaining(['ghcr.io/org/app:latest']));

    // Security-Floor (Grep-prüfbar): niemals `docker restart` im Modul.
    expect(calls.some((c) => c.includes('restart') && c[1] === 'restart')).toBe(false);
  });

  it('Grep: Quelltext ruft nirgends `docker restart` auf', () => {
    const src = readFileSync(new URL('../src/deploy/LocalDockerControl.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\[\s*['"]restart['"]/);
    expect(src).not.toMatch(/'docker restart'/);
  });

  it('rm -f Fehler (kein Vorgänger-Container) wird ignoriert — run läuft trotzdem', async () => {
    const execFn = jest.fn(async (cmd, args) => {
      if (args[0] === 'rm') throw new Error('No such container');
      return '';
    });
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const control = new LocalDockerControl({ execFn, fetchFn });

    const result = await control.pullAndRecreate({
      image: 'ghcr.io/org/app',
      containerName: 'app-slug',
      hostPort: 8080,
      containerPort: 8080,
    });

    expect(result.ready).toBe(true);
  });

  it('Tag-Default ist "latest" wenn nicht angegeben', async () => {
    const calls = [];
    const execFn = jest.fn(async (cmd, args) => { calls.push(args); return ''; });
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const control = new LocalDockerControl({ execFn, fetchFn });

    await control.pullAndRecreate({ image: 'ghcr.io/org/app', containerName: 'x', hostPort: 80, containerPort: 80 });

    expect(calls[0]).toEqual(['pull', 'ghcr.io/org/app:latest']);
  });

  it('Pull-Fehler wirft { errorClass: "pull-failed" }, KEIN run/rm danach', async () => {
    const execFn = jest.fn(async (cmd, args) => {
      if (args[0] === 'pull') throw new Error('denied');
      return '';
    });
    const control = new LocalDockerControl({ execFn, fetchFn: jest.fn() });

    await expect(
      control.pullAndRecreate({ image: 'ghcr.io/org/app', containerName: 'x', hostPort: 80, containerPort: 80 }),
    ).rejects.toMatchObject({ errorClass: 'pull-failed' });

    // nur der pull-Aufruf fand statt.
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('Start-Fehler (docker run) wirft { errorClass: "start-failed" }', async () => {
    const execFn = jest.fn(async (cmd, args) => {
      if (args[0] === 'run') throw new Error('port already allocated');
      return '';
    });
    const control = new LocalDockerControl({ execFn, fetchFn: jest.fn() });

    await expect(
      control.pullAndRecreate({ image: 'ghcr.io/org/app', containerName: 'x', hostPort: 80, containerPort: 80 }),
    ).rejects.toMatchObject({ errorClass: 'start-failed' });
  });

  it('Readiness-Timeout -> { ready: false }, kein Crash (Edge-Case: nicht readiness-bereit)', async () => {
    jest.useFakeTimers();
    const execFn = jest.fn(async () => '');
    const fetchFn = jest.fn(async () => { throw new Error('ECONNREFUSED'); }); // nie erreichbar
    const control = new LocalDockerControl({ execFn, fetchFn });

    const promise = control.pullAndRecreate({
      image: 'ghcr.io/org/app',
      containerName: 'x',
      hostPort: 80,
      containerPort: 80,
    });

    // Alle Timer (Settle + Poll-Intervalle bis Timeout) durchlaufen.
    await jest.advanceTimersByTimeAsync(65_000);
    const result = await promise;

    expect(result.ready).toBe(false);
    jest.useRealTimers();
  });
});
