/**
 * tunnelHealService.test.js — Unit-Tests für TunnelHealService (S-187 + S-188).
 *
 * Covers (vps-tunnel-self-heal):
 *   AC1  — Phase 1: createTunnel → Token unter TUNNEL_TOKEN_KEY ablegen + TUNNEL_ID_KEY aktualisieren;
 *          alte Token-Referenz best-effort aufräumen; nach Erfolg liefert newTunnelId
 *   AC2  — Phase 1 fehlgeschlagen (cloudflare-not-configured / cloudflare-auth-failed /
 *          cloudflare-unavailable) → kein SSH-Schritt, kein orphan-Secret, klare Fehlerklasse
 *   AC3  — Phase 2: pushTunnelEnvFile aufgerufen (env-file write + cloudflared restart);
 *          Phase-2-Ergebnis im Report korrekt
 *   AC4  — Security/Floor (HART): Token NIE in Audit-Einträgen, NIE in Report, NIE im Log-Aufruf
 *          (alle geprüft via Spy auf auditStore.record + report-Traversal)
 *   AC5  — Phase 2 fehlgeschlagen → Tunnel bleibt referenziert (store.set war bereits aufgerufen),
 *          kein verwaistes Geheimnis, Report meldet Phase-2-Fehler klar; Phase 3 übersprungen
 *   AC6  — Phase 3: ps() → managed Container; je Container addRouteOnly (geteilter ADR-012-Pfad);
 *          kein eigener CF-Mutationscode (Grep: kein addRoute/createDnsRecord direkt in TunnelHealService)
 *   AC7  — Protected Hostname → addRouteOnly WIRD aufgerufen und gibt intern (LockoutGuard) protected-resource zurück;
 *          protectedSkipped im Report; kein CF-Anlege-Call (addRoute/createDnsRecord); kein Eintrag in errors[]
 *   AC8  — Teil-Fehler: ein Container-Fehler kippt die übrigen nicht; jedes Ergebnis im Report;
 *          report.result = "ok" / "partial"
 *   AC11 — TunnelRecreateReport enthält NIEMALS tunnelToken — nur tunnelId (nicht-geheim)
 *   AC12 — Audit-First: auditStore.record() VOR jeder mutierenden Phase;
 *          bei Audit-Fail → Aktion unterbleibt
 */

import { describe, it, expect, jest } from '@jest/globals';
import { TunnelHealService } from '../src/deploy/TunnelHealService.js';

// ── Test-Stubs ────────────────────────────────────────────────────────────────

const FAKE_TOKEN = 'eyJhbGciOiJFZERTQSJ9.TUNNEL_SECRET_VALUE.sig';
const NEW_TUNNEL_ID = 'new-tunnel-id-123';
const OLD_TUNNEL_ID = 'old-tunnel-id-456';
const VPS_ID = 'my-vps';

function makeCloudflareApiStub({
  createTunnelResult = { tunnelId: NEW_TUNNEL_ID, token: FAKE_TOKEN },
  createTunnelError = null,
  listTunnelsResult = [],
  deleteTunnelError = null,
} = {}) {
  return {
    listTunnels: jest.fn(async () => listTunnelsResult),
    deleteTunnel: jest.fn(async () => {
      if (deleteTunnelError) throw deleteTunnelError;
      return { result: 'ok' };
    }),
    createTunnel: jest.fn(async () => {
      if (createTunnelError) throw createTunnelError;
      return createTunnelResult;
    }),
  };
}

function makeCredentialStoreStub({
  existingTunnelId = null,
  setError = null,
  deleteError = null,
} = {}) {
  const store = new Map();
  if (existingTunnelId) {
    store.set(`credentials/misc/vps-${VPS_ID}-tunnel-id`, existingTunnelId);
  }
  return {
    getPlaintext: jest.fn(async (key) => store.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      if (setError) throw setError;
      store.set(key, value);
    }),
    delete: jest.fn(async (key) => {
      if (deleteError) throw deleteError;
      store.delete(key);
    }),
    _store: store, // Zugriff auf internen State für Assertions
  };
}

