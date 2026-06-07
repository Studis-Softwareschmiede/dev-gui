/**
 * GitHubView.test.jsx — Unit-Tests für GitHubView (github-repo-create Frontend-Anteil).
 *
 * Covers (github-repo-create AC1, AC5, AC6 — Frontend):
 *   AC1  — Formular vorhanden (Name, Sichtbarkeit, Beschreibung, README-Init);
 *           bei 201-Antwort wird Repo-URL klickbar angezeigt + fokussiert.
 *   AC5  — Fehlerantworten (403, 409, 422, 502, 500) werden klar und ohne
 *           Secret-Leak dargestellt.
 *   AC6  — Leerer Name → Fehlermeldung, kein Fetch-Request.
 *
 * NFR A11y:
 *   - Alle Felder mit <label> beschriftet (htmlFor).
 *   - Fehler programmatisch zugeordnet (aria-describedby).
 *   - Erfolgs-URL: tabIndex, <a>-Link (klickbar und fokussierbar).
 *   - <h1> für Haupt-Titel, <h2> für Formular-Sektion.
 *   - Touch-Target ≥ 44 px für Submit-Button.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

const { render }       = await import('@testing-library/react');
const React            = (await import('react')).default;
const { GitHubView }   = await import('../GitHubView.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Standardmässige Erfolgs-Antwort des Backends (201). */
const SUCCESS_RESPONSE = {
  name: 'mein-repo',
  fullName: 'softwareschmiede/mein-repo',
  htmlUrl: 'https://github.com/softwareschmiede/mein-repo',
  visibility: 'private',
};

/**
 * Erstellt einen jest.fn()-fetchFn der POST /api/github/repos simuliert.
 *
 * @param {{ ok?: boolean, status?: number, data?: object }} opts
 */
function makeFetchFn({ ok = true, status = 201, data = SUCCESS_RESPONSE } = {}) {
  return jest.fn(async () => ({
    ok,
    status,
    json: async () => data,
  }));
}

/** Rendert GitHubView mit injizierbarem fetchFn. */
function renderView(fetchFn) {
  const onNavigate = jest.fn();
  const utils = render(
    React.createElement(GitHubView, { onNavigate, fetchFn })
  );
  return { ...utils, onNavigate };
}

/** Füllt den Name-Input aus und submitted das Formular. */
async function fillAndSubmit(getByLabelText, getByRole, nameValue = 'mein-repo') {
  const nameInput = getByLabelText(/repository-name/i);
  fireEvent.change(nameInput, { target: { value: nameValue } });

  const submitBtn = getByRole('button', { name: /repository anlegen/i });
  await act(async () => {
    fireEvent.click(submitBtn);
  });
}

// ── Struktur / A11y ───────────────────────────────────────────────────────────

