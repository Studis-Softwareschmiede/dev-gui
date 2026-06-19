/**
 * TrainDialog.jsx — Modaler Train-Auswahl-Dialog für die Teamsicht (S-175).
 *
 * Covers (team-train-trigger):
 *   AC1  — Train-Button in TeamView (Maus + Tastatur, Touch-Target ≥ 44 px,
 *           Fokusring sichtbar): in TeamView.jsx integriert; hier die Dialog-Komponente.
 *   AC2  — role=dialog, aria-modal, Fokus-Falle, Esc schließt, Fokus-Rückgabe;
 *           „Alle"-Master-Checkbox zuoberst; nur KNOWLEDGE-Bereiche.
 *   AC3  — „Alle" an → alle angewählt; „Alle" aus → keiner; Teilauswahl → indeterminate;
 *           einzelne Häkchen bleiben frei setzbar.
 *   AC4  — Kostenmodus-Radios (sparsam/balanced/gründlich, Default balanced);
 *           Abarbeitung-Radios (Warteschlange/Parallel, Default Warteschlange).
 *   AC5  — „Weiter" → Bestätigungs-Step; „Ja" feuert; leere Auswahl deaktiviert „Weiter".
 *   AC6  — Queue: je Bereich /agent-flow:train<cost> <pack-id>; Parallel: ein Befehl
 *           mit allen Pack-IDs. Cost-Flag direkt nach dem Präfix.
 *   AC7  — „Parallel" deaktiviert mit Hinweis (Mehr-Pack-Train noch nicht verfügbar).
 *   AC9  — Doppel-Feuer-Schutz; je Befehl Status (gestartet/wartet/abgelehnt); 409 → Hinweis.
 *   AC10 — WCAG 2.1 AA: role=dialog, aria-modal, beschriftete Checkboxen/Radios,
 *           indeterminate-Kommunikation, sichtbare Fokusringe, aria-busy/aria-live.
 *   AC11 — Security-Floor: kein dangerouslySetInnerHTML/innerHTML; keine Secrets;
 *           nur /api/command; Server bleibt Allowlist-Grenze.
 *
 * A11y (WCAG 2.1 AA):
 *   - role="dialog" + aria-modal="true" + aria-labelledby.
 *   - Fokus-Falle: Tab/Shift+Tab zirkuliert innerhalb des Dialogs.
 *   - Esc schließt den Dialog und gibt Fokus an den Train-Button zurück.
 *   - Alle Checkboxen / Radios haben ein assoziiertes <label>.
 *   - „Alle"-Checkbox kommuniziert indeterminate über ref.indeterminate = true.
 *   - aria-busy / aria-live für Lade- und Sendestatus.
 *   - Bedeutung nicht allein über Farbe.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/command POST; kein direkter Shell-Aufruf.
 *   - Keine Secrets im Bundle.
 *
 * @param {{
 *   knowledge: Array<{ id: string, name: string, group: string }>,
 *   onClose: () => void,
 *   triggerRef: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { COST_MODES, costFlag } from './costMode.js';
import { EntityIcon } from './icons/EntityIcon.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Cost-mode display labels (nur die drei, die der Spec entsprechen: sparsam/balanced/gründlich).
 * Mapped von costMode.js-Werten.
 */
const TRAIN_COST_MODES = [
  { value: 'low-cost',    label: 'sparsam' },
  { value: 'balanced',    label: 'balanced' },
  { value: 'max-quality', label: 'gründlich' },
];

/**
 * Abarbeitungs-Optionen: Warteschlange (Standard) / Parallel.
 * Parallel ist deaktiviert bis Mehr-Pack-Train in agent-flow verfügbar (AC7).
 */
const QUEUE_MODES = [
  { value: 'queue',    label: 'Warteschlange' },
  { value: 'parallel', label: 'Parallel', disabled: true },
];

/** Session-Poll-Intervall für Queue-Abarbeitung (ms). */
const SESSION_POLL_MS = 2_000;
const SESSION_POLL_MAX_WAIT_MS = 120_000; // 2 Minuten max Wartezeit pro Befehl

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compose a single train command line (AC6).
 * @param {string[]} packIds
 * @param {string} costMode
 * @param {'queue'|'parallel'} queueMode
 * @returns {string[]} Array of command strings (1 per Queue-item, or 1 for Parallel)
 */