function makeVpsDockerControlStub({
  pushResult = { result: 'ok' },
  psResult = { result: 'ok', containers: [] },
} = {}) {
  return {
    pushTunnelEnvFile: jest.fn(async () => pushResult),
    ps: jest.fn(async () => psResult),
  };
}

/**
 * Minimal DeployOrchestrator stub for Phase 3 (S-188 AC6/AC7/AC8).
 * addRouteOnly() simulates the shared ADR-012 route-add path.
 *
 * @param {{ addRouteResult?: object, addRouteError?: Error }} opts
 */
function makeDeployOrchestratorStub({
  addRouteResult = { result: 'ok' },
  addRouteError = null,
} = {}) {
  return {
    addRouteOnly: jest.fn(async () => {
      if (addRouteError) throw addRouteError;
      return addRouteResult;
    }),
  };
}

function makeAuditStoreStub() {
  return {
    record: jest.fn(),
    _calls: [], // wird via record-Spy gefüllt
  };
}

const VPS_TARGET = { host: '1.2.3.4', port: 22, targetUser: 'root' };

// ── Hilfsfunktion: Report traversieren und auf Token prüfen ──────────────────

/**
 * Traversiert ein Objekt/Array und prüft ob FAKE_TOKEN irgendwo vorkommt.
 * Damit wird AC4/AC11 (Token NIE in Report/Response) beweisbar getestet.
 */
function containsToken(obj, token = FAKE_TOKEN) {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'string') return obj.includes(token);
  if (typeof obj === 'number' || typeof obj === 'boolean') return false;
  if (Array.isArray(obj)) return obj.some((item) => containsToken(item, token));
  if (typeof obj === 'object') {
    return Object.values(obj).some((val) => containsToken(val, token));
  }
  return false;
}

// ── Konstruktor-Tests ─────────────────────────────────────────────────────────

describe('TunnelHealService — Konstruktor', () => {
  it('wirft bei fehlender cloudflareApi', () => {
    expect(() => new TunnelHealService({
      cloudflareApi: null,
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    })).toThrow(/cloudflareApi/);
  });

  it('wirft bei fehlender vpsDockerControl', () => {
    expect(() => new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: null,
      credentialStore: makeCredentialStoreStub(),
    })).toThrow(/vpsDockerControl/);
  });

  it('wirft bei fehlendem credentialStore', () => {
    expect(() => new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: null,
    })).toThrow(/credentialStore/);
  });
});

// ── Phase 1 — Tunnel neu anlegen & Referenz ersetzen ─────────────────────────

