/**
 * SpecViewReconcileInline.test.jsx — Tests für reconcile-inline-feedback (S-205)
 * AC1–AC5, AC8, AC9 (Frontend-Teil; AC6/AC7 sind Backend, siehe
 * test/session-router.test.js + test/PtySessionRegistry.test.js).
 *
 * Covers (reconcile-inline-feedback):
 *   AC1 — Nach 202 wird `onNavigate` NICHT mehr aufgerufen (überschreibt
 *          reconcile-trigger AC5); inline „Reconcile läuft…" (role="status"),
 *          Button deaktiviert (disabled + Text-Label).
 *   AC2 — Solange `GET /api/session` `state:"busy"` liefert, bleibt „Reconcile
 *          läuft…" sichtbar, Button deaktiviert.
 *   AC3 — Erstmaliges nicht-`busy` nach `busy` → „Fertig" (role="status"),
 *          Button wieder auslösbar. Inklusive Edge-Case „Race busy→ready
 *          sofort" (erster Poll nach dem Start bereits nicht-busy).
 *   AC4 — Beim Übergang auf „Fertig" wird AuditSpecView automatisch GENAU
 *          EINMAL neu geladen (kein manueller Klick, kein Doppel-Reload).
 *   AC5 — Erkennbarer PR-Bezug im Audit-Inhalt → dezenter Link/Hinweis; kein
 *          Bezug → kein Element (graceful absence).
 *   AC8 — Sicherheitsfenster überschritten (Session flippt nie zurück) ODER
 *          wiederholte Poll-Fehler → neutrale Degradierung statt Endlos-
 *          Spinner; „Audit-Spec anzeigen" bleibt bedienbar.
 *   AC9 — Regression zu reconcile-trigger AC6/AC7: bereits vollständig
 *          gedeckt in SpecViewReconcileTrigger.test.jsx (409/500/Netzwerkfehler
 *          → Fehleranzeige mit Reset, kein onNavigate) — identisches
 *          Verhalten, hier nicht dupliziert.
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
 * Build a fetch mock with a scripted /api/session state sequence.
 *
 * @param {object} opts
 * @param {Array<'busy'|'ready'|'error'>} [opts.sessionSequence=['ready']] —
 *   consumed in order per /api/session call; last entry repeats once exhausted.
 * @param {number} [opts.commandStatus=202]
 * @param {string} [opts.auditBody='# Audit-Log\n\n- Aktion 1'] — spec-audit.md body
 * @param {number} [opts.auditStatus=200]
 */
function makeFetchFn({
  sessionSequence = ['ready'],
  commandStatus = 202,
  auditBody = '# Audit-Log\n\n- Aktion 1',
  auditStatus = 200,
} = {}) {
  let sessionCallIdx = 0;
  const auditCalls = [];

  const fn = jest.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/session') {
      const idx = Math.min(sessionCallIdx, sessionSequence.length - 1);
      sessionCallIdx += 1;
      const state = sessionSequence[idx];
      if (state === 'error') {
        throw new Error('network down');
      }
      return { ok: true, status: 200, json: async () => ({ state, restarts: 0 }) };
    }
    if (url === '/api/command' && opts?.method === 'POST') {
      return { ok: commandStatus === 202, status: commandStatus, json: async () => ({}) };
    }
    if (typeof url === 'string' && url.includes('docs/raw') && url.includes('spec-audit.md')) {
      auditCalls.push(url);
      return {
        ok: auditStatus >= 200 && auditStatus < 300,
        status: auditStatus,
        text: async () => auditBody,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  fn._auditCalls = auditCalls;
  return fn;
}

function renderSpecView(fetchFn, extraProps = {}) {
  const fn = fetchFn ?? makeFetchFn();
  globalThis.fetch = fn;

  const onNavigateSpy = jest.fn();
  render(
    React.createElement(SpecView, {
      projectSlug: 'my-project',
      onNavigate: onNavigateSpy,
      reconcilePollInterval: 10,
      reconcileSafetyWindowMs: 5 * 60 * 1000,
      reconcileMaxConsecutiveFailures: 5,
      ...extraProps,
    }),
  );
  return { onNavigateSpy, fetchFn: fn };
}

async function startRun(fetchFn) {
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
  });
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
  });
  await waitFor(() => {
    const calls = fetchFn.mock.calls.filter(
      (c) => c[0] === '/api/command' && c[1]?.method === 'POST',
    );
    expect(calls).toHaveLength(1);
  });
}