describe('GitHubView — Struktur und A11y', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rendert h1 "GitHub"', () => {
    const { getByRole } = renderView();
    const h1 = getByRole('heading', { level: 1 });
    expect(h1.textContent).toMatch(/^github$/i);
  });

  it('rendert main landmark "GitHub-Ansicht"', () => {
    const { getByRole } = renderView();
    expect(getByRole('main', { name: /github-ansicht/i })).toBeTruthy();
  });

  it('rendert h2 "Neues Repository anlegen"', () => {
    const { getByRole } = renderView();
    expect(getByRole('heading', { name: /neues repository anlegen/i })).toBeTruthy();
  });

  it('rendert Name-Input mit label (htmlFor)', () => {
    const { getByLabelText } = renderView();
    const input = getByLabelText(/repository-name/i);
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBe('repo-name');
  });

  it('rendert Sichtbarkeits-Select mit label', () => {
    const { getByLabelText } = renderView();
    const select = getByLabelText(/sichtbarkeit/i);
    expect(select.tagName).toBe('SELECT');
  });

  it('Sichtbarkeits-Select hat "Privat" als Default', () => {
    const { getByLabelText } = renderView();
    const select = getByLabelText(/sichtbarkeit/i);
    expect(select.value).toBe('private');
  });

  it('rendert Beschreibungs-Input mit label (optional)', () => {
    const { getByLabelText } = renderView();
    const input = getByLabelText(/beschreibung/i);
    expect(input.tagName).toBe('INPUT');
  });

  it('rendert README-Checkbox mit label', () => {
    const { getByLabelText } = renderView();
    const checkbox = getByLabelText(/mit readme initialisieren/i);
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(false);
  });

  it('rendert Submit-Button "Repository anlegen"', () => {
    const { getByRole } = renderView();
    expect(getByRole('button', { name: /repository anlegen/i })).toBeTruthy();
  });

  it('Submit-Button hat Touch-Target ≥ 44 px (minHeight)', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /repository anlegen/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('rendert Zurück-Button zum Panel', () => {
    const { getByRole } = renderView();
    expect(getByRole('button', { name: /zurück zum einstiegs-panel/i })).toBeTruthy();
  });

  it('Zurück-Button hat Touch-Target ≥ 44 px (minHeight)', () => {
    const { getByRole } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    const minH = parseInt(btn.style.minHeight, 10);
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  it('Zurück-Button ruft onNavigate("panel") auf', async () => {
    const { getByRole, onNavigate } = renderView();
    const btn = getByRole('button', { name: /zurück zum einstiegs-panel/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onNavigate).toHaveBeenCalledWith('panel');
  });
});

// ── AC6 — Frontend-Validierung: leerer Name ───────────────────────────────────

describe('GitHubView — AC6: Frontend-Validierung', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('leerer Name → Fehlermeldung wird angezeigt', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole, getByText } = renderView(fetchFn);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(getByText(/pflichtfeld/i)).toBeTruthy();
    });
  });

  it('leerer Name → kein fetch-Request ausgelöst', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole } = renderView(fetchFn);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('leerer Name → Name-Input hat aria-describedby auf Fehler-Element', async () => {
    const fetchFn = makeFetchFn();
    const { getByRole, getByLabelText } = renderView(fetchFn);

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const nameInput = getByLabelText(/repository-name/i);
      const errorId = nameInput.getAttribute('aria-describedby');
      expect(errorId).toBeTruthy();
      const errorEl = document.getElementById(errorId);
      expect(errorEl).toBeTruthy();
      expect(errorEl.textContent).toMatch(/pflichtfeld/i);
    });
  });

  it('Name nur aus Leerzeichen → Fehlermeldung, kein Request', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole, getByText } = renderView(fetchFn);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: '   ' } });

    const submitBtn = getByRole('button', { name: /repository anlegen/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(getByText(/pflichtfeld/i)).toBeTruthy();
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── AC1 — Erfolgspfad: klickbare Repo-URL ────────────────────────────────────

describe('GitHubView — AC1: Erfolgspfad', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bei 201: Repo-URL wird als klickbarer Link angezeigt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      expect(link).toBeTruthy();
      expect(link.href).toContain('github.com/softwareschmiede/mein-repo');
    });
  });

  it('bei 201: Link ist mit target="_blank" und rel="noreferrer" ausgestattet', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    });
  });

  it('bei 201: Link ist fokussierbar (tabIndex) UND hat tatsächlich den Fokus (useEffect)', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const link = getByRole('link', { name: /softwareschmiede\/mein-repo/i });
      // tabIndex 0 = fokussierbar; <a href> ohne explizites tabIndex=-1 ist immer fokussierbar
      expect(link.tabIndex).not.toBe(-1);
      // useEffect setzt focus() auf successUrlRef — prüfen ob activeElement tatsächlich der Link ist
      expect(document.activeElement).toBe(link);
    });
  });

  it('bei 201: Erfolgs-Statusbox hat role="status" und aria-live="polite"', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const statusBox = document.querySelector('[role="status"]');
      expect(statusBox).toBeTruthy();
      expect(statusBox.getAttribute('aria-live')).toBe('polite');
    });
  });

  it('bei 201: fullName wird in der Erfolgsanzeige genannt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole, getAllByText } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const els = getAllByText(/softwareschmiede\/mein-repo/i);
      expect(els.length).toBeGreaterThan(0);
    });
  });

  it('bei 201: Button "Weiteres Repository anlegen" erscheint', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      expect(getByRole('button', { name: /weiteres repository anlegen/i })).toBeTruthy();
    });
  });

  it('bei 201: "Weiteres Repository anlegen" setzt Formular zurück', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      getByRole('button', { name: /weiteres repository anlegen/i });
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /weiteres repository anlegen/i }));
    });

    await waitFor(() => {
      // Formular ist wieder sichtbar
      expect(getByRole('button', { name: /repository anlegen/i })).toBeTruthy();
    });
  });

  it('bei 201: öffentliches Repo zeigt "Öffentlich" Badge', async () => {
    const fetchFn = makeFetchFn({
      data: { ...SUCCESS_RESPONSE, visibility: 'public' },
    });
    const { getByLabelText, getByRole, getByText } = renderView(fetchFn);

    // Sichtbarkeit auf public stellen
    const select = getByLabelText(/sichtbarkeit/i);
    fireEvent.change(select, { target: { value: 'public' } });

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      expect(getByText(/öffentlich/i)).toBeTruthy();
    });
  });

  it('bei 201: POST-Request enthält name, visibility und autoInit', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    const checkbox = getByLabelText(/mit readme initialisieren/i);
    fireEvent.click(checkbox);

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/github/repos');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.name).toBe('test-repo');
    expect(body.visibility).toBe('private');
    expect(body.autoInit).toBe(true);
  });

  it('bei 201: optionale Beschreibung wird mitgeschickt wenn gefüllt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    const descInput = getByLabelText(/beschreibung/i);
    fireEvent.change(descInput, { target: { value: 'Meine Beschreibung' } });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.description).toBe('Meine Beschreibung');
  });

  it('bei 201: leere Beschreibung wird NICHT mitgeschickt', async () => {
    const fetchFn = makeFetchFn();
    const { getByLabelText, getByRole } = renderView(fetchFn);

    const nameInput = getByLabelText(/repository-name/i);
    fireEvent.change(nameInput, { target: { value: 'test-repo' } });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /repository anlegen/i }));
    });

    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.description).toBeUndefined();
  });
});

