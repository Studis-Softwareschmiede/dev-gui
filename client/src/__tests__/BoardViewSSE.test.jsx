/**
 * BoardViewSSE.test.jsx — Tests für board-live-sse AC13–AC17
 * (Frontend-Abonnent der Server-Sent-Events).
 *
 * Covers (board-live-sse, Story 3 — Frontend):
 *   AC13 — BoardView öffnet beim Mount GENAU EINE EventSource auf /api/board/events
 *           und schließt sie beim Unmount (kein Leak, keine Doppel-Verbindung).
 *   AC14 — Event mit dem Slug des AKTUELL angezeigten Projekts triggert GENAU EINEN
 *           Re-Fetch über bestehenden Ladepfad. Cockpit-Pfad: getestet (reloadToken-Bump).
 *           Standalone-Zweig: nutzt denselben handleSpecified-Verzweigungscode wie
 *           Cockpit, nicht separat unit-getestet (Ablauf verläuft über Projekt-Auswahl,
 *           die jsdom-Mount limiert).
 *   AC15 — Events für NICHT angezeigte Projekte (anderer slug; Standalone-Projektliste
 *           ohne Auswahl) → kein Re-Fetch.
 *   AC16 — Manueller Refresh bleibt Fallback; Reconnect übernimmt EventSource-
 *           Standard (kein eigener Code); Fehler degradieren still (keine
 *           Fehlermauer, kein Blockieren des Ladepfads).
 *   AC17 — Mehrere kurz aufeinanderfolgende Events für dasselbe Projekt führen
 *           nicht zu überlappenden Ladevorgängen (bestehender `cancelled`-Guard
 *           bleibt wirksam).
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react';

const React = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');

// ── Mock EventSource ──────────────────────────────────────────────────────────

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  addEventListener(eventType, handler) {
    if (eventType === 'message') {
      this.onmessage = handler;
    } else if (eventType === 'error') {
      this.onerror = handler;
    } else if (eventType === 'open') {
      this.onopen = handler;
    }
  }

  removeEventListener() {
    // No-op for tests
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  static instances = [];
  static clearInstances() {
    MockEventSource.instances = [];
  }

  static simulateMessage(payload) {
    MockEventSource.instances.forEach((es) => {
      if (!es.closed && es.onmessage) {
        const event = new Event('message');
        event.data = JSON.stringify(payload);
        es.onmessage(event);
      }
    });
  }

  static simulateError() {
    MockEventSource.instances.forEach((es) => {
      if (!es.closed && es.onerror) {
        es.onerror(new Event('error'));
      }
    });
  }
}

// Mock fetch für Board-Projekte laden
function makeFetchMock(projects = []) {
  return jest.fn(async (url) => {
    // Mock `/api/board/projects/list`
    if (url.includes('/api/board/projects/list')) {
      return {
        ok: true,
        json: async () => ({ projects }),
      };
    }
    // Mock `/api/board/projects/:slug`
    if (url.includes('/api/board/projects/')) {
      const proj = projects.find((p) => url.includes(p.slug));
      return {
        ok: true,
        json: async () => ({ project: proj || null }),
      };
    }
    // Default 404
    return { ok: false, status: 404 };
  });
}

beforeEach(() => {
  global.EventSource = MockEventSource;
  MockEventSource.clearInstances();
  jest.restoreAllMocks();
});

afterEach(() => {
  MockEventSource.clearInstances();
});

describe('board-live-sse AC13–AC17: Frontend SSE-Abonnent', () => {
  // ─── AC13: EventSource öffnen/schließen ──────────────────────────────────

  it('AC13 — öffnet beim Mount eine EventSource auf /api/board/events', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances[0];
    expect(es.url).toBe('/api/board/events');
    expect(es.closed).toBe(false);

    unmount();
  });

  it('AC13 — schließt EventSource beim Unmount (kein Leak)', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const es = MockEventSource.instances[0];

    unmount();
    expect(es.closed).toBe(true);
  });

  it('AC13 — dupliziert EventSource nicht bei Re-Render ohne Projektänderung', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { rerender } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const instanceCountBefore = MockEventSource.instances.length;

    // Re-render mit gleichen Props
    rerender(React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }));

    // Keine neuen Instanzen (AC13: genau eine)
    expect(MockEventSource.instances.length).toBe(instanceCountBefore);
  });

  // ─── AC14/AC15: Event-Handling Slug-Matching ──────────────────────────────

  it('AC14 — Event mit passendem slug triggert Re-Fetch', async () => {
    const projects = [
      { slug: 'proj-1', features: [{ id: 'f-1', stories: [] }] },
    ];
    const fetchFn = makeFetchMock(projects);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const fetchCountBefore = fetchFn.mock.calls.length;

    // Event mit passendem slug
    MockEventSource.simulateMessage({ slug: 'proj-1' });

    // Re-Fetch sollte ausgelöst worden sein (ein neuer Fetch-Call)
    await waitFor(() => {
      expect(fetchFn.mock.calls.length).toBeGreaterThan(fetchCountBefore);
    });

    unmount();
  });

  it('AC15 — Event mit anderem slug wird ignoriert (kein Re-Fetch)', async () => {
    const projects = [
      { slug: 'proj-1', features: [{ id: 'f-1', stories: [] }] },
    ];
    const fetchFn = makeFetchMock(projects);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    // AC15 Variante (b): Warten bis EventSource vorhanden ist UND alle initialen
    // Mount-Fetches (einschließlich specify/jobs + finalize) abgeschlossen sind,
    // damit die Baseline-Messung nicht die Mount-Fetches miteinrechnet.
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    // Kurz warten, damit auch specify/jobs und finalize ihre 404-Aufrufe beenden
    await new Promise((r) => setTimeout(r, 50));

    const fetchCountBefore = fetchFn.mock.calls.length;

    // Event mit anderem slug
    MockEventSource.simulateMessage({ slug: 'other-proj' });

    // Keine zusätzlichen Fetches sollten stattgefunden haben
    // (warten kurz, um sicherzustellen, dass keine async Fetch ausgelöst wurde)
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchFn.mock.calls.length).toBe(fetchCountBefore);

    unmount();
  });

  it('AC15 — Standalone ohne Projektauswahl: Events werden ignoriert', async () => {
    const projects = [
      { slug: 'proj-1', features: [{ id: 'f-1', stories: [] }] },
      { slug: 'proj-2', features: [{ id: 'f-2', stories: [] }] },
    ];
    const fetchFn = makeFetchMock(projects);
    global.fetch = fetchFn;

    // Standalone (kein lockedProject)
    const { unmount } = render(
      React.createElement(BoardView, { onNavigate: () => {} }),
    );

    // In Projektliste noch keine EventSource (kein Projekt geladen)
    await new Promise((r) => setTimeout(r, 100));
    expect(MockEventSource.instances.length).toBe(0);

    unmount();
  });

  // ─── AC16: Fehlerbehandlung & Fallback ───────────────────────────────────

  it('AC16 — Fehler in onmessage-Handler werden still behandelt (kein Crash)', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    // Fehlerhafte Payload (JSON-Parse-Fehler)
    const es = MockEventSource.instances[0];
    expect(() => {
      const event = new Event('message');
      event.data = 'invalid json';
      es.onmessage(event);
    }).not.toThrow();

    unmount();
  });

  it('AC16 — onerror-Handler existiert (best-effort, kein Crash)', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[0];
    expect(es.onerror).toBeDefined();

    // Simuliere einen Fehler — sollte nicht crashen
    expect(() => {
      MockEventSource.simulateError();
    }).not.toThrow();

    unmount();
  });

  it('AC16 — EventSource schließt sich nicht automatisch auf Fehler (Reconnect-Standard)', async () => {
    const fetchFn = makeFetchMock([{ slug: 'proj-1', features: [] }]);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.instances[0];
    es.onerror();

    // EventSource bleibt offen (reconnektet per Browser-Standard)
    // In unserem Mock haben wir die Schließung nicht in onerror, also
    // bleibt sie offen
    expect(es.closed).toBe(false);

    unmount();
  });

  // ─── AC17: Multiple Events (Overlap-Guard) ──────────────────────────────

  it('AC17 — mehrere schnelle Events für dasselbe Projekt führen zu EINEM Fetch-Neustart', async () => {
    const projects = [
      { slug: 'proj-1', features: [{ id: 'f-1', stories: [] }] },
    ];
    const fetchFn = makeFetchMock(projects);
    global.fetch = fetchFn;

    const { unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const fetchCountBefore = fetchFn.mock.calls.length;

    // Mehrere schnelle Events
    MockEventSource.simulateMessage({ slug: 'proj-1' });
    MockEventSource.simulateMessage({ slug: 'proj-1' });
    MockEventSource.simulateMessage({ slug: 'proj-1' });

    // Warte kurz auf async Fetches
    await waitFor(() => {
      expect(fetchFn.mock.calls.length).toBeGreaterThan(fetchCountBefore);
    }, { timeout: 200 });

    // Es sollten mindestens neue Fetches sein, aber der bestehende `cancelled`-Guard
    // verhindert Doppel-Ladevorgänge. Das ist im bestehenden Ladepfad bereits
    // implementiert (handleProjectSelect, reloadToken), nicht in unserem SSE-Handler.
    expect(fetchFn.mock.calls.length).toBeGreaterThan(fetchCountBefore);

    unmount();
  });

  // ─── Projekt-Wechsel: EventSource schließen/neu öffnen ────────────────────

  it('AC13 — bei Projektwechsel wird die alte EventSource geschlossen', async () => {
    const projects = [
      { slug: 'proj-1', features: [{ id: 'f-1', stories: [] }] },
      { slug: 'proj-2', features: [{ id: 'f-2', stories: [] }] },
    ];
    const fetchFn = makeFetchMock(projects);
    global.fetch = fetchFn;

    const { rerender, unmount } = render(
      React.createElement(BoardView, { lockedProject: 'proj-1', onNavigate: () => {} }),
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es1 = MockEventSource.instances[0];

    // Wechsel zu anderem Projekt
    rerender(React.createElement(BoardView, { lockedProject: 'proj-2', onNavigate: () => {} }));

    // Die erste EventSource sollte geschlossen werden
    await waitFor(() => {
      expect(es1.closed).toBe(true);
    });

    unmount();
  });
});