// ── AC1: Kein onNavigate, inline „Reconcile läuft…" ────────────────────────────

describe('reconcile-inline-feedback AC1: 202 → kein onNavigate, inline "Reconcile läuft…"', () => {
  it('202 → onNavigate wird NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'busy'] });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-running"]')).toBeTruthy();
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
  });

  it('202 → inline "Reconcile läuft…" (role="status"), Button disabled + Text-Label', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'busy'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const running = document.querySelector('[data-testid="reconcile-running"]');
      expect(running).toBeTruthy();
      expect(running.getAttribute('role')).toBe('status');
      expect(running.textContent).toMatch(/reconcile läuft/i);

      const btn = document.querySelector('[data-testid="reconcile-btn"]');
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-label')).toMatch(/läuft/i);
    });
  });

  it('202 → bleibt auf dem Spezifikation-Reiter (SpecView selbst bleibt gemountet, kein Wegspringen)', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'busy'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-box"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="reconcile-running"]')).toBeTruthy();
    });
  });
});

// ── AC2: Poll hält "Reconcile läuft…" solange busy ─────────────────────────────

describe('reconcile-inline-feedback AC2: solange busy, bleibt "Reconcile läuft…" + Button disabled', () => {
  it('mehrere busy-Polls in Folge → weiterhin "Reconcile läuft…", Button disabled', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'busy', 'busy', 'busy'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    // Wait through several poll ticks (pollInterval=10ms) — still running.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    const running = document.querySelector('[data-testid="reconcile-running"]');
    expect(running).toBeTruthy();
    const btn = document.querySelector('[data-testid="reconcile-btn"]');
    expect(btn.disabled).toBe(true);
  });
});

// ── AC3: busy → ready ⇒ "Fertig" ────────────────────────────────────────────────

describe('reconcile-inline-feedback AC3: busy → nicht-busy ⇒ "Fertig", Button wieder auslösbar', () => {
  it('busy → ready ⇒ "Fertig" (role="status"), Button wieder auslösbar', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'ready', 'ready'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const done = document.querySelector('[data-testid="reconcile-done"]');
      expect(done).toBeTruthy();
      expect(done.getAttribute('role')).toBe('status');
      expect(done.textContent).toMatch(/fertig/i);
    });

    await waitFor(() => {
      const btn = document.querySelector('[data-testid="reconcile-btn"]');
      expect(btn.disabled).toBe(false);
    });

    // "Reconcile läuft…" ist verschwunden.
    expect(document.querySelector('[data-testid="reconcile-running"]')).toBeNull();
  });

  it('Edge-Case „Race busy→ready sofort": erster Poll nach Start bereits nicht-busy ⇒ direkt "Fertig"', async () => {
    // Kein "busy" in der Sequenz — der erste Poll NACH dem Start liefert bereits ready.
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'ready', 'ready'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-done"]')).toBeTruthy();
    });
    // Kein Hängenbleiben in "läuft".
    expect(document.querySelector('[data-testid="reconcile-running"]')).toBeNull();
  });
});

// ── AC4: Audit-Reload genau einmal bei Abschluss ───────────────────────────────

describe('reconcile-inline-feedback AC4: Audit-Reload automatisch + genau einmal', () => {
  it('Übergang auf "Fertig" → genau ein GET docs/raw?path=docs/spec-audit.md, ohne manuellen Klick', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'ready', 'ready', 'ready'] });
    renderSpecView(fetchFn);

    // Vor dem Lauf: kein Audit-Request.
    expect(fetchFn._auditCalls).toHaveLength(0);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-done"]')).toBeTruthy();
    });

    // Gerenderter Audit-Inhalt sichtbar, ohne Klick auf "Audit-Spec anzeigen".
    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeTruthy();
    });

    // Genau ein Audit-Request, auch nach weiteren ready-Polls (kein Doppel-Reload).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(fetchFn._auditCalls).toHaveLength(1);
  });

  it('Kein projectSlug → Audit-Reload feuert keinen Request mit leerem Slug (Edge-Case)', async () => {
    const fetchFn = makeFetchFn({ sessionSequence: ['ready', 'busy', 'ready', 'ready'] });
    globalThis.fetch = fetchFn;
    const onNavigateSpy = jest.fn();
    render(
      React.createElement(SpecView, {
        projectSlug: '',
        onNavigate: onNavigateSpy,
        reconcilePollInterval: 10,
      }),
    );

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-btn"]'));
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-confirm-yes"]'));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(fetchFn._auditCalls).toHaveLength(0);
  });
});