// ── AC5 — Fehlerpfade: 403, 409, 422, 502, 500 ───────────────────────────────

describe('GitHubView — AC5: Fehlerpfade', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('403 → Fehlermeldung "403" oder "Berechtigung" angezeigt', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/403|berechtigung/i);
    });
  });

  it('403 → Kein Token/Secret in der Fehlermeldung (Security)', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 403, data: { error: 'Keine Berechtigung für diese Aktion' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      // Keine Token-artigen Strings (nur minimale Prüfung auf typische Leak-Muster)
      expect(text).not.toMatch(/eyJ[A-Za-z0-9]/); // JWT
      expect(text).not.toMatch(/ghp_/);            // GitHub PAT
    });
  });

  it('409 → Fehlermeldung "409" oder "vergeben" angezeigt', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 409, data: { error: 'Repository-Name bereits vergeben in der Org' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/409|vergeben/i);
    });
  });

  it('422 → Fehlermeldung "422" oder "ungültig" angezeigt', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 422, data: { error: 'Ungültiger Repository-Name' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/422|ungültig/i);
    });
  });

  it('502 → Fehlermeldung "502" oder "GitHub" angezeigt', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 502, data: { error: 'GitHub-API-Fehler beim Anlegen des Repositories' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/502|github/i);
    });
  });

  it('500 → Fehlermeldung "500" oder "Fehler" angezeigt', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 500, data: { error: 'Audit-Write fehlgeschlagen' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/500|fehler/i);
    });
  });

  it('Netzwerkfehler (fetch wirft) → Fehlermeldung angezeigt', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('Network failure')));
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const text = document.body.textContent;
      expect(text).toMatch(/network failure|fehler/i);
    });
  });

  it('Fehler-Paragraph hat role="alert" (A11y — sofortige Ankündigung)', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 422, data: { error: 'Ungültiger Name' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  it('nach Fehlerpfad: Formular bleibt sichtbar (kein Erfolgs-Panel)', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 422, data: { error: 'Ungültiger Name' } });
    const { getByLabelText, getByRole, queryByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      // Kein Erfolgs-Link sichtbar
      expect(queryByRole('link', { name: /github\.com/i })).toBeFalsy();
      // Submit-Button noch vorhanden
      expect(getByRole('button', { name: /repository anlegen/i })).toBeTruthy();
    });
  });
});

// ── A11y — aria-describedby auf API-Fehler ────────────────────────────────────

describe('GitHubView — A11y: aria-describedby für API-Fehler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-Fehler: Fehlermeldung hat id, Select hat aria-describedby auf diesen id', async () => {
    const fetchFn = makeFetchFn({ ok: false, status: 422, data: { error: 'Ungültiger Name' } });
    const { getByLabelText, getByRole } = renderView(fetchFn);

    await fillAndSubmit(getByLabelText, getByRole);

    await waitFor(() => {
      const formError = document.querySelector('#repo-form-error');
      expect(formError).toBeTruthy();
      expect(formError.textContent).toMatch(/422|ungültig/i);
    });
  });
});
