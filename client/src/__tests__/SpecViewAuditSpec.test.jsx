/**
 * SpecViewAuditSpec.test.jsx — Tests für spec-audit-view AC1–AC3 (Button +
 * Lade-Logik) UND audit-spec-main-pane (S-210) AC1–AC7: die Ausgabe des
 * „Audit-Spec anzeigen"-Buttons erscheint jetzt in der rechten
 * Haupt-Inhaltsfläche (statt in der schmalen linken Sidebar); der Button
 * selbst bleibt unverändert an seiner Stelle in der Sidebar.
 *
 * Covers (spec-audit-view):
 *   AC1 — Sekundär-Button „Audit-Spec anzeigen" im Spezifikation-Reiter
 *          vorhanden; direkt unterhalb des ReconcileTrigger-Buttons
 *          (reconcile-box) positioniert; Touch-Target ≥ 44 px.
 *   AC2 — Klick löst genau einen GET .../docs/raw?path=docs/spec-audit.md
 *          aus; der zurückgegebene Markdown wird über MarkdownLite gerendert
 *          und ist sichtbar.
 *   AC3 — 404 (Datei fehlt) → freundlicher Hinweis „noch kein
 *          Reconcile-Lauf" (role="status"), keine rohe Fehlermeldung,
 *          kein Crash.
 *   AC4 — überschrieben durch audit-spec-main-pane (S-210) AC4 (siehe unten).
 *
 * Covers (audit-spec-main-pane):
 *   AC1 — Sidebar zeigt nach Klick KEINE gerenderte Markdown-Ausgabe mehr
 *          (audit-spec-box enthält nur noch den Button).
 *   AC2 — Ausgabe erscheint im Haupt-Content-Container (`specview-content`),
 *          nicht in der Sidebar (`specview-sidebar`).
 *   AC3 — Umschalten: Klick auf „Audit-Spec anzeigen" ersetzt ein per
 *          Navigation gewähltes Dokument in der Hauptfläche durch das
 *          Logbuch; ein anschließender Navigations-Klick schaltet zurück.
 *   AC4 — Lade-/404-/Fehlerzustand jetzt in der Haupt-Inhaltsfläche, nicht in
 *          der Sidebar.
 *   AC7 — entkoppelt über `fetchFn` testbar (siehe Rest der Datei) + neue
 *          Ausgabe-Ort-/Umschalt-Tests unten.
 *
 * reconcile-trigger (S-201) Tests liegen in SpecViewReconcileTrigger.test.jsx;
 * Doc-Navigation/-Filter in SpecView.test.jsx — diese Datei deckt
 * ausschließlich den Audit-Spec-Button ab.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }  = await import('@testing-library/react');
const React        = (await import('react')).default;
const { SpecView } = await import('../SpecView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

let origFetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const FAKE_DOCS = [
  { path: 'README.md', title: 'README', type: 'readme', status: null, id: null, version: null },
];

/**
 * Build a fetch mock that handles the doc list, /api/session, a plain
 * docs/raw?path=README.md request (Navigations-Dokument) and the
 * docs/raw?path=docs/spec-audit.md request.
 *
 * @param {object} opts
 * @param {'busy'|'ready'} [opts.sessionState='ready']
 * @param {number|'network-error'} [opts.auditStatus=200] — HTTP status for the
 *   audit-spec raw request; use 'network-error' to reject instead.
 * @param {string} [opts.auditBody='# Audit-Log\n\n- Aktion 1'] — response body
 *   (only used when auditStatus resolves to ok/text).
 */
