/**
 * AreasManageDialog.jsx — „Bereiche verwalten"-Dialog (docs/specs/bereichs-modell.md,
 * V7/AC8-AC10, S-290). Konsumiert die Bereichs-Endpunkte des `boardRouter`
 * (`AreaWriter`/`BoardAggregator` sind Backend, bereits gelandet — S-288/S-289).
 *
 * A11y-/Struktur-Muster 1:1 aus `ArchiveConfirmDialog` (BoardView.jsx,
 * board-feature-archive AC7) übernommen — dieselbe Codebase-Konvention für
 * fokussierte Dialoge: Backdrop, Fokus beim Öffnen auf das erste Bedienelement,
 * ECHTE Fokusfalle (Tab/Shift+Tab zyklisch über ALLE Buttons/Inputs, nicht nur
 * Buttons — dieser Dialog hat Text-Eingaben), `Esc` schließt immer, Fokus-
 * Rückgabe an `triggerRef` (analog `ObsidianIngestOverlay`).
 *
 * Covers (bereichs-modell):
 *   AC8  — Öffnet als modales Overlay mit der (vom Backend bereits nach `order`
 *          sortierten) Bereichsliste; Anlegen (Name-Feld + „Hinzufügen" →
 *          `POST .../areas`), Umbenennen (Inline-Edit je Zeile → `PATCH
 *          .../areas/:id`), Umsortieren (Hoch/Runter-Buttons → `POST
 *          .../areas/reorder`, ADJAZENTER ID-Swap — kein Drag, siehe „Neu
 *          zu bauen"-Auswahl unten), Löschen (→ `DELETE .../areas/:id`, mit
 *          Bestätigungsabfrage). Nach JEDER erfolgreichen Mutation wird die
 *          Bereichsliste per `GET .../areas` neu geladen (kein optimistisches
 *          Update — die Reihenfolge/Zähler kommen vom Server, Single Source
 *          of Truth bleibt `areas.yaml`).
 *   AC9  — Der Lösch-Button je Zeile ist deaktiviert (mit sprechendem
 *          `aria-label` + `title`-Hinweis), solange `storyCount > 0` (aus dem
 *          bereits geladenen `GET .../areas`-Read-Model — das einzige vom
 *          Backend gelieferte Zuordnungs-Feld, `specCount` wird dort NICHT
 *          exponiert, s.u.). Ist er aktiv, öffnet ein Klick eine inline
 *          Bestätigung („Wirklich löschen?" + Ja/Abbrechen) in derselben
 *          Zeile (kein verschachtelter zweiter Modal-Layer). `area-not-empty`
 *          (409, inkl. rein Spec-gebundener Bereiche — s.u.), sonstiges
 *          `409`/`5xx` erscheinen nicht-blockierend (`role="alert"`) in
 *          genau dieser Zeile; der Dialog/die Liste bleiben unverändert
 *          sichtbar (kein Crash, kein Verwerfen der bereits geladenen Liste).
 *   AC10 — `role="dialog"`, `aria-modal="true"`, `aria-labelledby`; Fokus
 *          beim Öffnen auf das erste Bedienelement; ECHTE Fokusfalle
 *          (Tab/Shift+Tab zyklisch); `Esc` schließt (IMMER erreichbar, kein
 *          blockierender Guard — mirror `ObsidianIngestOverlay`); Fokus-
 *          Rückgabe an `triggerRef`; sichtbarer Fokusring (kein
 *          `outline: none` in den Styles unten); ausschließlich echte
 *          `<button>`-Elemente mit sprechenden `aria-label`s (kein `<div
 *          onClick>`); Lade-/Fehler-/Erfolgs-Zustände sind `role="status"`
 *          (`aria-live="polite"`) bzw. `role="alert"` zugeordnet; Pflicht-/
 *          Zustands-Bedeutung (leer vs. gebunden, aktiv vs. deaktiviert)
 *          steht als TEXT (Zähler-Badge „leer"/„N Story/Storys", Button-
 *          `disabled`-Attribut + Label), nicht allein über Farbe.
 *
 * ── „Neu zu bauen"-Auswahl: Hoch/Runter statt Drag (V7 nennt „oder Drag") ────
 * Die Spec nennt für „Umsortieren" ausdrücklich „Hoch/Runter-Buttons ODER
 * Drag" — beide sind spec-konform. Diese Implementierung setzt NUR
 * Hoch/Runter-Buttons um: Drag-and-Drop bräuchte zusätzliche Maus-/Touch-/
 * Tastatur-Äquivalent-Logik (A11y-Anforderung AC10 gilt für JEDE
 * Umsortier-Bedienung), die die Spec nicht separat vorschreibt — Hoch/Runter
 * ist bereits per Tastatur voll bedienbar (echte `<button>`s) und erfüllt
 * AC8/AC10 vollständig ohne diesen Zusatzaufwand (kein Gold-Plating in die
 * andere Richtung: die einfachere der beiden gleichwertigen Optionen).
 *
 * ── `specCount` clientseitig NICHT bekannt (Backend-Read-Model-Lücke) ───────
 * `GET .../areas` liefert laut Vertrag (`bereichs-modell.md` V6/§Verträge)
 * `storyCount`, aber KEIN `specCount` (`src/BoardAggregator.js` `_buildAreaEntries`/
 * die AC2-Roll-up-Berechnung tragen nur `storyCount`). Der Lösch-Button wird
 * daher NUR anhand von `storyCount` deaktiviert — ein Bereich mit
 * `storyCount === 0`, aber weiterhin per Spec-Frontmatter zugeordneten Specs,
 * zeigt den Button aktiv. Das ist kein Spec-Verstoß: `AreaWriter.deleteArea()`
 * bleibt die harte, autoritative Prüfung (V5) und liefert in diesem Fall
 * `409 area-not-empty` mit `specCount` im Body — genau dieser Fall wird von
 * AC9 ausdrücklich als nicht-blockierender Inline-Fehler behandelt („Doppel-
 * schutz Frontend + Backend", Edge-Cases-Abschnitt der Spec). Ein rein
 * client-seitiges Vor-Deaktivieren für den reinen Spec-Fall wäre nur über
 * einen NEUEN Read-Model-Fetch (z.B. DocsReader-Abfrage) möglich, den weder
 * V6/§Verträge noch AC8-AC10 fordern — SPEC-LÜCKE, falls gewünscht, s.
 * Handoff.
 *
 * ── Component-Props-Vertrag ─────────────────────────────────────────────────
 * @param {{
 *   projectSlug: string,
 *   onClose: () => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 *
 * - `projectSlug` — der Bereichs-Scope (`GET/POST/PATCH/DELETE
 *   /api/board/projects/:slug/areas...`).
 * - `onClose` — schließt das Overlay (X-lose Variante: Footer-„Schließen"-
 *   Button/`Esc`/Backdrop-Klick, analog `ObsidianIngestOverlay`).
 * - `triggerRef` — optional; erhält beim Schließen den Fokus zurück (A11y).
 * - `fetchFn` — injectable `fetch` für Tests (default: `globalThis.fetch`).
 *
 * Security (Floor):
 *   - Kein `dangerouslySetInnerHTML` — alle Texte (Namen, Fehlermeldungen)
 *     werden als reiner React-Text gerendert (XSS-safe auch bei einem Namen
 *     wie `<script>`).
 *   - `projectSlug` wird nur zur URL-Interpolation via `encodeURIComponent`
 *     verwendet — die serverseitige Slug-/ID-Validierung (`SLUG_RE`/
 *     `AREA_ID_RE`) bleibt die autoritative Schranke (Defense-in-Depth,
 *     kein Vertrauen auf Client-Encoding allein).
 *   - Kein Secret/Token im UI — Fehlertexte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`boardRouter.js`).
 */

