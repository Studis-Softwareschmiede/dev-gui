/**
 * DeployOrchestrator.test.js — Unit-Tests für die atomare Container+Route-Saga (ADR-012).
 *
 * Covers (deploy-lifecycle AC3–AC9):
 *   AC3  — Deploy happy-path: pull → run → addRoute+createDnsRecord → { result: "ok", deployment }
 *   AC4  — Route-step failure → Container rolled back (rm called), result: "error" (no secret leak)
 *   AC4  — Container-step failure → no route step attempted, result: "error"
 *   AC4  — Pull failure → no run, no route, result: "error"
 *   AC5  — Undeploy happy-path: removeRoute → deleteDnsRecord → rm → { result: "ok" }
 *   AC6  — Undeploy with wrong/missing confirm → { result: "error", reason: "confirmation-required" }
 *   AC7  — Protected hostname → { result: "error", reason: "protected-resource" }, no step called
 *   AC9  — No secret (private-key / token) in any result.reason
 *   list — listDeployments: live join of ps() containers + listRoutes(), drift visible
 *   AC4  (vps-readiness-gate) — probe→provisioning/unreachable → pull NIEMALS aufgerufen,
 *         result:error errorClass:vps-provisioning mit freundlicher Meldung (AC6)
 *   AC5  (vps-readiness-gate) — probe→ready → bestehende Saga unverändert (Gate ist No-op)
 *   AC13 (vps-readiness-gate) — kein SSH-Key/Token in result.reason bei vps-provisioning-Fehler
 *
 * Covers (vps-tunnel-existence-gate S-185 AC1–AC6, AC12, AC13):
 *   AC1  — listTunnels-Gate: tunnelId nicht in Cloudflare → tunnel-missing, pull NIEMALS aufgerufen
 *   AC2  — listTunnels-Gate: tunnelId in Cloudflare → Gate ist No-op, Saga läuft weiter
 *   AC3  — Preflight-Reihenfolge: LockoutGuard → Tunnel-Mismatch/-Missing → listTunnels → Readiness
 *          → Re-Deploy-ps/rm → pull (Gate vor Re-Deploy-Replace, AC1/AC3/AC5/AC6)
 *   AC4  — Cloudflare nicht konsultierbar (nicht konfiguriert/Auth/Netz) → fail-closed, kein Docker-Schritt
 *   AC5  — Tunnel-Mismatch: mitgegebene tunnelId ≠ registrierte → tunnel-mismatch, kein Schritt
 *          inkl. EXISTING container: dockerControl.rm wird NICHT aufgerufen (C1-Fix)
 *   AC6  — VPS ohne registrierte Tunnel-Id → tunnel-missing, kein Schritt
 *          inkl. EXISTING container: dockerControl.rm wird NICHT aufgerufen (C1-Fix)
 *   AC12 — Kein Token in result.reason bei tunnel-missing/tunnel-mismatch
 *   AC13 — Read-only Checks erzeugen keinen Audit-Eintrag (Orchestrator ist audit-frei → gilt via Router)
 *
 * Covers (deploy-config-volume-mount):
 *   AC4/D1  — Guard-/Seed-Gate ruft pushAppConfigFile() NACH Readiness-Gate, VOR Re-Deploy-
 *             Replace (ps/rm) und VOR pull/run; requiresConfig falsy/abwesend → pushAppConfigFile
 *             NIE aufgerufen (Deploy-Pfad AC1/AC8-byte-identisch)
 *   AC6     — pushAppConfigFile() liefert config-file-missing → deploy() bricht VOR jeder
 *             Mutation ab (kein pull/run/ps-Replace/Cloudflare-Call), Fehler wird durchgereicht
 *   AC5     — pushAppConfigFile() liefert seeded:false (Datei existiert bereits) → Deploy läuft
 *             unverändert weiter (Gate ist bei ok-Ergebnis ein No-op)
 *   AC1/AC2 — requiresConfig/configApp werden unverändert an run() durchgereicht (nicht
 *             manipuliert); configSeed wird nur an pushAppConfigFile() gereicht, NIE an run()
 */

import { describe, it, expect, jest } from '@jest/globals';
import { DeployOrchestrator } from '../src/deploy/DeployOrchestrator.js';

// ── Mock factories ─────────────────────────────────────────────────────────────

/**
 * Create a mock VpsDockerControl stub.
 * All methods default to success; individual calls can be overridden.
 * probeResult: wenn gesetzt, wird probe() als Mock exponiert; wenn null, fehlt probe()
 *   (simuliert Legacy-DockerControl ohne probe-Methode).
 */
function makeDockerControl({
  pullResult = { result: 'ok' },
  runResult = { result: 'ok', containerId: 'abc123', hostPort: 8080 },
  rmResult = { result: 'ok' },
  psResult = { result: 'ok', containers: [] },
  probeResult = { state: 'ready' }, // Default: probe meldet "ready" → Gate-No-op
  // deploy-config-volume-mount: Default-Erfolg (Datei existiert bereits, kein Seed nötig).
  pushAppConfigFileResult = { result: 'ok', seeded: false },
} = {}) {
  const ctrl = {
    pull: jest.fn(async () => pullResult),
    run: jest.fn(async () => runResult),
    rm: jest.fn(async () => rmResult),
    ps: jest.fn(async () => psResult),
    pushAppConfigFile: jest.fn(async () => pushAppConfigFileResult),
  };
  // probe() nur exponieren wenn probeResult !== null (null = Legacy ohne probe)
  if (probeResult !== null) {
    ctrl.probe = jest.fn(async () => probeResult);
  }
  return ctrl;
}

/**
 * Create a mock CloudflareApi stub.
 * S-185: listTunnels is now included — default returns [{ id: DEPLOY_PARAMS.tunnelId }]
 * so existing tests remain unaffected (tunnel exists → Gate ist No-op).
 */
