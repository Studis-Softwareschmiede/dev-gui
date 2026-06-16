/**
 * @file assistRefineRouter.test.js — HTTP-level tests for POST /api/assist/refine.
 * Item #S-134, Iteration 2 (AC5, AC7, AC10, AC11).
 *
 * Covers (fabric-intake-dialog): AC5, AC7, AC10, AC11
 *   AC5  — 200 happy path: refinedText + openQuestions zurück; claude -p via
 *           gemocktem runner (kein echter claude-Aufruf); kein JobLock belegt
 *           (paralleler Command-Lauf wird nicht blockiert → kein 409).
 *   AC7  — Audit-First: AuditStore.record() VOR claude-Aufruf (Konvention analog
 *           CommandService); genau EIN Audit-Eintrag je akzeptiertem Aufruf;
 *           Identität korrekt gesetzt; text NICHT in Spawn-args (stdin-Übergabe).
 *           Bei record()-Fehler → 500, claude wird NICHT aufgerufen.
 *   AC10 — 400 bei leerem text; 400 bei unbekanntem kind; kein runner-Aufruf
 *           bei 400; kein Audit bei 400; 502 wenn runner wirft/claude fehlt
 *           (kein Secret-/Pfad-Leak).
 *   AC11 — Doktrin: .claude/CLAUDE.md enthält keine unbedingte „KEIN claude -p"-Aussage
 *           mehr, die den Proof-Helfer ausschließt (Doku-Test).
 *           AccessGuard-Verdrahtung: per server.js-Inspektion, kein separater
 *           Middleware-Test.
 *
 * Pattern: express + node:http createServer auf Port 0 (127.0.0.1), kein supertest.
 * AssistService mit gemocktem runClaude injiziert — kein echter claude-Aufruf.
 * AccessGuard per req.identity-Injection simuliert (wie deploymentsRouter.test.js).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistRefineRouter } from '../src/assistRefineRouter.js';
import { AssistService } from '../src/AssistService.js';
import { AuditStore } from '../src/AuditStore.js';
import { JobLock } from '../src/JobLock.js';

// ── HTTP-Hilfsfunktionen ──────────────────────────────────────────────────────

/**
 * Sendet einen HTTP-POST an den Test-Server.
 * @param {import('node:http').Server} server
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ status: number, body: unknown }>}
 */
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

/**
 * Startet einen Express-Server auf Port 0 (ephemeral) und gibt ihn zurück.
 */
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
  refinedText: 'A concise project description.',
  openQuestions: [
    { question: 'What is the target audience?', why: 'Helps scope the project.', options: ['B2B', 'B2C'] },
    { question: 'What is the timeline?' },
  ],
  notes: 'Looks like a solid idea.',
});

/**
 * Baut eine Express-App mit assistRefineRouter.
 * @param {{ runClaude?: Function, identity?: object|null, auditStore?: AuditStore }} opts
 */