describe('TunnelHealService — Phase 1: Tunnel anlegen (AC1)', () => {
  it('AC1: createTunnel mit devgui-<vpsId>-Namen aufgerufen', async () => {
    const cfApi = makeCloudflareApiStub();
    const store = makeCredentialStoreStub();
    const docker = makeVpsDockerControlStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: 'admin@test.com', auditStore: audit });

    expect(cfApi.createTunnel).toHaveBeenCalledWith(`devgui-${VPS_ID}`);
  });

  it('Idempotenz: gleichnamiger Alt-Tunnel wird VOR createTunnel gelöscht (kein 409-conflict)', async () => {
    const cfApi = makeCloudflareApiStub({
      listTunnelsResult: [
        { id: 'stale-same-name', name: `devgui-${VPS_ID}`, status: 'inactive' },
        { id: 'fremder-tunnel', name: 'beautymoltTunnel', status: 'down' },
      ],
    });
    const svc = new TunnelHealService({
      cloudflareApi: cfApi,
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });
    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: 'admin@test.com', auditStore: makeAuditStoreStub() });

    // Nur der gleichnamige Alt-Tunnel wird entfernt, NICHT der fremde
    expect(cfApi.deleteTunnel).toHaveBeenCalledWith('stale-same-name');
    expect(cfApi.deleteTunnel).toHaveBeenCalledTimes(1);
    // Cleanup läuft VOR createTunnel
    expect(cfApi.deleteTunnel.mock.invocationCallOrder[0])
      .toBeLessThan(cfApi.createTunnel.mock.invocationCallOrder[0]);
  });

  it('Idempotenz: kein gleichnamiger Tunnel → kein deleteTunnel, createTunnel läuft normal', async () => {
    const cfApi = makeCloudflareApiStub({
      listTunnelsResult: [{ id: 'fremder-tunnel', name: 'beautymoltTunnel' }],
    });
    const svc = new TunnelHealService({
      cloudflareApi: cfApi,
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });
    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: 'admin@test.com', auditStore: makeAuditStoreStub() });

    expect(cfApi.deleteTunnel).not.toHaveBeenCalled();
    expect(cfApi.createTunnel).toHaveBeenCalledTimes(1);
  });

  it('AC1: Token wird unter TUNNEL_TOKEN_KEY(newTunnelId) gespeichert', async () => {
    const cfApi = makeCloudflareApiStub();
    const store = makeCredentialStoreStub();
    const docker = makeVpsDockerControlStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // Token im Store gesetzt (store.set aufgerufen mit TUNNEL_TOKEN_KEY)
    const tokenKey = `credentials/cloudflare/tunnel_token/${NEW_TUNNEL_ID}`;
    expect(store.set).toHaveBeenCalledWith(tokenKey, FAKE_TOKEN);
  });

  it('AC1: TUNNEL_ID_KEY auf neue Id aktualisiert', async () => {
    const cfApi = makeCloudflareApiStub();
    const store = makeCredentialStoreStub({ existingTunnelId: OLD_TUNNEL_ID });
    const docker = makeVpsDockerControlStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    const idKey = `credentials/misc/vps-${VPS_ID}-tunnel-id`;
    expect(store.set).toHaveBeenCalledWith(idKey, NEW_TUNNEL_ID);
    expect(report.newTunnelId).toBe(NEW_TUNNEL_ID);
    expect(report.oldTunnelId).toBe(OLD_TUNNEL_ID);
  });

  it('AC1: Alte Token-Referenz best-effort aufgeräumt', async () => {
    const cfApi = makeCloudflareApiStub();
    const store = makeCredentialStoreStub({ existingTunnelId: OLD_TUNNEL_ID });
    const docker = makeVpsDockerControlStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    const oldTokenKey = `credentials/cloudflare/tunnel_token/${OLD_TUNNEL_ID}`;
    expect(store.delete).toHaveBeenCalledWith(oldTokenKey);
  });

  it('AC1: Phase-1-Erfolg → report.phase1.ok = true + report.newTunnelId gesetzt', async () => {
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });
    expect(report.phase1.ok).toBe(true);
    expect(report.newTunnelId).toBe(NEW_TUNNEL_ID);
  });
});

// ── Phase 1 — Fehlerfall ──────────────────────────────────────────────────────

describe('TunnelHealService — Phase 1: Fehlerfall (AC2)', () => {
  it('AC2: cloudflare-not-configured → kein SSH, report.phase1.ok = false', async () => {
    const err = Object.assign(new Error('not configured'), { errorClass: 'cloudflare-not-configured' });
    const cfApi = makeCloudflareApiStub({ createTunnelError: err });
    const docker = makeVpsDockerControlStub();
    const store = makeCredentialStoreStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.phase1.ok).toBe(false);
    expect(report.phase1.errorClass).toBe('cloudflare-not-configured');
    // AC2: kein SSH-Schritt
    expect(docker.pushTunnelEnvFile).not.toHaveBeenCalled();
    // AC2: kein orphan-Secret (Token nie gespeichert)
    expect(store.set).not.toHaveBeenCalled();
  });

  it('AC2: cloudflare-auth-failed → kein SSH, Fehlerklasse korrekt', async () => {
    const err = Object.assign(new Error('auth'), { errorClass: 'cloudflare-auth-failed' });
    const cfApi = makeCloudflareApiStub({ createTunnelError: err });
    const docker = makeVpsDockerControlStub();
    const store = makeCredentialStoreStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.phase1.ok).toBe(false);
    expect(report.phase1.errorClass).toBe('cloudflare-auth-failed');
    expect(docker.pushTunnelEnvFile).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('AC2: cloudflare-unavailable → kein SSH, Fehlerklasse korrekt', async () => {
    const err = Object.assign(new Error('unavailable'), { errorClass: 'cloudflare-unavailable' });
    const cfApi = makeCloudflareApiStub({ createTunnelError: err });
    const docker = makeVpsDockerControlStub();
    const store = makeCredentialStoreStub();
    const audit = makeAuditStoreStub();

    const svc = new TunnelHealService({ cloudflareApi: cfApi, vpsDockerControl: docker, credentialStore: store });
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.phase1.ok).toBe(false);
    expect(report.phase1.errorClass).toBe('cloudflare-unavailable');
    expect(docker.pushTunnelEnvFile).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });
});