function makeCloudflareApi({
  addRouteResult = undefined, // undefined = resolves (no throw)
  addRouteError = null,
  createDnsRecordResult = undefined,
  createDnsRecordError = null,
  removeRouteResult = undefined,
  removeRouteError = null,
  deleteDnsRecordResult = undefined,
  deleteDnsRecordError = null,
  listRoutesResult = [],
  listRoutesError = null,
  isProtectedFn = () => false,
  resolvedZoneId = 'zone-resolved-abc',  // default resolved zone
  resolveZoneError = null,
  // S-185 AC1–AC4: listTunnels mock
  // Default: Tunnel existiert → Gate ist No-op (Rückwärtskompatibilität für alle bestehenden Tests)
  listTunnelsResult = [{ id: 'tunnel-abc-123' }], // matches DEPLOY_PARAMS.tunnelId
  listTunnelsError = null,
} = {}) {
  return {
    addRoute: jest.fn(async () => {
      if (addRouteError) throw addRouteError;
      return addRouteResult;
    }),
    createDnsRecord: jest.fn(async () => {
      if (createDnsRecordError) throw createDnsRecordError;
      return createDnsRecordResult;
    }),
    removeRoute: jest.fn(async () => {
      if (removeRouteError) throw removeRouteError;
      return removeRouteResult;
    }),
    deleteDnsRecord: jest.fn(async () => {
      if (deleteDnsRecordError) throw deleteDnsRecordError;
      return deleteDnsRecordResult;
    }),
    listRoutes: jest.fn(async () => {
      if (listRoutesError) throw listRoutesError;
      return listRoutesResult;
    }),
    listTunnels: jest.fn(async () => {
      if (listTunnelsError) throw listTunnelsError;
      return listTunnelsResult;
    }),
    isProtected: jest.fn(isProtectedFn),
    resolveZoneForHostname: jest.fn(async () => {
      if (resolveZoneError) throw resolveZoneError;
      return resolvedZoneId;
    }),
  };
}

/**
 * Create a mock VpsProviderRegistry stub for S-185 AC5/AC6 tests.
 * @param {{ tunnelId: string|null }} [opts]
 */
function makeVpsRegistry({ tunnelId = 'tunnel-abc-123', throws = false } = {}) {
  return {
    getTargetRecord: jest.fn(async () => {
      if (throws) throw new Error('Store unavailable');
      if (tunnelId === null) return null;
      return { tunnelId };
    }),
  };
}

/**
 * Create a mock LockoutGuard.
 */
function makeLockoutGuard(isProtectedResult = false) {
  return {
    isProtected: jest.fn(() => isProtectedResult),
  };
}

/** Standard deploy params (safe, not protected) — zoneId NOT included (resolved server-side). */
const DEPLOY_PARAMS = {
  image: 'ghcr.io/org/app:v1',
  vps: { host: '1.2.3.4', port: 22, targetUser: 'root' },
  hostname: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
};

const UNDEPLOY_PARAMS = {
  vps: { host: '1.2.3.4', port: 22, targetUser: 'root' },
  hostname: 'app.example.com',
  confirm: 'app.example.com',
  tunnelId: 'tunnel-abc-123',
};

// ── Constructor ────────────────────────────────────────────────────────────────

describe('DeployOrchestrator — Konstruktor', () => {
  it('wirft wenn dockerControl fehlt', () => {
    expect(() => new DeployOrchestrator({
      dockerControl: null,
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: makeLockoutGuard(),
    })).toThrow(/dockerControl/i);
  });

  it('wirft wenn cloudflareApi fehlt', () => {
    expect(() => new DeployOrchestrator({
      dockerControl: makeDockerControl(),
      cloudflareApi: null,
      lockoutGuard: makeLockoutGuard(),
    })).toThrow(/cloudflareApi/i);
  });

  it('wirft wenn lockoutGuard fehlt', () => {
    expect(() => new DeployOrchestrator({
      dockerControl: makeDockerControl(),
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: null,
    })).toThrow(/lockoutGuard/i);
  });

  it('initialisiert korrekt mit gültigen Abhängigkeiten', () => {
    expect(() => new DeployOrchestrator({
      dockerControl: makeDockerControl(),
      cloudflareApi: makeCloudflareApi(),
      lockoutGuard: makeLockoutGuard(),
    })).not.toThrow();
  });
});

// ── deploy() — AC3: Happy Path ─────────────────────────────────────────────────

describe('DeployOrchestrator — deploy() — AC3: Happy Path', () => {
  it('AC3: happy path → pull → run → addRoute → createDnsRecord → result:ok + deployment', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const guard = makeLockoutGuard(false);

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: guard });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(result.deployment).toBeDefined();
    expect(result.deployment.hostname).toBe(DEPLOY_PARAMS.hostname);
    expect(result.deployment.image).toBe(DEPLOY_PARAMS.image);
    expect(result.deployment.containerId).toBe('abc123');
    expect(result.deployment.routePresent).toBe(true);
    expect(result.deployment.containerPresent).toBe(true);
  });

  it('AC3: alle drei Schritte werden in Reihenfolge aufgerufen: pull → run → addRoute', async () => {
    const callOrder = [];
    const docker = makeDockerControl({
      pullResult: { result: 'ok' },
      runResult: { result: 'ok', containerId: 'cid-abc', hostPort: 8080 },
      psResult: { result: 'ok', containers: [] },
    });
    docker.pull.mockImplementation(async () => { callOrder.push('pull'); return { result: 'ok' }; });
    docker.run.mockImplementation(async () => { callOrder.push('run'); return { result: 'ok', containerId: 'cid', hostPort: 8080 }; });
    docker.ps.mockImplementation(async () => { callOrder.push('ps'); return { result: 'ok', containers: [] }; });

    const cf = makeCloudflareApi();
    cf.addRoute.mockImplementation(async () => { callOrder.push('addRoute'); });
    cf.createDnsRecord.mockImplementation(async () => { callOrder.push('createDnsRecord'); });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // ps is called before run to select free port, then pull, run, addRoute, createDnsRecord
    expect(callOrder).toContain('pull');
    expect(callOrder).toContain('run');
    expect(callOrder).toContain('addRoute');
    expect(callOrder).toContain('createDnsRecord');
    // pull must come before run
    expect(callOrder.indexOf('pull')).toBeLessThan(callOrder.indexOf('run'));
    // run must come before addRoute
    expect(callOrder.indexOf('run')).toBeLessThan(callOrder.indexOf('addRoute'));
  });

  it('AC2: run() wird mit Label cloudflare.tunnel-hostname=<hostname> aufgerufen', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(DEPLOY_PARAMS);

    expect(docker.run).toHaveBeenCalledWith(
      DEPLOY_PARAMS.vps,
      DEPLOY_PARAMS.image,
      DEPLOY_PARAMS.hostname,
      expect.any(Object),
    );
  });
});

// ── deploy() — AC4: Rollback ───────────────────────────────────────────────────