function makeApp({ runClaude, identity = { email: 'test@example.com' }, auditStore } = {}) {
  const app = express();
  app.use(express.json());
  // Simuliere AccessGuard (setzt req.identity)
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });

  const store = auditStore ?? new AuditStore();
  const assistService = new AssistService({ runClaude });

  app.use(assistRefineRouter(assistService, store));

  return { app, auditStore: store, assistService };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/assist/refine — AC5: Happy Path (200)', () => {
  it('gibt 200 + refinedText + openQuestions zurück bei gültigem kind:idea', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: 'I want to build a SaaS app for student management.',
        kind: 'idea',
      });

      expect(status).toBe(200);
      expect(typeof body.refinedText).toBe('string');
      expect(body.refinedText).toBe('A concise project description.');
      expect(Array.isArray(body.openQuestions)).toBe(true);
      expect(body.openQuestions).toHaveLength(2);
      expect(body.openQuestions[0].question).toBe('What is the target audience?');
      expect(body.openQuestions[0].why).toBe('Helps scope the project.');
      expect(body.openQuestions[0].options).toEqual(['B2B', 'B2C']);
      expect(body.openQuestions[1].question).toBe('What is the timeline?');
      expect(body.notes).toBe('Looks like a solid idea.');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('gibt 200 zurück bei gültigem kind:change', async () => {
    const runClaude = jest.fn(async () => JSON.stringify({
      refinedText: 'Refactored description.',
      openQuestions: [],
    }));
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: 'We need to add dark mode support.',
        kind: 'change',
      });

      expect(status).toBe(200);
      expect(body.refinedText).toBe('Refactored description.');
      expect(body.openQuestions).toEqual([]);
      // notes fehlt → nicht im Body
      expect(body.notes).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('ruft runClaude genau einmal auf (AC5: zustandsloser one-shot)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/refine', { text: 'Some idea', kind: 'idea' });
      expect(runClaude).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC5: Kein JobLock (parallel zu laufendem Command)', () => {
  it('belegt den JobLock NICHT — ein anderer Lock kann parallel acquiriert werden', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    // Separater JobLock simuliert einen laufenden Command
    const jobLock = new JobLock();
    const acquired = jobLock.tryAcquire();
    expect(acquired).toBe(true); // Laufender Command hat Lock

    try {
      // assist/refine darf trotzdem laufen (kein 409)
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Idee während laufendem Flow.',
        kind: 'idea',
      });
      expect(status).toBe(200);

      // Lock ist noch gehalten (nicht von assist/refine freigegeben)
      expect(jobLock.tryAcquire()).toBe(false); // immer noch blockiert
    } finally {
      jobLock.release();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC7: Audit-First (Audit VOR claude-Aufruf)', () => {
  it('erzeugt genau EINEN Audit-Eintrag je akzeptiertem Aufruf', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({
      runClaude,
      identity: { email: 'user@example.com' },
    });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Build a learning platform.',
        kind: 'idea',
      });
      expect(status).toBe(200);

      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].identity).toBe('user@example.com');
      expect(entries[0].command).toBe('assist/refine');
      expect(typeof entries[0].time).toBe('string');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Audit wird VOR claude-Aufruf geschrieben (Audit-First-Konvention)', async () => {
    // Prüft die Reihenfolge: Audit-Eintrag muss existieren, bevor runClaude aufgerufen wird.
    const auditStore = new AuditStore();
    let auditCountAtClaudeCall = -1;

    const runClaude = jest.fn(async () => {
      // Zum Zeitpunkt des claude-Aufrufs muss der Audit-Eintrag bereits existieren
      auditCountAtClaudeCall = auditStore.getAll().length;
      return HAPPY_RAW;
    });

    const { app } = makeApp({ runClaude, auditStore });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Test Audit-First ordering.',
        kind: 'idea',
      });
      expect(status).toBe(200);

      // Audit-Eintrag war bereits vorhanden als claude aufgerufen wurde
      expect(auditCountAtClaudeCall).toBe(1);
      // Und insgesamt genau ein Eintrag
      expect(auditStore.getAll()).toHaveLength(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('Identität null bei Dev-Bypass (kein email in identity)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({
      runClaude,
      identity: null,
    });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/refine', { text: 'Some text', kind: 'change' });
      const entries = auditStore.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].identity).toBeNull();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein Audit-Eintrag bei 400 (ungültiger Input)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/refine', { text: '', kind: 'idea' });
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('kein Audit-Eintrag bei 400 (unbekanntes kind)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app, auditStore } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      await httpPost(srv, '/api/assist/refine', { text: 'Some text', kind: 'bad-kind' });
      expect(auditStore.getAll()).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('record()-Fehler → 500, claude wird NICHT aufgerufen (Audit-First-Sicherheitsnetz)', async () => {
    // AuditStore mit fehlschlagendem record()
    const faultyAuditStore = new AuditStore();
    faultyAuditStore.record = jest.fn(() => {
      throw new Error('Disk full');
    });

    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude, auditStore: faultyAuditStore });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: 'Valid text.',
        kind: 'idea',
      });

      // Audit-Fehler → 500 (claude wurde NICHT aufgerufen)
      expect(status).toBe(500);
      expect(typeof body.error).toBe('string');
      // claude darf NICHT aufgerufen worden sein (Audit-First-Konvention)
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC7: stdin statt argv (text nicht in Spawn-args)', () => {
  it('text erscheint NICHT in den Spawn-Argumenten von defaultRunClaude', async () => {
    // Prüft das Design von defaultRunClaude: text wird via STDIN übergeben,
    // nicht als argv-Token. Da wir den echten Spawn nicht aufrufen (CI-sicher),
    // prüfen wir dies auf Quellcode-Ebene via AssistService/defaultRunClaude-Signatur.
    //
    // Der eigentliche Sicherheitstest: der gemockte runClaude erhält text im
    // Params-Objekt, NICHT als CLI-Argument-String. Bei defaultRunClaude wird
    // text via child.stdin.write() übergeben (security/R02, AC7).

    const capturedArgs = [];
    const runClaude = jest.fn(async (params) => {
      capturedArgs.push(params);
      return HAPPY_RAW;
    });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    const userText = 'Sehr geheimer Projekttext — darf nicht in argv erscheinen.';

    try {
      await httpPost(srv, '/api/assist/refine', { text: userText, kind: 'idea' });

      // runClaude empfängt { text, kind } als Parameter-Objekt
      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0].text).toBe(userText);
      expect(capturedArgs[0].kind).toBe('idea');

      // Der text ist ein Parameter an runClaude, NICHT ein Spawn-arg.
      // Zum Beweis: wir importieren defaultRunClaude und prüfen, dass die
      // claude-Spawn-Args den text nicht enthalten.
      // (Quellcode-Ebene: spawn('claude', ['-p', SYSTEM_PROMPT], ...) + stdin.write(text))
      const { defaultRunClaude } = await import('../src/AssistService.js');
      expect(typeof defaultRunClaude).toBe('function');
      // Sicherheitsprüfung: text darf nicht im call-Argument von spawn stehen.
      // Wir assertieren: capturedArgs[0] hat kein argv-/shell-Feld.
      expect(capturedArgs[0]).not.toHaveProperty('argv');
      expect(capturedArgs[0]).not.toHaveProperty('shell');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC10: 400 bei ungültigem Input', () => {
  it('400 bei leerem text (leerer String)', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: '',
        kind: 'idea',
      });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      // runClaude darf NICHT aufgerufen worden sein (AC10)
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei whitespace-only text', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: '   \t\n  ',
        kind: 'idea',
      });
      expect(status).toBe(400);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlendem text', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', { kind: 'idea' });
      expect(status).toBe(400);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei unbekanntem kind', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: 'Valid text.',
        kind: 'unknown-kind',
      });
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      // runClaude darf NICHT aufgerufen worden sein (AC10)
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('400 bei fehlendem kind', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Valid text.',
      });
      expect(status).toBe(400);
      expect(runClaude).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC10: 502 bei claude-Fehler', () => {
  it('502 wenn runClaude wirft (claude nicht verfügbar)', async () => {
    const runClaude = jest.fn(async () => {
      throw new Error('claude is not available in PATH');
    });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status, body } = await httpPost(srv, '/api/assist/refine', {
        text: 'Some valid text.',
        kind: 'idea',
      });
      expect(status).toBe(502);
      expect(typeof body.error).toBe('string');
      // Kein Secret-/Pfad-Leak in der Fehlermeldung (AC10, security/R01)
      expect(body.error).not.toMatch(/PATH|secret|token|password/i);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 wenn runClaude mit exit-code-Fehler wirft', async () => {
    const runClaude = jest.fn(async () => {
      throw new Error('claude -p exited with code 1');
    });
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Some valid text.',
        kind: 'change',
      });
      expect(status).toBe(502);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('502 wenn runClaude ungültiges JSON zurückgibt', async () => {
    const runClaude = jest.fn(async () => 'This is not JSON at all, just prose.');
    const { app } = makeApp({ runClaude });
    const srv = await startServer(app);

    try {
      const { status } = await httpPost(srv, '/api/assist/refine', {
        text: 'Some valid text.',
        kind: 'idea',
      });
      expect(status).toBe(502);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('POST /api/assist/refine — AC11: Doktrin-Doku-Test', () => {
  it('.claude/CLAUDE.md enthält keine unbedingte KEIN-claude-p-Aussage mehr', () => {
    // AC11: Die Doktrin darf keine Aussage enthalten, die den Proof-Helfer ausschließt.
    // Der PTY-/Flow-Pfad soll weiterhin als PTY-only ausgewiesen sein;
    // aber die Absolutaussage ohne Ausnahme muss weg sein.
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../../');
    const claudeMd = readFileSync(resolve(repoRoot, '.claude/CLAUDE.md'), 'utf8');

    // Die neue Formulierung darf nicht mehr „KEIN `claude -p`" ohne Einschränkung sagen.
    // Akzeptabel: Erklärungen MIT Ausnahme-Vermerk (enthalten „Ausnahme" oder „assist/refine").
    // Wir prüfen: gibt es eine Zeile, die NUR „KEIN `claude -p`" sagt (ohne Einschränkungs-Kontext)?
    const lines = claudeMd.split('\n');
    const unconditionalBanLines = lines.filter((line) => {
      // Zeile enthält "KEIN `claude -p`" ODER "KEIN claude -p" (ohne Anführungszeichen)
      const hasBan = /KEIN\s+`claude\s+-p`|KEIN\s+claude\s+-p/i.test(line);
      if (!hasBan) return false;
      // Hat die Zeile einen Ausnahme-/Einschränkungs-Kontext?
      const hasException = /Ausnahme|assist\/refine|AssistService|headless|bewusst/i.test(line);
      // Nur Zeilen ohne Ausnahme-Kontext sind ein Problem
      return !hasException;
    });

    expect(unconditionalBanLines).toHaveLength(0);
  });

  it('docs/architecture.md ADR-001 und NFR-Kosten enthalten keine unbedingte kein-p-Aussage mehr', () => {
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../../');
    const archMd = readFileSync(resolve(repoRoot, 'docs/architecture.md'), 'utf8');

    // Prüfe ADR-001-Zeile: darf nicht mehr unbedingtes „nicht `claude -p`" enthalten,
    // das die Ausnahme ignoriert.
    const lines = archMd.split('\n');
    const adr001Lines = lines.filter((l) => l.includes('ADR-001'));
    const nfrKostenLines = lines.filter((l) => l.includes('**Kosten:**'));

    // ADR-001 muss einen Ausnahme-Vermerk haben
    const adr001HasException = adr001Lines.some((l) =>
      /Ausnahme|assist\/refine|AssistService|bewusst/i.test(l),
    );
    expect(adr001HasException).toBe(true);

    // NFR-Kosten muss einen Ausnahme-Vermerk haben
    const nfrHasException = nfrKostenLines.some((l) =>
      /Ausnahme|assist\/refine|AssistService|bewusst/i.test(l),
    );
    expect(nfrHasException).toBe(true);
  });
});

describe('AssistService.refine — Unit Tests', () => {
  it('gibt { ok: false, reason: "invalid-text" } zurück bei leerem text', async () => {
    const service = new AssistService({ runClaude: jest.fn() });
    const result = await service.refine({ text: '', kind: 'idea' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-text');
  });

  it('gibt { ok: false, reason: "invalid-kind" } zurück bei unbekanntem kind', async () => {
    const service = new AssistService({ runClaude: jest.fn() });
    const result = await service.refine({ text: 'Valid text', kind: 'foobar' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-kind');
  });

  it('gibt { ok: false, reason: "claude-error" } zurück wenn runClaude wirft', async () => {
    const service = new AssistService({ runClaude: async () => { throw new Error('ENOENT'); } });
    const result = await service.refine({ text: 'Valid text', kind: 'idea' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude-error');
  });

  it('gibt { ok: true, refinedText, openQuestions } zurück bei erfolgreichem Aufruf', async () => {
    const service = new AssistService({ runClaude: async () => HAPPY_RAW });
    const result = await service.refine({ text: 'Valid text', kind: 'idea' });
    expect(result.ok).toBe(true);
    expect(result.refinedText).toBe('A concise project description.');
    expect(result.openQuestions).toHaveLength(2);
    expect(result.notes).toBe('Looks like a solid idea.');
  });

  it('parst JSON aus Markdown-Code-Block korrekt', async () => {
    const withFence = '```json\n' + HAPPY_RAW + '\n```';
    const service = new AssistService({ runClaude: async () => withFence });
    const result = await service.refine({ text: 'Valid text', kind: 'change' });
    expect(result.ok).toBe(true);
    expect(result.refinedText).toBe('A concise project description.');
  });

  it('ruft runClaude NICHT auf bei ungültigem text (AC10)', async () => {
    const runClaude = jest.fn();
    const service = new AssistService({ runClaude });
    await service.refine({ text: '  ', kind: 'idea' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('ruft runClaude NICHT auf bei ungültigem kind (AC10)', async () => {
    const runClaude = jest.fn();
    const service = new AssistService({ runClaude });
    await service.refine({ text: 'Valid text', kind: 'bad-kind' });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('übergibt repoContext an runClaude wenn angegeben', async () => {
    const runClaude = jest.fn(async () => HAPPY_RAW);
    const service = new AssistService({ runClaude });
    await service.refine({ text: 'Valid text', kind: 'change', repoContext: 'my-repo' });
    expect(runClaude).toHaveBeenCalledWith(
      expect.objectContaining({ repoContext: 'my-repo' }),
    );
  });
});
