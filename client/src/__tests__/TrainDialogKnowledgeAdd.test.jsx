/**
 * TrainDialogKnowledgeAdd.test.jsx — Tests for the „Neuen Knowledge Space anlegen"-Flow.
 *
 * @file Scope: client/src/TrainDialog.jsx (KnowledgeAddStep + isValidBootstrapUrl + composePackId)
 *
 * Covers (team-knowledge-add):
 *   AC1  — Button „Neuen Knowledge Space anlegen" im TrainDialog vorhanden;
 *           Klick wechselt in den Anlage-Schritt (data-testid=btn-add-knowledge).
 *   AC2  — Anlage-Schritt: mehrzeiliges Beschreibungsfeld + Button „Quellen suchen".
 *   AC3  — „Quellen suchen" ruft POST /api/assist/knowledge-sources { description } auf;
 *           zeigt Ladezustand (aria-busy=true / data-testid=ks-searching).
 *   AC4  — Ergebnis: Checkbox-Liste (Titel/URL/why, vorausgewählt); Pack-Name+Typ editierbar
 *           (vorbefüllt mit suggestedPackId/suggestedType); Fehler → klare Meldung (ks-search-error).
 *   AC5  — Manuelle Quelle hinzufügen als Fallback (btn-add-manual-url, ks-manual-url).
 *   AC6  — Pack-ID kanonisch aus Name+Typ; existiert Pack-ID → OK deaktiviert + Hinweis
 *           (ks-name-exists).
 *   AC7  — OK sendet genau einen /agent-flow:train --bootstrap <pack-id> <urls…>
 *           an POST /api/command; nur bestätigte (ausgewählte) URLs.
 *   AC8  — OK erst aktiv bei gültigem Namen + ≥1 ausgewählter Quelle (btn-ks-ok disabled).
 *   AC9  — Security-Floor: kein dangerouslySetInnerHTML; URL-Validierung isValidBootstrapUrl.
 *   AC13 — Quellen als „Vorschlag, bitte prüfen" gekennzeichnet; dev-gui fetcht sie nicht.
 *
 *   isValidBootstrapUrl — Unit-Tests (AC9, A5, AC14):
 *     https:// und http:// erlaubt; keine Steuerzeichen; keine Leerzeichen; einzeilig.
 *   composePackId — Unit-Tests (AC6):
 *     language, framework@major, build/<name>, migration/<name>@major.
 *
 * Notes:
 *   - Fetch der /api/team-Daten (Kollisions-Check): im Test durch fetchFn gemockt.
 *   - Für jsdom-Einschränkungen: aria-busy-Verhalten über data-testid simuliert.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }             = await import('@testing-library/react');
const React                  = (await import('react')).default;
const { TrainDialog }        = await import('../TrainDialog.jsx');
const { isValidBootstrapUrl, composePackId } = await import('../TrainDialog.jsx');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KNOWLEDGE = [
  { id: 'security', name: 'Security', group: 'core' },
  { id: 'typescript', name: 'TypeScript', group: 'core' },
];

const KNOWLEDGE_SOURCES_RESPONSE = {
  ok: true,
  suggestedPackId: 'rust',
  suggestedType: 'language',
  sources: [
    { title: 'The Rust Book', url: 'https://doc.rust-lang.org/book/', why: 'Offizielle Einführung' },
    { title: 'Rust Reference', url: 'https://doc.rust-lang.org/reference/', why: 'Sprachspezifikation' },
  ],
  notes: 'Rust für Backend',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Rendert TrainDialog mit kontrollierten fetch-Mocks.
 * @param {{ fetchFn?: Function, knowledge?: Array }} opts
 */
function renderDialog(opts = {}) {
  const { fetchFn, knowledge = KNOWLEDGE } = opts;
  const triggerRef = { current: { focus: jest.fn() } };
  const onClose = jest.fn();

  const result = render(
    React.createElement(TrainDialog, {
      knowledge,
      onClose,
      triggerRef,
      fetchFn,
    }),
  );

  return { ...result, onClose, triggerRef };
}

/**
 * Öffnet den Anlage-Schritt durch Klick auf den Button.
 */
async function openAddStep(container) {
  const btn = container.querySelector('[data-testid="btn-add-knowledge"]');
  expect(btn).not.toBeNull();
  await act(async () => {
    fireEvent.click(btn);
  });
}

// ── Unit-Tests: isValidBootstrapUrl (AC9, A5, AC14) ──────────────────────────