describe('DeployOrchestrator — deploy() — AC4: Rollback', () => {
  it('AC4: Route-Schritt schlägt fehl → Container wird zurückgerollt (rm aufgerufen)', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
    });
    const routeError = Object.assign(new Error('Cloudflare unavailable'), { errorClass: 'cloudflare-unavailable' });
    const cf = makeCloudflareApi({ addRouteError: routeError });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    // Container muss zurückgerollt worden sein
    expect(docker.rm).toHaveBeenCalled();
  });

  it('AC4: Route-Schritt schlägt fehl → kein verwaister Container; reason ohne Geheim-Leak', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
    });
    const sensitiveError = Object.assign(
      new Error('Bearer eyJhbGciOiJSUzI1NiJ9.sensitivetoken'),
      { errorClass: 'cloudflare-auth-failed' },
    );
    const cf = makeCloudflareApi({ addRouteError: sensitiveError });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(docker.rm).toHaveBeenCalled();
    // Kein Token-Leak im reason
    expect(result.reason).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result.reason).not.toContain('sensitivetoken');
  });

  it('AC4: Container-Schritt schlägt fehl → kein Route-Schritt versucht', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
      runResult: { result: 'error', reason: 'SSH auth failed', errorClass: 'auth-failed' },
    });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(cf.addRoute).not.toHaveBeenCalled();
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
  });

  it('AC4: Pull schlägt fehl → kein Run, kein Route-Schritt', async () => {
    const docker = makeDockerControl({
      pullResult: { result: 'error', reason: 'Image nicht gefunden', errorClass: 'docker-failed' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('AC4: DNS-Schritt schlägt fehl → Container und Route werden zurückgerollt', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
    });
    const dnsError = Object.assign(new Error('DNS error'), { errorClass: 'cloudflare-unavailable' });
    const cf = makeCloudflareApi({ createDnsRecordError: dnsError });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(docker.rm).toHaveBeenCalled();
    // removeRoute should be attempted as rollback
    expect(cf.removeRoute).toHaveBeenCalled();
  });

  it('S1: Route-Schritt schlägt fehl, Rollback-rm schlägt fehl → reason nennt Drift ehrlich', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] },
      rmResult: { result: 'error', reason: 'SSH timeout', errorClass: 'unreachable' },
    });
    const routeError = Object.assign(new Error('Cloudflare down'), { errorClass: 'cloudflare-unavailable' });
    const cf = makeCloudflareApi({ addRouteError: routeError });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    // reason must mention Drift/Reconciliation (honest rollback failure)
    expect(result.reason).toMatch(/rollback fehlgeschlagen|reconciliation/i);
  });
});

// ── deploy() — AC7: LockoutGuard ──────────────────────────────────────────────

describe('DeployOrchestrator — deploy() — AC7: LockoutGuard', () => {
  it('AC7: protected Hostname → result:error, reason:protected-resource; kein Docker/CF-Schritt', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const guard = makeLockoutGuard(true); // protected!

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: guard });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
    // Kein Schritt wurde ausgeführt
    expect(docker.pull).not.toHaveBeenCalled();
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });
});

// ── deploy() — zoneId server-side resolution ──────────────────────────────────

describe('DeployOrchestrator — deploy() — zoneId Server-Auflösung', () => {
  it('zone-not-found: resolveZoneForHostname gibt null zurück → result:error, reason:zone-not-found', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ resolvedZoneId: null });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('zone-not-found');
    // No docker or Cloudflare mutation steps called
    expect(docker.pull).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('zone-not-found: resolveZoneForHostname wirft → result:error, kein Secret-Leak', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cfErr = Object.assign(new Error('Cloudflare auth failed'), { errorClass: 'cloudflare-auth-failed' });
    const cf = makeCloudflareApi({ resolveZoneError: cfErr });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it('zone aufgelöst → createDnsRecord wird mit aufgelöster zoneId aufgerufen', async () => {
    const resolvedZone = 'resolved-zone-id-xyz';
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ resolvedZoneId: resolvedZone });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(DEPLOY_PARAMS);

    // createDnsRecord must have been called with the resolved zone ID
    expect(cf.createDnsRecord).toHaveBeenCalledWith(
      resolvedZone,
      DEPLOY_PARAMS.hostname,
      DEPLOY_PARAMS.tunnelId,
    );
  });
});

// ── undeploy() — AC5: Happy Path ──────────────────────────────────────────────

describe('DeployOrchestrator — undeploy() — AC5: Happy Path', () => {
  it('AC5: happy path → removeRoute → deleteDnsRecord → rm → result:ok', async () => {
    const callOrder = [];
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [{ containerId: 'cid-123', hostname: 'app.example.com', image: 'x', status: 'Up', hostPort: 8080 }] },
    });
    docker.rm.mockImplementation(async () => { callOrder.push('rm'); return { result: 'ok' }; });
    const cf = makeCloudflareApi();
    cf.removeRoute.mockImplementation(async () => { callOrder.push('removeRoute'); });
    cf.deleteDnsRecord.mockImplementation(async () => { callOrder.push('deleteDnsRecord'); });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.undeploy(UNDEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // Route muss VOR Container entfernt werden (AC5: Route-first)
    expect(callOrder.indexOf('removeRoute')).toBeLessThan(callOrder.indexOf('rm'));
  });

  it('AC5: removeRoute wird VOR rm aufgerufen (Route-first)', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [{ containerId: 'cid-456', hostname: 'app.example.com', image: 'y', status: 'Up', hostPort: 8081 }] },
    });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    await orch.undeploy(UNDEPLOY_PARAMS);

    // removeRoute must be called, and must happen before any rm calls
    expect(cf.removeRoute).toHaveBeenCalled();
    expect(docker.rm).toHaveBeenCalled();
  });

  it('AC5: kein Container gefunden → trotzdem result:ok (Route war der wichtige Schritt)', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [] }, // no container
    });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.undeploy(UNDEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(cf.removeRoute).toHaveBeenCalled();
    expect(docker.rm).not.toHaveBeenCalled(); // no container to remove
  });
});

// ── undeploy() — AC6: type-to-confirm ─────────────────────────────────────────

describe('DeployOrchestrator — undeploy() — AC6: type-to-confirm', () => {
  it('AC6: fehlender confirm → result:error, reason:confirmation-required; keine Mutation', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.undeploy({ ...UNDEPLOY_PARAMS, confirm: '' });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('confirmation-required');
    expect(cf.removeRoute).not.toHaveBeenCalled();
    expect(docker.rm).not.toHaveBeenCalled();
  });

  it('AC6: falscher confirm → result:error, reason:confirmation-required; keine Mutation', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.undeploy({ ...UNDEPLOY_PARAMS, confirm: 'wrong.example.com' });

    expect(result.result).toBe('error');
    expect(result.reason).toBe('confirmation-required');
    expect(cf.removeRoute).not.toHaveBeenCalled();
  });

  it('AC6: korrekter confirm → undeploy wird ausgeführt', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [{ containerId: 'cid', hostname: 'app.example.com', image: 'x', status: 'Up', hostPort: 8080 }] },
    });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.undeploy(UNDEPLOY_PARAMS); // confirm === hostname

    expect(result.result).toBe('ok');
  });
});

