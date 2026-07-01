/**
 * SpecViewAuditSpec.test.jsx — Tests für AC1–AC4 (spec-audit-view):
 * „Audit-Spec anzeigen"-Sekundär-Button direkt unterhalb des
 * ReconcileTrigger-Buttons im Spezifikation-Reiter (SpecView.jsx).
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
 *   AC4 — Zugänglicher Lade-Zustand während des Ladens; Netzwerkfehler/500/
 *          unerwarteter Status → sichtbare, neutrale Fehleranzeige
 *          (role="alert"), kein Crash, übriger Reiter bleibt bedienbar;
 *          Doppelklick löst keinen zweiten konkurrierenden Render aus.
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
 * Build a fetch mock that handles the doc list, /api/session and the
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
    });

    // kein Fehler-Element, kein Crash
    expect(document.querySelector('[data-testid="audit-spec-error"]')).toBeNull();
  });
});

// ── AC4: Lade-Zustand, Fehler, Doppelklick-Guard ──────────────────────────────

describe('SpecView — spec-audit-view AC4: Lade-Zustand + Fehleranzeige, kein Crash', () => {
  it('zugänglicher Lade-Zustand während des Ladens sichtbar', async () => {
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
    });

    await act(async () => {
      resolveFetch();
    });
  });

  it('Netzwerkfehler → sichtbare, neutrale Fehleranzeige (role="alert"), kein Crash', async () => {
    const fetchFn = makeFetchFn({ auditStatus: 'network-error' });
    renderSpecView(fetchFn);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audit-spec-btn"]'));
    });

    await waitFor(() => {
      const err = document.querySelector('[data-testid="audit-spec-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
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