import { useState, useRef, useEffect, useCallback } from 'react';

export function AreasManageDialog({ projectSlug, onClose, triggerRef, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  // 'loading' | 'ready' | 'error' — initialer + jeder Reload der Bereichsliste.
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [areas, setAreas] = useState([]);

  // Anlegen (AC8)
  const [newName, setNewName] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState('');

  // Umbenennen — Inline-Edit je Zeile (AC8)
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  // Umsortieren (AC8)
  const [reorderError, setReorderError] = useState('');

  // Löschen — inline Bestätigung je Zeile (AC9)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const dialogRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const areasUrl = `/api/board/projects/${encodeURIComponent(projectSlug)}/areas`;

  // `silent` (Reload nach einer erfolgreichen Mutation, AC8): behält den
  // aktuellen 'ready'-Zustand bei, statt kurz auf 'loading' umzuschalten —
  // sonst würde das Umschalten den ready-Block (Liste + Formular) unmounten
  // und neu mounten, was laufende Eingaben (z.B. das gerade geleerte
  // Namensfeld) verwirft/den Fokus verliert. Der initiale Load und ein
  // manueller „Erneut versuchen" bleiben NICHT silent (zeigen den
  // Lade-Hinweis, da zu diesem Zeitpunkt ohnehin noch keine Liste sichtbar ist).
  const loadAreas = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoadState('loading');
    setLoadError('');
    let res;
    try {
      res = await fetch_(areasUrl);
    } catch {
      if (!mountedRef.current) return;
      setLoadState('error');
      setLoadError('Netzwerkfehler beim Laden der Bereiche.');
      return;
    }
    if (!mountedRef.current) return;
    if (res.status !== 200) {
      setLoadState('error');
      setLoadError(`Bereiche konnten nicht geladen werden (HTTP ${res.status}).`);
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!mountedRef.current) return;
    // Backend sortiert bereits nach `order` (AC1/AC8) — keine Client-Neusortierung.
    setAreas(Array.isArray(data.areas) ? data.areas : []);
    setLoadState('ready');
  }, [areasUrl, fetch_]);

  useEffect(() => { loadAreas(); }, [loadAreas]);

  const handleClose = useCallback(() => {
    // AC10: Schließen (Footer-Button/Esc/Backdrop) reagiert immer.
    onClose();
    triggerRef?.current?.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen + Esc-Abbruch + ECHTE Fokusfalle (AC10). Fasst Buttons
  // UND Text-Inputs (dieser Dialog hat Eingabefelder, anders als
  // ArchiveConfirmDialog, das nur Buttons kennt).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const getFocusable = () =>
      dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])');

    const initial = getFocusable();
    if (initial.length > 0) initial[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key === 'Tab') {
        const items = getFocusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // ── Anlegen (AC8) ───────────────────────────────────────────────────────────
  const handleAddSubmit = useCallback(async (e) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || addSubmitting) return;
    setAddSubmitting(true);
    setAddError('');
    let res;
    try {
      res = await fetch_(areasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
    } catch {
      if (!mountedRef.current) return;
      setAddSubmitting(false);
      setAddError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;
    if (res.status === 201) {
      setNewName('');
      setAddSubmitting(false);
      await loadAreas({ silent: true }); // AC8: nach erfolgreicher Mutation neu laden (silent — s.o.)
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setAddSubmitting(false);
    setAddError(data.message ?? data.error ?? `Bereich konnte nicht angelegt werden (HTTP ${res.status}).`);
  }, [newName, addSubmitting, areasUrl, fetch_, loadAreas]);

  // ── Umbenennen (AC8) ────────────────────────────────────────────────────────
  const handleStartEdit = useCallback((area) => {
    setEditingId(area.id);
    setEditValue(area.name);
    setEditError('');
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditValue('');
    setEditError('');
  }, []);

  const handleSaveEdit = useCallback(async (id) => {
    const trimmed = editValue.trim();
    if (!trimmed || editSubmitting) return;
    setEditSubmitting(true);
    setEditError('');
    let res;
    try {
      res = await fetch_(`${areasUrl}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
    } catch {
      if (!mountedRef.current) return;
      setEditSubmitting(false);
      setEditError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;
    if (res.status === 200) {
      setEditingId(null);
      setEditValue('');
      setEditSubmitting(false);
      await loadAreas({ silent: true }); // AC8 (silent — s.o.)
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setEditSubmitting(false);
    setEditError(data.message ?? data.error ?? `Bereich konnte nicht umbenannt werden (HTTP ${res.status}).`);
  }, [editValue, editSubmitting, areasUrl, fetch_, loadAreas]);

  // ── Umsortieren (AC8) — adjazenter ID-Swap, s. Modul-Doku oben ──────────────
  const handleMove = useCallback(async (id, direction) => {
    const ids = areas.map((a) => a.id);
    const idx = ids.indexOf(id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ids.length) return;
    const orderedIds = [...ids];
    [orderedIds[idx], orderedIds[swapIdx]] = [orderedIds[swapIdx], orderedIds[idx]];
    setReorderError('');
    let res;
    try {
      res = await fetch_(`${areasUrl}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
    } catch {
      if (!mountedRef.current) return;
      setReorderError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;
    if (res.status === 200) {
      await loadAreas({ silent: true }); // AC8 (silent — s.o.)
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setReorderError(data.message ?? data.error ?? `Umsortieren fehlgeschlagen (HTTP ${res.status}).`);
  }, [areas, areasUrl, fetch_, loadAreas]);

  // ── Löschen (AC9) ───────────────────────────────────────────────────────────
  const handleOpenDeleteConfirm = useCallback((id) => {
    setConfirmDeleteId(id);
    setDeleteError('');
    setDeleteSubmitting(false);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
    setDeleteError('');
    setDeleteSubmitting(false);
  }, []);

  const handleConfirmDelete = useCallback(async (id) => {
    if (deleteSubmitting) return;
    setDeleteSubmitting(true);
    setDeleteError('');
    let res;
    try {
      res = await fetch_(`${areasUrl}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      if (!mountedRef.current) return;
      setDeleteSubmitting(false);
      setDeleteError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    if (!mountedRef.current) return;
    if (res.status === 200) {
      setConfirmDeleteId(null);
      setDeleteSubmitting(false);
      await loadAreas({ silent: true }); // AC8 (silent — s.o.)
      return;
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    setDeleteSubmitting(false);
    // AC9: area-not-empty (auch der reine Spec-Fall, s. Modul-Doku) nennt die
    // Zähler; sonstige Fehler (409 Lock/5xx) zeigen den rohen Server-Text.
    if (data.error === 'area-not-empty') {
      setDeleteError(
        `Bereich kann nicht gelöscht werden — noch ${data.storyCount ?? 0} Story/Storys und ${data.specCount ?? 0} Spec(s) zugeordnet.`,
      );
    } else {
      setDeleteError(data.error ?? `Bereich konnte nicht gelöscht werden (HTTP ${res.status}).`);
    }
  }, [deleteSubmitting, areasUrl, fetch_, loadAreas]);

  const titleId = 'areas-manage-dialog-title';

  return (
    <>
      {/* Backdrop — bricht ab wie Esc/Footer-Schließen (kein blockierender Guard). */}
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.dialog}
        data-testid="areas-manage-dialog"
      >
        <h2 id={titleId} style={styles.heading}>Bereiche verwalten</h2>

        {loadState === 'loading' && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="areas-manage-loading">
            Bereiche werden geladen…
          </p>
        )}

        {loadState === 'error' && (
          <div role="alert" style={styles.error} data-testid="areas-manage-load-error">
            {loadError}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={loadAreas}
                aria-label="Bereichsliste erneut laden"
                data-testid="areas-manage-load-retry-btn"
              >
                Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {loadState === 'ready' && (
          <>
            {areas.length === 0 && (
              <p style={styles.hint} data-testid="areas-manage-empty">
                Noch keine Bereiche angelegt.
              </p>
            )}

            {areas.length > 0 && (
              <ul style={styles.areaList} data-testid="areas-manage-list">
                {areas.map((area, idx) => {
                  const isEditing = editingId === area.id;
                  const isConfirming = confirmDeleteId === area.id;
                  const hasStories = (area.storyCount ?? 0) > 0;
                  const editValueTrimmed = editValue.trim();

                  return (
                    <li key={area.id} style={styles.areaRow} data-testid="areas-manage-row" data-area-id={area.id}>
                      <div style={styles.areaRowMain}>
                        {isEditing ? (
                          <>
                            <label htmlFor={`areas-manage-edit-${area.id}`} style={styles.visuallyHidden}>
                              Bereich {area.name} umbenennen
                            </label>
                            <input
                              id={`areas-manage-edit-${area.id}`}
                              type="text"
                              style={styles.textInput}
                              value={editValue}
                              disabled={editSubmitting}
                              onChange={(e) => setEditValue(e.target.value)}
                              data-testid={`areas-manage-edit-input-${area.id}`}
                            />
                            <button
                              type="button"
                              style={(!editValueTrimmed || editSubmitting) ? styles.btnDisabledSmall : styles.btnPrimarySmall}
                              disabled={!editValueTrimmed || editSubmitting}
                              onClick={() => handleSaveEdit(area.id)}
                              aria-label={`Umbenennen von ${area.name} speichern`}
                              data-testid={`areas-manage-save-btn-${area.id}`}
                            >
                              {editSubmitting ? 'Speichere…' : 'Speichern'}
                            </button>
                            <button
                              type="button"
                              style={styles.btnSecondarySmall}
                              disabled={editSubmitting}
                              onClick={handleCancelEdit}
                              aria-label="Umbenennen abbrechen"
                              data-testid={`areas-manage-cancel-edit-btn-${area.id}`}
                            >
                              Abbrechen
                            </button>
                          </>
                        ) : (
                          <>
                            <span style={styles.areaName} data-testid={`areas-manage-name-${area.id}`}>
                              {area.name}
                            </span>
                            {/* AC2/AC9: Zuordnung als TEXT, nicht nur Farbe. */}
                            <span style={styles.areaMeta} data-testid={`areas-manage-count-${area.id}`}>
                              {hasStories ? `${area.storyCount} Story/Storys` : 'leer'}
                            </span>
                            <button
                              type="button"
                              style={styles.btnSecondarySmall}
                              onClick={() => handleStartEdit(area)}
                              aria-label={`Bereich ${area.name} umbenennen`}
                              data-testid={`areas-manage-rename-btn-${area.id}`}
                            >
                              Umbenennen
                            </button>
                          </>
                        )}
                      </div>

                      {isEditing && editError && (
                        <div role="alert" style={styles.errorInline} data-testid={`areas-manage-edit-error-${area.id}`}>
                          {editError}
                        </div>
                      )}

                      <div style={styles.areaRowActions}>
                        <button
                          type="button"
                          style={idx === 0 ? styles.btnDisabledIcon : styles.btnIcon}
                          disabled={idx === 0}
                          onClick={() => handleMove(area.id, 'up')}
                          aria-label={`Bereich ${area.name} nach oben verschieben`}
                          data-testid={`areas-manage-up-btn-${area.id}`}
                        >
                          <span aria-hidden="true">▲</span>
                        </button>
                        <button
                          type="button"
                          style={idx === areas.length - 1 ? styles.btnDisabledIcon : styles.btnIcon}
                          disabled={idx === areas.length - 1}
                          onClick={() => handleMove(area.id, 'down')}
                          aria-label={`Bereich ${area.name} nach unten verschieben`}
                          data-testid={`areas-manage-down-btn-${area.id}`}
                        >
                          <span aria-hidden="true">▼</span>
                        </button>

                        {!isConfirming ? (
                          <button
                            type="button"
                            style={hasStories ? styles.btnDisabledSmall : styles.btnDangerSmall}
                            disabled={hasStories}
                            onClick={() => handleOpenDeleteConfirm(area.id)}
                            aria-label={hasStories
                              ? `Bereich ${area.name} löschen — nicht möglich, solange Storys/Specs zugeordnet sind`
                              : `Bereich ${area.name} löschen`}
                            title={hasStories ? 'Erst zugeordnete Storys/Specs umhängen oder auflösen' : undefined}
                            data-testid={`areas-manage-delete-btn-${area.id}`}
                          >
                            Löschen
                          </button>
                        ) : (
                          <span style={styles.confirmRow} data-testid={`areas-manage-delete-confirm-${area.id}`}>
                            <span style={styles.confirmText}>Wirklich löschen?</span>
                            <button
                              type="button"
                              style={styles.btnDangerSmall}
                              disabled={deleteSubmitting}
                              aria-busy={deleteSubmitting}
                              onClick={() => handleConfirmDelete(area.id)}
                              aria-label={`Löschen von ${area.name} bestätigen`}
                              data-testid={`areas-manage-delete-confirm-btn-${area.id}`}
                            >
                              {deleteSubmitting ? 'Lösche…' : 'Ja, löschen'}
                            </button>
                            <button
                              type="button"
                              style={styles.btnSecondarySmall}
                              disabled={deleteSubmitting}
                              onClick={handleCancelDelete}
                              aria-label="Löschen abbrechen"
                              data-testid={`areas-manage-delete-cancel-btn-${area.id}`}
                            >
                              Abbrechen
                            </button>
                          </span>
                        )}
                      </div>

                      {isConfirming && deleteError && (
                        <div role="alert" style={styles.errorInline} data-testid={`areas-manage-delete-error-${area.id}`}>
                          {deleteError}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <form style={styles.addForm} onSubmit={handleAddSubmit}>
              <label htmlFor="areas-manage-new-name" style={styles.visuallyHidden}>
                Name des neuen Bereichs
              </label>
              <input
                id="areas-manage-new-name"
                type="text"
                style={styles.textInput}
                value={newName}
                disabled={addSubmitting}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name des neuen Bereichs"
                data-testid="areas-manage-new-name-input"
              />
              <button
                type="submit"
                style={(!newName.trim() || addSubmitting) ? styles.btnDisabledSmall : styles.btnPrimarySmall}
                disabled={!newName.trim() || addSubmitting}
                aria-label="Bereich hinzufügen"
                data-testid="areas-manage-add-btn"
              >
                {addSubmitting ? 'Wird angelegt…' : 'Hinzufügen'}
              </button>
            </form>

            {addError && (
              <div role="alert" style={styles.errorInline} data-testid="areas-manage-add-error">
                {addError}
              </div>
            )}
            {reorderError && (
              <div role="alert" style={styles.errorInline} data-testid="areas-manage-reorder-error">
                {reorderError}
              </div>
            )}
          </>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            aria-label="Bereiche-verwalten-Dialog schließen"
            data-testid="areas-manage-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog ObsidianIngestOverlay.jsx / ArchiveConfirmDialog) ─────────

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 999,
  },
  dialog: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    background: '#1a1a1a',
    border: '1px solid #374151',
    borderRadius: 10,
    padding: '24px 28px',
    minWidth: 460,
    maxWidth: 620,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
  },
  heading: {
    margin: '0 0 12px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },
  hint: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  areaList: {
    listStyle: 'none',
    margin: '0 0 14px',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  areaRow: {
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '8px 10px',
  },
  areaRowMain: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  areaRowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  areaName: {
    fontSize: 14,
    fontWeight: 600,
    color: '#e5e7eb',
    flex: 1,
    minWidth: 80,
  },
  // Zähler-Badge — Text trägt die Bedeutung, nicht die Farbe (AC9/AC10).
  // Kontrast: #9ca3af on #1e293b ≈ 5.8:1 — WCAG AA (analog ObsidianIngestOverlay optionalBadge).
  areaMeta: {
    fontSize: 11,
    fontWeight: 600,
    color: '#9ca3af',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  },
  confirmRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  confirmText: {
    fontSize: 12,
    color: '#fca5a5',
    marginRight: 2,
  },
  textInput: {
    flex: 1,
    minWidth: 140,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '8px 10px',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
    // Focus ring preserved (no outline:none)
  },
  addForm: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  errorInline: {
    margin: '6px 0 0',
    padding: '6px 10px',
    fontSize: 12,
    color: '#fecaca',
    background: '#3f1d1d',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 12,
  },
  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  btnPrimarySmall: {
    minHeight: 36,
    padding: '6px 14px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },
  btnSecondary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    // Focus ring preserved (no outline:none)
  },
  btnSecondarySmall: {
    minHeight: 36,
    padding: '6px 12px',
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },
  btnDangerSmall: {
    minHeight: 36,
    padding: '6px 12px',
    background: '#7f1d1d',
    color: '#fecaca',
    border: '1px solid #b91c1c',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },
  btnDisabledSmall: {
    minHeight: 36,
    padding: '6px 12px',
    background: '#1e293b',
    color: '#4b5563',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'not-allowed',
    whiteSpace: 'nowrap',
  },
  btnIcon: {
    minHeight: 32,
    minWidth: 32,
    padding: '4px 8px',
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
    // Focus ring preserved (no outline:none)
  },
  btnDisabledIcon: {
    minHeight: 32,
    minWidth: 32,
    padding: '4px 8px',
    background: 'transparent',
    color: '#374151',
    border: '1px solid #263143',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'not-allowed',
  },
  // Visuell versteckt, aber für Screenreader vorhanden (Label ohne sichtbaren Text
  // neben dem kompakten Inline-Edit-Feld — AC10).
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
};