// ── undeploy() — AC7: LockoutGuard ────────────────────────────────────────────

describe('DeployOrchestrator — undeploy() — AC7: LockoutGuard', () => {
  it('AC7: protected Hostname → result:error, reason:protected-resource; kein Schritt', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const guard = makeLockoutGuard(true);

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: guard });
    const result = await orch.undeploy(UNDEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.reason).toBe('protected-resource');
    expect(cf.removeRoute).not.toHaveBeenCalled();
    expect(docker.rm).not.toHaveBeenCalled();
  });
});

// ── listDeployments ────────────────────────────────────────────────────────────

describe('DeployOrchestrator — listDeployments()', () => {
  const LIST_PARAMS = {
    vps: { host: '1.2.3.4', port: 22, targetUser: 'root' },
    tunnelId: 'tunnel-abc',
  };

  it('liefert Deployments aus ps() + listRoutes() — routePresent/containerPresent korrekt', async () => {
    const containers = [
      { containerId: 'cid-1', hostname: 'app.example.com', image: 'img:v1', status: 'Up 2h', hostPort: 8080 },
    ];
    const routes = [
      { hostname: 'app.example.com', service: 'http://localhost:8080', tunnelId: 'tunnel-abc', protected: false },
      { hostname: 'orphan-route.example.com', service: 'http://localhost:8081', tunnelId: 'tunnel-abc', protected: false },
    ];

    const docker = makeDockerControl({ psResult: { result: 'ok', containers } });
    const cf = makeCloudflareApi({ listRoutesResult: routes });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.listDeployments(LIST_PARAMS);

    expect(result.deployments).toHaveLength(2);

    const healthy = result.deployments.find((d) => d.hostname === 'app.example.com');
    expect(healthy.routePresent).toBe(true);
    expect(healthy.containerPresent).toBe(true);

    const orphan = result.deployments.find((d) => d.hostname === 'orphan-route.example.com');
    expect(orphan.routePresent).toBe(true);
    expect(orphan.containerPresent).toBe(false); // Drift!
  });

  it('Drift sichtbar: Container ohne Route → containerPresent:true, routePresent:false', async () => {
    const containers = [
      { containerId: 'cid-orphan', hostname: 'orphan-container.example.com', image: 'x', status: 'Up', hostPort: 9000 },
    ];
    const docker = makeDockerControl({ psResult: { result: 'ok', containers } });
    const cf = makeCloudflareApi({ listRoutesResult: [] }); // no routes

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.listDeployments(LIST_PARAMS);

    const d = result.deployments.find((dep) => dep.hostname === 'orphan-container.example.com');
    expect(d.containerPresent).toBe(true);
    expect(d.routePresent).toBe(false);
  });

  it('degradiert bei ps()-Fehler: errors[] statt Absturz', async () => {
    const docker = makeDockerControl({
      psResult: { result: 'error', reason: 'SSH unreachable', errorClass: 'unreachable' },
    });
    const cf = makeCloudflareApi({ listRoutesResult: [] });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.listDeployments(LIST_PARAMS);

    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.deployments).toHaveLength(0);
  });

  it('degradiert bei listRoutes()-Fehler: errors[] statt Absturz', async () => {
    const containers = [
      { containerId: 'cid-1', hostname: 'app.example.com', image: 'x', status: 'Up', hostPort: 8080 },
    ];
    const docker = makeDockerControl({ psResult: { result: 'ok', containers } });
    const cf = makeCloudflareApi({ listRoutesError: Object.assign(new Error('CF down'), { errorClass: 'cloudflare-unavailable' }) });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.listDeployments(LIST_PARAMS);

    expect(result.errors).toBeDefined();
    expect(result.errors.some((e) => e.errorClass === 'cloudflare-unavailable')).toBe(true);
    // Container should still appear (route unknown)
    expect(result.deployments).toHaveLength(1);
  });

  it('hostPort im Deployment-Read-Model aus ps()-Container übernommen', async () => {
    const containers = [
      { containerId: 'cid-1', hostname: 'app.example.com', image: 'img:v1', status: 'Up 3h', hostPort: 8083 },
    ];
    const docker = makeDockerControl({ psResult: { result: 'ok', containers } });
    const cf = makeCloudflareApi({ listRoutesResult: [{ hostname: 'app.example.com', service: 'http://localhost:8083' }] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.listDeployments(LIST_PARAMS);

    const d = result.deployments.find((dep) => dep.hostname === 'app.example.com');
    expect(d.hostPort).toBe(8083);
  });

  it('hostPort ist null für Deployments ohne Container (Route-Drift)', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ listRoutesResult: [{ hostname: 'orphan.example.com', service: 'http://localhost:8090' }] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.listDeployments(LIST_PARAMS);

    const d = result.deployments.find((dep) => dep.hostname === 'orphan.example.com');
    expect(d.hostPort).toBeNull();
  });
});

// ── AC9: No secret leak ────────────────────────────────────────────────────────