function composeTrainCommands(packIds, costMode, queueMode) {
  const cost = costFlag('/agent-flow:train', costMode);
  if (queueMode === 'parallel') {
    // Ein Befehl mit allen Packs (AC6 Parallel)
    return [`/agent-flow:train${cost} ${packIds.join(' ')}`];
  }
  // Warteschlange: je Pack ein Befehl (AC6 Queue)
  return packIds.map((id) => `/agent-flow:train${cost} ${id}`);
}

/**
 * Wait until GET /api/session returns state:"ready".
 * Returns false when max wait time exceeded.
 * @param {Function} fetchFn
 * @param {number} maxWaitMs
 * @returns {Promise<boolean>}
 */
async function waitForReady(fetchFn, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn('/api/session');
      if (res.ok) {
        const json = await res.json();
        if (json.state === 'ready') return true;
      }
    } catch {
      // ignore transient errors
    }
    await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
  }
  return false;
}

// ── TrainDialog ───────────────────────────────────────────────────────────────

/**
 * Modal train dialog.
 * Step 1: Auswahl (Checkboxen + Kostenmodus + Abarbeitung)
 * Step 2: Bestätigung (Zusammenfassung + Ja/Nein)
 * Step 3: Sende-Status
 *
 * @param {{
 *   knowledge: Array<{ id: string, name: string, group: string }>,
 *   onClose: () => void,
 *   triggerRef: React.RefObject,
 *   fetchFn?: Function,
 * }} props
 */
