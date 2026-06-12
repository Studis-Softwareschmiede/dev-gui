/**
 * StackDeployOrchestrator.test.js — Unit-Tests für Stack-Deploy/Undeploy/Status-Saga.
 *
 * Covers (stack-deploy-orchestration.md AC6–AC11):
 *   AC6  — Deploy happy-path: syncRepo → ensureEnv → composeUp → addRouteOnly je publicService
 *   AC7  — Route-Schritt fehlgeschlagen → Rollback angelegter Routen; kein Teil-/Geheim-Leak
 *   AC7  — composeUp-Fehler → kein Route-Schritt
 *   AC7  — syncRepo-Fehler → kein weiterer Schritt
 *   AC8  — Undeploy: Routen entfernen → composeDown (Volumes behalten)
 *   AC8  — Undeploy ohne/falschem confirm → { result: "error", reason: "confirmation-required" }
 *   AC9  — Status: composePs ⊕ listRoutes; Drift-Flags; Fehler in errors[]
 *   AC10 — Protected Hostname → 422-äquivalent; kein Compose-/Cloudflare-Schritt
 *   AC10 — Protected Hostname beim Undeploy → { result: "error", reason: "protected-resource" }
 *   AC11 — Kein Secret (SSH-Key, CF-Token, generierter App-Boot-Wert) in result.reason
 *
 * Kein Secret (SSH-Key, CF-Token, generierte App-Boot-Werte) in result.reason (security/R01).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { StackDeployOrchestrator } from '../src/deploy/StackDeployOrchestrator.js';

// ── Mock-Factories ─────────────────────────────────────────────────────────────

/**
 * Minimale, valide StackDefinition für Tests.
 * publicServices hat zwei öffentliche Hostnames.
 */
const STACK_DEF = {
  stackName: 'my-stack',
  repoUrl: 'https://github.com/org/my-stack',
  branch: 'main',
  composeFile: 'docker-compose.yml',
  vps: 'vps-1',
  publicServices: [
    { service: 'web', hostname: 'web.example.com' },
    { service: 'api', hostname: 'api.example.com' },
  ],
  tunnelId: 'tunnel-abc-123',
  secretsSpec: {
    generate: ['DB_PASSWORD', 'JWT_SECRET'],
    required: [],
  },
};

/** VPS-Target für Tests */
const VPS_TARGET = { host: '1.2.3.4', port: 22, targetUser: 'root' };

/**
 * Erstellt einen VpsComposeControl-Stub.
 */
function makeComposeControl({
  syncRepoResult = { result: 'ok' },
  ensureEnvResult = { result: 'exists' },
  composeUpResult = { result: 'ok' },
  composeDownResult = { result: 'ok' },
  composePsResult = { result: 'ok', containers: [] },
} = {}) {
  return {
    syncRepo: jest.fn(async () => syncRepoResult),
    ensureEnv: jest.fn(async () => ensureEnvResult),
    composeUp: jest.fn(async () => composeUpResult),
    composeDown: jest.fn(async () => composeDownResult),
    composePs: jest.fn(async () => composePsResult),
  };
}

/**
 * Erstellt einen DeployOrchestrator-Stub (nur addRouteOnly wird benötigt).
 */
function makeOrchestrator({
  addRouteOnlyResult = { result: 'ok' },
  addRouteOnlyError = null,
  addRouteOnlyFn = null,
} = {}) {
  return {
    addRouteOnly: addRouteOnlyFn ?? jest.fn(async () => {
      if (addRouteOnlyError) throw addRouteOnlyError;
      return addRouteOnlyResult;
    }),
  };
}

/**
 * Erstellt einen CloudflareApi-Stub.
 */