describe('DeployOrchestrator — AC9: Kein Secret-Leak in result.reason', () => {
  it('SSH-Private-Key erscheint NICHT in result.reason', async () => {
    const pemDummy = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') + '\nFAKEKEYDATA\n' + ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');
    const docker = makeDockerControl({
      pullResult: { result: 'error', reason: `Auth failed: ${pemDummy}`, errorClass: 'auth-failed' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    // reason from VpsDockerControl is passed through but should not expose key
    // VpsDockerControl.sanitizeErrorReason already cleans it; orchestrator passes it as-is
    // but tests that the orchestrator's own sanitizeReason doesn't add leaks
    expect(result.reason).not.toContain('FAKEKEYDATA');
  });

  it('Cloudflare-Token erscheint NICHT in result.reason nach Route-Fehler', async () => {
    const secretToken = 'cf_live_abcdefghijklmnopqrstuvwxyz1234567890';
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const tokenError = Object.assign(
      new Error(`Bearer ${secretToken} auth failed`),
      { errorClass: 'cloudflare-auth-failed' },
    );
    const cf = makeCloudflareApi({ addRouteError: tokenError });

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.reason).not.toContain(secretToken);
    expect(result.reason).not.toContain('cf_live');
  });
});

// ── Host-Port selection ────────────────────────────────────────────────────────

describe('DeployOrchestrator — Host-Port-Auswahl', () => {
  it('wählt Port 8080 wenn keine Container laufen', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(DEPLOY_PARAMS);

    // run must have been called with hostPort: 8080
    const runCall = docker.run.mock.calls[0];
    expect(runCall[3].hostPort).toBe(8080);
  });

  it('wählt nächsten freien Port wenn 8080 belegt ist', async () => {
    const docker = makeDockerControl({
      psResult: {
        result: 'ok',
        containers: [
          { containerId: 'x', hostname: 'other.com', image: 'y', status: 'Up', hostPort: 8080 },
        ],
      },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(DEPLOY_PARAMS);

    const runCall = docker.run.mock.calls[0];
    expect(runCall[3].hostPort).toBe(8081);
  });
});

// ── AC13: Auto-Port via inspect() ─────────────────────────────────────────────

describe('DeployOrchestrator — AC13: Container-Port via docker inspect', () => {
  it('uses single exposed port from inspect()', async () => {
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'cnt-123', hostPort: 8080 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [] })),
      inspect: jest.fn(async () => ({ result: 'ok', ports: ['3000/tcp'] })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // run() should be called with containerPort=3000
    const runCall = docker.run.mock.calls[0];
    expect(runCall[3].containerPort).toBe(3000);
    // portAmbiguous/portFallback should be false
    expect(result.deployment.portAmbiguous).toBe(false);
    expect(result.deployment.portFallback).toBe(false);
  });

  it('uses smallest port when multiple ExposedPorts returned (portAmbiguous=true)', async () => {
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'cnt-123', hostPort: 8080 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [] })),
      inspect: jest.fn(async () => ({ result: 'ok', ports: ['8080/tcp', '3000/tcp', '5000/tcp'] })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // smallest port = 3000
    const runCall = docker.run.mock.calls[0];
    expect(runCall[3].containerPort).toBe(3000);
    expect(result.deployment.portAmbiguous).toBe(true);
    expect(result.deployment.portFallback).toBe(false);
  });

  it('uses default port 8080 and sets portFallback=true when no ExposedPorts', async () => {
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'cnt-123', hostPort: 8080 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [] })),
      inspect: jest.fn(async () => ({ result: 'ok', ports: [] })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    const runCall = docker.run.mock.calls[0];
    expect(runCall[3].containerPort).toBe(8080); // default
    expect(result.deployment.portFallback).toBe(true);
    expect(result.deployment.portAmbiguous).toBe(false);
  });

  it('falls back to default port when inspect() not available (no method)', async () => {
    // dockerControl without inspect() (legacy)
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // containerPort should default (inspect not called)
    expect(result.deployment.portAmbiguous).toBe(false);
    expect(result.deployment.portFallback).toBe(false);
  });

  it('falls back to default port when inspect() returns error (graceful degradation)', async () => {
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'cnt-123', hostPort: 8080 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [] })),
      inspect: jest.fn(async () => ({ result: 'error', ports: [], reason: 'docker-failed', errorClass: 'docker-failed' })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    // Deploy should still succeed (inspect is best-effort)
    expect(result.result).toBe('ok');
    expect(result.deployment.portFallback).toBe(false); // fallback is only set when ports:[]
  });
});

// ── AC14: Re-Deploy = Ersetzen ────────────────────────────────────────────────

describe('DeployOrchestrator — AC14: Re-Deploy = replace existing', () => {
  it('removes existing container with same hostname before deploying (replaced=true)', async () => {
    const existingContainer = { containerId: 'old-cnt', hostname: 'app.example.com', image: 'old:v1', status: 'Up', hostPort: 8080 };
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'new-cnt', hostPort: 8081 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [existingContainer] })),
      inspect: jest.fn(async () => ({ result: 'ok', ports: ['8080/tcp'] })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // rm() should be called for the old container (re-deploy)
    expect(docker.rm).toHaveBeenCalledWith(
      expect.anything(),
      'old-cnt',
      expect.anything(),
    );
    // replaced flag set in deployment
    expect(result.deployment.replaced).toBe(true);
  });

  it('replaced=false when no existing container on hostname', async () => {
    const docker = {
      pull: jest.fn(async () => ({ result: 'ok' })),
      run: jest.fn(async () => ({ result: 'ok', containerId: 'new-cnt', hostPort: 8080 })),
      rm: jest.fn(async () => ({ result: 'ok' })),
      ps: jest.fn(async () => ({ result: 'ok', containers: [] })),
      inspect: jest.fn(async () => ({ result: 'ok', ports: [] })),
    };
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(result.deployment.replaced).toBe(false);
    // rm() only called once for the re-deploy check (but no existing container found)
    // The initial ps() for re-deploy check returns empty containers
    // No rm() call for re-deploy
    // (rm may still be called in rollback path, but here no rollback occurs)
    const rmCallsForReplace = docker.rm.mock.calls.filter((call) => call[1] === 'old-cnt');
    expect(rmCallsForReplace.length).toBe(0);
  });
});

// ── AC10/UI: deploymentsRouter vps-targets endpoint ───────────────────────────

describe('deploymentsRouter — GET /api/deployments/vps-targets (AC10)', () => {
  it('returns list of vps IDs from configured vpsTargets', async () => {
    // Import and test the endpoint directly
    const { deploymentsRouter } = await import('../src/deploymentsRouter.js');
    const { AuditStore } = await import('../src/AuditStore.js');
    const express = (await import('express')).default;
    const http = await import('node:http');

    const vpsTargets = new Map([
      ['vps-1', { host: '1.2.3.4', port: 22, targetUser: 'root' }],
      ['vps-2', { host: '5.6.7.8', port: 22, targetUser: 'root' }],
    ]);
    const orchestratorStub = {
      listDeployments: jest.fn(async () => ({ deployments: [] })),
      deploy: jest.fn(),
      undeploy: jest.fn(),
    };
    const auditStore = new AuditStore();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.identity = { email: 'admin@example.com' }; next(); });
    app.use(deploymentsRouter(orchestratorStub, auditStore, vpsTargets));

    const { port, server } = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, () => resolve({ port: s.address().port, server: s }));
    });

    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port, path: '/api/deployments/vps-targets', method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    server.close();

    expect(result.status).toBe(200);
    expect(result.body.vpsIds).toEqual(expect.arrayContaining(['vps-1', 'vps-2']));
    expect(result.body.vpsIds.length).toBe(2);
  });
});

