/**
 * ObsidianVaultFolderBrowserOverlay.jsx — Ordner-Browser-Overlay für den Obsidian-
 * Vault-Pfad (docs/specs/obsidian-vault-folder-browser.md AC6/AC9, S-379).
 *
 * A11y-/Struktur-Muster 1:1 aus `ObsidianIngestOverlay.jsx` übernommen (Backdrop,
 * Fokus beim Öffnen, `Esc` schließt IMMER, Fokus-Rückgabe an `triggerRef`,
 * `mountedRef`-Guard gegen State-Updates nach Unmount) — Read-only-Variante ohne
 * Poll-Loop: jede Navigation (Unterordner/Zurück/Breadcrumb) löst einen einzelnen
 * `GET .../obsidian-vault/browse?path=…`-Request aus (`browseFetch`, S-378).
 *
 * Covers (obsidian-vault-folder-browser):
 *   AC6 — Öffnet die Unterordner-Liste des aktuellen Pfads, eine Breadcrumb-/
 *         „Zurück"-Navigation und pro Unterordner einen Eintrag zum Hinein-
 *         navigieren. „Diesen Ordner verwenden" übernimmt den Container-Pfad
 *         des aktuellen Ordners via `onSelect` (Aufrufer übergibt den Wert an
 *         das bestehende Speichern-Feld/PUT-Flow — die PUT-Validierung bleibt
 *         das Gate, dieser Overlay validiert nicht selbst).
 *   AC9 — Tastaturbedienbar (Buttons statt Links, `Esc` schließt), Fokusführung
 *         beim Öffnen/Navigieren/Übernehmen/Schließen (Überschrift „aktueller
 *         Ordner" erhält nach jedem Laden den Fokus + ist eine `aria-live`-
 *         Region — kündigt Navigation für Screenreader an, ohne einen
 *         separaten Live-Text zu benötigen), Bedienziele ≥44px (alle Buttons),
 *         aria-Labels für Navigations-/Auswahl-Elemente, Lade-/Fehler-Zustände
 *         über `role="status"`/`role="alert"` (nicht nur Farbe).
 *
 * Security (Floor):
 *   - Kein Freitext-Pfad-Feld in diesem Overlay — Navigation ausschließlich über
 *     vom Backend gelieferte `entries[].path`/`breadcrumb[].path`/`parent`-Werte
 *     (server-seitig bereits confined, obsidian-vault-folder-browser AC3).
 *   - Kein `dangerouslySetInnerHTML`; Fehlertexte kommen 1:1 vom bereits
 *     secret-freien Backend-Contract (`obsidianVaultPathRouter.js`).
 *
 * @param {{
 *   onClose: () => void,
 *   onSelect: (path: string) => void,
 *   triggerRef?: React.RefObject,
 *   fetchFn?: typeof fetch,
 *   browseFetch?: (path: string|undefined, fetchFn: typeof fetch) => Promise<object>,
 * }} props
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { fetchObsidianVaultBrowse } from './settingsApi.js';

export function ObsidianVaultFolderBrowserOverlay({
  onClose,
  onSelect,
  triggerRef,
  fetchFn,
  browseFetch = fetchObsidianVaultBrowse,
}) {
  // 'loading' | 'ready' | 'error'
  const [phase, setPhase] = useState('loading');
  const [data, setData] = useState(null); // { root, path, parent, breadcrumb, entries }
  const [errorMsg, setErrorMsg] = useState('');
  const [pathToLoad, setPathToLoad] = useState(undefined); // undefined = Mount-Root

  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    if (triggerRef?.current) triggerRef.current.focus();
  }, [onClose, triggerRef]);

  // Fokus beim Öffnen (auf den Dialog selbst, bis der erste Ladevorgang fertig
  // ist); Esc schließt IMMER (AC9).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose();
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const load = useCallback(async (path) => {
    setPhase('loading');
    setErrorMsg('');
    try {
      const result = await browseFetch(path, fetchFn);
      if (!mountedRef.current) return;
      setData(result);
      setPhase('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err.message ?? 'Ordner-Auflistung fehlgeschlagen.');
      setPhase('error');
    }
  }, [browseFetch, fetchFn]);

  useEffect(() => {
    load(pathToLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathToLoad]);

  // AC9: Fokusführung bei jeder Navigation — die Überschrift „aktueller Ordner"
  // erhält nach jedem erfolgreichen Laden den Fokus (kündigt den neuen Ort für
  // Screenreader an, dient gleichzeitig als sichtbarer Fokuspunkt).
  useEffect(() => {
    if (phase === 'ready' && headingRef.current) {
      headingRef.current.focus();
    }
  }, [phase, data?.path]);

  const navigateTo = useCallback((path) => {
    setPathToLoad(path ?? undefined);
  }, []);

  const handleUseFolder = useCallback(() => {
    if (!data?.path) return;
    onSelect(data.path);
    handleClose();
  }, [data, onSelect, handleClose]);

  const titleId = 'obsidian-vault-browser-title';
  const headingId = 'obsidian-vault-browser-current-folder';

  return (
    <>
      <div style={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={styles.dialog}
        data-testid="obsidian-vault-browser-overlay"
      >
        <h2 id={titleId} style={styles.heading}>Obsidian-Vault-Ordner durchsuchen</h2>

        {phase === 'loading' && (
          <p role="status" aria-live="polite" style={styles.hint} data-testid="obsidian-vault-browser-loading">
            Ordner wird geladen…
          </p>
        )}

        {phase === 'error' && (
          <div role="alert" style={styles.error} data-testid="obsidian-vault-browser-error">
            {errorMsg}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={() => load(pathToLoad)}
                data-testid="obsidian-vault-browser-retry-btn"
              >
                Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {phase === 'ready' && data && (
          <>
            <h3
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              style={styles.currentFolderHeading}
              aria-live="polite"
            >
              Aktueller Ordner: <code style={styles.currentFolderCode}>{data.path}</code>
            </h3>

            <nav aria-label="Pfad-Breadcrumb" style={styles.breadcrumbNav}>
              {data.breadcrumb.map((crumb, idx) => {
                const isCurrent = crumb.path === data.path;
                return (
                  <span key={crumb.path} style={styles.breadcrumbItem}>
                    {idx > 0 && <span aria-hidden="true" style={styles.breadcrumbSep}> / </span>}
                    {isCurrent ? (
                      <span aria-current="location" style={styles.breadcrumbCurrent}>{crumb.name}</span>
                    ) : (
                      <button
                        type="button"
                        style={styles.breadcrumbBtn}
                        onClick={() => navigateTo(crumb.path)}
                      >
                        {crumb.name}
                      </button>
                    )}
                  </span>
                );
              })}
            </nav>

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={data.parent === null ? styles.btnDisabled : styles.btnSecondary}
                disabled={data.parent === null}
                aria-disabled={data.parent === null}
                aria-label="Eine Ebene nach oben"
                onClick={() => navigateTo(data.parent)}
                data-testid="obsidian-vault-browser-up-btn"
              >
                ↑ Zurück
              </button>
            </div>

            {data.entries.length === 0 ? (
              <p style={styles.hint} role="status" data-testid="obsidian-vault-browser-empty">
                Keine Unterordner vorhanden.
              </p>
            ) : (
              <ul style={styles.entryList} aria-label="Unterordner" data-testid="obsidian-vault-browser-entries">
                {data.entries.map((entry) => (
                  <li key={entry.path} style={styles.entryItem}>
                    <button
                      type="button"
                      style={styles.entryBtn}
                      onClick={() => navigateTo(entry.path)}
                      aria-label={`In Unterordner „${entry.name}" wechseln`}
                    >
                      📁 {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnPrimary}
                onClick={handleUseFolder}
                data-testid="obsidian-vault-browser-use-btn"
              >
                Diesen Ordner verwenden
              </button>
            </div>
          </>
        )}

        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleClose}
            data-testid="obsidian-vault-browser-close-btn"
          >
            Schließen
          </button>
        </div>
      </div>
    </>
  );
}

// ── Styles (analog ObsidianIngestOverlay.jsx) ─────────────────────────────────

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
  currentFolderHeading: {
    margin: '0 0 10px',
    fontSize: 13,
    fontWeight: 600,
    color: '#d4d4d4',
  },
  currentFolderCode: {
    fontSize: 13,
    color: '#86efac',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
  breadcrumbNav: {
    marginBottom: 12,
    fontSize: 13,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  breadcrumbItem: {
    display: 'inline-flex',
    alignItems: 'center',
  },
  breadcrumbSep: {
    color: '#6b7280',
    padding: '0 2px',
  },
  breadcrumbBtn: {
    background: 'none',
    border: 'none',
    color: '#93c5fd',
    fontSize: 13,
    cursor: 'pointer',
    padding: '10px 6px',
    minHeight: 44,
    textDecoration: 'underline',
  },
  breadcrumbCurrent: {
    color: '#e5e7eb',
    fontWeight: 700,
    padding: '10px 6px',
  },
  entryList: {
    listStyle: 'none',
    margin: '0 0 14px',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 260,
    overflowY: 'auto',
  },
  entryItem: {
    margin: 0,
  },
  entryBtn: {
    width: '100%',
    textAlign: 'left',
    minHeight: 44,
    padding: '10px 12px',
    background: '#1e293b',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 4,
    marginBottom: 10,
  },
  btnPrimary: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
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
  },
  btnDisabled: {
    minHeight: 44,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#4b5563',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'not-allowed',
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
};
