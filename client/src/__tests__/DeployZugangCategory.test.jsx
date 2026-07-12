/**
 * DeployZugangCategory.test.jsx — Tests für den Settings-Reiter „Deploy-Zugang"
 * (deploy-bitwarden-gpg-injection F-072, S-333).
 *
 * Covers:
 *   AC5/AC6 — write-only Felder (Status „gesetzt/nicht gesetzt", nie Klartext);
 *             ready-Anzeige; Setzen schickt PUT mit dem Wert (Klartext bleibt lokal).
 *   AC7     — „Zugang prüfen" ruft validate und zeigt Erfolg/Fehler secret-frei.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { render, waitFor, fireEvent } from '@testing-library/react';

const React = (await import('react')).default;
const { DeployZugangCategory } = await import('../settings/DeployZugangCategory.jsx');

afterEach(() => { jest.restoreAllMocks(); });

const EMPTY_STATUS = {
  persisted: true,
  ready: false,
  fields: {
    server_url: { set: false, updatedAt: null },
    client_id: { set: false, updatedAt: null },
    client_secret: { set: false, updatedAt: null },
    master_password: { set: false, updatedAt: null },
  },
};
const READY_STATUS = {
  persisted: true,
  ready: true,
  fields: {
    server_url: { set: false, updatedAt: null },
    client_id: { set: true, updatedAt: '2026-07-12T00:00:00Z' },
    client_secret: { set: true, updatedAt: '2026-07-12T00:00:00Z' },
    master_password: { set: true, updatedAt: '2026-07-12T00:00:00Z' },
  },
};

function makeFetch({ status = EMPTY_STATUS, validate = { ok: true }, validateHttp = 200, putSpy } = {}) {
  return jest.fn(async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (url === '/api/settings/deploy-access' && method === 'GET') {
      return { ok: true, status: 200, json: async () => status };
    }
    if (url === '/api/settings/deploy-access/validate' && method === 'POST') {
      return { ok: validateHttp < 400, status: validateHttp, json: async () => validate };
    }
    if (url.startsWith('/api/settings/deploy-access/') && method === 'PUT') {
      if (putSpy) putSpy(url, JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ field: 'x', set: true, updatedAt: 'now' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  });
}

describe('DeployZugangCategory', () => {
  it('zeigt unvollständigen Zugang + write-only Feld-Status', async () => {
    const fetchFn = makeFetch({ status: EMPTY_STATUS });
    const { getByText, getAllByText } = render(React.createElement(DeployZugangCategory, { fetchFn }));
    await waitFor(() => expect(getByText(/Zugang unvollständig/)).toBeTruthy());
    // vier Felder „nicht gesetzt"
    expect(getAllByText('nicht gesetzt').length).toBe(4);
  });

  it('ready → „vollständig hinterlegt"; Prüfen-Knopf aktiv', async () => {
    const fetchFn = makeFetch({ status: READY_STATUS });
    const { getByText, getByLabelText } = render(React.createElement(DeployZugangCategory, { fetchFn }));
    await waitFor(() => expect(getByText(/Zugang vollständig hinterlegt/)).toBeTruthy());
    const btn = getByLabelText('Deploy-Zugang gegen Bitwarden prüfen');
    expect(btn.disabled).toBe(false);
  });

  it('„Zugang prüfen" → Erfolg zeigt gültig-Meldung', async () => {
    const fetchFn = makeFetch({ status: READY_STATUS, validate: { ok: true } });
    const { getByText, getByLabelText } = render(React.createElement(DeployZugangCategory, { fetchFn }));
    await waitFor(() => expect(getByText(/vollständig hinterlegt/)).toBeTruthy());
    fireEvent.click(getByLabelText('Deploy-Zugang gegen Bitwarden prüfen'));
    await waitFor(() => expect(getByText(/Zugang gültig/)).toBeTruthy());
  });

  it('„Zugang prüfen" → Fehler zeigt secret-freie Klartext-Meldung', async () => {
    const fetchFn = makeFetch({ status: READY_STATUS, validate: { ok: false, errorClass: 'unlock-failed', error: 'Entsperren fehlgeschlagen (Master-Passwort falsch).' } });
    const { getByText, getByLabelText } = render(React.createElement(DeployZugangCategory, { fetchFn }));
    await waitFor(() => expect(getByText(/vollständig hinterlegt/)).toBeTruthy());
    fireEvent.click(getByLabelText('Deploy-Zugang gegen Bitwarden prüfen'));
    await waitFor(() => expect(getByText(/Master-Passwort falsch/)).toBeTruthy());
  });

  it('Feld setzen schickt PUT mit dem eingegebenen Wert', async () => {
    const putSpy = jest.fn();
    const fetchFn = makeFetch({ status: EMPTY_STATUS, putSpy });
    const { getByLabelText, getByText } = render(React.createElement(DeployZugangCategory, { fetchFn }));
    await waitFor(() => expect(getByText(/unvollständig/)).toBeTruthy());
    // „Setzen" für Client-ID
    fireEvent.click(getByLabelText('API Client-ID setzen'));
    const input = getByLabelText('API Client-ID — neuer Wert');
    fireEvent.change(input, { target: { value: 'user.abc' } });
    fireEvent.click(getByText('Speichern'));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/api/settings/deploy-access/client_id', { value: 'user.abc' }));
  });
});
