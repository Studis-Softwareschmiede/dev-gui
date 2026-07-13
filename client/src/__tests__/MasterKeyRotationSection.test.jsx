/**
 * MasterKeyRotationSection.test.jsx — Unit-Tests für MasterKeyRotationSection.jsx
 * (credential-key-rotation v2, S-342 — docs/specs/credential-key-rotation.md).
 *
 * Covers (credential-key-rotation):
 *   AC13 — Zweistufige UI-Quittung: „Master-Key rotieren" ruft POST
 *          /api/settings/credential-rotate; Erfolg zeigt Stufe 1 (Re-Encryption +
 *          Verifikation) UND Stufe 2 (Backup + ggf. Bitwarden-Umschaltung); eine
 *          fehlgeschlagene Teil-Stufe (Archiv/Backup) zeigt eine stufen-genaue,
 *          geheimnisfreie Warnung statt einer grünen Quittung.
 *   AC4/AC11 — Bitwarden-Zugangsdaten sind OPTIONAL: werden sie mitgegeben, gehen
 *          sie im Request-Body an den Server; bleiben sie leer, wird kein
 *          `bwEmail`/`bwPassword` gesendet (Kern-Rotation bleibt möglich).
 *   AC5/AC13 — „Endgültig entsorgen" ist eine GETRENNTE Aktion mit eigenem
 *          Bestätigungs-Checkbox + eigenen Bitwarden-Feldern; ruft
 *          POST /api/settings/credential-key-archive-discard NUR nach Bestätigung.
 *   Floor  — nach jedem Request (Erfolg wie Fehlschlag) sind die Passwort-Felder
 *          im DOM wieder leer (kein Klartext-Rest im State).
 *
 * Strategie: Komponente in Isolation gerendert (keine volle SettingsView nötig —
 * einzige Prop ist `fetchFn`); `fetchFn` als jest.fn()-Mock injiziert.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { fireEvent, waitFor, cleanup } from '@testing-library/react';

const { render } = await import('@testing-library/react');
const React = (await import('react')).default;
const { MasterKeyRotationSection } = await import('../MasterKeyRotationSection.jsx');

afterEach(() => {
  cleanup();
});

function makeFetch(handler) {
  return jest.fn(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : undefined;
    const result = handler(url, body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.data,
    };
  });
}

describe('MasterKeyRotationSection — Rotations-Formular', () => {
  it('rendert Überschrift + Pflichtfeld „Neuer Master-Key"', () => {
    const { getByRole, getByLabelText } = render(<MasterKeyRotationSection fetchFn={jest.fn()} />);
    expect(getByRole('heading', { name: /master-key-rotation/i })).toBeTruthy();
    expect(getByLabelText(/neuer master-key/i)).toBeTruthy();
  });

  it('ohne Bestätigungs-Checkbox: Rotieren-Button bleibt deaktiviert, kein Request', () => {
    const fetchFn = makeFetch(() => ({ status: 200, data: { ok: true, swapped: true, backup: { local: 'ok', offHost: 'disabled' } } }));
    const { getByLabelText, getByRole } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    const btn = getByRole('button', { name: /master-key rotieren/i });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Happy Path OHNE Bitwarden-Daten: POST ohne bwEmail/bwPassword im Body; Stufe 1 + Stufe 2 (Backup) grün', async () => {
    const fetchFn = makeFetch((url, body) => {
      expect(url).toBe('/api/settings/credential-rotate');
      expect(body.newKey).toBe('a-new-secure-master-key-value');
      expect(body.bwEmail).toBeUndefined();
      expect(body.bwPassword).toBeUndefined();
      return { status: 200, data: { ok: true, swapped: true, backup: { local: 'ok', offHost: 'disabled' } } };
    });

    const { getByLabelText, getByRole, getByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(getByText(/stufe 1.*✓/i)).toBeTruthy();
    });
    expect(getByText(/stufe 2 — backup ✓/i)).toBeTruthy();
    // Bitwarden-Umschaltung nicht angefordert → gemuted (kein grünes/rotes Symbol)
    expect(getByText(/stufe 2 — bitwarden umgeschaltet –/i)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('mit Bitwarden-Daten: POST enthält bwEmail/bwPassword; archive:{ok:true} zeigt grüne Stufe 2', async () => {
    const fetchFn = makeFetch((url, body) => {
      expect(body.bwEmail).toBe('admin@example.com');
      expect(body.bwPassword).toBe('bw-secret-password');
      return {
        status: 200,
        data: { ok: true, swapped: true, backup: { local: 'ok', offHost: 'disabled' }, archive: { ok: true } },
      };
    });

    const { getByLabelText, getByRole, getByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.change(getByLabelText(/bitwarden e-mail \(optional/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(getByLabelText(/bitwarden passwort \(optional/i), { target: { value: 'bw-secret-password' } });
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(getByText(/stufe 2 — bitwarden umgeschaltet ✓/i)).toBeTruthy();
    });
  });

  it('Archiv-Fehlschlag (Stufe 2 Teil-Fehler): stufen-genaue Warnung statt grüner Quittung — Stufe 1 bleibt grün', async () => {
    const fetchFn = makeFetch(() => ({
      status: 200,
      data: { ok: true, swapped: true, backup: { local: 'ok', offHost: 'disabled' }, archive: { ok: false, errorClass: 'auth-failed' } },
    }));

    const { container, getByLabelText, getByRole, getByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.change(getByLabelText(/bitwarden e-mail \(optional/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(getByLabelText(/bitwarden passwort \(optional/i), { target: { value: 'wrong-password' } });
    // Zwischenzustand vor dem Request: Passwort steht noch im Feld (State hält es)
    expect(getByLabelText(/bitwarden passwort \(optional/i).value).toBe('wrong-password');
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(getByText(/stufe 1.*✓/i)).toBeTruthy();
    });
    expect(getByText(/stufe 2 — bitwarden umgeschaltet ⚠/i)).toBeTruthy();
    // Keine Bitwarden-Werte im DOM (echte Regression würde hier fehlschlagen, da
    // derselbe container geprüft wird, der zuvor das Passwort im Feld hielt)
    expect(container.textContent).not.toContain('wrong-password');
    expect(getByLabelText(/bitwarden passwort \(optional/i).value).toBe('');
  });

  it('persist-failed (swapped:true, ok:false): Stufe 1 grün + separate Warnung „Reboot-Risiko"', async () => {
    const fetchFn = makeFetch(() => ({
      status: 500,
      data: { ok: false, reason: 'persist-failed', swapped: true, backup: { local: 'ok', offHost: 'disabled' } },
    }));

    const { getByLabelText, getByRole, getByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(getByText(/reboot-risiko/i)).toBeTruthy();
    });
  });

  it('Vor-Swap-Fehlschlag (swapped:false): Stufe 1 zeigt Fehlschlag, keine Stufe-2-Zeile', async () => {
    const fetchFn = makeFetch(() => ({
      status: 400,
      data: { ok: false, reason: 'same-key', swapped: false },
    }));

    const { getByLabelText, getByRole, getByText, queryByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/neuer master-key/i), { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(getByText(/rotation abgelehnt: same-key/i)).toBeTruthy();
    });
    expect(queryByText(/stufe 2/i)).toBeNull();
  });

  it('Floor: Passwort-Felder werden nach dem Request geleert (kein Klartext-Rest im DOM/State)', async () => {
    const fetchFn = makeFetch(() => ({ status: 200, data: { ok: true, swapped: true, backup: { local: 'ok', offHost: 'disabled' } } }));

    const { getByLabelText, getByRole } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    const newKeyInput = getByLabelText(/neuer master-key/i);
    fireEvent.change(newKeyInput, { target: { value: 'a-new-secure-master-key-value' } });
    fireEvent.click(getByLabelText(/ich bestätige die master-key-rotation/i));
    fireEvent.click(getByRole('button', { name: /master-key rotieren/i }));

    await waitFor(() => {
      expect(newKeyInput.value).toBe('');
    });
  });
});

describe('MasterKeyRotationSection — Endgültige Entsorgung (AC5/AC13)', () => {
  it('rendert eigenen Abschnitt mit eigener Bestätigung, getrennt vom Rotations-Formular', () => {
    const { getByRole, getByLabelText } = render(<MasterKeyRotationSection fetchFn={jest.fn()} />);
    expect(getByRole('heading', { name: /endgültig entsorgen/i })).toBeTruthy();
    expect(getByLabelText(/permanente entsorgung/i)).toBeTruthy();
  });

  it('ohne Bestätigung: Button bleibt deaktiviert, kein Request', () => {
    const fetchFn = jest.fn();
    const { getByRole } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);
    const btn = getByRole('button', { name: /endgültig entsorgen/i });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('mit Bestätigung + Zugangsdaten: POST /api/settings/credential-key-archive-discard, confirm:true im Body', async () => {
    const fetchFn = makeFetch((url, body) => {
      expect(url).toBe('/api/settings/credential-key-archive-discard');
      expect(body.confirm).toBe(true);
      expect(body.bwEmail).toBe('admin@example.com');
      expect(body.bwPassword).toBe('bw-secret-password');
      return { status: 200, data: { ok: true } };
    });

    const { getByLabelText, getByRole, getByText } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/^bitwarden e-mail \*/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(getByLabelText(/^bitwarden passwort \*/i), { target: { value: 'bw-secret-password' } });
    fireEvent.click(getByLabelText(/permanente entsorgung/i));
    fireEvent.click(getByRole('button', { name: /endgültig entsorgen/i }));

    await waitFor(() => {
      expect(getByText(/entsorgt/i)).toBeTruthy();
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('Fehlschlag: role=alert mit Fehlermeldung, kein Klartext-Leak', async () => {
    const fetchFn = makeFetch(() => ({ status: 500, data: { ok: false, reason: 'item-update-failed' } }));

    const { getByLabelText, getByRole, container } = render(<MasterKeyRotationSection fetchFn={fetchFn} />);

    fireEvent.change(getByLabelText(/^bitwarden e-mail \*/i), { target: { value: 'admin@example.com' } });
    fireEvent.change(getByLabelText(/^bitwarden passwort \*/i), { target: { value: 'super-secret-value' } });
    fireEvent.click(getByLabelText(/permanente entsorgung/i));
    fireEvent.click(getByRole('button', { name: /endgültig entsorgen/i }));

    await waitFor(() => {
      expect(getByRole('alert').textContent).toMatch(/fehlgeschlagen/i);
    });
    expect(container.textContent).not.toContain('super-secret-value');
  });
});
