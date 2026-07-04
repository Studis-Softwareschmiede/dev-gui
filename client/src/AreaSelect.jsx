/**
 * AreaSelect.jsx — Bereichs-Dropdown für Story-/Idee-Dialoge
 * (story-idee-bereich-zuordnung AC1/AC2/AC3/AC6, S-291).
 *
 * Lädt GET /api/board/projects/:slug/areas (sortiert nach order) und rendert
 * ein beschriftetes <select> mit allen Bereichen plus dem Eintrag
 * „+ Neuer Bereich…“ (AC3: Inline-Neuanlage über DENSELBEN Anlege-Pfad wie
 * „Bereiche verwalten“ — POST …/areas; nach 201 Liste neu laden, neuen Bereich
 * auswählen, Fokus zurück; 400/409 inline ohne Dialog-Verlust).
 *
 * Vorbelegung (AC2): `defaultAreaId` (Bereich der geöffneten Kachel), sonst
 * erster Bereich nach order; existieren keine Bereiche, erzwingt die Komponente
 * die Inline-Neuanlage (Eingabefeld direkt sichtbar).
 *
 * Degradation: schlägt der areas-Load fehl, meldet `onReady(false)` und die
 * Komponente rendert nichts — aufrufende Dialoge bleiben voll funktionsfähig
 * (Bestands-Verhalten, kein area-Pflichtfeld).
 *
 * A11y (AC6): label/htmlFor, sprechende aria-label, role=alert für Fehler,
 * tastaturbedienbar (natives select/input/button).
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const NEW_SENTINEL = '__neuer_bereich__';

/**
 * @param {{
 *   projectSlug: string,
 *   value: string|null,
 *   onChange: (areaId: string|null) => void,
 *   onReady?: (ok: boolean) => void,
 *   defaultAreaId?: string|null,
 *   idPrefix?: string,
 *   fetchFn?: typeof fetch,
 * }} props
 */
export function AreaSelect({ projectSlug, value, onChange, onReady, defaultAreaId, idPrefix = 'area-select', fetchFn }) {
  const [areas, setAreas] = useState(null); // null = lädt/fehlgeschlagen, [] = leer
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [saving, setSaving] = useState(false);
  const selectRef = useRef(null);
  const doFetch = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);

  const load = useCallback(async () => {
    if (!doFetch) return null;
    const res = await doFetch(`/api/board/projects/${encodeURIComponent(projectSlug)}/areas`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.areas) ? data.areas : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((list) => {
        if (cancelled || list == null) return;
        setAreas(list);
        onReady?.(true);
        // AC2: Vorbelegung — Kachel-Bereich, sonst erster nach order; leer → Neuanlage erzwingen
        if (list.length === 0) { setCreating(true); onChange(null); return; }
        const prefill = (defaultAreaId && list.some((a) => a.id === defaultAreaId))
          ? defaultAreaId
          : list[0].id;
        onChange(prefill);
      })
      .catch(() => { if (!cancelled) onReady?.(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug]);

  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === NEW_SENTINEL) { setCreating(true); setCreateError(''); return; }
    onChange(v);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || saving || !doFetch) return;
    setSaving(true); setCreateError('');
    try {
      const res = await doFetch(`/api/board/projects/${encodeURIComponent(projectSlug)}/areas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status !== 201) {
        setCreateError(typeof data?.error === 'string' ? data.error : `Anlegen fehlgeschlagen (HTTP ${res.status})`);
        return;
      }
      const list = await load() ?? [];
      setAreas(list);
      setCreating(false); setNewName('');
      onChange(data.id ?? null);
      selectRef.current?.focus(); // AC3: Fokus zurück
    } catch {
      setCreateError('Anlegen fehlgeschlagen (Netzwerk)');
    } finally {
      setSaving(false);
    }
  };

  if (areas === null) return null; // lädt noch oder degradiert (AC3-Analogie)

  return (
    <div style={styles.wrap}>
      <label style={styles.label} htmlFor={`${idPrefix}-select`}>Bereich</label>
      {areas.length > 0 && (
        <select
          id={`${idPrefix}-select`}
          ref={selectRef}
          value={creating ? NEW_SENTINEL : (value ?? '')}
          onChange={handleSelect}
          aria-label="Bereich der neuen Story/Idee"
          style={styles.select}
        >
          {areas.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
          <option value={NEW_SENTINEL}>＋ Neuer Bereich…</option>
        </select>
      )}
      {creating && (
        <div style={styles.createRow}>
          <label style={styles.srOnly} htmlFor={`${idPrefix}-new-name`}>Name des neuen Bereichs</label>
          <input
            id={`${idPrefix}-new-name`}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
            placeholder="Name des neuen Bereichs"
            aria-label="Name des neuen Bereichs"
            style={styles.input}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newName.trim() || saving}
            aria-label="Neuen Bereich anlegen"
            style={styles.btn}
          >
            Anlegen
          </button>
          {areas.length > 0 && (
            <button
              type="button"
              onClick={() => { setCreating(false); setCreateError(''); }}
              aria-label="Neuanlage abbrechen"
              style={styles.btnGhost}
            >
              Abbrechen
            </button>
          )}
        </div>
      )}
      {createError && (
        <p role="alert" aria-live="polite" style={styles.error}>{createError}</p>
      )}
    </div>
  );
}

const styles = {
  wrap: { marginBottom: 12 },
  label: { display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 },
  select: { width: '100%', minHeight: 44, background: '#111', color: '#d4d4d4', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', fontSize: 14 },
  createRow: { display: 'flex', gap: 8, marginTop: 8 },
  input: { flex: 1, minHeight: 44, background: '#111', color: '#d4d4d4', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', fontSize: 14 },
  btn: { minHeight: 44, padding: '8px 14px', background: '#1e3a5f', color: '#bfdbfe', border: '1px solid #1d4ed8', borderRadius: 6, cursor: 'pointer' },
  btnGhost: { minHeight: 44, padding: '8px 14px', background: 'transparent', color: '#9ca3af', border: '1px solid #334155', borderRadius: 6, cursor: 'pointer' },
  error: { margin: '6px 0 0', fontSize: 13, color: '#fca5a5' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
};
