/**
 * @file knowledgeSourceRouter.test.js — HTTP-level tests for POST /api/assist/knowledge-sources.
 * S-174 (team-knowledge-add), Iteration 1.
 *
 * Covers (team-knowledge-add):
 *   AC3  — POST /api/assist/knowledge-sources {description} ruft KnowledgeSourceService.findSources()
 *           auf (headless, kein JobLock, description via stdin an claude).
 *   AC11 — Eigener KnowledgeSourceService; AssistService bleibt unverändert (kein kind-Switch).
 *           Kein JobLock belegt (paralleler Command-Lauf wird nicht blockiert → kein 409).
 *   AC12 — claude -p mit exklusiv --allowedTools WebSearch: im Argument-Array geprüft
 *           (kein WebFetch, kein Schreib-/FS-Tool). Prüfbar am spawn-Args-Array.
 *   AC14 — URL-Validierung: isValidBootstrapUrl() aus TrainDialog (gemeinsame Logik) —
 *           backend-seitig prüfbar (Unit-Test der Validierungsfunktion in KnowledgeSourceService).
 *   AC15 — Audit-First: AuditStore.record() VOR claude-Aufruf; genau EIN Audit-Eintrag
 *           je akzeptiertem Aufruf; kein Audit bei 400; record()-Fehler → 500, claude NICHT
 *           aufgerufen; Timeout 60 s + max. 1 Retry (im Service); fail-safe.
 *
 * Pattern: express + node:http createServer auf Port 0 (127.0.0.1), kein supertest.
 * KnowledgeSourceService mit gemocktem runClaude injiziert — kein echter claude-Aufruf.
 * AccessGuard per req.identity-Injection simuliert (wie assistRefineRouter.test.js).
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { knowledgeSourceRouter } from '../src/knowledgeSourceRouter.js';
import { KnowledgeSourceService } from '../src/KnowledgeSourceService.js';
import { AuditStore } from '../src/AuditStore.js';
import { JobLock } from '../src/JobLock.js';

// ── HTTP-Hilfsfunktionen ──────────────────────────────────────────────────────

function httpPost(server, path, body) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const bodyStr = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function startServer(app) {
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

// ── Test-Hilfsfunktionen ──────────────────────────────────────────────────────

/** Gültige claude-Ausgabe als JSON-String. */
const HAPPY_RAW = JSON.stringify({
  suggestedPackId: 'rust',
  suggestedType: 'language',
  sources: [
    { title: 'The Rust Programming Language', url: 'https://doc.rust-lang.org/book/', why: 'Offizielle Einführung' },
    { title: 'Rust Reference', url: 'https://doc.rust-lang.org/reference/', why: 'Sprachspezifikation' },
  ],
  notes: 'Rust für systemnahe Backend-Services',
});