function makeFetchFn({ sessionState = 'ready', auditStatus = 200, auditBody = '# Audit-Log\n\n- Aktion 1' } = {}) {
  return jest.fn(async (url) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (typeof url === 'string' && url.includes('docs/raw') && url.includes('spec-audit.md')) {
      if (auditStatus === 'network-error') {
        throw new Error('network down');
      }
      return {
        ok: auditStatus >= 200 && auditStatus < 300,
        status: auditStatus,
        text: async () => auditBody,
      };
    }
    if (typeof url === 'string' && url.includes('docs/raw') && url.includes('README.md')) {
      return { ok: true, status: 200, text: async () => '# README Inhalt' };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/**
 * Render SpecView, replacing globalThis.fetch so the Audit-Spec-Button
 * (default fetchFn = globalThis.fetch) picks it up.
 *
 * @param {Function} [fetchFn]  Optional fetch mock; defaults to makeFetchFn().
 * @param {object} [props]      Extra props to override (e.g. projectSlug).
 */
function renderSpecView(fetchFn, props = {}) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;

  render(
    React.createElement(SpecView, {
      projectSlug: 'my-project',
      ...props,
    }),
  );
  return { fetchFn: fn };
}

// ── AC1: Button vorhanden + positioniert ──────────────────────────────────────

describe('SpecView — spec-audit-view AC1: Button vorhanden + positioniert', () => {
  it('rendert „Audit-Spec anzeigen"-Button im Spezifikation-Reiter', () => {
    renderSpecView();
    const btn = document.querySelector('[data-testid="audit-spec-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Audit-Spec anzeigen/i);
  });

  it('Button ist direkt unterhalb des ReconcileTrigger-Boxes (reconcile-box) positioniert', () => {
    renderSpecView();
    const reconcileBox = document.querySelector('[data-testid="reconcile-box"]');
    const auditBox = document.querySelector('[data-testid="audit-spec-box"]');
    expect(reconcileBox).toBeTruthy();
    expect(auditBox).toBeTruthy();
    // auditBox muss im DOM direkt nach reconcileBox folgen (gleicher Elternknoten).
    expect(reconcileBox.parentElement).toBe(auditBox.parentElement);
    expect(reconcileBox.nextElementSibling).toBe(auditBox);
  });

  it('Button hat minHeight≥44px (Touch-Target, WCAG 2.1 AA)', () => {
    renderSpecView();
    const btn = document.querySelector('[data-testid="audit-spec-btn"]');
    const px = parseInt(btn.style.minHeight, 10);
    expect(px).toBeGreaterThanOrEqual(44);
  });

  it('Zustand ist per zugänglichem Label erkennbar (nicht nur Farbe)', () => {
    renderSpecView();
    const btn = document.querySelector('[data-testid="audit-spec-btn"]');
    expect(btn.getAttribute('aria-label')).toMatch(/Audit-Spec/i);
  });

  // audit-spec-main-pane (S-210) AC1
  it('audit-spec-main-pane AC1: audit-spec-box enthält NUR den Button, keine gerenderte Markdown-Ausgabe', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeTruthy();
    });

    const auditBox = document.querySelector('[data-testid="audit-spec-box"]');
    expect(auditBox.querySelector('[data-testid="audit-spec-content"]')).toBeNull();
    expect(auditBox.textContent).toMatch(/^Audit-Spec anzeigen$/);
  });
});

// ── AC2: Klick lädt + rendert ──────────────────────────────────────────────────

describe('SpecView — spec-audit-view AC2: Klick lädt genau einmal + rendert Markdown', () => {
  it('Klick löst genau einen GET .../docs/raw?path=docs/spec-audit.md aus', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const calls = fetchFn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('docs/raw') && c[0].includes('spec-audit.md'),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatch(/\/api\/board\/projects\/my-project\/docs\/raw\?path=/);
      expect(calls[0][0]).toContain(encodeURIComponent('docs/spec-audit.md'));
    });
  });

  it('geladener Markdown wird über MarkdownLite gerendert und ist sichtbar', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200, auditBody: '# Audit-Log\n\n- Reconcile-Aktion 1' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const content = document.querySelector('[data-testid="audit-spec-content"]');
      expect(content).toBeTruthy();
      const h1 = content.querySelector('h1');
      expect(h1?.textContent).toBe('Audit-Log');
      expect(content.textContent).toMatch(/Reconcile-Aktion 1/);
    });
  });

  // audit-spec-main-pane (S-210) AC2
  it('audit-spec-main-pane AC2: Ausgabe erscheint im Haupt-Content-Container (specview-content), nicht in der Sidebar', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200, auditBody: '# Audit-Log\n\n- Reconcile-Aktion 1' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const content = document.querySelector('[data-testid="audit-spec-content"]');
      expect(content).toBeTruthy();
      const contentPane = document.querySelector('[data-testid="specview-content"]');
      const sidebar = document.querySelector('[data-testid="specview-sidebar"]');
      expect(contentPane.contains(content)).toBe(true);
      expect(sidebar.contains(content)).toBe(false);
    });
  });
});

// ── AC3: 404 → freundlicher Hinweis ───────────────────────────────────────────

describe('SpecView — spec-audit-view AC3: 404 → freundlicher Hinweis, kein Crash', () => {
  it('404 → Hinweis "noch kein Reconcile-Lauf" (role="status"), keine rohe Fehlermeldung', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 404 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const notice = document.querySelector('[data-testid="audit-spec-notfound"]');
      expect(notice).toBeTruthy();
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.textContent).toMatch(/noch kein reconcile-lauf/i);
      // audit-spec-main-pane AC4: Hinweis erscheint in der Hauptfläche, nicht in der Sidebar.
      const contentPane = document.querySelector('[data-testid="specview-content"]');
      expect(contentPane.contains(notice)).toBe(true);
    });

    // kein Fehler-Element, kein Crash
    expect(document.querySelector('[data-testid="audit-spec-error"]')).toBeNull();
    // AC1: keine Markdown-Ausgabe/kein 404-Hinweis in der Sidebar.
    const auditBox = document.querySelector('[data-testid="audit-spec-box"]');
    expect(auditBox.querySelector('[data-testid="audit-spec-notfound"]')).toBeNull();
  });
});