function makeCloudflareApi({
  removeRouteResult = undefined,
  removeRouteError = null,
  deleteDnsRecordResult = undefined,
  deleteDnsRecordError = null,
  resolvedZoneId = 'zone-abc',
  resolveZoneError = null,
  listRoutesResult = [],
  listRoutesError = null,
} = {}) {
  return {
    removeRoute: jest.fn(async () => {
      if (removeRouteError) throw removeRouteError;
      return removeRouteResult;
    }),
    deleteDnsRecord: jest.fn(async () => {
      if (deleteDnsRecordError) throw deleteDnsRecordError;
      return deleteDnsRecordResult;
    }),
    resolveZoneForHostname: jest.fn(async () => {
      if (resolveZoneError) throw resolveZoneError;
      return resolvedZoneId;
    }),
    listRoutes: jest.fn(async () => {
      if (listRoutesError) throw listRoutesError;
      return listRoutesResult;
    }),
  };
}

/**
 * Erstellt einen LockoutGuard-Stub.
 * isProtectedFn(hostname) → boolean
 */
function makeLockoutGuard({ isProtectedFn = () => false } = {}) {
  return { isProtected: jest.fn(isProtectedFn) };
}

/**
 * Erstellt einen vollständigen StackDeployOrchestrator mit Stubs.
 */
function makeOrchestrat({
  composeControlOpts = {},
  orchestratorOpts = {},
  cloudflareApiOpts = {},
  lockoutGuardOpts = {},
} = {}) {
  const composeControl = makeComposeControl(composeControlOpts);
  const orchestrator = makeOrchestrator(orchestratorOpts);
  const cloudflareApi = makeCloudflareApi(cloudflareApiOpts);
  const lockoutGuard = makeLockoutGuard(lockoutGuardOpts);
  const sdo = new StackDeployOrchestrator({
    composeControl, orchestrator, cloudflareApi, lockoutGuard,
  });
  return { sdo, composeControl, orchestrator, cloudflareApi, lockoutGuard };
}

// ── Konstruktor ────────────────────────────────────────────────────────────────

describe('StackDeployOrchestrator — Konstruktor', () => {
  it('wirft wenn composeControl fehlt', () => {
    expect(() => new StackDeployOrchestrator({
      composeControl: null,
      orchestrator: makeOrchestrator(),
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: makeLockoutGuard(),
    })).toThrow(/composeControl/i);
  });

  it('wirft wenn orchestrator fehlt', () => {
    expect(() => new StackDeployOrchestrator({
      composeControl: makeComposeControl(),
      orchestrator: null,
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: makeLockoutGuard(),
    })).toThrow(/orchestrator/i);
  });

  it('wirft wenn cloudflareApi fehlt', () => {
    expect(() => new StackDeployOrchestrator({
      composeControl: makeComposeControl(),
      orchestrator: makeOrchestrator(),
      cloudflareApi: null,
      lockoutGuard: makeLockoutGuard(),
    })).toThrow(/cloudflareApi/i);
  });

  it('wirft wenn lockoutGuard fehlt', () => {
    expect(() => new StackDeployOrchestrator({
      composeControl: makeComposeControl(),
      orchestrator: makeOrchestrator(),
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: null,
    })).toThrow(/lockoutGuard/i);
  });
});

// ── AC6: Stack-Deploy Happy-Path ───────────────────────────────────────────────

describe('AC6 — Deploy happy-path', () => {
  it('führt syncRepo → ensureEnv → composeUp → addRouteOnly je publicService aus', async () => {
    const { sdo, composeControl, orchestrator } = makeOrchestrat();

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('ok');
    expect(result.stack.stackName).toBe('my-stack');
    expect(result.stack.routedHostnames).toEqual(['web.example.com', 'api.example.com']);

    expect(composeControl.syncRepo).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'my-stack', branch: 'main' }),
    );
    expect(composeControl.ensureEnv).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'my-stack' }),
    );
    expect(composeControl.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'my-stack', project: 'my-stack' }),
    );
    // addRouteOnly aufgerufen für BEIDE öffentliche Services
    expect(orchestrator.addRouteOnly).toHaveBeenCalledTimes(2);
    expect(orchestrator.addRouteOnly).toHaveBeenCalledWith(
      expect.objectContaining({ tunnelId: 'tunnel-abc-123', hostname: 'web.example.com' }),
    );
    expect(orchestrator.addRouteOnly).toHaveBeenCalledWith(
      expect.objectContaining({ tunnelId: 'tunnel-abc-123', hostname: 'api.example.com' }),
    );
  });

  it('interne Services (keine publicServices) bekommen KEINE Route (AC6)', async () => {
    const stackDefNoPublic = { ...STACK_DEF, publicServices: [] };
    const { sdo, orchestrator } = makeOrchestrat();

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: stackDefNoPublic });

    expect(result.result).toBe('ok');
    expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
  });

  it('Erst-Deploy (ensureEnv result: generated) → stack.envStatus = "generated"', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: { ensureEnvResult: { result: 'generated', generatedKeys: 'DB_PASSWORD,JWT_SECRET' } },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('ok');
    expect(result.stack.envStatus).toBe('generated');
  });

  it('Re-Deploy (ensureEnv result: exists) → stack.envStatus = "exists"', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: { ensureEnvResult: { result: 'exists' } },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('ok');
    expect(result.stack.envStatus).toBe('exists');
  });
});

