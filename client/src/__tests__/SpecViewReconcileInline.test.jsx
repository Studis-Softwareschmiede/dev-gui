/**
 * SpecViewReconcileInline.test.jsx — Tests für reconcile-inline-feedback (S-205)
 * AC1/AC4/AC5 (unverändert) + headless-reconcile-runner (S-208) AC11–AC14 und den
 * job-poll-basierten Degradierungs-Schutz (Ablösung von AC2/AC3/AC8-Quelle).
 *
 * Covers (reconcile-inline-feedback):
 *   AC1 — Nach 202 wird `onNavigate` NICHT mehr aufgerufen (überschreibt
 *          reconcile-trigger AC5); inline „Reconcile läuft…" (role="status"),
 *          Button deaktiviert (disabled + Text-Label).
 *   AC2 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208) AC11: die
 *          Fertig-Quelle ist jetzt `GET /api/reconcile/:jobId` (nicht mehr
 *          `/api/session`). Siehe AC11-Tests unten.
 *   AC3 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208) AC12: Status
 *          `done` (statt „erstmaliges nicht-busy") → „Fertig". Siehe AC12-Tests.
 *   AC4 — Beim Übergang auf „Fertig" wird AuditSpecView automatisch GENAU
 *          EINMAL neu geladen (kein manueller Klick, kein Doppel-Reload).
 *          Mechanismus unverändert, jetzt ausgelöst von Job-Status `done` (AC12).
 *   AC5 — Erkennbarer PR-Bezug im Audit-Inhalt → dezenter Link/Hinweis; kein
 *          Bezug → kein Element (graceful absence). Unverändert.
 *   AC8 — ÜBERSCHRIEBEN durch headless-reconcile-runner (S-208): Quelle des
 *          Sicherheitsfensters/Poll-Fehlerzählers ist jetzt der Job-Poll
 *          (`/api/reconcile/:jobId`), nicht mehr `/api/session`. Siehe unten.
 *   AC9 — Regression zu reconcile-trigger AC6/AC7: bereits vollständig
 *          gedeckt in SpecViewReconcileTrigger.test.jsx (409/400/500/Netzwerkfehler
 *          → Fehleranzeige mit Reset, kein onNavigate) — identisches
 *          Verhalten, hier nicht dupliziert.
 *
 * Covers (headless-reconcile-runner):
 *   AC11 — Im Lauf-Zustand pollt der Trigger `GET /api/reconcile/:jobId`
 *          (nicht `/api/session` als Fertig-Quelle); solange `status:"running"`
 *          bleibt „Reconcile läuft…", kein onNavigate.
 *   AC12 — Status `done` → „Fertig" (role="status"), Button wieder auslösbar,
 *          AuditSpecView automatisch genau einmal neu geladen; PR-Hinweis
 *          best-effort über den bestehenden Audit-Mechanismus (AC5).
 *   AC13 — Status `failed` (Job-Poll) → inline Fehleranzeige mit Reset
 *          (role="alert"), kein Crash.
 *   AC14 — Status `auth-expired` → klarer Hinweis „Claude-Anmeldung
 *          abgelaufen — Token via `claude setup-token` erneuern" (role="alert",
 *          Text nicht nur Farbe); kein falsches „Fertig".
 *   AC15 — Alle Zustände sind über den injizierbaren `fetchFn` steuerbar (kein
 *          Test hängt an einem realen Reconcile-Lauf) — durchgängig in dieser
 *          Datei demonstriert.
 *
 * Covers (audit-spec-main-pane):
 *   AC5 — Edge-Case „aktiv gezeigtes Navigations-Dokument": zeigt die
 *          Hauptfläche gerade ein per Navigation gewähltes Dokument, schaltet
 *          der Auto-Reload nach Reconcile-Abschluss die Hauptfläche NICHT
 *          unbemerkt auf das Audit-Logbuch um (der Reload lädt trotzdem genau
 *          einmal im Hintergrund).
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
 * Build a fetch mock with a scripted GET /api/reconcile/:jobId status sequence
 * (headless-reconcile-runner AC11–AC14).
 *
 * @param {object} opts
 * @param {'ready'|'busy'} [opts.sessionState='ready'] — constant /api/session state
 *   (Fremd-Busy-Guard, reconcile-trigger AC4 — irrelevant to done-detection here).
 * @param {number} [opts.reconcileStartStatus=202] — HTTP status for POST /api/reconcile
 * @param {object} [opts.reconcileStartBody={jobId:'job-1', status:'running'}]
 * @param {Array<'running'|'done'|'failed'|'auth-expired'|'network-error'|'not-found'>}
 *   [opts.jobStatusSequence=['running']] — consumed in order per GET /api/reconcile/:jobId
 *   call; last entry repeats once exhausted.
 * @param {string} [opts.jobStatusFailedError='Reconcile fehlgeschlagen.'] — error text
 *   returned alongside a 'failed' entry.
 * @param {string} [opts.auditBody='# Audit-Log\n\n- Aktion 1'] — spec-audit.md body
 * @param {number} [opts.auditStatus=200]
 */