// ── AC5: PR-Bezug (best-effort) ─────────────────────────────────────────────────

describe('reconcile-inline-feedback AC5: PR-Bezug im Audit-Inhalt (best-effort)', () => {
  it('PR-URL im Audit-Inhalt → dezenter Link (target=_blank, rel=noopener noreferrer)', async () => {
    const fetchFn = makeFetchFn({
      sessionSequence: ['ready', 'ready', 'ready'],
      auditBody: '# Audit-Log\n\n- Reconcile-Lauf siehe https://github.com/org/repo/pull/42',
    });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const link = document.querySelector('[data-testid="audit-spec-pr-link"]');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toMatch(/noopener/);
      expect(link.getAttribute('rel')).toMatch(/noreferrer/);
      expect(link.textContent).toMatch(/42/);
    });
  });

  it('Bare #<nummer> ohne URL → Text-Hinweis (kein anklickbarer Link)', async () => {
    const fetchFn = makeFetchFn({
      sessionSequence: ['ready', 'ready', 'ready'],
      auditBody: '# Audit-Log\n\n- Siehe PR #17 für Details',
    });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const hint = document.querySelector('[data-testid="audit-spec-pr-hint"]');
      expect(hint).toBeTruthy();
      expect(hint.textContent).toMatch(/17/);
    });
    expect(document.querySelector('[data-testid="audit-spec-pr-link"]')).toBeNull();
  });

  it('Kein erkennbarer PR-Bezug → kein Link/Hinweis-Element (graceful absence)', async () => {
    const fetchFn = makeFetchFn({
      sessionSequence: ['ready', 'ready', 'ready'],
      auditBody: '# Audit-Log\n\n- Keine PR-Referenz hier.',
    });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="audit-spec-pr-link"]')).toBeNull();
    expect(document.querySelector('[data-testid="audit-spec-pr-hint"]')).toBeNull();
  });
});

// ── AC8: robuste Degradierung ────────────────────────────────────────────────────

describe('reconcile-inline-feedback AC8: robuste Degradierung — kein Endlos-Spinner', () => {
  it('Session bleibt dauerhaft busy → nach Sicherheitsfenster neutrale Degradierung', async () => {
    // Immer busy — Session flippt nie zurück.
    const fetchFn = makeFetchFn({
      sessionSequence: ['ready', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy'],
    });
    renderSpecView(fetchFn, { reconcilePollInterval: 10, reconcileSafetyWindowMs: 40, reconcileMaxConsecutiveFailures: 100 });

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-degraded"]')).toBeTruthy();
    }, { timeout: 3000 });

    // Kein Endlos-Spinner mehr — "läuft"-Status ist weg.
    expect(document.querySelector('[data-testid="reconcile-running"]')).toBeNull();

    // "Audit-Spec anzeigen" bleibt manuell bedienbar (nicht deaktiviert durch den Trigger).
    const auditBtn = document.querySelector('[data-testid="audit-spec-btn"]');
    expect(auditBtn).toBeTruthy();
    expect(auditBtn.disabled).toBe(false);
  });

  it('/api/session schlägt wiederholt fehl → neutrale Degradierung statt Hängenbleiben', async () => {
    const fetchFn = makeFetchFn({
      sessionSequence: ['ready', 'error', 'error', 'error', 'error', 'error', 'error'],
    });
    renderSpecView(fetchFn, { reconcilePollInterval: 10, reconcileSafetyWindowMs: 5 * 60 * 1000, reconcileMaxConsecutiveFailures: 3 });

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-degraded"]')).toBeTruthy();
    }, { timeout: 3000 });
  });
});