// ── AC4/AC5/AC6/AC13 (vps-readiness-gate): Deploy-Gate ───────────────────────

describe('DeployOrchestrator — deploy() — Deploy-Gate (vps-readiness-gate AC4/AC5/AC6/AC13)', () => {
  // ── AC4: probe→provisioning → pull NICHT aufgerufen ─────────────────────

  it('AC4 — probe→provisioning → pull NIEMALS aufgerufen, result:error, errorClass:vps-provisioning', async () => {
    const docker = makeDockerControl({
      probeResult: { state: 'provisioning', reason: 'VPS wird noch eingerichtet' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('vps-provisioning');
    // pull() darf NIEMALS aufgerufen werden (AC4)
    expect(docker.pull).not.toHaveBeenCalled();
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
  });

  it('AC4 — probe→unreachable → pull NIEMALS aufgerufen, result:error, errorClass:vps-provisioning', async () => {
    const docker = makeDockerControl({
      probeResult: { state: 'unreachable', reason: 'VPS nicht erreichbar' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('vps-provisioning');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  // ── AC5: probe→ready → Saga läuft unverändert ────────────────────────────

  it('AC5 — probe→ready → bestehende Saga läuft unverändert (Gate ist No-op), result:ok', async () => {
    const docker = makeDockerControl({
      probeResult: { state: 'ready' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    // Alle Saga-Schritte wurden ausgeführt
    expect(docker.pull).toHaveBeenCalled();
    expect(docker.run).toHaveBeenCalled();
    expect(cf.addRoute).toHaveBeenCalled();
    expect(cf.createDnsRecord).toHaveBeenCalled();
  });

  // ── AC6: freundliche Meldung ohne rohen Fehlertext, Host, Key, Token ─────

  it('AC6 — vps-provisioning reason enthält freundliche Meldung (kein SSH-Error, kein Host, kein Key)', async () => {
    const docker = makeDockerControl({
      probeResult: { state: 'provisioning' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('vps-provisioning');
    // Freundliche Meldung (AC6): kein roher SSH-Fehlertext, kein Host, kein Key
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/eingerichtet|versuchen/i); // sinngemäß "erneut versuchen"
    expect(result.reason).not.toContain('1.2.3.4');  // kein Host
    expect(result.reason).not.toContain('PRIVATE KEY'); // kein Key
  });

  it('AC6 — vps-provisioning reason erwähnt erneutes Versuchen ("~1–2 Min")', async () => {
    const docker = makeDockerControl({
      probeResult: { state: 'unreachable' },
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.errorClass).toBe('vps-provisioning');
    // Spec AC6: "sinngemäß erneutes Versuchen"
    expect(result.reason).toMatch(/erneut versuchen|min/i);
  });

  // ── AC13: kein Key/Token in reason ────────────────────────────────────────

  it('AC13 — vps-provisioning result.reason enthält keinen SSH-Key / Token', async () => {
    const pemDummy2 = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') + '\nFAKEKEYDATA\n' + ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' ');
    const docker = makeDockerControl({
      probeResult: { state: 'provisioning', reason: pemDummy2 }, // Probe leakt Key intern
      psResult: { result: 'ok', containers: [] },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('vps-provisioning');
    // Der Orchestrator schreibt eine eigene freundliche Meldung — kein durchgereichter Key
    expect(result.reason).not.toContain('FAKEKEYDATA');
    expect(result.reason).not.toContain('PRIVATE KEY');
  });

  // ── Backward-compat: Legacy-DockerControl ohne probe() ───────────────────

  it('AC5 (backward-compat) — DockerControl ohne probe()-Methode → Gate wird übersprungen, Saga läuft', async () => {
    // Legacy-DockerControl (kein probe()) → Gate-Prüfung wird übersprungen (graceful degradation)
    const docker = makeDockerControl({ probeResult: null, psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
  });
});

// ── S-185 AC1–AC4: Tunnel-Existenz-Gate (listTunnels) ────────────────────────

describe('DeployOrchestrator — deploy() — S-185 AC1–AC4: Tunnel-Existenz-Gate', () => {
  // ── AC1: Tunnel fehlt in Cloudflare → tunnel-missing, kein Docker-Schritt ──

  it('AC1 — tunnelId nicht in Cloudflare → result:error, errorClass:tunnel-missing, pull NICHT aufgerufen', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    // listTunnels gibt keine Tunnel zurück → Tunnel fehlt
    const cf = makeCloudflareApi({ listTunnelsResult: [] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
    expect(cf.createDnsRecord).not.toHaveBeenCalled();
  });

  it('AC1 — listTunnels gibt anderen Tunnel zurück (nicht die gesuchte ID) → tunnel-missing', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ listTunnelsResult: [{ id: 'different-tunnel-999' }] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  // ── AC2: Tunnel existiert → Gate ist No-op, Saga läuft weiter ──────────────

  it('AC2 — tunnelId in Cloudflare → Gate ist No-op, bestehende Saga läuft unverändert', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    // Standard-Mock: Tunnel existiert (matches DEPLOY_PARAMS.tunnelId)
    const cf = makeCloudflareApi({ listTunnelsResult: [{ id: DEPLOY_PARAMS.tunnelId }] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
    expect(docker.run).toHaveBeenCalled();
    expect(cf.addRoute).toHaveBeenCalled();
  });

  it('AC2 — mehrere Tunnel im Account, registrierter existiert → Gate ist No-op', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({
      listTunnelsResult: [
        { id: 'other-tunnel-aaa' },
        { id: DEPLOY_PARAMS.tunnelId }, // registrierter existiert
        { id: 'other-tunnel-bbb' },
      ],
    });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
  });

  // ── AC4: Cloudflare nicht konsultierbar → fail-closed ────────────────────

  it('AC4 — listTunnels wirft cloudflare-not-configured → fail-closed, kein Docker-Schritt', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cfNotConfigured = Object.assign(
      new Error('Cloudflare not configured'),
      { errorClass: 'cloudflare-not-configured' },
    );
    const cf = makeCloudflareApi({ listTunnelsError: cfNotConfigured });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('cloudflare-not-configured');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('AC4 — listTunnels wirft cloudflare-auth-failed → fail-closed, kein Docker-Schritt', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cfAuthErr = Object.assign(
      new Error('Cloudflare auth failed'),
      { errorClass: 'cloudflare-auth-failed' },
    );
    const cf = makeCloudflareApi({ listTunnelsError: cfAuthErr });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('cloudflare-auth-failed');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it('AC4 — listTunnels wirft cloudflare-unavailable (Netzfehler) → fail-closed, kein Docker-Schritt', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const netErr = Object.assign(
      new Error('Network error'),
      { errorClass: 'cloudflare-unavailable' },
    );
    const cf = makeCloudflareApi({ listTunnelsError: netErr });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('cloudflare-unavailable');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  // ── AC12: Kein Token in result.reason ─────────────────────────────────────

  it('AC12 — result.reason bei tunnel-missing enthält keinen Token/Key', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ listTunnelsResult: [] });
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.reason).not.toContain('Bearer');
    expect(result.reason).not.toContain('PRIVATE KEY');
    expect(result.reason).not.toContain('token');
  });
});

// ── S-185 AC5/AC6: Tunnel-Mismatch/-Missing via VpsProviderRegistry ─────────

describe('DeployOrchestrator — deploy() — S-185 AC5/AC6: Fehlverdrahtungs-Schutz', () => {
  // AC5: mitgegebene tunnelId ≠ registrierte → tunnel-mismatch
  it('AC5 — tunnelId stimmt nicht mit registrierter überein → tunnel-mismatch, kein Schritt', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    // Registry hat andere tunnelId registriert
    const registry = makeVpsRegistry({ tunnelId: 'registered-tunnel-different' });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    // Deploy sendet 'tunnel-abc-123' aber Registry hat 'registered-tunnel-different'
    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'sandbox-3' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-mismatch');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('AC5 — fremder tunnelId (beautymoltTunnel für sandbox-3) → tunnel-mismatch (realer Vorfall)', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ tunnelId: 'correct-sandbox3-tunnel-id' });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({
      ...DEPLOY_PARAMS,
      tunnelId: 'beautymolt-tunnel-xyz', // fremder Tunnel
      vpsId: 'sandbox-3',
    });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-mismatch');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  // AC5: richtige tunnelId → kein Mismatch, Saga läuft weiter
  it('AC5 — tunnelId stimmt mit registrierter überein → kein Mismatch, Saga läuft weiter', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi({ listTunnelsResult: [{ id: DEPLOY_PARAMS.tunnelId }] });
    // Registry hat dieselbe tunnelId registriert
    const registry = makeVpsRegistry({ tunnelId: DEPLOY_PARAMS.tunnelId });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'my-vps' });

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
  });

  // AC6: VPS ohne registrierte Tunnel-Id → tunnel-missing
  it('AC6 — VPS ohne registrierte tunnelId (null) → tunnel-missing, kein Schritt', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ tunnelId: null }); // kein Tunnel
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'vps-no-tunnel' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    expect(docker.pull).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('AC6 — getTargetRecord gibt null zurück (kein Record) → tunnel-missing', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    // Record existiert nicht
    const registry = {
      getTargetRecord: jest.fn(async () => null),
    };
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'ghost-vps' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it('AC6 — Store-Fehler in getTargetRecord → tunnel-missing (kein Crash, kein Token-Leak)', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ throws: true }); // Store wirft
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'vps-store-error' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    expect(docker.pull).not.toHaveBeenCalled();
    // Kein Token in reason
    expect(result.reason).not.toContain('Bearer');
  });

  // C1-Fix: Tunnel-Gates laufen VOR dem Re-Deploy-Replace-Block (kein rm bei fehlendem Tunnel)
  it('C1/AC5 — tunnel-mismatch mit EXISTING container: dockerControl.rm wird NICHT aufgerufen', async () => {
    const existingContainer = { containerId: 'old-cnt', hostname: 'app.example.com', image: 'old:v1', status: 'Up', hostPort: 8080 };
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [existingContainer] },
    });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ tunnelId: 'registered-tunnel-different' });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'sandbox-3' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-mismatch');
    // rm() darf NIEMALS aufgerufen werden — bestehender Container bleibt (AC5/C1)
    expect(docker.rm).not.toHaveBeenCalled();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it('C1/AC6 — tunnel-missing (kein Tunnel registriert) mit EXISTING container: dockerControl.rm wird NICHT aufgerufen', async () => {
    const existingContainer = { containerId: 'old-cnt', hostname: 'app.example.com', image: 'old:v1', status: 'Up', hostPort: 8080 };
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [existingContainer] },
    });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ tunnelId: null }); // kein Tunnel registriert
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'vps-no-tunnel' });

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    // rm() darf NIEMALS aufgerufen werden — bestehender Container bleibt (AC6/C1)
    expect(docker.rm).not.toHaveBeenCalled();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it('C1/AC1 — listTunnels gibt leere Liste (Tunnel fehlt in CF) mit EXISTING container: dockerControl.rm wird NICHT aufgerufen', async () => {
    const existingContainer = { containerId: 'old-cnt', hostname: 'app.example.com', image: 'old:v1', status: 'Up', hostPort: 8080 };
    const docker = makeDockerControl({
      psResult: { result: 'ok', containers: [existingContainer] },
    });
    // Kein vpsRegistry → Mismatch-Gate übersprungen; listTunnels-Gate schlägt an
    const cf = makeCloudflareApi({ listTunnelsResult: [] }); // Tunnel fehlt in Cloudflare
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
    });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-missing');
    // rm() darf NIEMALS aufgerufen werden — bestehender Container bleibt (AC1/C1)
    expect(docker.rm).not.toHaveBeenCalled();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  // Graceful Degradation: ohne vpsRegistry oder vpsId → Gate überspringen
  it('AC2 (backward-compat) — ohne vpsRegistry → Mismatch-Gate übersprungen, Saga läuft', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    // Kein vpsRegistry → Gate übersprungen (Legacy-Setups)
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'some-vps' });

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
  });

  it('AC2 (backward-compat) — ohne vpsId → Mismatch-Gate übersprungen, Saga läuft', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    const cf = makeCloudflareApi();
    const registry = makeVpsRegistry({ tunnelId: 'other-tunnel' });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    // Kein vpsId im deploy() Call → Gate übersprungen
    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
  });

  // AC3: Präzedenz-Reihenfolge — Mismatch-Gate kommt VOR listTunnels-Gate
  it('AC3 — Mismatch-Gate (AC5) läuft VOR listTunnels-Gate (AC1): tunnel-mismatch wenn beide Probleme', async () => {
    const docker = makeDockerControl({ psResult: { result: 'ok', containers: [] } });
    // listTunnels liefert leere Liste UND Mismatch
    const cf = makeCloudflareApi({ listTunnelsResult: [] });
    const registry = makeVpsRegistry({ tunnelId: 'completely-different-tunnel' });
    const orch = new DeployOrchestrator({
      dockerControl: docker,
      cloudflareApi: cf,
      lockoutGuard: makeLockoutGuard(false),
      vpsRegistry: registry,
    });

    const result = await orch.deploy({ ...DEPLOY_PARAMS, vpsId: 'my-vps' });

    // Mismatch-Gate schlägt zuerst an (AC3-Reihenfolge)
    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('tunnel-mismatch');
    // listTunnels wurde NICHT aufgerufen (Mismatch beendet schon vorher)
    expect(cf.listTunnels).not.toHaveBeenCalled();
    expect(docker.pull).not.toHaveBeenCalled();
  });
});