// ── audit-spec-main-pane AC3: Umschalten Audit ↔ Navigations-Dokument ─────────

describe('SpecView — audit-spec-main-pane AC3: Umschalten statt Doppelanzeige', () => {
  it('Klick auf „Audit-Spec anzeigen" ersetzt ein bereits gewähltes Navigations-Dokument in der Hauptfläche', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200, auditBody: '# Audit-Log\n\n- Aktion' });
    renderSpecView(fetchFn);

    // Erst ein Navigations-Dokument öffnen (README.md aus FAKE_DOCS).
    await waitFor(() => {
      expect(document.querySelector('button[title="README.md"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(document.querySelector('button[title="README.md"]'));
    });
    await waitFor(() => {
      const h1 = document.querySelector('[data-testid="specview-content"] h1');
      expect(h1?.textContent).toBe('README Inhalt');
    });

    // Klick auf Audit-Spec-Button → Logbuch ersetzt das Dokument.
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const content = document.querySelector('[data-testid="audit-spec-content"]');
      expect(content).toBeTruthy();
    });
    // Beide nie gleichzeitig sichtbar — kein Dokument-Hinweis/-Inhalt mehr in der Hauptfläche.
    const contentPane = document.querySelector('[data-testid="specview-content"]');
    expect(contentPane.textContent).not.toMatch(/Dokument aus der Navigation auswählen/);
  });

  it('anschließender Navigations-Klick schaltet die Hauptfläche zurück auf das Dokument (Logbuch verschwindet)', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 200, auditBody: '# Audit-Log\n\n- Aktion' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeTruthy();
    });

    await waitFor(() => {
      expect(document.querySelector('button[title="README.md"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(document.querySelector('button[title="README.md"]'));
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeNull();
      const h1 = document.querySelector('[data-testid="specview-content"] h1');
      expect(h1).toBeTruthy();
    });
  });
});

// ── AC4 (überschrieben durch audit-spec-main-pane AC4): Lade-Zustand, Fehler, Doppelklick-Guard ──

describe('SpecView — audit-spec-main-pane AC4: Lade-Zustand + Fehleranzeige in der Hauptfläche, kein Crash', () => {
  it('zugänglicher Lade-Zustand während des Ladens sichtbar — in der Haupt-Inhaltsfläche, nicht in der Sidebar', async () => {
    let resolveFetch;
    const fetchFn = jest.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
        return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
      }
      if (url === '/api/session') {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (typeof url === 'string' && url.includes('docs/raw') && url.includes('spec-audit.md')) {
        return new Promise((resolve) => {
          resolveFetch = () => resolve({ ok: true, status: 200, text: async () => '# Audit-Log' });
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    renderSpecView(fetchFn);

    act(() => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const loading = document.querySelector('[data-testid="audit-spec-loading"]');
      expect(loading).toBeTruthy();
      expect(loading.getAttribute('role')).toBe('status');
      expect(loading.textContent).toMatch(/lade/i);
      // audit-spec-main-pane AC4: Ort ist die Hauptfläche, nicht die Sidebar.
      expect(document.querySelector('[data-testid="specview-content"]').contains(loading)).toBe(true);
      expect(document.querySelector('[data-testid="specview-sidebar"]').contains(loading)).toBe(false);
    });

    await act(async () => {
      resolveFetch();
    });
  });

  it('Netzwerkfehler → sichtbare, neutrale Fehleranzeige (role="alert") in der Hauptfläche, kein Crash', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 'network-error' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="audit-spec-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
      expect(document.querySelector('[data-testid="specview-content"]').contains(err)).toBe(true);
    });

    // übriger Reiter bleibt bedienbar — Reconcile-Button noch da und klickbar
    expect(document.querySelector('[data-testid="reconcile-btn"]')).toBeTruthy();
  });

  it('500 → sichtbare, neutrale Fehleranzeige (role="alert"), kein Crash', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 500 });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="audit-spec-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('Doppelklick löst keinen zweiten konkurrierenden Render aus (Button deaktiviert während Ladung)', async () => {
    const fetchFn = jest.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
        return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
      }
      if (url === '/api/session') {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      if (typeof url === 'string' && url.includes('docs/raw') && url.includes('spec-audit.md')) {
        return { ok: true, status: 200, text: async () => '# Audit-Log' };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    renderSpecView(fetchFn);

    const btn = document.querySelector('[data-testid="audit-spec-btn"]');
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeTruthy();
    });

    const calls = fetchFn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('docs/raw') && c[0].includes('spec-audit.md'),
    );
    expect(calls).toHaveLength(1);
  });
});
