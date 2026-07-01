/**
 * @file IdeaSpecifyChatService.test.js — Unit tests for the Idea-Specify Multi-Turn
 * chat boundary (docs/specs/idea-specify-chat.md AC3, AC4, AC5, AC13).
 *
 * Covers (idea-specify-chat): AC3, AC4, AC5, AC13
 *
 *   AC3  — start(): seedet die Session mit Titel + Notes; liefert Claudes
 *          Eröffnungs-Turn als `reply`; sessionId ist erzeugt und über
 *          `hasSession()` auffindbar.
 *   AC4  — message(): hängt die Nutzer-Nachricht an die serverseitig gehaltene
 *          Historie an, liefert `{ reply, readyToSpecify, draftText? }`;
 *          unbekannte sessionId → `{ ok:false, reason:'session-not-found' }`;
 *          leere/ungültige message → `{ ok:false, reason:'invalid-message' }`.
 *   AC5  — tool-los (kein `--dangerously-skip-permissions`), STDIN-Übergabe
 *          (kein Nutzer-Text in argv), harter `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-
 *          Block via `buildChildEnv()`, injizierbarer Runner (kein echter
 *          `claude`-Aufruf nötig), `claude -p`-Fehler → `{ ok:false, reason:'claude-error' }`,
 *          Markdown-Fence-tolerantes JSON-Parsing.
 *   AC13 — der KOMPLETTE bisherige Gesprächsverlauf (alle Owner-/Claude-Turns)
 *          geht bei JEDEM Turn erneut in den `runClaude`-Aufruf ein — kein
 *          Kontextverlust über mehrere Turns; Historie wird NUR bei Erfolg
 *          committet (kein Duplikat bei Retry nach einem fehlgeschlagenen Turn).
 *
 * Pattern: injizierter `runClaude`-Stub (analog AssistService.test-Muster in
 * assistRefineRouter.test.js) — kein echter `claude`-Kindprozess nötig.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  IdeaSpecifyChatService,
  buildSeedMessage,
  parseClaudeOutput,
  defaultRunClaude,
  DEFAULT_CHAT_TIMEOUT_MS,
} from '../src/IdeaSpecifyChatService.js';

/** Gültige claude-Ausgabe als JSON-String (nicht bereit). */
const NOT_READY_RAW = JSON.stringify({
  reply: 'What is the target audience for this feature?',
  readyToSpecify: false,
});

/** Gültige claude-Ausgabe als JSON-String (bereit zu spezifizieren). */
const READY_RAW = JSON.stringify({
  reply: 'Great, I have everything I need.',
  readyToSpecify: true,
  draftText: 'Build a dark-mode toggle in settings, persisted per user.',
});

describe('buildSeedMessage — AC3: Seed aus Titel + Notes', () => {
  it('baut eine Seed-Nachricht mit Titel', () => {
    const seed = buildSeedMessage({ title: 'Dark mode' });
    expect(seed).toContain('Dark mode');
  });

  it('hängt Notes an, wenn vorhanden', () => {
    const seed = buildSeedMessage({ title: 'Dark mode', notes: 'Owner wants it toggle-able' });
    expect(seed).toContain('Dark mode');
    expect(seed).toContain('Owner wants it toggle-able');
  });

  it('lässt Notes weg, wenn leer/undefined', () => {
    const seed = buildSeedMessage({ title: 'Dark mode', notes: undefined });
    expect(seed).not.toMatch(/Notes:/);
  });
});

