/**
 * Dashboard.test.jsx — Unit tests for the Dashboard component.
 *
 * Mock fetch('/api/status') via a custom fetchFn prop.
 * Uses jest fake timers to verify auto-refresh.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, waitFor } from '@testing-library/react';

// Dynamic imports after mock declarations (ESM VM-modules requirement).
const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { Dashboard } = await import('../Dashboard.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fetchFn that resolves with JSON once for each call in order. */
function makeFetchFn(...payloads) {
  let call = 0;
  return jest.fn(() => {
    const payload = payloads[Math.min(call++, payloads.length - 1)];
    return Promise.resolve({
      ok:   true,
      json: () => Promise.resolve(payload),
    });
  });
}

/** A fetchFn that always rejects. */
function makeFailFetchFn() {
  return jest.fn(() => Promise.reject(new Error('network error')));
}

/** A fetchFn that returns a non-2xx response. */
function makeHttpErrorFetchFn(status = 500) {
  return jest.fn(() =>
    Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) })
  );
}

/** Minimal status payload with one project and one preview. */
const SAMPLE_STATUS = {
  projects: [
    { name: 'brew-proxy-new', openItems: 3, lastCi: 'success' },
    { name: 'brew_assistent-new', openItems: 0, lastCi: 'failure' },
  ],
  previews: [
    { name: 'brew-proxy-new-preview', url: 'http://localhost:3001', status: 'running' },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard — initial loading state', () => {
  it('shows loading notice before first fetch resolves', () => {
    // fetchFn that never resolves
    const fetchFn = jest.fn(() => new Promise(() => {}));
    const { getAllByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );
    // During loading there are two role="status" elements: the "Lade…" div and
    // the refreshing indicator (↻). At least one must contain "lade".
    const statuses = getAllByRole('status');
    const loadingEl = statuses.find((el) => /lade/i.test(el.textContent));
    expect(loadingEl).toBeTruthy();
  });
});

describe('Dashboard — renders project cards', () => {
  it('renders one card per project with the project name', async () => {
    const fetchFn = makeFetchFn(SAMPLE_STATUS);
    const { getAllByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      const articles = getAllByRole('article');
      expect(articles).toHaveLength(2);
    });
  });

  it('renders each project name', async () => {
    const fetchFn = makeFetchFn(SAMPLE_STATUS);
    const { getByText } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      expect(getByText('brew-proxy-new')).toBeTruthy();
      expect(getByText('brew_assistent-new')).toBeTruthy();
    });
  });

  it('renders openItems count for each project', async () => {
    const fetchFn = makeFetchFn(SAMPLE_STATUS);
    const { getByText } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      expect(getByText('3')).toBeTruthy();
      expect(getByText('0')).toBeTruthy();
    });
  });
});

describe('Dashboard — CI status label/icon per status', () => {
  const ciCases = [
    ['success',     /Erfolg/],
    ['failure',     /Fehlgeschlagen/],
    ['in_progress', /Läuft/],
    ['none',        /Kein CI/],
    ['unknown',     /Unbekannt/],
  ];

  for (const [status, labelRe] of ciCases) {
    it(`lastCi '${status}' shows correct label`, async () => {
      const payload = {
        projects: [{ name: 'proj', openItems: 0, lastCi: status }],
        previews: [],
      };
      const fetchFn = makeFetchFn(payload);
      const { getByLabelText } = render(
        React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
      );

      await waitFor(() => {
        // CiBadge renders with aria-label "CI-Status: <label>"
        const badge = getByLabelText(new RegExp(`CI-Status:\\s*${labelRe.source}`, 'i'));
        expect(badge).toBeTruthy();
      });
    });
  }
});

describe("Dashboard — 'unknown' openItems renders as 'unbekannt'", () => {
  it("shows 'unbekannt' when openItems is the string 'unknown'", async () => {
    const payload = {
      projects: [{ name: 'proj', openItems: 'unknown', lastCi: 'none' }],
      previews: [],
    };
    const fetchFn = makeFetchFn(payload);
    const { getByText } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      expect(getByText('unbekannt')).toBeTruthy();
    });
  });

  it("does not crash when openItems is 'unknown'", async () => {
    const payload = {
      projects: [{ name: 'proj', openItems: 'unknown', lastCi: 'unknown' }],
      previews: [],
    };
    const fetchFn = makeFetchFn(payload);
    const { getByText } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );
    // Wait for post-fetch state to settle (also asserts render succeeded)
    await waitFor(() => {
      expect(getByText('proj')).toBeTruthy();
    });
  });
});

describe('Dashboard — preview URLs are clickable links', () => {
  it('renders a clickable <a href> for each preview', async () => {
    const fetchFn = makeFetchFn(SAMPLE_STATUS);
    const { getByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      const link = getByRole('link', { name: /localhost:3001/i });
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe('http://localhost:3001');
    });
  });
});

describe('Dashboard — auto-refresh re-fetches after the interval', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('calls fetchFn again after the poll interval', async () => {
    const fetchFn = makeFetchFn(SAMPLE_STATUS, SAMPLE_STATUS);
    render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 500 })
    );

    // Flush initial fetch
    await act(async () => { await Promise.resolve(); });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Advance past the poll interval
    await act(async () => {
      jest.advanceTimersByTime(501);
      await Promise.resolve();
    });
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Dashboard — fetch failure: error state, no crash', () => {
  it('shows error notice when fetch rejects', async () => {
    const fetchFn = makeFailFetchFn();
    const { getByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/fehler/i);
    });
  });

  it('shows error notice when fetch returns non-2xx', async () => {
    const fetchFn = makeHttpErrorFetchFn(500);
    const { getByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/fehler/i);
    });
  });

  it('does not crash on fetch failure', async () => {
    const fetchFn = makeFailFetchFn();
    const { getByRole } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );
    // Wait for post-fetch error state to settle (also asserts render succeeded)
    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/fehler/i);
    });
  });

  it('renders stale data with error notice after a second fetch fails', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(SAMPLE_STATUS) })
      .mockRejectedValueOnce(new Error('network error'));

    const { getByText } = render(
      React.createElement(Dashboard, { fetchFn, pollInterval: 60_000 })
    );

    // Wait for initial successful render
    await waitFor(() => {
      expect(getByText('brew-proxy-new')).toBeTruthy();
    });

    // Trigger second (failing) fetch
    await act(async () => {
      // Force a second fetch by calling it directly via the mock
      try { await fetchFn('/api/status'); } catch { /* expected */ }
    });

    // The component still shows stale data — just verify it hasn't crashed and
    // project name is still present.
    expect(getByText('brew-proxy-new')).toBeTruthy();

    // Manually cause re-render with error by mounting a fresh instance that
    // starts with stale data then fails — simulated via two-call fetchFn
    const fetchFn2 = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(SAMPLE_STATUS) })
      .mockRejectedValue(new Error('gone'));

    const { getByRole: getByRole2, getByText: getByText2 } = render(
      React.createElement(Dashboard, { fetchFn: fetchFn2, pollInterval: 1 })
    );

    await waitFor(() => { expect(getByText2('brew-proxy-new')).toBeTruthy(); });

    await waitFor(() => {
      const alert = getByRole2('alert');
      expect(alert.textContent).toMatch(/veraltete|fehler/i);
    }, { timeout: 3000 });
  });
});