export function TrainDialog({ knowledge, onClose, triggerRef, fetchFn }) {
  const fetch_ = fetchFn ?? globalThis.fetch.bind(globalThis);

  // ── Selection state
  const [selected, setSelected] = useState(new Set()); // Set of knowledge ids
  const [costMode, setCostMode] = useState('balanced');
  const [queueMode, setQueueMode] = useState('queue');

  // ── Step: 'select' | 'confirm' | 'sending'
  const [step, setStep] = useState('select');

  // ── Sending state: array of { command, status: 'pending'|'sent'|'rejected'|'busy'|'error', msg? }
  const [sendItems, setSendItems] = useState([]);
  const [isSending, setIsSending] = useState(false);

  // ── Refs for focus management and trap
  const dialogRef = useRef(null);
  const allCheckRef = useRef(null); // ref for master checkbox (indeterminate)

  // ── Derived: knowledge grouped by group (for display)
  const knByGroup = groupBy(knowledge, (k) => k.group);
  const knGroups = Object.keys(knByGroup).sort((a, b) => a.localeCompare(b));
  const allIds = knowledge.map((k) => k.id);
  const hasKnowledge = knowledge.length > 0;

  // ── Derived: "Alle"-state
  const allSelected = hasKnowledge && selected.size === allIds.length;
  const noneSelected = selected.size === 0;
  const partialSelected = !allSelected && !noneSelected;

  // ── Sync indeterminate on master checkbox
  useEffect(() => {
    if (allCheckRef.current) {
      allCheckRef.current.indeterminate = partialSelected;
    }
  }, [partialSelected]);

  // ── Focus trap: on mount focus the first element, Esc closes
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Focus the first focusable element
    const focusable = getFocusable(dialog);
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key === 'Tab') {
        const focusableNow = getFocusable(dialog);
        if (focusableNow.length === 0) return;
        const first = focusableNow[0];
        const last = focusableNow[focusableNow.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Close + return focus to trigger button
  const handleClose = useCallback(() => {
    if (isSending) return; // AC9: warnen statt sofort schließen
    onClose();
    // Fokus-Rückgabe an Train-Button (AC2/AC10)
    if (triggerRef?.current) {
      triggerRef.current.focus();
    }
  }, [isSending, onClose, triggerRef]);

  // ── "Alle" master checkbox handler
  function handleAllChange(e) {
    if (e.target.checked) {
      setSelected(new Set(allIds));
    } else {
      setSelected(new Set());
    }
  }

  // ── Individual checkbox handler
  function handleItemChange(id, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // ── "Weiter" → Bestätigungs-Step
  function handleWeiter() {
    if (selected.size === 0) return;
    setStep('confirm');
    // Fokus wird durch den step-useEffect neu gesetzt
  }

  // ── "Zurück" → zurück zur Auswahl
  function handleZurueck() {
    setStep('select');
  }

  // ── "Ja/Starten" → Befehle feuern (AC5/AC9)
  async function handleStart() {
    if (isSending) return; // Doppel-Feuer-Schutz (AC9)

    const packIds = Array.from(selected);
    const commands = composeTrainCommands(packIds, costMode, queueMode);
    const items = commands.map((cmd) => ({ command: cmd, status: 'pending', msg: '' }));

    setSendItems(items);
    setIsSending(true);
    setStep('sending');

    for (let i = 0; i < items.length; i++) {
      const cmd = items[i].command;

      // Queue: warte bis Session ready (AC6)
      if (queueMode === 'queue' && i > 0) {
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'pending', msg: 'Warte auf Session…' };
          return next;
        });
        const ready = await waitForReady(fetch_, SESSION_POLL_MAX_WAIT_MS);
        if (!ready) {
          setSendItems((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], status: 'error', msg: 'Timeout — Session nicht bereit.' };
            return next;
          });
          continue;
        }
      }

      // Senden
      let res;
      try {
        res = await fetch_('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        });
      } catch {
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'error', msg: 'Netzwerkfehler.' };
          return next;
        });
        continue;
      }

      if (res.status === 202) {
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'sent', msg: 'gestartet' };
          return next;
        });
      } else if (res.status === 409) {
        // AC9: Session belegt → Hinweis
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'busy', msg: 'Session belegt — bitte später erneut versuchen.' };
          return next;
        });
      } else if (res.status === 400) {
        let detail = 'Ungültiger Befehl.';
        try {
          const json = await res.json();
          if (json?.reason) detail = `Abgelehnt: ${json.reason}`;
        } catch { /* ignore */ }
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'rejected', msg: detail };
          return next;
        });
      } else {
        setSendItems((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'error', msg: 'Serverfehler.' };
          return next;
        });
      }
    }

    setIsSending(false);
  }

  // ── Summary text for confirmation step
  const selectedNames = Array.from(selected).map((id) => {
    const item = knowledge.find((k) => k.id === id);
    return item ? (item.name || item.id) : id;
  });
  const costLabel = TRAIN_COST_MODES.find((m) => m.value === costMode)?.label ?? costMode;
  const queueLabel = QUEUE_MODES.find((m) => m.value === queueMode)?.label ?? queueMode;

  const dialogId = 'train-dialog';
  const titleId = 'train-dialog-title';

  // ── Render
  return (
    <>
      {/* Backdrop */}
      <div
        style={styles.backdrop}
        onClick={isSending ? undefined : handleClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        id={dialogId}
        style={styles.dialog}
        data-testid="train-dialog"
      >
        <h2 id={titleId} style={styles.dialogTitle}>
          Train — Knowledge auswählen
        </h2>

        {/* ── Step: Auswahl ── */}
        {step === 'select' && (
          <>
            {/* Leerzustand */}
            {!hasKnowledge && (
              <p style={styles.emptyMsg} aria-live="polite">
                Kein agent-flow-Plugin gefunden — keine Knowledge-Bereiche verfügbar.
              </p>
            )}

            {/* „Alle"-Master-Checkbox (AC2/AC3) */}
            {hasKnowledge && (
              <div style={styles.allRow}>
                <label style={styles.checkLabel}>
                  <input
                    ref={allCheckRef}
                    type="checkbox"
                    style={styles.checkbox}
                    checked={allSelected}
                    onChange={handleAllChange}
                    aria-label="Alle Knowledge-Bereiche auswählen"
                    data-testid="check-all"
                  />
                  <span style={styles.checkText}>Alle</span>
                </label>
              </div>
            )}

            {/* Knowledge-Liste gruppiert (AC2) */}
            {hasKnowledge && (
              <div style={styles.knowledgeList} aria-label="Knowledge-Bereiche" aria-busy="false">
                {knGroups.map((group) => (
                  <div key={group} style={styles.groupBlock}>
                    <div style={styles.groupHeading}>{group}</div>
                    {knByGroup[group].map((kn) => (
                      <label key={kn.id} style={styles.checkLabel}>
                        <input
                          type="checkbox"
                          style={styles.checkbox}
                          checked={selected.has(kn.id)}
                          onChange={(e) => handleItemChange(kn.id, e.target.checked)}
                          data-testid={`check-${kn.id}`}
                        />
                        <EntityIcon kind="knowledge" id={kn.id} group={kn.group} size={14} />
                        <span style={styles.checkText}>{kn.name || kn.id}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Kostenmodus-Radios (AC4) */}
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Kostenmodus</legend>
              <div style={styles.radioGroup} role="radiogroup" aria-label="Kostenmodus">
                {TRAIN_COST_MODES.map((m) => (
                  <label key={m.value} style={styles.radioLabel}>
                    <input
                      type="radio"
                      name="train-cost"
                      value={m.value}
                      checked={costMode === m.value}
                      onChange={() => setCostMode(m.value)}
                      style={styles.radio}
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Abarbeitungs-Radios (AC4/AC7) */}
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Abarbeitung</legend>
              <div style={styles.radioGroup} role="radiogroup" aria-label="Abarbeitung">
                {QUEUE_MODES.map((m) => (
                  <label
                    key={m.value}
                    style={m.disabled ? { ...styles.radioLabel, ...styles.disabledLabel } : styles.radioLabel}
                  >
                    <input
                      type="radio"
                      name="train-queue"
                      value={m.value}
                      checked={queueMode === m.value}
                      onChange={() => !m.disabled && setQueueMode(m.value)}
                      disabled={m.disabled}
                      aria-disabled={m.disabled}
                      style={styles.radio}
                    />
                    <span>{m.label}</span>
                    {m.disabled && (
                      <span style={styles.disabledHint} aria-live="polite">
                        {' '}(kommt mit Mehr-Pack-Train — noch nicht verfügbar)
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Aktions-Buttons */}
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={selected.size > 0 ? styles.btnPrimary : styles.btnDisabled}
                disabled={selected.size === 0}
                aria-disabled={selected.size === 0}
                onClick={handleWeiter}
                data-testid="btn-weiter"
              >
                Weiter
              </button>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={handleClose}
                data-testid="btn-abbrechen"
              >
                Abbrechen
              </button>
            </div>
          </>
        )}

        {/* ── Step: Bestätigung (AC5) ── */}
        {step === 'confirm' && (
          <>
            <div style={styles.confirmBox} aria-live="polite">
              <p style={styles.confirmText}>
                <strong>{selectedNames.length}</strong> Train-{selectedNames.length === 1 ? 'Lauf' : 'Läufe'}:{' '}
                <code style={styles.codeInline}>{selectedNames.join(', ')}</code>
              </p>
              <p style={styles.confirmMeta}>
                Modus: <strong>{costLabel}</strong> · Abarbeitung: <strong>{queueLabel}</strong>
              </p>
              <p style={styles.confirmQuestion}>Jetzt starten?</p>
            </div>

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.btnPrimary}
                onClick={handleStart}
                data-testid="btn-ja"
              >
                Ja, starten
              </button>
              <button
                type="button"
                style={styles.btnSecondary}
                onClick={handleZurueck}
                data-testid="btn-zurueck"
              >
                Zurück
              </button>
            </div>
          </>
        )}

        {/* ── Step: Sende-Status (AC9) ── */}
        {step === 'sending' && (
          <>
            <div
              aria-live="polite"
              aria-busy={isSending}
              style={styles.sendStatusList}
              data-testid="send-status"
            >
              {sendItems.map((item, idx) => (
                <div key={idx} style={styles.sendItem}>
                  <span style={statusDotStyle(item.status)} aria-hidden="true" />
                  <span style={styles.sendCmd}>{item.command}</span>
                  <span style={statusTextStyle(item.status)}>
                    {statusLabel(item.status)}
                    {item.msg ? ` — ${item.msg}` : ''}
                  </span>
                </div>
              ))}
            </div>

            {isSending && (
              <p style={styles.sendingNote} aria-live="polite">
                Läuft… bitte warten.
              </p>
            )}

            {!isSending && (
              <div style={styles.buttonRow}>
                <button
                  type="button"
                  style={styles.btnSecondary}
                  onClick={handleClose}
                  data-testid="btn-schliessen"
                >
                  Schließen
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function groupBy(arr, keyFn) {
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

function getFocusable(container) {
  return Array.from(
    container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.closest('[disabled]'));
}

function statusLabel(status) {
  switch (status) {
    case 'pending':  return 'ausstehend';
    case 'sent':     return 'gestartet';
    case 'rejected': return 'abgelehnt';
    case 'busy':     return 'Session belegt';
    case 'error':    return 'Fehler';
    default:         return status;
  }
}

function statusDotStyle(status) {
  const color = {
    pending:  '#6b7280',
    sent:     '#4ade80',
    rejected: '#f87171',
    busy:     '#fbbf24',
    error:    '#f87171',
  }[status] ?? '#6b7280';
  return {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
    marginTop: 4,
  };
}

function statusTextStyle(status) {
  const color = {
    pending:  '#9ca3af',
    sent:     '#4ade80',
    rejected: '#f87171',
    busy:     '#fbbf24',
    error:    '#f87171',
  }[status] ?? '#9ca3af';
  return { color, fontSize: 12, flexShrink: 0 };
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
    minWidth: 360,
    maxWidth: 520,
    maxHeight: '85vh',
    overflowY: 'auto',
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
  },

  dialogTitle: {
    margin: '0 0 18px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },

  emptyMsg: {
    color: '#9ca3af',
    fontSize: 13,
    padding: '8px 0',
  },

  // „Alle"-Checkbox-Zeile
  allRow: {
    borderBottom: '1px solid #2a2a2a',
    paddingBottom: 10,
    marginBottom: 10,
  },

  knowledgeList: {
    maxHeight: 260,
    overflowY: 'auto',
    marginBottom: 16,
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 12px',
  },

  groupBlock: {
    marginBottom: 10,
  },

  groupHeading: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#6b7280',
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  // Checkbox label-Zeile: flex, gap, Touch-Target ≥ 44px via minHeight + padding
  checkLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    padding: '4px 0',
    cursor: 'pointer',
    // Focus ring erbt vom input — kein outline:none
  },

  checkbox: {
    width: 16,
    height: 16,
    accentColor: '#3b82f6',
    cursor: 'pointer',
    flexShrink: 0,
  },

  checkText: {
    color: '#e5e7eb',
    fontSize: 13,
  },

  // Fieldsets für Kostenmodus / Abarbeitung
  fieldset: {
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 14,
  },

  legend: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#9ca3af',
    textTransform: 'uppercase',
    padding: '0 4px',
  },

  radioGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 8,
  },

  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 13,
    color: '#e5e7eb',
    minHeight: 28,
  },

  disabledLabel: {
    color: '#6b7280',
    cursor: 'not-allowed',
  },

  radio: {
    accentColor: '#3b82f6',
    width: 14,
    height: 14,
    cursor: 'pointer',
    flexShrink: 0,
  },

  disabledHint: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },

  // Aktions-Buttons
  buttonRow: {
    display: 'flex',
    gap: 10,
    marginTop: 16,
    justifyContent: 'flex-end',
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
    // Focus ring visible — kein outline:none
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

  // Bestätigungs-Step
  confirmBox: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '14px 16px',
    marginBottom: 4,
  },

  confirmText: {
    margin: '0 0 8px',
    fontSize: 14,
    lineHeight: 1.5,
    color: '#e5e7eb',
  },

  confirmMeta: {
    margin: '0 0 8px',
    fontSize: 13,
    color: '#9ca3af',
  },

  confirmQuestion: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: '#f0f9ff',
  },

  codeInline: {
    background: '#1e293b',
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#93c5fd',
  },

  // Sende-Status
  sendStatusList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 12,
  },

  sendItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '8px 10px',
  },

  sendCmd: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#9ca3af',
    wordBreak: 'break-all',
  },

  sendingNote: {
    fontSize: 13,
    color: '#fbbf24',
    fontStyle: 'italic',
    margin: '0 0 12px',
  },
};