// ── AC7: Rollback bei Route-Fehler ────────────────────────────────────────────

describe('AC7 — Rollback bei Route-Schritt-Fehler', () => {
  it('1. Route ok, 2. Route fehlgeschlagen → 1. Route wird zurückgerollt', async () => {
    let callCount = 0;
    const addRouteOnlyFn = jest.fn(async () => {
      callCount++;
      if (callCount === 2) {
        return { result: 'error', reason: 'Route-Anlage fehlgeschlagen', errorClass: 'cloudflare-error' };
      }
      return { result: 'ok' };
    });

    const { sdo, cloudflareApi } = makeOrchestrat({
      orchestratorOpts: { addRouteOnlyFn },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    // Rollback: removeRoute für die 1. erfolgreich angelegte Route
    expect(cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-abc-123', 'web.example.com');
    // 2. Route war nicht erfolgreich → KEIN Rollback für api.example.com
    expect(cloudflareApi.removeRoute).not.toHaveBeenCalledWith('tunnel-abc-123', 'api.example.com');
  });

  it('Route-Fehler → kein Secret/Teil-Leak in reason (AC7)', async () => {
    const addRouteOnlyFn = jest.fn(async () => ({
      result: 'error',
      reason: 'Bearer secret-cf-token-123 CF-Error',
      errorClass: 'cloudflare-error',
    }));

    const { sdo } = makeOrchestrat({ orchestratorOpts: { addRouteOnlyFn } });
    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    // Token muss sanitized sein
    expect(result.reason).not.toContain('secret-cf-token-123');
    expect(result.reason).not.toMatch(/Bearer [A-Za-z0-9._-]{8,}/);
  });

  it('composeUp fehlgeschlagen → kein Route-Schritt (AC7)', async () => {
    const { sdo, orchestrator } = makeOrchestrat({
      composeControlOpts: { composeUpResult: { result: 'error', reason: 'docker-failed', errorClass: 'docker-failed' } },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    // addRouteOnly darf NICHT aufgerufen worden sein
    expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
  });

  it('syncRepo fehlgeschlagen → kein ensureEnv, kein composeUp, kein Route-Schritt (AC7)', async () => {
    const { sdo, composeControl, orchestrator } = makeOrchestrat({
      composeControlOpts: { syncRepoResult: { result: 'error', reason: 'unreachable', errorClass: 'unreachable' } },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(composeControl.ensureEnv).not.toHaveBeenCalled();
    expect(composeControl.composeUp).not.toHaveBeenCalled();
    expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
  });

  it('ensureEnv fehlgeschlagen → kein composeUp, kein Route-Schritt', async () => {
    const { sdo, composeControl, orchestrator } = makeOrchestrat({
      composeControlOpts: {
        ensureEnvResult: {
          result: 'error',
          reason: 'Generier-Skript auf VPS fehlgeschlagen',
          errorClass: 'docker-failed',
        },
      },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(composeControl.composeUp).not.toHaveBeenCalled();
    expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
  });

  it('Rollback-Fehler → weiterfahren (best-effort), kein Crash', async () => {
    let callCount = 0;
    const addRouteOnlyFn = jest.fn(async () => {
      callCount++;
      if (callCount === 2) {
        return { result: 'error', reason: 'cloudflare-error', errorClass: 'cloudflare-error' };
      }
      return { result: 'ok' };
    });
    const removeRouteError = new Error('Rollback fehlgeschlagen');
    removeRouteError.errorClass = 'cloudflare-error';

    const { sdo } = makeOrchestrat({
      orchestratorOpts: { addRouteOnlyFn },
      cloudflareApiOpts: { removeRouteError },
    });

    // Darf nicht werfen — best-effort Rollback
    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });
    expect(result.result).toBe('error');
  });
});

// ── AC8: Undeploy ────────────────────────────────────────────────────────────

describe('AC8 — Undeploy', () => {
  it('happy-path: removeRoute + DNS → composeDown für jeden öffentlichen Service', async () => {
    const { sdo, cloudflareApi, composeControl } = makeOrchestrat();

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    expect(result.result).toBe('ok');
    // Routen für BEIDE öffentliche Services entfernt
    expect(cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-abc-123', 'web.example.com');
    expect(cloudflareApi.removeRoute).toHaveBeenCalledWith('tunnel-abc-123', 'api.example.com');
    // DNS-CNAME ebenfalls entfernt (best-effort)
    expect(cloudflareApi.deleteDnsRecord).toHaveBeenCalled();
    // composeDown aufgerufen
    expect(composeControl.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'my-stack', project: 'my-stack', removeVolumes: false }),
    );
  });

  it('Volumes werden NICHT entfernt (default removeVolumes: false)', async () => {
    const { sdo, composeControl } = makeOrchestrat();

    await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    expect(composeControl.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ removeVolumes: false }),
    );
  });

  it('fehlendes confirm → { result: "error", reason: "confirmation-required" }; keine Mutation', async () => {
    const { sdo, cloudflareApi, composeControl } = makeOrchestrat();

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: undefined });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('confirmation-required');
    expect(result.errorClass).toBe('confirmation-required');
    // Keine Mutation
    expect(cloudflareApi.removeRoute).not.toHaveBeenCalled();
    expect(composeControl.composeDown).not.toHaveBeenCalled();
  });

  it('falsches confirm → { result: "error", reason: "confirmation-required" }; keine Mutation', async () => {
    const { sdo, cloudflareApi, composeControl } = makeOrchestrat();

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'wrong-stack' });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('confirmation-required');
    expect(cloudflareApi.removeRoute).not.toHaveBeenCalled();
    expect(composeControl.composeDown).not.toHaveBeenCalled();
  });

  it('Reihenfolge: Routen-zuerst, dann composeDown (kein Traffic auf gestoppten Stack)', async () => {
    const callOrder = [];
    const cloudflareApi = makeCloudflareApi();
    const composeControl = makeComposeControl();

    cloudflareApi.removeRoute.mockImplementation(async () => {
      callOrder.push('removeRoute');
    });
    composeControl.composeDown.mockImplementation(async () => {
      callOrder.push('composeDown');
      return { result: 'ok' };
    });

    const sdo = new StackDeployOrchestrator({
      composeControl,
      orchestrator: makeOrchestrator(),
      cloudflareApi,
      lockoutGuard: makeLockoutGuard(),
    });

    await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    // Alle removeRoute-Aufrufe kommen VOR composeDown
    const lastRoute = callOrder.lastIndexOf('removeRoute');
    const firstDown = callOrder.indexOf('composeDown');
    expect(lastRoute).toBeLessThan(firstDown);
  });

  it('Route-Fehler → best-effort; composeDown trotzdem ausgeführt; routeDriftWarning', async () => {
    const routeError = new Error('CF-Fehler');
    routeError.errorClass = 'cloudflare-error';

    const { sdo, composeControl } = makeOrchestrat({
      cloudflareApiOpts: { removeRouteError: routeError },
    });

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    // composeDown trotzdem ausgeführt
    expect(composeControl.composeDown).toHaveBeenCalled();
    // Ergebnis ist 'ok' (best-effort Route-Fehler führen nicht zu Gesamtfehler)
    expect(result.result).toBe('ok');
    expect(result.routeDriftWarning).toBeDefined();
  });

  it('composeDown-Fehler → { result: "error" }', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        composeDownResult: { result: 'error', reason: 'unreachable', errorClass: 'unreachable' },
      },
    });

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('unreachable');
  });
});