function makeFetchFn({
  sessionState = 'ready',
  reconcileStartStatus = 202,
  reconcileStartBody = { jobId: 'job-1', status: 'running' },
  jobStatusSequence = ['running'],
  jobStatusFailedError = 'Reconcile fehlgeschlagen.',
  auditBody = '# Audit-Log\n\n- Aktion 1',
  auditStatus = 200,
} = {}) {
  let jobCallIdx = 0;
  const auditCalls = [];

  const fn = jest.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('/docs') && !url.includes('/raw')) {
      return { ok: true, status: 200, json: async () => ({ docs: FAKE_DOCS }) };
    }
    if (url === '/api/session') {
      return { ok: true, status: 200, json: async () => ({ state: sessionState, restarts: 0 }) };
    }
    if (url === '/api/reconcile' && opts?.method === 'POST') {
      return {
        ok: reconcileStartStatus === 202,
        status: reconcileStartStatus,
        json: async () => reconcileStartBody,
      };
    }
    if (typeof url === 'string' && url.startsWith('/api/reconcile/')) {
      const idx = Math.min(jobCallIdx, jobStatusSequence.length - 1);
      jobCallIdx += 1;
      const entry = jobStatusSequence[idx];
      if (entry === 'network-error') {
        throw new Error('network down');
      }
      if (entry === 'not-found') {
        return { ok: false, status: 404, json: async () => ({ error: 'Unknown jobId' }) };
      }
      if (entry === 'failed') {
        return { ok: true, status: 200, json: async () => ({ status: 'failed', error: jobStatusFailedError }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: entry }) };
    }
    if (typeof url === 'string' && url.includes('docs/raw') && url.includes('spec-audit.md')) {
      auditCalls.push(url);
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
      (c) => c[0] === '/api/reconcile' && c[1]?.method === 'POST',
    );
    expect(calls).toHaveLength(1);
  });
}

// ── AC1: Kein onNavigate, inline „Reconcile läuft…" ────────────────────────────

describe('reconcile-inline-feedback AC1: 202 → kein onNavigate, inline "Reconcile läuft…"', () => {
  it('202 → onNavigate wird NICHT aufgerufen', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running'] });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-running"]')).toBeTruthy();
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
  });

  it('202 → inline "Reconcile läuft…" (role="status"), Button disabled + Text-Label', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running'] });
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
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-box"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="reconcile-running"]')).toBeTruthy();
    });
  });
});

// ── AC11 (headless-reconcile-runner): Job-Poll hält "Reconcile läuft…" solange running ──

describe('headless-reconcile-runner AC11: solange status:"running" (Job-Poll), bleibt "Reconcile läuft…" + Button disabled', () => {
  it('mehrere running-Polls in Folge → weiterhin "Reconcile läuft…", Button disabled, kein /api/session-Fertig-Poll nötig', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running'] });
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

    // Fertig-Quelle ist /api/reconcile/:jobId, nicht /api/session.
    const jobPollCalls = fetchFn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('/api/reconcile/'),
    );
    expect(jobPollCalls.length).toBeGreaterThan(0);
  });
});

// ── AC12 (headless-reconcile-runner): Status "done" ⇒ "Fertig" ─────────────────

describe('headless-reconcile-runner AC12: Job-Status "done" ⇒ "Fertig", Button wieder auslösbar', () => {
  it('running → done ⇒ "Fertig" (role="status"), Button wieder auslösbar', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running', 'done'] });
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

  it('Edge-Case „erster Job-Poll nach Start bereits done": direkt "Fertig", kein Hängenbleiben in "läuft"', async () => {
    // Kein "running" in der Sequenz — der erste Poll NACH dem Start liefert bereits "done".
    const fetchFn = makeFetchFn({ jobStatusSequence: ['done'] });
    renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-done"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="reconcile-running"]')).toBeNull();
  });
});

// ── AC4/AC12: Audit-Reload genau einmal bei Abschluss ──────────────────────────

describe('reconcile-inline-feedback AC4 (Quelle jetzt headless-reconcile-runner AC12): Audit-Reload automatisch + genau einmal', () => {
  it('Übergang auf "Fertig" → genau ein GET docs/raw?path=docs/spec-audit.md, ohne manuellen Klick', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running', 'done'] });
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

    // Genau ein Audit-Request, auch nach weiteren Ticks (Job-Poll stoppt nach
    // dem terminalen Status — kein Doppel-Reload).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(fetchFn._auditCalls).toHaveLength(1);
  });

  it('Kein projectSlug → Audit-Reload feuert keinen Request mit leerem Slug (Edge-Case)', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running', 'done'] });
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
      jobStatusSequence: ['done'],
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
      jobStatusSequence: ['done'],
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
      jobStatusSequence: ['done'],
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

// ── AC13 (headless-reconcile-runner): Job-Status "failed" ──────────────────────

describe('headless-reconcile-runner AC13: Job-Status "failed" → inline Fehleranzeige mit Reset', () => {
  it('running → failed ⇒ sichtbare Fehleranzeige (role="alert") mit dem Fehlertext aus dem Job, Reset möglich', async () => {
    const fetchFn = makeFetchFn({
      jobStatusSequence: ['running', 'failed'],
      jobStatusFailedError: 'claude nicht verfügbar',
    });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const failed = document.querySelector('[data-testid="reconcile-job-failed"]');
      expect(failed).toBeTruthy();
      expect(failed.getAttribute('role')).toBe('alert');
      expect(failed.textContent).toMatch(/claude nicht verfügbar/i);
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
    // Kein falsches "Fertig".
    expect(document.querySelector('[data-testid="reconcile-done"]')).toBeNull();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="reconcile-job-failed-reset"]'));
    });
    expect(document.querySelector('[data-testid="reconcile-job-failed"]')).toBeNull();
    expect(document.querySelector('[data-testid="reconcile-btn"]')).toBeTruthy();
  });
});

