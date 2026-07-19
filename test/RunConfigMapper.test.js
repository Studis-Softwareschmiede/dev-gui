/**
 * RunConfigMapper.test.js — Unit-Tests für die Run-Config → Saga-Parameter-Abbildung
 * (container-image-update AC6).
 *
 * Covers (container-image-update):
 *   AC6 — mapRunConfigToDeployParams() bildet eine ContainerRunConfig (aus
 *         VpsDockerControl.inspectContainer()) auf die DeployOrchestrator.deploy()-Parameter
 *         containerEnv/requiresConfig/configApp/configMountPath ab; echte Run-Config-Env
 *         bleibt unverändert erhalten (inkl. potenzieller Secrets — reiner Mapper, kein
 *         Log/Response-Pfad hier)
 *   AC7 — erkennt NICHT eindeutig abbildbare Binds (mehrere Binds, unbekanntes Format,
 *         Nicht-rw-Modus, Host-Pfad außerhalb des bekannten .../apps/<app>/config-Musters)
 *         und liefert das Prädikat `ambiguous: true` nach außen (der fail-closed-Abbruch
 *         selbst ist Aufgabe des Update-Endpunkts, S-355 — hier nur das Prädikat)
 *   AC18 — (S-382) image-gebackene Build-Metadaten-Env-Keys (BUILD_METADATA_ENV_DENYLIST,
 *          mind. APP_VERSION) werden aus containerEnv herausgefiltert, BEVOR es an die
 *          Saga geht; alle nicht gelisteten Keys (Secrets/Config wie GPG_PASSPHRASE)
 *          bleiben unverändert erhalten (AC6)
 *
 * Strategie: reine Funktion, keine Mocks nötig.
 */

import { describe, it, expect } from '@jest/globals';
import { mapRunConfigToDeployParams, BUILD_METADATA_ENV_DENYLIST } from '../src/deploy/RunConfigMapper.js';

describe('mapRunConfigToDeployParams — kein Bind (AC6)', () => {
  it('kein Bind → requiresConfig:false, ambiguous:false', () => {
    const result = mapRunConfigToDeployParams({
      image: 'ghcr.io/org/app:v1',
      env: { PATH: '/usr/bin' },
      binds: [],
      labels: {},
    });

    expect(result.requiresConfig).toBe(false);
    expect(result.ambiguous).toBe(false);
    expect(result.configApp).toBeUndefined();
    expect(result.configMountPath).toBeUndefined();
  });

  it('containerEnv wird unverändert übernommen (auch Secret-Werte)', () => {
    const result = mapRunConfigToDeployParams({
      image: 'ghcr.io/org/app:v1',
      env: { GPG_PASSPHRASE: 's3cr3t', PATH: '/usr/bin' },
      binds: [],
      labels: {},
    });

    expect(result.containerEnv).toEqual({ GPG_PASSPHRASE: 's3cr3t', PATH: '/usr/bin' });
  });

  it('env fehlt/kein Objekt → containerEnv fällt auf {} zurück (kein Crash)', () => {
    const result = mapRunConfigToDeployParams({ image: 'x', env: null, binds: [], labels: {} });
    expect(result.containerEnv).toEqual({});
  });
});

describe('mapRunConfigToDeployParams — bekanntes config-Mount-Muster (AC6)', () => {
  it('genau EIN Bind nach .../apps/<app>/config:<mountPath> → requiresConfig:true + configApp/configMountPath extrahiert', () => {
    const result = mapRunConfigToDeployParams({
      image: 'ghcr.io/org/app:v1',
      env: {},
      binds: ['/root/apps/myapp/config:/app/config'],
      labels: {},
    });

    expect(result.ambiguous).toBe(false);
    expect(result.requiresConfig).toBe(true);
    expect(result.configApp).toBe('myapp');
    expect(result.configMountPath).toBe('/app/config');
  });

  it('abweichender configMountPath (nicht /app/config) wird korrekt extrahiert', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/home/deploy/apps/flashrescue/config:/data/cfg'],
      labels: {},
    });

    expect(result.ambiguous).toBe(false);
    expect(result.requiresConfig).toBe(true);
    expect(result.configApp).toBe('flashrescue');
    expect(result.configMountPath).toBe('/data/cfg');
  });

  it('explizit ":rw"-Modus-Suffix wird weiterhin als bekanntes Muster erkannt', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/root/apps/myapp/config:/app/config:rw'],
      labels: {},
    });

    expect(result.ambiguous).toBe(false);
    expect(result.requiresConfig).toBe(true);
    expect(result.configApp).toBe('myapp');
    expect(result.configMountPath).toBe('/app/config');
  });
});