// ── AC9: Stack-Status ─────────────────────────────────────────────────────────

describe('AC9 — Stack-Status', () => {
  it('happy-path: composePs ⊕ listRoutes; containerPresent + routePresent korrekt', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        composePsResult: {
          result: 'ok',
          containers: [
            { service: 'web', status: 'running', name: 'my-stack-web-1', ports: '' },
            { service: 'api', status: 'running', name: 'my-stack-api-1', ports: '' },
          ],
        },
      },
      cloudflareApiOpts: {
        listRoutesResult: [
          { hostname: 'web.example.com', tunnelId: 'tunnel-abc-123' },
          { hostname: 'api.example.com', tunnelId: 'tunnel-abc-123' },
        ],
      },
    });

    const status = await sdo.status({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(status.stackName).toBe('my-stack');
    expect(status.services).toHaveLength(2);

    const webService = status.services.find((s) => s.service === 'web');
    expect(webService.containerPresent).toBe(true);
    expect(webService.routePresent).toBe(true);
    expect(webService.drift).toBe(false);

    const apiService = status.services.find((s) => s.service === 'api');
    expect(apiService.containerPresent).toBe(true);
    expect(apiService.routePresent).toBe(true);
    expect(apiService.drift).toBe(false);
  });

  it('Drift-Flag gesetzt wenn Container läuft aber Route fehlt', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        composePsResult: {
          result: 'ok',
          containers: [
            { service: 'web', status: 'running', name: 'my-stack-web-1', ports: '' },
          ],
        },
      },
      cloudflareApiOpts: {
        listRoutesResult: [], // keine Routen
      },
    });

    const status = await sdo.status({ vps: VPS_TARGET, stackDef: STACK_DEF });

    const webService = status.services.find((s) => s.service === 'web');
    expect(webService.containerPresent).toBe(true);
    expect(webService.routePresent).toBe(false);
    expect(webService.drift).toBe(true);
  });

  it('Drift-Flag gesetzt wenn Route vorhanden aber Container fehlt', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        composePsResult: { result: 'ok', containers: [] }, // kein Container
      },
      cloudflareApiOpts: {
        listRoutesResult: [{ hostname: 'web.example.com', tunnelId: 'tunnel-abc-123' }],
      },
    });

    const status = await sdo.status({ vps: VPS_TARGET, stackDef: STACK_DEF });

    const webService = status.services.find((s) => s.service === 'web');
    expect(webService.containerPresent).toBe(false);
    expect(webService.routePresent).toBe(true);
    expect(webService.drift).toBe(true);
  });

  it('composePs-Fehler → degradiert in errors[], Status-Objekt trotzdem zurückgegeben', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        composePsResult: { result: 'error', reason: 'unreachable', errorClass: 'unreachable' },
      },
    });

    const status = await sdo.status({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(status.stackName).toBe('my-stack');
    expect(status.errors).toBeDefined();
    expect(status.errors.some((e) => e.errorClass === 'unreachable')).toBe(true);
  });

  it('listRoutes-Fehler → degradiert in errors[], Status-Objekt trotzdem zurückgegeben', async () => {
    const routeError = new Error('Cloudflare nicht erreichbar');
    routeError.errorClass = 'cloudflare-unavailable';

    const { sdo } = makeOrchestrat({
      cloudflareApiOpts: { listRoutesError: routeError },
    });

    const status = await sdo.status({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(status.stackName).toBe('my-stack');
    expect(status.errors).toBeDefined();
    expect(status.errors.some((e) => e.errorClass === 'cloudflare-unavailable')).toBe(true);
  });
});