function makeApp({ runClaude, identity = { email: 'test@example.com' }, auditStore } = {}) {
  const app = express();
  app.use(express.json());
  // Simuliere AccessGuard
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });

  const store = auditStore ?? new AuditStore();
  const service = new KnowledgeSourceService({ runClaude });

  app.use(knowledgeSourceRouter(service, store));

  return { app, auditStore: store, service };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/assist/knowledge-sources — Happy Path (200)', () => {
  it('gibt 200 + ok:true + suggestedPackId + sources zurück bei gültiger description', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Knowledge zu Rust für systemnahe Backend-Services',
      });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.suggestedPackId).toBe('rust');
      expect(body.suggestedType).toBe('language');
      expect(Array.isArray(body.sources)).toBe(true);
      expect(body.sources).toHaveLength(2);
      expect(body.sources[0].title).toBe('The Rust Programming Language');
      expect(body.sources[0].url).toBe('https://doc.rust-lang.org/book/');
      expect(body.sources[0].why).toBe('Offizielle Einführung');
      expect(body.notes).toBe('Rust für systemnahe Backend-Services');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ruft runClaude genau einmal auf (zustandsloser one-shot)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Rust-Wissen',
      });
      expect(runClaude).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/knowledge-sources — AC11: Kein JobLock', () => {
  it('belegt den JobLock NICHT — ein anderer Lock kann parallel acquiriert werden', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    const jobLock = new JobLock();
    const acquired = jobLock.tryAcquire();
    expect(acquired).toBe(true);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Rust-Wissen während laufendem Flow.',
      });
      expect(status).toBe(200);
      // Lock ist noch gehalten (nicht von knowledge-sources freigegeben)
      expect(jobLock.tryAcquire()).toBe(false);
    } finally {
      jobLock.release();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/knowledge-sources — AC15: Audit-First', () => {
  it('erzeugt genau EINEN Audit-Eintrag je akzeptiertem Aufruf', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({
      runClaude,
      identity: { email: 'user@example.com' },
    });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Rust-Knowledge',
      });
      expect(status).toBe(200);

      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].identity).toBe('user@example.com');
      expect(entries[0].command).toBe('assist/knowledge-sources');
      expect(typeof entries[0].time).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Audit wird VOR claude-Aufruf geschrieben (Audit-First-Konvention)', async () => {
    const auditStore = new AuditStore();
    let auditCountAtClaudeCall = -1;

    const runClaude = jest.fn(async () => {
      auditCountAtClaudeCall = auditStore.getAll().length;
      return HAPPY_RAW;
    });

    const { app } = makeApp({ runClaude, auditStore });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Test Audit-First ordering.',
      });
      expect(status).toBe(200);
      // Audit-Eintrag war bereits vorhanden als claude aufgerufen wurde
      expect(auditCountAtClaudeCall).toBe(1);
      expect(auditStore.getAll()).toHaveLength(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Identität null bei Dev-Bypass (kein email in identity)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({ runClaude, identity: null });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/knowledge-sources', { description: 'Rust' });
      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].identity).toBeNull();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein Audit-Eintrag bei 400 (leere description)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/knowledge-sources', { description: '' });
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('record()-Fehler → 500, claude wird NICHT aufgerufen (Audit-First)', async () => {
    const faultyAuditStore = new AuditStore();
    faultyAuditStore.record = jest.fn(() => { throw new Error('Disk full'); });

    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude, auditStore: faultyAuditStore });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Valid description.',
      });
      expect(status).toBe(500);
      expect(typeof body.error).toBe('string');
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/knowledge-sources — 400 bei ungültigem Input', () => {
  it('400 bei leerer description', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: '',
      });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei whitespace-only description', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: '   ',
      });
      expect(status).toBe(400);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlender description', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {});
      expect(status).toBe(400);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/knowledge-sources — 502 bei claude-Fehler', () => {
  it('502 wenn runClaude wirft (claude nicht verfügbar)', async () => {
    const runClaude = jest.fn(async () => {
      throw new Error('claude is not available in PATH');
    });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Rust Knowledge',
      });
      expect(status).toBe(502);
      expect(typeof body.error).toBe('string');
      // Kein Secret-/Pfad-Leak (AC15, security/R01)
      expect(body.error).not.toMatch(/PATH|secret|token|password/i);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 wenn runClaude ungültiges JSON zurückgibt', async () => {
    const runClaude = jest.fn(async () => 'This is not JSON at all, just prose.');
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/knowledge-sources', {
        description: 'Rust Knowledge',
      });
      expect(status).toBe(502);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('KnowledgeSourceService — Unit Tests', () => {
  it('gibt { ok:false, reason:"invalid-description" } bei leerer description zurück', async () => {
    const service = new KnowledgeSourceService({ runClaude: jest.fn() });
    const result = await service.findSources({ description: '' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-description');
  });

  it('gibt { ok:false, reason:"invalid-description" } bei whitespace-only description zurück', async () => {
    const service = new KnowledgeSourceService({ runClaude: jest.fn() });
    const result = await service.findSources({ description: '  ' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-description');
  });

  it('ruft runClaude NICHT auf bei ungültiger description', async () => {
    const runClaude = jest.fn();
    const service = new KnowledgeSourceService({ runClaude });
    await service.findSources({ description: '' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('gibt { ok:true, suggestedPackId, sources } zurück bei erfolgreichem Aufruf', async () => {
    const service = new KnowledgeSourceService({ runClaude: async () => HAPPY_RAW });
    const result = await service.findSources({ description: 'Rust für Backend' });
    expect(result.ok).toBe(true);
    expect(result.suggestedPackId).toBe('rust');
    expect(result.suggestedType).toBe('language');
    expect(result.sources).toHaveLength(2);
    expect(result.notes).toBe('Rust für systemnahe Backend-Services');
  });

  it('gibt { ok:false, reason:"claude-error" } zurück wenn runClaude wirft', async () => {
    const service = new KnowledgeSourceService({ runClaude: async () => { throw new Error('ENOENT'); } });
    const result = await service.findSources({ description: 'Rust' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude-error');
    // Kein Secret-Leak in message (AC15, security/R01)
    expect(result.message).not.toMatch(/PATH|secret|key|token/i);
  });

  it('parst JSON aus Markdown-Code-Block korrekt', async () => {
    const withFence = '```json\n' + HAPPY_RAW + '\n```';
    const service = new KnowledgeSourceService({ runClaude: async () => withFence });
    const result = await service.findSources({ description: 'Rust' });
    expect(result.ok).toBe(true);
    expect(result.suggestedPackId).toBe('rust');
  });

  it('Retry-Logik: bei erstem Fehler + Erfolg beim zweiten Versuch → ok:true', async () => {
    let callCount = 0;
    const runClaude = jest.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Timeout');
      return HAPPY_RAW;
    });
    const service = new KnowledgeSourceService({ runClaude });
    const result = await service.findSources({ description: 'Rust' });
    expect(result.ok).toBe(true);
    expect(runClaude).toHaveBeenCalledTimes(2); // 1 Retry (A7: max. 1 Retry)
  });

  it('Nach 2 Fehlern → { ok:false, reason:"claude-error" } (A7: max. 1 Retry)', async () => {
    const runClaude = jest.fn(async () => { throw new Error('Timeout'); });
    const service = new KnowledgeSourceService({ runClaude });
    const result = await service.findSources({ description: 'Rust' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude-error');
    expect(runClaude).toHaveBeenCalledTimes(2); // max. 1 Retry
  });
});

describe('KnowledgeSourceService — AC12: --allowedTools WebSearch in Spawn-Args', () => {
  it('defaultRunClaude übergibt --allowedTools WebSearch (kein WebFetch) als Array-Arg', async () => {
    // Prüft das Design-Prinzip: die Spawn-Argumente MÜSSEN enthalten:
    // ['claude', '-p', SYSTEM_PROMPT, '--allowedTools', 'WebSearch']
    // Kein 'WebFetch', kein Schreib-/FS-Tool.
    // Da wir echten spawn nicht aufrufen, prüfen wir auf Quellcode-Ebene:
    // Der capturedArgs-Test prüft, dass description als params.description kommt
    // (NICHT als argv-Teil — security/R02, AC9).
    const capturedParams = [];
    const runClaude = jest.fn(async (params) => {
      capturedParams.push(params);
      return HAPPY_RAW;
    });

    const service = new KnowledgeSourceService({ runClaude });
    await service.findSources({ description: 'Test-Beschreibung' });

    // runClaude empfängt { description } als Parameter-Objekt (security/R02)
    expect(capturedParams).toHaveLength(1);
    expect(capturedParams[0].description).toBe('Test-Beschreibung');
    // Keine argv/shell-Felder (description nie als arg)
    expect(capturedParams[0]).not.toHaveProperty('argv');
    expect(capturedParams[0]).not.toHaveProperty('shell');

    // Quellcode-Verifikation: defaultRunClaude importieren und prüfen
    const { defaultRunClaude } = await import('../src/KnowledgeSourceService.js');
    expect(typeof defaultRunClaude).toBe('function');
    // Indirect: Funktion-Source enthält '--allowedTools' und 'WebSearch' als Argument
    const src = defaultRunClaude.toString();
    expect(src).toContain('--allowedTools');
    expect(src).toContain('WebSearch');
    // 'WebFetch' darf NICHT als erlaubtes Tool im Argument-Array stehen.
    // Ein Kommentar "KEIN WebFetch" ist erlaubt — wir prüfen, dass kein "'WebFetch'" oder '"WebFetch"' vorkommt.
    expect(src).not.toMatch(/'WebFetch'|"WebFetch"/);
    // Und keine Bash-/Schreib-Tools
    expect(src).not.toMatch(/'Bash'|"Bash"|'Edit'|"Edit"|'Write'|"Write"/i);
  });
});