describe('isValidBootstrapUrl — URL-Validierung (AC9, A5, AC14)', () => {
  it('https:// URL ist gültig', () => {
    expect(isValidBootstrapUrl('https://doc.rust-lang.org/book/')).toBe(true);
  });

  it('http:// URL ist gültig', () => {
    expect(isValidBootstrapUrl('http://example.com/docs')).toBe(true);
  });

  it('ftp:// URL ist ungültig', () => {
    expect(isValidBootstrapUrl('ftp://example.com/')).toBe(false);
  });

  it('URL ohne Protokoll ist ungültig', () => {
    expect(isValidBootstrapUrl('example.com')).toBe(false);
  });

  it('URL mit Leerzeichen ist ungültig', () => {
    expect(isValidBootstrapUrl('https://example.com/a b')).toBe(false);
  });

  it('URL mit Zeilenumbruch ist ungültig', () => {
    expect(isValidBootstrapUrl('https://example.com/\ninjection')).toBe(false);
  });

  it('URL mit Steuerzeichen ist ungültig', () => {
    // eslint-disable-next-line no-control-regex
    expect(isValidBootstrapUrl('https://example.com/\x00test')).toBe(false);
  });

  it('URL mit Tab ist ungültig', () => {
    expect(isValidBootstrapUrl('https://example.com/\ttest')).toBe(false);
  });

  it('Nicht-String ist ungültig', () => {
    expect(isValidBootstrapUrl(null)).toBe(false);
    expect(isValidBootstrapUrl(undefined)).toBe(false);
    expect(isValidBootstrapUrl(42)).toBe(false);
  });
});

// ── Unit-Tests: composePackId (AC6) ──────────────────────────────────────────

describe('composePackId — Pack-ID Komposition (AC6)', () => {
  it('language → <name>', () => {
    expect(composePackId('rust', 'language', '')).toBe('rust');
  });

  it('framework + version → <name>@<major>', () => {
    expect(composePackId('spring-boot', 'framework', '3')).toBe('spring-boot@3');
  });

  it('framework ohne version → <name>', () => {
    expect(composePackId('react', 'framework', '')).toBe('react');
  });

  it('build → build/<name>', () => {
    expect(composePackId('gradle', 'build', '')).toBe('build/gradle');
  });

  it('migration → migration/<name>', () => {
    expect(composePackId('flyway', 'migration', '')).toBe('migration/flyway');
  });

  it('migration + version → migration/<name>@<major>', () => {
    expect(composePackId('flyway', 'migration', '10')).toBe('migration/flyway@10');
  });

  it('security → <name>', () => {
    expect(composePackId('owasp', 'security', '')).toBe('owasp');
  });

  it('other → <name>', () => {
    expect(composePackId('my-pack', 'other', '')).toBe('my-pack');
  });
});

// ── Integration-Tests: KnowledgeAddStep in TrainDialog ──────────────────────

describe('TrainDialog — AC1: „Neuen Knowledge Space anlegen" Button', () => {
  it('Button ist im Select-Step vorhanden (data-testid=btn-add-knowledge)', () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    const btn = container.querySelector('[data-testid="btn-add-knowledge"]');
    expect(btn).not.toBeNull();
  });

  it('Klick öffnet den Anlage-Schritt (Beschreibungsfeld erscheint)', async () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    const descField = container.querySelector('[data-testid="ks-description"]');
    expect(descField).not.toBeNull();
  });
});

describe('TrainDialog — AC2: Anlage-Schritt Beschreibungsfeld', () => {
  it('Mehrzeiliges textarea vorhanden', async () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    const textarea = container.querySelector('[data-testid="ks-description"]');
    expect(textarea).not.toBeNull();
    expect(textarea.tagName.toLowerCase()).toBe('textarea');
  });

  it('„Quellen suchen"-Button vorhanden', async () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    const btn = container.querySelector('[data-testid="btn-search-sources"]');
    expect(btn).not.toBeNull();
  });

  it('„Quellen suchen"-Button ohne Beschreibung deaktiviert', async () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    const btn = container.querySelector('[data-testid="btn-search-sources"]');
    expect(btn.disabled).toBe(true);
  });

  it('„Quellen suchen"-Button mit Beschreibung aktiv', async () => {
    const fetchFn = jest.fn();
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust für Backend-Services' },
      });
    });

    const btn = container.querySelector('[data-testid="btn-search-sources"]');
    expect(btn.disabled).toBe(false);
  });
});