describe('parseClaudeOutput — AC5: Markdown-Fence-tolerantes JSON-Parsing', () => {
  it('parst reines JSON', () => {
    const result = parseClaudeOutput(NOT_READY_RAW);
    expect(result.reply).toBe('What is the target audience for this feature?');
    expect(result.readyToSpecify).toBe(false);
    expect(result.draftText).toBeUndefined();
  });

  it('parst JSON aus einem ```json ... ```-Block', () => {
    const withFence = '```json\n' + READY_RAW + '\n```';
    const result = parseClaudeOutput(withFence);
    expect(result.reply).toBe('Great, I have everything I need.');
    expect(result.readyToSpecify).toBe(true);
    expect(result.draftText).toBe('Build a dark-mode toggle in settings, persisted per user.');
  });

  it('parst JSON aus einem generischen ``` ... ```-Block (kein "json"-Tag)', () => {
    const withFence = '```\n' + NOT_READY_RAW + '\n```';
    const result = parseClaudeOutput(withFence);
    expect(result.reply).toBe('What is the target audience for this feature?');
  });

  it('Fallback: extrahiert das erste { ... }-Segment aus umgebendem Text', () => {
    const withProse = `Sure, here is my answer:\n${NOT_READY_RAW}\nHope that helps!`;
    const result = parseClaudeOutput(withProse);
    expect(result.reply).toBe('What is the target audience for this feature?');
  });

  it('wirft bei fehlendem reply', () => {
    expect(() => parseClaudeOutput(JSON.stringify({ readyToSpecify: false }))).toThrow();
  });

  it('wirft bei komplett ungültigem JSON (keine Prosa)', () => {
    expect(() => parseClaudeOutput('This is not JSON at all.')).toThrow();
  });

  it('readyToSpecify defaultet auf false wenn nicht strikt true', () => {
    const result = parseClaudeOutput(JSON.stringify({ reply: 'Hi', readyToSpecify: 'yes' }));
    expect(result.readyToSpecify).toBe(false);
  });
});