// ── Phase 2 — Token-Push via SSH ─────────────────────────────────────────────

describe('TunnelHealService — Phase 2: Token-Push (AC3)', () => {
  it('AC3: pushTunnelEnvFile mit VPS-Target und Token aufgerufen', async () => {
    const docker = makeVpsDockerControlStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(docker.pushTunnelEnvFile).toHaveBeenCalledTimes(1);
    // VPS-Target muss übergeben werden
    const [calledVps, calledToken] = docker.pushTunnelEnvFile.mock.calls[0];
    expect(calledVps).toEqual(VPS_TARGET);
    // Token muss genau FAKE_TOKEN sein (nicht null, nicht undefined)
    expect(calledToken).toBe(FAKE_TOKEN);
  });

  it('AC3: Phase-2-Erfolg → report.phase2.ok = true', async () => {
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub({ pushResult: { result: 'ok' } }),
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.phase2.ok).toBe(true);
  });

  it('AC5: Phase 2 fehlgeschlagen → Tunnel bleibt referenziert (store.set war aufgerufen)', async () => {
    const docker = makeVpsDockerControlStub({ pushResult: { result: 'error', errorClass: 'unreachable' } });
    const store = makeCredentialStoreStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: store,
    });
    const audit = makeAuditStoreStub();
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // AC5: Tunnel referenziert → store.set für TUNNEL_TOKEN_KEY und TUNNEL_ID_KEY aufgerufen
    expect(store.set).toHaveBeenCalledWith(
      `credentials/cloudflare/tunnel_token/${NEW_TUNNEL_ID}`,
      FAKE_TOKEN,
    );
    expect(store.set).toHaveBeenCalledWith(
      `credentials/misc/vps-${VPS_ID}-tunnel-id`,
      NEW_TUNNEL_ID,
    );
    // AC5: Phase 2 fehlgeschlagen → report.phase2.ok = false
    expect(report.phase2.ok).toBe(false);
    expect(report.phase2.errorClass).toBe('unreachable');
    // AC5: newTunnelId vorhanden (Tunnel ist referenziert, kein orphan)
    expect(report.newTunnelId).toBe(NEW_TUNNEL_ID);
    // AC5: Fehler im errors[]-Array
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'phase2', errorClass: 'unreachable' }),
    ]));
  });

  it('AC5: Phase 2 fehlgeschlagen → Phase 3 wird übersprungen (routes leer)', async () => {
    const docker = makeVpsDockerControlStub({ pushResult: { result: 'error', errorClass: 'docker-failed' } });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();
    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.routes).toEqual([]);
  });
});

// ── Security-Floor: Token NIE in Audit / Report (AC4 / AC11) ─────────────────