describe('TrainDialog — AC3: Quellen-Suche ruft POST /api/assist/knowledge-sources auf', () => {
  it('Klick auf „Quellen suchen" sendet POST zu /api/assist/knowledge-sources', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return {
          ok: true,
          status: 200,
          json: async () => KNOWLEDGE_SOURCES_RESPONSE,
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust für systemnahe Backend-Services' },
      });
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      const calls = fetchFn.mock.calls.filter((c) => c[0] === '/api/assist/knowledge-sources');
      expect(calls.length).toBeGreaterThan(0);
    });

    const call = fetchFn.mock.calls.find((c) => c[0] === '/api/assist/knowledge-sources');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.description).toBe('Rust für systemnahe Backend-Services');
  });

  it('Zeigt Ladezustand (data-testid=ks-searching) während Suche', async () => {
    // Hanging fetch — resolver wird erst verzögert aufgerufen
    let resolveSearch;
    const searchPromise = new Promise((res) => { resolveSearch = res; });
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return searchPromise;
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    // Während die Suche läuft, soll der Ladezustand angezeigt werden
    const searching = container.querySelector('[data-testid="ks-searching"]');
    expect(searching).not.toBeNull();

    // Suche abschließen
    resolveSearch({
      ok: true,
      status: 200,
      json: async () => KNOWLEDGE_SOURCES_RESPONSE,
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-searching"]')).toBeNull();
    });
  });
});

describe('TrainDialog — AC4: Quellen-Liste nach Suche', () => {
  it('Checkboxen (vorausgewählt) für gefundene Quellen', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-source-0"]')).not.toBeNull();
    });

    // Beide Quellen vorhanden
    expect(container.querySelector('[data-testid="ks-source-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ks-source-1"]')).not.toBeNull();

    // Vorausgewählt
    const check0 = container.querySelector('[data-testid="ks-source-check-0"]');
    expect(check0.checked).toBe(true);
    const check1 = container.querySelector('[data-testid="ks-source-check-1"]');
    expect(check1.checked).toBe(true);
  });

  it('Pack-Name/Typ vorbefüllt mit Vorschlag', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      const nameInput = container.querySelector('[data-testid="ks-pack-name"]');
      expect(nameInput).not.toBeNull();
    });

    const nameInput = container.querySelector('[data-testid="ks-pack-name"]');
    expect(nameInput.value).toBe('rust');
  });

  it('Fehler-Meldung bei fehlgeschlagener Suche (kein Secret-Leak)', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: false, status: 502, json: async () => ({ error: 'claude unavailable' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-search-error"]')).not.toBeNull();
    });

    const errorEl = container.querySelector('[data-testid="ks-search-error"]');
    // Fehlermeldung darf kein Secret enthalten
    expect(errorEl.textContent).not.toMatch(/secret|token|key|PATH/i);
  });
});

describe('TrainDialog — AC5: Manuelle Quelle hinzufügen', () => {
  async function openReviewStep(container, _fetchFn) {
    await openAddStep(container);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-manual-url"]')).not.toBeNull();
    });
  }

  it('URL-Feld und Hinzufügen-Button vorhanden', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { container } = renderDialog({ fetchFn });
    await openReviewStep(container, fetchFn);

    expect(container.querySelector('[data-testid="ks-manual-url"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-add-manual-url"]')).not.toBeNull();
  });

  it('gültige https:// URL wird hinzugefügt', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return {
          ok: true, status: 200,
          json: async () => ({ ...KNOWLEDGE_SOURCES_RESPONSE, sources: [] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { container } = renderDialog({ fetchFn });
    await openReviewStep(container, fetchFn);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-manual-url"]'), {
        target: { value: 'https://example.com/docs' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-add-manual-url"]'));
    });

    // Quelle wurde hinzugefügt
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-source-0"]')).not.toBeNull();
    });
  });

  it('ungültige URL zeigt Fehlermeldung', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return {
          ok: true, status: 200,
          json: async () => ({ ...KNOWLEDGE_SOURCES_RESPONSE, sources: [] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { container } = renderDialog({ fetchFn });
    await openReviewStep(container, fetchFn);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-manual-url"]'), {
        target: { value: 'not-a-url' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-add-manual-url"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-manual-url-error"]')).not.toBeNull();
    });
  });
});

describe('TrainDialog — AC6: Kollisions-Check (Pack-ID existiert bereits)', () => {
  it('OK deaktiviert + Hinweis wenn Pack-ID existiert', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        // suggestedPackId = 'security' — existiert bereits in knowledge
        return {
          ok: true, status: 200,
          json: async () => ({
            ...KNOWLEDGE_SOURCES_RESPONSE,
            suggestedPackId: 'security',
            suggestedType: 'security',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    // knowledge enthält 'security'
    const { container } = renderDialog({
      fetchFn,
      knowledge: [{ id: 'security', name: 'Security', group: 'core' }],
    });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Security Knowledge' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-name-exists"]')).not.toBeNull();
    });

    // OK-Button deaktiviert
    const okBtn = container.querySelector('[data-testid="btn-ks-ok"]');
    expect(okBtn.disabled).toBe(true);
  });
});