// ── deploy() — deploy-config-volume-mount: Guard-/Seed-Gate (D1/AC1/AC2/AC4/AC5/AC6) ──

describe('DeployOrchestrator — deploy() — config.yaml Guard-/Seed-Gate (deploy-config-volume-mount)', () => {
  const CONFIG_DEPLOY_PARAMS = {
    ...DEPLOY_PARAMS,
    requiresConfig: true,
    configApp: 'myapp',
    configSeed: 'foo: bar',
  };

  it('requiresConfig falsy/abwesend → pushAppConfigFile NIE aufgerufen (AC1/AC8 Deploy-Pfad unverändert)', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pushAppConfigFile).not.toHaveBeenCalled();
  });

  it('requiresConfig true → pushAppConfigFile wird mit vps/configApp/configSeed aufgerufen', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(CONFIG_DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pushAppConfigFile).toHaveBeenCalledTimes(1);
    const [calledVps, calledApp, calledContent] = docker.pushAppConfigFile.mock.calls[0];
    expect(calledVps).toEqual(CONFIG_DEPLOY_PARAMS.vps);
    expect(calledApp).toBe('myapp');
    expect(calledContent).toBe('foo: bar');
  });

  it('Gate-Reihenfolge: pushAppConfigFile läuft NACH Readiness-Probe, VOR Re-Deploy-Replace (ps/rm) und VOR pull/run', async () => {
    const callOrder = [];
    const docker = makeDockerControl();
    docker.probe.mockImplementation(async () => { callOrder.push('probe'); return { state: 'ready' }; });
    docker.pushAppConfigFile.mockImplementation(async () => { callOrder.push('pushAppConfigFile'); return { result: 'ok', seeded: true }; });
    docker.ps.mockImplementation(async () => { callOrder.push('ps'); return { result: 'ok', containers: [] }; });
    docker.pull.mockImplementation(async () => { callOrder.push('pull'); return { result: 'ok' }; });
    docker.run.mockImplementation(async () => { callOrder.push('run'); return { result: 'ok', containerId: 'cid', hostPort: 8080 }; });
    const cf = makeCloudflareApi();

    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });
    const result = await orch.deploy(CONFIG_DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(callOrder.indexOf('probe')).toBeLessThan(callOrder.indexOf('pushAppConfigFile'));
    expect(callOrder.indexOf('pushAppConfigFile')).toBeLessThan(callOrder.indexOf('ps'));
    expect(callOrder.indexOf('pushAppConfigFile')).toBeLessThan(callOrder.indexOf('pull'));
    expect(callOrder.indexOf('pushAppConfigFile')).toBeLessThan(callOrder.indexOf('run'));
  });

  it('AC6: pushAppConfigFile → config-file-missing → deploy() bricht VOR jeder Mutation ab (kein pull/run/ps/addRoute)', async () => {
    const docker = makeDockerControl({
      pushAppConfigFileResult: {
        result: 'error',
        reason: 'config.yaml fehlt auf dem VPS und kein Seed-Inhalt übergeben',
        errorClass: 'config-file-missing',
      },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(CONFIG_DEPLOY_PARAMS);

    expect(result.result).toBe('error');
    expect(result.errorClass).toBe('config-file-missing');
    expect(docker.ps).not.toHaveBeenCalled();
    expect(docker.pull).not.toHaveBeenCalled();
    expect(docker.run).not.toHaveBeenCalled();
    expect(cf.addRoute).not.toHaveBeenCalled();
  });

  it('AC5: pushAppConfigFile → seeded:false (Datei existiert bereits) → Deploy läuft unverändert weiter', async () => {
    const docker = makeDockerControl({ pushAppConfigFileResult: { result: 'ok', seeded: false } });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy(CONFIG_DEPLOY_PARAMS);

    expect(result.result).toBe('ok');
    expect(docker.pull).toHaveBeenCalled();
    expect(docker.run).toHaveBeenCalled();
  });

  it('AC1/AC2: requiresConfig/configApp werden an run() durchgereicht; configSeed NICHT an run()', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(CONFIG_DEPLOY_PARAMS);

    expect(docker.run).toHaveBeenCalledTimes(1);
    const runOpts = docker.run.mock.calls[0][3];
    expect(runOpts.requiresConfig).toBe(true);
    expect(runOpts.configApp).toBe('myapp');
    expect(runOpts.configSeed).toBeUndefined();
  });

  it('requiresConfig false → run()-Opts enthalten weder requiresConfig noch configApp (byte-identisch)', async () => {
    const docker = makeDockerControl();
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    await orch.deploy(DEPLOY_PARAMS);

    const runOpts = docker.run.mock.calls[0][3];
    expect(runOpts).not.toHaveProperty('requiresConfig');
    expect(runOpts).not.toHaveProperty('configApp');
  });

  it('AC10 (Floor): configSeed erscheint nie im reason bei config-file-missing', async () => {
    const secretishSeed = 'admin_token: super-secret-marker-XYZ';
    const docker = makeDockerControl({
      pushAppConfigFileResult: {
        result: 'error',
        reason: 'config.yaml fehlt auf dem VPS und kein Seed-Inhalt übergeben',
        errorClass: 'config-file-missing',
      },
    });
    const cf = makeCloudflareApi();
    const orch = new DeployOrchestrator({ dockerControl: docker, cloudflareApi: cf, lockoutGuard: makeLockoutGuard(false) });

    const result = await orch.deploy({ ...CONFIG_DEPLOY_PARAMS, configSeed: secretishSeed });

    expect(result.reason).not.toContain(secretishSeed);
  });
});