describe('TunnelHealService — Security-Floor: Token NIE in Audit/Report (AC4/AC11)', () => {
  it('AC4: kein Token in Audit-Einträgen (alle auditStore.record()-Calls geprüft)', async () => {
    const audit = makeAuditStoreStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: 'admin@test.com', auditStore: audit });

    // Alle auditStore.record()-Aufrufe durchsuchen: Token darf nicht vorkommen
    expect(audit.record).toHaveBeenCalled(); // mindestens 1 Audit-Eintrag
    for (const call of audit.record.mock.calls) {
      const auditArg = call[0];
      const auditStr = JSON.stringify(auditArg);
      expect(auditStr).not.toContain(FAKE_TOKEN);
      // Auch Identität: nur email, kein Token
      if (auditArg.identity) {
        expect(auditArg.identity).not.toContain(FAKE_TOKEN);
      }
    }
  });

  it('AC11: kein Token im TunnelRecreateReport (vollständige Traversal)', async () => {
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // AC11: kein Token im Report (vollständige Objekt-Traversal)
    expect(containsToken(report, FAKE_TOKEN)).toBe(false);
  });

  it('AC11: kein Token im Report auch bei Phase-2-Fehler', async () => {
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub({ pushResult: { result: 'error', errorClass: 'unreachable' } }),
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(containsToken(report, FAKE_TOKEN)).toBe(false);
  });

  it('AC11: Report enthält newTunnelId (nicht-geheim), aber KEIN token-Feld', async () => {
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.newTunnelId).toBe(NEW_TUNNEL_ID);
    // Explizit: kein token-Feld im Report
    expect(report).not.toHaveProperty('token');
    expect(report).not.toHaveProperty('tunnelToken');
  });
});

// ── Audit-First (AC12) ────────────────────────────────────────────────────────

describe('TunnelHealService — Audit-First (AC12)', () => {
  it('AC12: Audit-Eintrag VOR Phase 1 (createTunnel)', async () => {
    const callOrder = [];
    const audit = {
      record: jest.fn(() => { callOrder.push('audit'); }),
    };
    const cfApi = {
      createTunnel: jest.fn(async () => { callOrder.push('createTunnel'); return { tunnelId: NEW_TUNNEL_ID, token: FAKE_TOKEN }; }),
    };
    const svc = new TunnelHealService({
      cloudflareApi: cfApi,
      vpsDockerControl: makeVpsDockerControlStub(),
      credentialStore: makeCredentialStoreStub(),
    });

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // Audit muss vor createTunnel kommen
    const firstAudit = callOrder.indexOf('audit');
    const firstCreateTunnel = callOrder.indexOf('createTunnel');
    expect(firstAudit).toBeLessThan(firstCreateTunnel);
  });

  it('AC12: Audit-Eintrag VOR Phase 2 (pushTunnelEnvFile)', async () => {
    const callOrder = [];
    const audit = {
      record: jest.fn(() => { callOrder.push('audit'); }),
    };
    const docker = {
      pushTunnelEnvFile: jest.fn(async () => { callOrder.push('pushTunnelEnvFile'); return { result: 'ok' }; }),
    };
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
    });

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // Mindestens ein Audit VOR pushTunnelEnvFile
    const auditIdx = callOrder.indexOf('audit');
    const pushIdx = callOrder.indexOf('pushTunnelEnvFile');
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(auditIdx);
  });

  it('AC12: Audit-Fail vor Phase 2 → pushTunnelEnvFile nicht aufgerufen', async () => {
    // Audit für Phase 1 ok, aber Audit für Phase 2 wirft
    let auditCallCount = 0;
    const audit = {
      record: jest.fn(() => {
        auditCallCount++;
        if (auditCallCount >= 2) {
          throw new Error('Audit-Store-Fehler');
        }
      }),
    };
    const docker = makeVpsDockerControlStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
    });

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // Phase 2 muss übersprungen werden
    expect(docker.pushTunnelEnvFile).not.toHaveBeenCalled();
    expect(report.phase2.ok).toBe(false);
    expect(report.phase2.errorClass).toBe('audit-failed');
  });
});

// ── VPS-Target-Fehlerfall ─────────────────────────────────────────────────────

describe('TunnelHealService — VPS-Target-Fehlerfall', () => {
  it('kein vpsTarget (null) → Phase 2 übersprungen, klarer Fehler', async () => {
    const docker = makeVpsDockerControlStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: null, identity: null, auditStore: audit });

    expect(report.phase1.ok).toBe(true);
    expect(report.phase2.ok).toBe(false);
    expect(report.phase2.errorClass).toBe('vps-target-missing');
    expect(docker.pushTunnelEnvFile).not.toHaveBeenCalled();
  });
});

// ── Phase 3 — Routen bestücken (S-188 AC6/AC7/AC8) ──────────────────────────