describe('mapRunConfigToDeployParams — Eindeutigkeits-Prädikat (AC7)', () => {
  it('mehrere Binds → ambiguous:true, ambiguousReason:multiple-binds', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: [
        '/root/apps/myapp/config:/app/config',
        '/root/apps/myapp/extra:/app/extra',
      ],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.ambiguousReason).toBe('multiple-binds');
    expect(result.requiresConfig).toBe(false);
  });

  it('Bind mit :ro-Modus (nicht read-write) → ambiguous:true, ambiguousReason:non-rw-bind-mode', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/root/apps/myapp/config:/app/config:ro'],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.ambiguousReason).toBe('non-rw-bind-mode');
  });

  it('Host-Pfad außerhalb des bekannten .../apps/<app>/config-Musters → ambiguous:true, ambiguousReason:unknown-bind-pattern', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/var/lib/some-other-volume:/app/config'],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.ambiguousReason).toBe('unknown-bind-pattern');
  });

  it('nicht parsbares Bind-Format (kein ":"-Trenner) → ambiguous:true, ambiguousReason:unrecognized-bind-format', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['not-a-valid-bind-string'],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.ambiguousReason).toBe('unrecognized-bind-format');
  });

  it('Bind mit zu vielen ":"-Segmenten (>3 Teile) → ambiguous:true, ambiguousReason:unrecognized-bind-format', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/root/apps/myapp/config:/app/config:rw:extra'],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.ambiguousReason).toBe('unrecognized-bind-format');
  });

  it('ambiguous:true → requiresConfig bleibt false (Aufrufer darf configApp/configMountPath nicht nutzen)', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: {},
      binds: ['/var/lib/some-other-volume:/app/config'],
      labels: {},
    });

    expect(result.requiresConfig).toBe(false);
    expect(result.configApp).toBeUndefined();
    expect(result.configMountPath).toBeUndefined();
  });
});

describe('mapRunConfigToDeployParams — Build-Metadaten-Deny-Liste (AC18)', () => {
  it('APP_VERSION wird aus containerEnv gefiltert, echte Env (GPG_PASSPHRASE) bleibt erhalten', () => {
    const result = mapRunConfigToDeployParams({
      image: 'ghcr.io/org/app:latest',
      env: { APP_VERSION: '2026-07-18 13:36:16 CEST', GPG_PASSPHRASE: 's3cr3t', PATH: '/usr/bin' },
      binds: [],
      labels: {},
    });

    expect(result.containerEnv).toEqual({ GPG_PASSPHRASE: 's3cr3t', PATH: '/usr/bin' });
    expect(result.containerEnv).not.toHaveProperty('APP_VERSION');
  });

  it('BUILD_METADATA_ENV_DENYLIST ist eine benannte, deterministische Konstante und enthält mindestens APP_VERSION', () => {
    expect(Array.isArray(BUILD_METADATA_ENV_DENYLIST)).toBe(true);
    expect(BUILD_METADATA_ENV_DENYLIST).toContain('APP_VERSION');
  });

  it('Env ohne APP_VERSION bleibt vollständig unverändert (kein Über-Filtern)', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: { GPG_PASSPHRASE: 's3cr3t', HOSTNAME_LABEL_HINT: 'x' },
      binds: [],
      labels: {},
    });

    expect(result.containerEnv).toEqual({ GPG_PASSPHRASE: 's3cr3t', HOSTNAME_LABEL_HINT: 'x' });
  });

  it('Deny-Filter wirkt auch bei ambiguous:true (Binds außerhalb des bekannten Musters)', () => {
    const result = mapRunConfigToDeployParams({
      image: 'x',
      env: { APP_VERSION: 'alt', GPG_PASSPHRASE: 's3cr3t' },
      binds: ['/var/lib/some-other-volume:/app/config'],
      labels: {},
    });

    expect(result.ambiguous).toBe(true);
    expect(result.containerEnv).toEqual({ GPG_PASSPHRASE: 's3cr3t' });
  });
});