// ── AC14 (headless-reconcile-runner): Job-Status "auth-expired" ────────────────

describe('headless-reconcile-runner AC14: Job-Status "auth-expired" → klarer Erneuerungs-Hinweis, kein falsches "Fertig"', () => {
  it('running → auth-expired ⇒ Hinweis "Claude-Anmeldung abgelaufen … claude setup-token … erneuern"', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running', 'auth-expired'] });
    const { onNavigateSpy } = renderSpecView(fetchFn);

    await startRun(fetchFn);

    await waitFor(() => {
      const authExpired = document.querySelector('[data-testid="reconcile-auth-expired"]');
      expect(authExpired).toBeTruthy();
      expect(authExpired.getAttribute('role')).toBe('alert');
      expect(authExpired.textContent).toMatch(/Claude-Anmeldung abgelaufen/i);
      expect(authExpired.textContent).toMatch(/claude setup-token/i);
      expect(authExpired.textContent).toMatch(/erneuern/i);
    });
    expect(onNavigateSpy).not.toHaveBeenCalled();
    // Kein falsches "Fertig".
    expect(document.querySelector('[data-testid="reconcile-done"]')).toBeNull();
  });
});

// ── AC8 (Quelle jetzt Job-Poll): robuste Degradierung ───────────────────────────

describe('reconcile-inline-feedback AC8 (Quelle jetzt headless-reconcile-runner Job-Poll): robuste Degradierung — kein Endlos-Spinner', () => {
  it('Job-Status bleibt dauerhaft "running" → nach Sicherheitsfenster neutrale Degradierung', async () => {
    // Immer "running" — nie ein Endzustand.
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running'] });
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

  it('GET /api/reconcile/:jobId schlägt wiederholt fehl (Netzwerkfehler) → neutrale Degradierung statt Hängenbleiben', async () => {
    const fetchFn = makeFetchFn({
      jobStatusSequence: ['running', 'network-error', 'network-error', 'network-error', 'network-error'],
    });
    renderSpecView(fetchFn, { reconcilePollInterval: 10, reconcileSafetyWindowMs: 5 * 60 * 1000, reconcileMaxConsecutiveFailures: 3 });

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-degraded"]')).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('GET /api/reconcile/:jobId liefert 404 (Server-Neustart, unbekannte jobId) wiederholt → neutrale Degradierung', async () => {
    const fetchFn = makeFetchFn({
      jobStatusSequence: ['running', 'not-found', 'not-found', 'not-found', 'not-found'],
    });
    renderSpecView(fetchFn, { reconcilePollInterval: 10, reconcileSafetyWindowMs: 5 * 60 * 1000, reconcileMaxConsecutiveFailures: 3 });

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-degraded"]')).toBeTruthy();
    }, { timeout: 3000 });
  });
});

// ── audit-spec-main-pane AC5: Auto-Reload verdrängt kein aktiv gezeigtes Dokument ──

describe('audit-spec-main-pane AC5: Auto-Reload nach Reconcile-Abschluss überschreibt kein aktiv gezeigtes Navigations-Dokument', () => {
  it('Hauptfläche zeigt aktiv README.md → Übergang auf "Fertig" lädt Audit im Hintergrund, ersetzt aber nicht die Dokument-Anzeige', async () => {
    const fetchFn = makeFetchFn({ jobStatusSequence: ['running', 'done'] });
    renderSpecView(fetchFn);

    // Navigations-Dokument öffnen, bevor der Reconcile-Lauf abgeschlossen ist.
    await waitFor(() => {
      expect(document.querySelector('button[title="README.md"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(document.querySelector('button[title="README.md"]'));
    });
    await waitFor(() => {
      const h1 = document.querySelector('h1');
      expect(h1?.textContent).toBe('README Inhalt');
    });

    await startRun(fetchFn);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="reconcile-done"]')).toBeTruthy();
    });

    // Der Auto-Reload feuert trotzdem genau einmal im Hintergrund …
    await waitFor(() => {
      expect(fetchFn._auditCalls).toHaveLength(1);
    });

    // … aber die Hauptfläche bleibt beim Dokument — kein unbemerktes Umschalten,
    // kein audit-spec-content sichtbar.
    const h1 = document.querySelector('h1');
    expect(h1?.textContent).toBe('README Inhalt');
    expect(document.querySelector('[data-testid="audit-spec-content"]')).toBeNull();
  });
});