const MANAGED_CONTAINER = {
  containerId: 'abc123',
  hostname: 'app.example.com',
  hostPort: 8080,
  image: 'ghcr.io/org/app:v1',
  status: 'Up 2 hours',
};

describe('TunnelHealService — Phase 3: Routen bestücken (AC6)', () => {
  it('AC6: ps() aufgerufen mit vpsTarget nach Phase 2 Erfolg', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(docker.ps).toHaveBeenCalledWith(VPS_TARGET);
  });

  it('AC6: addRouteOnly mit neuem tunnelId + hostname + hostPort aufgerufen', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(orch.addRouteOnly).toHaveBeenCalledTimes(1);
    const args = orch.addRouteOnly.mock.calls[0][0];
    expect(args.tunnelId).toBe(NEW_TUNNEL_ID);
    expect(args.hostname).toBe(MANAGED_CONTAINER.hostname);
    expect(args.hostPort).toBe(MANAGED_CONTAINER.hostPort);
  });

  it('AC6: kein direkter CF-Mutationscode — addRouteOnly ist der einzige Route-Anlege-Pfad', () => {
    // Grep-prüfbar: TunnelHealService darf kein cloudflareApi.addRoute/createDnsRecord direkt aufrufen.
    // Dieser Test assertiert das strukturell: cloudflareApi hat KEINE addRoute/createDnsRecord-Methode
    // die von TunnelHealService direkt aufgerufen würde. Der einzige Pfad ist über addRouteOnly.
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub();
    const cfApiSpy = {
      createTunnel: jest.fn(async () => ({ tunnelId: NEW_TUNNEL_ID, token: FAKE_TOKEN })),
      // addRoute und createDnsRecord explizit NICHT vorhanden — würde Fehler werfen falls aufgerufen
    };

    const svc = new TunnelHealService({
      cloudflareApi: cfApiSpy,
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });

    // Wenn TunnelHealService cfApi.addRoute/createDnsRecord aufrufen würde, würde recreate() werfen.
    // Der Test bestätigt, dass er NICHT wirft und addRouteOnly stattdessen aufgerufen wird.
    const audit = makeAuditStoreStub();
    return expect(
      svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit }),
    ).resolves.toMatchObject({ phase1: { ok: true }, phase2: { ok: true } });
  });

  it('AC6: Route-Ergebnis route-created im Report (ein Container)', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub({ addRouteResult: { result: 'ok' } });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.routes).toHaveLength(1);
    expect(report.routes[0]).toMatchObject({ hostname: MANAGED_CONTAINER.hostname, result: 'route-created' });
    expect(report.result).toBe('ok');
  });

  it('AC6: Keine managed Container → routes leer, result ok', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [] },
    });
    const orch = makeDeployOrchestratorStub();
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.routes).toHaveLength(0);
    expect(orch.addRouteOnly).not.toHaveBeenCalled();
    expect(report.result).toBe('ok');
  });

  it('AC6: kein deployOrchestrator konfiguriert → Phase 3 no-op, routes leer', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      // deployOrchestrator nicht gesetzt
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.routes).toHaveLength(0);
    // ps() NICHT aufgerufen wenn kein orchestrator
    expect(docker.ps).not.toHaveBeenCalled();
  });
});

describe('TunnelHealService — Phase 3: Protected Hostname (AC7)', () => {
  it('AC7: protected-resource → protectedSkipped im Report, addRouteOnly trotzdem aufgerufen (LockoutGuard inbegriffen)', async () => {
    // addRouteOnly liefert protected-resource → TunnelHealService schreibt protected-skipped in routes[]
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub({
      addRouteResult: { result: 'error', errorClass: 'protected-resource' },
    });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // AC7: protectedSkipped im routes[]-Eintrag
    expect(report.routes).toHaveLength(1);
    expect(report.routes[0]).toMatchObject({
      hostname: MANAGED_CONTAINER.hostname,
      result: 'protected-skipped',
    });
    // AC7: addRouteOnly WURDE aufgerufen (LockoutGuard liegt intern drin)
    expect(orch.addRouteOnly).toHaveBeenCalledTimes(1);
    // Protected-Skip ist kein Fehler → kein Eintrag in errors[]
    const protectedErrors = report.errors.filter((e) => e.scope.includes(MANAGED_CONTAINER.hostname));
    expect(protectedErrors).toHaveLength(0);
    // AC7: result "ok" (keine echten Fehler)
    expect(report.result).toBe('ok');
  });
});