describe('TrainDialog — AC7: OK sendet /agent-flow:train --bootstrap', () => {
  it('OK sendet genau EINEN Befehl mit --bootstrap und bestätigten URLs', async () => {
    const commandCalls = [];
    const fetchFn = jest.fn(async (url, opts) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      if (url === '/api/command') {
        commandCalls.push(JSON.parse(opts.body));
        return { ok: true, status: 202, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust für Backend' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    // Warte auf Review-Step
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-pack-name"]')).not.toBeNull();
    });

    // Pack-Name setzen (muss gültig sein)
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-pack-name"]'), {
        target: { value: 'rust' },
      });
    });

    // OK klicken
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-ks-ok"]'));
    });

    await waitFor(() => {
      expect(commandCalls.length).toBe(1);
    });

    const cmd = commandCalls[0].command;
    expect(cmd).toMatch(/^\/agent-flow:train --bootstrap rust /);
    expect(cmd).toContain('https://doc.rust-lang.org/book/');
    expect(cmd).toContain('https://doc.rust-lang.org/reference/');
    // Genau ein Befehl (AC7)
    expect(commandCalls.length).toBe(1);
  });

  it('Nur ausgewählte (checked) Quellen fließen in den Befehl', async () => {
    const commandCalls = [];
    const fetchFn = jest.fn(async (url, opts) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      if (url === '/api/command') {
        commandCalls.push(JSON.parse(opts.body));
        return { ok: true, status: 202, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-source-check-1"]')).not.toBeNull();
    });

    // Zweite Quelle abwählen
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="ks-source-check-1"]'));
    });

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-pack-name"]'), {
        target: { value: 'rust' },
      });
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-ks-ok"]'));
    });

    await waitFor(() => {
      expect(commandCalls.length).toBe(1);
    });

    const cmd = commandCalls[0].command;
    // Nur erste URL
    expect(cmd).toContain('https://doc.rust-lang.org/book/');
    // Nicht die zweite
    expect(cmd).not.toContain('https://doc.rust-lang.org/reference/');
  });
});

describe('TrainDialog — AC8: OK erst aktiv bei gültigem Namen + Quellen', () => {
  it('OK initial deaktiviert (kein Name, keine Quellen)', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return {
          ok: true, status: 200,
          json: async () => ({ ...KNOWLEDGE_SOURCES_RESPONSE, sources: [], suggestedPackId: '' }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);

    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="btn-ks-ok"]')).not.toBeNull();
    });

    const okBtn = container.querySelector('[data-testid="btn-ks-ok"]');
    // Kein Name, keine Quellen → disabled
    expect(okBtn.disabled).toBe(true);
  });
});

describe('TrainDialog — AC9/AC13: Security + Vorschlag-Kennzeichnung', () => {
  it('Quellen sind als Text angezeigt (kein klickbarer Link/Fetch)', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return { ok: true, status: 200, json: async () => KNOWLEDGE_SOURCES_RESPONSE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Rust' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="ks-source-0"]')).not.toBeNull();
    });

    // URLs sind als Text (<span>, nicht als <a>) — kein direktes Fetching durch den Browser
    const srcEl = container.querySelector('[data-testid="ks-source-0"]');
    const anchors = srcEl.querySelectorAll('a');
    expect(anchors.length).toBe(0); // Kein <a>-Tag (A4/AC13)
  });

  it('kein dangerouslySetInnerHTML — URLs werden als Text dargestellt', async () => {
    // Test: die URL-Texte werden sicher als Text-Nodes gerendert
    const maliciousUrl = 'https://example.com/<script>alert(1)</script>';
    const fetchFn = jest.fn(async (url) => {
      if (url === '/api/assist/knowledge-sources') {
        return {
          ok: true, status: 200,
          json: async () => ({
            ...KNOWLEDGE_SOURCES_RESPONSE,
            sources: [{ title: 'Test', url: maliciousUrl, why: 'test' }],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    // URL ist ungültig (kein isValidBootstrapUrl wegen <>) — wird gefiltert
    // Aber selbst wenn sie angezeigt wird: kein dangerouslySetInnerHTML
    const { container } = renderDialog({ fetchFn });

    await openAddStep(container);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="ks-description"]'), {
        target: { value: 'Test' },
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="btn-search-sources"]'));
    });

    await waitFor(() => {
      // Die URL mit <script> wird gefiltert (nicht gültig nach isValidBootstrapUrl)
      // daher kein Source-Element
      expect(container.querySelector('[data-testid="btn-ks-ok"]')).not.toBeNull();
    });

    // Kein <script>-Tag im DOM
    expect(container.querySelectorAll('script').length).toBe(0);
  });
});