// ── AC10: Protected Hostname ───────────────────────────────────────────────────

describe('AC10 — Protected Hostname', () => {
  it('Deploy: protected Hostname → { result: "error", reason: "protected-resource" }; kein Schritt ausgeführt', async () => {
    const { sdo, composeControl, orchestrator } = makeOrchestrat({
      lockoutGuardOpts: { isProtectedFn: (h) => h === 'web.example.com' },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
    expect(result.errorClass).toBe('protected-resource');
    // Kein einziger Schritt ausgeführt
    expect(composeControl.syncRepo).not.toHaveBeenCalled();
    expect(composeControl.ensureEnv).not.toHaveBeenCalled();
    expect(composeControl.composeUp).not.toHaveBeenCalled();
    expect(orchestrator.addRouteOnly).not.toHaveBeenCalled();
  });

  it('Deploy: JEDER öffentliche Hostname geprüft; zweiter protected → Fehler', async () => {
    const { sdo, composeControl } = makeOrchestrat({
      lockoutGuardOpts: { isProtectedFn: (h) => h === 'api.example.com' },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
    expect(composeControl.syncRepo).not.toHaveBeenCalled();
  });

  it('Undeploy: protected Hostname → { result: "error", reason: "protected-resource" }; keine Mutation', async () => {
    const { sdo, cloudflareApi, composeControl } = makeOrchestrat({
      lockoutGuardOpts: { isProtectedFn: (h) => h === 'web.example.com' },
    });

    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'my-stack' });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
    expect(cloudflareApi.removeRoute).not.toHaveBeenCalled();
    expect(composeControl.composeDown).not.toHaveBeenCalled();
  });

  it('protected-Check ist VOR type-to-confirm-Check (AC10 hat höhere Priorität)', async () => {
    const { sdo } = makeOrchestrat({
      lockoutGuardOpts: { isProtectedFn: () => true },
    });

    // Falsches confirm — aber protected-Check greift zuerst
    const result = await sdo.undeploy({ vps: VPS_TARGET, stackDef: STACK_DEF, confirm: 'wrong' });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
  });
});

// ── Secret-Leak-Freiheit (AC11/security) ──────────────────────────────────────

describe('AC11/security — Kein Secret in result.reason', () => {
  it('SSH-Key erscheint NICHT in Deploy-Fehler-reason', async () => {
    const sshKeyLike = 'BEGIN OPENSSH PRIVATE KEY\nMIIEpAIBAAKCAQEA\nEND OPENSSH PRIVATE KEY';
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        syncRepoResult: { result: 'error', reason: sshKeyLike, errorClass: 'auth-failed' },
      },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(result.reason).not.toContain('OPENSSH PRIVATE KEY');
    expect(result.reason).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('CF-Token erscheint NICHT in Deploy-Fehler-reason', async () => {
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        syncRepoResult: {
          result: 'error',
          reason: 'Bearer cf-token-abc123xyz456 unauthorized',
          errorClass: 'auth-failed',
        },
      },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('error');
    expect(result.reason).not.toContain('cf-token-abc123xyz456');
  });

  it('App-Boot-Secrets (generierte Werte) erscheinen NICHT in result (E3-Schutz)', async () => {
    // ensureEnv gibt generatedKeys (Namen, keine Werte) zurück — Werte verlassen den VPS nie
    const { sdo } = makeOrchestrat({
      composeControlOpts: {
        ensureEnvResult: {
          result: 'generated',
          generatedKeys: 'DB_PASSWORD,JWT_SECRET',
          // Kein `values`-Feld (wäre ein Security-Bug)
        },
      },
    });

    const result = await sdo.deploy({ vps: VPS_TARGET, stackDef: STACK_DEF });

    expect(result.result).toBe('ok');
    // result.stack enthält keine generierten Werte
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toMatch(/[a-f0-9]{32,}/); // kein Hash/Token-Muster
    expect(resultStr).not.toContain('password'); // kein Klartext-Passwort
    expect(resultStr).not.toContain('secret');   // kein Geheimnis-Wert
  });
});