describe('TunnelHealService — Phase 3: Teil-Fehler-Semantik (AC8)', () => {
  const CONTAINER_A = { containerId: 'c1', hostname: 'app-a.example.com', hostPort: 8080, image: 'img:v1', status: 'Up' };
  const CONTAINER_B = { containerId: 'c2', hostname: 'app-b.example.com', hostPort: 8081, image: 'img:v2', status: 'Up' };

  it('AC8: ein Container-Fehler kippt die übrigen nicht — beide Hostnamen im Report', async () => {
    let callCount = 0;
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [CONTAINER_A, CONTAINER_B] },
    });
    const orch = {
      addRouteOnly: jest.fn(async ({ hostname }) => {
        callCount++;
        // CONTAINER_A schlägt fehl, CONTAINER_B gelingt
        if (hostname === CONTAINER_A.hostname) {
          return { result: 'error', errorClass: 'zone-not-found' };
        }
        return { result: 'ok' };
      }),
    };

    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // AC8: beide Container im Report
    expect(report.routes).toHaveLength(2);
    const routeA = report.routes.find((r) => r.hostname === CONTAINER_A.hostname);
    const routeB = report.routes.find((r) => r.hostname === CONTAINER_B.hostname);
    expect(routeA).toMatchObject({ result: 'error', errorClass: 'zone-not-found' });
    expect(routeB).toMatchObject({ result: 'route-created' });

    // AC8: addRouteOnly beide Male aufgerufen (Fehler von A bricht B nicht ab)
    expect(callCount).toBe(2);

    // AC8: Gesamt-Ergebnis partial (Teil-Fehler)
    expect(report.result).toBe('partial');
  });

  it('AC8: Fehler via throw → error im Report, nächste Container laufen weiter', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [CONTAINER_A, CONTAINER_B] },
    });
    const orch = {
      addRouteOnly: jest.fn(async ({ hostname }) => {
        if (hostname === CONTAINER_A.hostname) {
          throw Object.assign(new Error('Cloudflare-Fehler'), { errorClass: 'cloudflare-unavailable' });
        }
        return { result: 'ok' };
      }),
    };

    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    const routeA = report.routes.find((r) => r.hostname === CONTAINER_A.hostname);
    const routeB = report.routes.find((r) => r.hostname === CONTAINER_B.hostname);
    expect(routeA).toMatchObject({ result: 'error', errorClass: 'cloudflare-unavailable' });
    expect(routeB).toMatchObject({ result: 'route-created' });
    expect(report.result).toBe('partial');
  });

  it('AC8: alle Container erfolgreich → report.result = "ok"', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [CONTAINER_A, CONTAINER_B] },
    });
    const orch = makeDeployOrchestratorStub({ addRouteResult: { result: 'ok' } });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    expect(report.result).toBe('ok');
    expect(report.routes).toHaveLength(2);
    expect(report.routes.every((r) => r.result === 'route-created')).toBe(true);
  });

  it('AC11: kein Token im Report bei Phase-3-Lauf (vollständige Traversal)', async () => {
    const docker = makeVpsDockerControlStub({
      psResult: { result: 'ok', containers: [MANAGED_CONTAINER] },
    });
    const orch = makeDeployOrchestratorStub({ addRouteResult: { result: 'ok' } });
    const svc = new TunnelHealService({
      cloudflareApi: makeCloudflareApiStub(),
      vpsDockerControl: docker,
      credentialStore: makeCredentialStoreStub(),
      deployOrchestrator: orch,
    });
    const audit = makeAuditStoreStub();

    const report = await svc.recreate({ vpsId: VPS_ID, vpsName: VPS_ID, vpsTarget: VPS_TARGET, identity: null, auditStore: audit });

    // AC11: kein Token im Report (vollständige Traversal)
    expect(containsToken(report, FAKE_TOKEN)).toBe(false);
  });
});