describe('IdeaSpecifyChatService#start — AC3', () => {
  it('seedet die Session mit Titel + Notes und liefert Claudes Eröffnungs-Turn', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const result = await service.start({ title: 'Dark mode', notes: 'toggle in settings' });

    expect(result.ok).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    expect(result.reply).toBe('What is the target audience for this feature?');
    expect(runClaude).toHaveBeenCalledTimes(1);

    const [[{ history }]] = runClaude.mock.calls.map((c) => [c[0]]);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toContain('Dark mode');
    expect(history[0].content).toContain('toggle in settings');
  });

  it('die zurückgegebene sessionId ist über hasSession() auffindbar', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const result = await service.start({ title: 'Dark mode' });
    expect(service.hasSession(result.sessionId)).toBe(true);
    expect(service.hasSession('does-not-exist')).toBe(false);
  });

  it('{ ok:false, reason:"claude-error" } wenn runClaude wirft', async () => {
    const runClaude = jest.fn(async () => { throw new Error('claude is not available in PATH'); });
    const service = new IdeaSpecifyChatService({ runClaude });

    const result = await service.start({ title: 'Dark mode' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude-error');
    // Kein Secret-/Pfad-Leak in der Fehlermeldung (security/R01)
    expect(result.message).not.toMatch(/PATH|secret|token|password/i);
  });

  it('{ ok:false, reason:"claude-error" } wenn runClaude ungültiges JSON liefert', async () => {
    const runClaude = jest.fn(async () => 'not json at all');
    const service = new IdeaSpecifyChatService({ runClaude });

    const result = await service.start({ title: 'Dark mode' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude-error');
  });

  it('übergibt repoContext an runClaude wenn angegeben', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    await service.start({ title: 'Dark mode', repoContext: 'my-project' });
    expect(runClaude).toHaveBeenCalledWith(expect.objectContaining({ repoContext: 'my-project' }));
  });
});

describe('IdeaSpecifyChatService#message — AC4, AC13', () => {
  it('hängt die Nutzer-Nachricht an die Historie an und liefert den nächsten Turn', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockResolvedValueOnce(READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const started = await service.start({ title: 'Dark mode' });
    const result = await service.message({ sessionId: started.sessionId, message: 'Only for premium users.' });

    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Great, I have everything I need.');
    expect(result.readyToSpecify).toBe(true);
    expect(result.draftText).toBe('Build a dark-mode toggle in settings, persisted per user.');
  });

  it('AC13: der komplette bisherige Gesprächsverlauf geht bei jedem Turn erneut ein (kein Verlust über mehrere Turns)', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockResolvedValueOnce(JSON.stringify({ reply: 'Anything else?', readyToSpecify: false }))
      .mockResolvedValueOnce(READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const started = await service.start({ title: 'Dark mode', notes: 'toggle' });
    await service.message({ sessionId: started.sessionId, message: 'Only for premium users.' });
    await service.message({ sessionId: started.sessionId, message: 'Yes, also a system-theme option.' });

    // Dritter Aufruf (letzter message()-Call) muss die GESAMTE bisherige Historie
    // enthalten: Seed-Turn, erste Claude-Antwort, erste Owner-Antwort, zweite
    // Claude-Antwort, zweite Owner-Antwort (5 Turns).
    const thirdCallArgs = runClaude.mock.calls[2][0];
    expect(thirdCallArgs.history).toHaveLength(5);
    expect(thirdCallArgs.history[0].content).toContain('Dark mode');
    expect(thirdCallArgs.history[1].content).toBe('What is the target audience for this feature?');
    expect(thirdCallArgs.history[2].content).toBe('Only for premium users.');
    expect(thirdCallArgs.history[3].content).toBe('Anything else?');
    expect(thirdCallArgs.history[4].content).toBe('Yes, also a system-theme option.');
  });

  it('{ ok:false, reason:"session-not-found" } bei unbekannter sessionId', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const result = await service.message({ sessionId: 'unknown-id', message: 'Hi' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session-not-found');
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('{ ok:false, reason:"invalid-message" } bei leerer/whitespace-only message', async () => {
    const runClaude = jest.fn(async () => NOT_READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const started = await service.start({ title: 'Dark mode' });
    const result = await service.message({ sessionId: started.sessionId, message: '   ' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-message');
  });

  it('Historie bleibt bei einem fehlgeschlagenen Turn unverändert (transaktional, kein Duplikat bei Retry)', async () => {
    const runClaude = jest.fn()
      .mockResolvedValueOnce(NOT_READY_RAW)
      .mockRejectedValueOnce(new Error('claude -p timed out after 45 s'))
      .mockResolvedValueOnce(READY_RAW);
    const service = new IdeaSpecifyChatService({ runClaude });

    const started = await service.start({ title: 'Dark mode' });
    const failed = await service.message({ sessionId: started.sessionId, message: 'First attempt.' });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('claude-error');

    // Retry mit derselben Nachricht — die Historie darf den fehlgeschlagenen
    // Turn NICHT doppelt enthalten (nur der erneute Versuch erscheint einmal).
    const retried = await service.message({ sessionId: started.sessionId, message: 'First attempt.' });
    expect(retried.ok).toBe(true);

    const thirdCallArgs = runClaude.mock.calls[2][0];
    const ownerTurns = thirdCallArgs.history.filter((t) => t.role === 'user' && t.content === 'First attempt.');
    expect(ownerTurns).toHaveLength(1);
  });
});

describe('defaultRunClaude — AC5: tool-los, STDIN-Übergabe, harter API-Key-Block', () => {
  it('ist eine Funktion, die { history, repoContext } als Parameter akzeptiert', () => {
    expect(typeof defaultRunClaude).toBe('function');
  });

  it('Quellcode-Verifikation: kein --dangerously-skip-permissions (tool-los)', () => {
    const src = defaultRunClaude.toString();
    expect(src).not.toMatch(/--dangerously-skip-permissions/);
  });

  it('Quellcode-Verifikation: nutzt buildChildEnv() (harter ANTHROPIC_API_KEY/OPENAI_API_KEY-Block)', () => {
    const src = defaultRunClaude.toString();
    expect(src).toContain('buildChildEnv');
  });

  it('Quellcode-Verifikation: schreibt den Gesprächsverlauf via stdin, nicht als argv', () => {
    const src = defaultRunClaude.toString();
    expect(src).toContain('child.stdin.write');
    // Die Owner-/Verlaufstexte dürfen nicht Teil des spawn()-argv-Arrays sein —
    // spawn wird ausschliesslich mit ['claude', ['-p', SYSTEM_PROMPT], ...] aufgerufen.
    expect(src).toMatch(/spawn\('claude',\s*\['-p',\s*SYSTEM_PROMPT\]/);
  });

  it('Timeout-Fenster liegt zwischen 30 und 60 Sekunden (Spec-Vorgabe)', () => {
    expect(DEFAULT_CHAT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_CHAT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
