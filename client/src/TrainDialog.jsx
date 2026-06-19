/**
 * TrainDialog.jsx — Modaler Train-Auswahl-Dialog für die Teamsicht (S-175 + S-174).
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
 * Covers (team-knowledge-add):
 *   AC1  — Button „Neuen Knowledge Space anlegen" im Train-Popup, öffnet Anlage-Schritt. (V1)
 *   AC2  — Anlage-Schritt: mehrzeiliges Beschreibungsfeld + Button „Quellen suchen". (V2)
 *   AC3  — „Quellen suchen" ruft POST /api/assist/knowledge-sources { description } auf;
 *           description via stdin an claude (kein direkter argv-Kontakt). (V3)
 *   AC4  — Checkbox-Liste mit Titel/URL/why (vorausgewählt); editierbarer Name+Typ
 *           (vorbefüllt); aria-busy während Suche; Fehler → klare Meldung. (V3, V4)
 *   AC5  — Manuelle Quelle hinzufügen als Fallback. (V4)
 *   AC6  — Pack-ID aus Name+Typ+Version kanonisch; Kollisions-Check gegen /api/team;
 *           OK deaktiviert + Hinweis wenn Name bereits existiert. (V5)
 *   AC7  — OK sendet /agent-flow:train --bootstrap <pack-id> <bestätigte-urls…>
 *           an POST /api/command; Doppel-Feuer-Schutz. (V6)
 *   AC8  — OK erst aktiv bei gültigem Namen + ≥1 ausgewählter Quelle. (V4, V6)
 *   AC9  — Security-Floor: kein dangerouslySetInnerHTML; nur erlaubte APIs.
 *           URL-Validierung frontend-seitig (^https?://, keine Steuerzeichen). (alle)
 *   AC13 — URLs kennzeichnet als „Vorschlag, bitte prüfen"; dev-gui fetcht sie nie.
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
 *   - Nur /api/command, /api/team, /api/assist/knowledge-sources POST; kein direkter Shell-Aufruf.
 *   - Keine Secrets im Bundle.
 *   - URL-Validierung: ^https?://, keine Steuerzeichen/Leerzeichen, einzeilig (AC9, A5).
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

// ── URL-Validierung (A5, AC9) ─────────────────────────────────────────────────

/**
 * Prüft, ob eine URL sicher für den --bootstrap-Befehl ist.
 * Regel: ^https?://, keine Steuerzeichen (0x00–0x1F, 0x7F), keine Leerzeichen, einzeilig.
 * Analog zur backend-seitigen Validierungsregel (A5, AC9, AC14).
 * @param {string} url
 * @returns {boolean}
 */
export function isValidBootstrapUrl(url) {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // Keine Steuerzeichen (U+0000–U+001F, U+007F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(url)) return false;
  // Keine Leerzeichen (würde den CLI-Befehl aufbrechen)
  if (/\s/.test(url)) return false;
  // Einzeilig — keine Zeilenumbrüche
  if (/[\r\n]/.test(url)) return false;
  return true;
}

/**
 * Kanonische Pack-ID aus Name + Typ (+optionale Major-Version).
 * Resolver-Formen: language → <name>, framework → <name>@<major>,
 *                  build → build/<name>, migration → migration/<name>[@<major>].
 * @param {string} name
 * @param {string} packType
 * @param {string} version
 * @returns {string}
 */
export function composePackId(name, packType, version) {
  const n = name.trim();
  const v = version.trim();
  switch (packType) {
    case 'framework':
      return v ? `${n}@${v}` : n;
    case 'build':
      return `build/${n}`;
    case 'migration':
      return v ? `migration/${n}@${v}` : `migration/${n}`;
    default:
      // language, security, other → <name>
      return n;
  }
}

// ── KnowledgeAddStep ──────────────────────────────────────────────────────────

/**
 * Mehrstufiger Sub-View für „Neuen Knowledge Space anlegen".
 * Wird innerhalb des TrainDialog als step='add-knowledge' angezeigt.
 *
 * AC1–AC9 (team-knowledge-add): Beschreibung → Suche → Checkbox-Liste → OK.
 *
 * @param {{
 *   existingKnowledgeIds: string[],
 *   onBack: () => void,
 *   onFire: (command: string) => void,
 *   fetchFn: Function,
 * }} props
 */
function KnowledgeAddStep({ existingKnowledgeIds, onBack, onFire, fetchFn }) {
  // ── Substep: 'describe' | 'search' | 'review'
  const [subStep, setSubStep] = useState('describe');

  // ── Beschreibungs-Eingabe (AC2)
  const [description, setDescription] = useState('');

  // ── Suchergebnis-State
  const [searchError, setSearchError] = useState('');
  const [sources, setSources] = useState([]); // [{ title, url, why, selected }]
  const [suggestedPackId, setSuggestedPackId] = useState('');

  // ── Editierbare Name/Typ/Version-Felder (AC4, V4)
  const [packName, setPackName] = useState('');
  const [packType, setPackType] = useState('language');
  const [packVersion, setPackVersion] = useState('');

  // ── Manuelle Quelle (AC5)
  const [manualUrl, setManualUrl] = useState('');
  const [manualUrlError, setManualUrlError] = useState('');

  // ── OK-Schutz: Doppel-Feuer (AC8)
  const [isFiring, setIsFiring] = useState(false);

  // ── Derived: existiert Pack-ID bereits? (AC6)
  const packId = composePackId(packName, packType, packVersion);
  const nameExists = packName.trim() !== '' && existingKnowledgeIds.includes(packId);
  const selectedSources = sources.filter((s) => s.selected);
  const hasValidName = packName.trim() !== '' && !nameExists;
  const canFire = hasValidName && selectedSources.length > 0 && !isFiring;

  // ── Quelle suchen (AC3)
  async function handleSearch() {
    if (!description.trim()) return;
    setSubStep('search');
    setSearchError('');
    setSources([]);

    try {
      const res = await fetchFn('/api/assist/knowledge-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });

      let data;
      try { data = await res.json(); } catch { data = {}; }

      if (!res.ok || !data.ok) {
        // Fail-safe: kein Crash, kein Secret in Meldung (A7, AC4)
        setSearchError(
          data?.error && typeof data.error === 'string' && !data.error.includes('secret')
            ? data.error
            : 'Quellen-Suche fehlgeschlagen. Bitte manuell eingeben.'
        );
        setSubStep('review');
        return;
      }

      // Vorschlag übernehmen (AC4): vorbefüllen, Owner kann überschreiben
      if (data.suggestedPackId) {
        setSuggestedPackId(data.suggestedPackId);
        // Extrahiere Name + Typ aus suggestedPackId
        parsePackId(data.suggestedPackId, data.suggestedType ?? 'language', setPackName, setPackType, setPackVersion);
      }
      // Quellen als Checkbox-Liste (vorausgewählt, AC4)
      const rawSources = Array.isArray(data.sources) ? data.sources : [];
      // Nur gültige URLs (A4 — dev-gui fetcht nie; A5 — URL-Format prüfen)
      const filtered = rawSources.filter((s) => isValidBootstrapUrl(s.url));
      setSources(filtered.map((s) => ({ ...s, selected: true })));
      setSubStep('review');
    } catch {
      // Netzwerkfehler — kein Secret-Leak (AC4, A7)
      setSearchError('Netzwerkfehler beim Suchen der Quellen. Bitte manuell eingeben.');
      setSubStep('review');
    }
  }

  // ── Manuelle Quelle hinzufügen (AC5)
  function handleAddManualUrl() {
    setManualUrlError('');
    const url = manualUrl.trim();
    if (!isValidBootstrapUrl(url)) {
      setManualUrlError('URL muss mit https:// oder http:// beginnen und keine Sonderzeichen enthalten.');
      return;
    }
    if (sources.some((s) => s.url === url)) {
      setManualUrlError('Diese URL ist bereits in der Liste.');
      return;
    }
    setSources((prev) => [...prev, { title: url, url, why: 'Manuell hinzugefügt', selected: true }]);
    setManualUrl('');
  }

  // ── OK feuern (AC7, AC8)
  async function handleFire() {
    if (!canFire) return;
    setIsFiring(true);

    const confirmedUrls = selectedSources
      .map((s) => s.url)
      .filter(isValidBootstrapUrl); // A5: nur gültige URLs

    if (confirmedUrls.length === 0) {
      setIsFiring(false);
      return;
    }

    const command = `/agent-flow:train --bootstrap ${packId} ${confirmedUrls.join(' ')}`;
    onFire(command);
  }

  // ── Sub-Step: Beschreibung eingeben (AC2)
  if (subStep === 'describe') {
    return (
      <div style={styles.addSection}>
        <h3 style={styles.addHeading}>Neuen Knowledge Space anlegen</h3>
        <p style={styles.addHint}>
          Beschreibe, welches Wissen angelegt werden soll. Claude sucht dann offizielle Quellen.
        </p>
        <label style={styles.addLabel} htmlFor="ks-description">
          Beschreibung
        </label>
        <textarea
          id="ks-description"
          style={styles.addTextarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="z.B. Knowledge zu Rust fuer systemnahe Backend-Services, Fokus aktuelle stabile APIs"
          rows={4}
          maxLength={2000}
          aria-label="Beschreibung des Knowledge Space"
          data-testid="ks-description"
        />
        <div style={styles.buttonRow}>
          <button
            type="button"
            style={description.trim() ? styles.btnPrimary : styles.btnDisabled}
            disabled={!description.trim()}
            aria-disabled={!description.trim()}
            onClick={handleSearch}
            data-testid="btn-search-sources"
          >
            Quellen suchen
          </button>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={onBack}
            data-testid="btn-add-back"
          >
            Zurück
          </button>
        </div>
      </div>
    );
  }

  // ── Sub-Step: Suche läuft (AC4 aria-busy)
  if (subStep === 'search') {
    return (
      <div style={styles.addSection}>
        <h3 style={styles.addHeading}>Neuen Knowledge Space anlegen</h3>
        <div
          aria-busy="true"
          aria-live="polite"
          style={styles.searchingBox}
          data-testid="ks-searching"
        >
          Suche offizielle Quellen für: „{description}"…
        </div>
      </div>
    );
  }

  // ── Sub-Step: Ergebnis / Review (AC4, AC5, AC6, AC7, AC8)
  return (
    <div style={styles.addSection}>
      <h3 style={styles.addHeading}>Neuen Knowledge Space anlegen</h3>

      {/* Fehler-Anzeige (AC4) */}
      {searchError && (
        <div role="alert" style={styles.addError} data-testid="ks-search-error">
          {searchError}
        </div>
      )}

      {/* Pack-Name + Typ + Version (AC4 — editierbar, vorbefüllt) */}
      <div style={styles.addFieldRow}>
        <div style={styles.addField}>
          <label style={styles.addLabel} htmlFor="ks-pack-name">
            Name
          </label>
          <input
            id="ks-pack-name"
            type="text"
            style={styles.addInput}
            value={packName}
            onChange={(e) => setPackName(e.target.value)}
            placeholder={suggestedPackId || 'z.B. rust'}
            aria-label="Pack-Name"
            data-testid="ks-pack-name"
          />
        </div>
        <div style={styles.addField}>
          <label style={styles.addLabel} htmlFor="ks-pack-type">
            Typ
          </label>
          <select
            id="ks-pack-type"
            style={styles.addSelect}
            value={packType}
            onChange={(e) => setPackType(e.target.value)}
            aria-label="Pack-Typ"
            data-testid="ks-pack-type"
          >
            <option value="language">Sprache</option>
            <option value="framework">Framework</option>
            <option value="build">Build</option>
            <option value="migration">Migration</option>
            <option value="security">Security</option>
            <option value="other">Sonstiges</option>
          </select>
        </div>
        {(packType === 'framework' || packType === 'migration') && (
          <div style={styles.addField}>
            <label style={styles.addLabel} htmlFor="ks-pack-version">
              Major-Version
            </label>
            <input
              id="ks-pack-version"
              type="text"
              style={styles.addInput}
              value={packVersion}
              onChange={(e) => setPackVersion(e.target.value)}
              placeholder="z.B. 3"
              aria-label="Major-Version"
              data-testid="ks-pack-version"
            />
          </div>
        )}
      </div>

      {/* Pack-ID Vorschau + Kollisions-Check (AC6) */}
      {packName.trim() && (
        <div style={styles.addPackIdRow} data-testid="ks-pack-id-preview">
          Pack-ID: <code style={styles.codeInline}>{packId}</code>
          {nameExists && (
            <span style={styles.addExistsHint} role="alert" data-testid="ks-name-exists">
              {' '}— bereits vorhanden. Über „Vorhandenes trainieren" aktualisieren.
            </span>
          )}
        </div>
      )}

      {/* Quellen-Liste (AC4, AC13 — „Vorschlag, bitte prüfen") */}
      {sources.length > 0 && (
        <div style={styles.addSourcesSection}>
          <div style={styles.addSourcesLabel}>
            Quellen (Vorschlag, bitte prüfen):
          </div>
          <div style={styles.addSourcesList} aria-label="Gefundene Quellen">
            {sources.map((src, idx) => (
              <label key={idx} style={styles.addSourceItem} data-testid={`ks-source-${idx}`}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={src.selected}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSources((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], selected: checked };
                      return next;
                    });
                  }}
                  data-testid={`ks-source-check-${idx}`}
                />
                <div style={styles.addSourceInfo}>
                  <div style={styles.addSourceTitle}>{src.title}</div>
                  <div style={styles.addSourceUrl}>
                    {/* A4/AC13: Link nicht klickbar als anchor — kein Fetch; nur Text */}
                    <span style={styles.addSourceUrlText}>{src.url}</span>
                  </div>
                  {src.why && (
                    <div style={styles.addSourceWhy}>{src.why}</div>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Manuelle Quelle hinzufügen (AC5) */}
      <div style={styles.addManualRow}>
        <label style={styles.addLabel} htmlFor="ks-manual-url">
          Quelle manuell hinzufügen:
        </label>
        <div style={styles.addManualInputRow}>
          <input
            id="ks-manual-url"
            type="url"
            style={styles.addInput}
            value={manualUrl}
            onChange={(e) => { setManualUrl(e.target.value); setManualUrlError(''); }}
            placeholder="https://doc.example.com/..."
            aria-label="Manuelle Quelle URL"
            data-testid="ks-manual-url"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddManualUrl(); } }}
          />
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={handleAddManualUrl}
            data-testid="btn-add-manual-url"
          >
            Hinzufügen
          </button>
        </div>
        {manualUrlError && (
          <div role="alert" style={styles.addFieldError} data-testid="ks-manual-url-error">
            {manualUrlError}
          </div>
        )}
      </div>

      {/* Aktions-Buttons (AC7, AC8) */}
      <div style={styles.buttonRow}>
        <button
          type="button"
          style={canFire ? styles.btnPrimary : styles.btnDisabled}
          disabled={!canFire}
          aria-disabled={!canFire}
          onClick={handleFire}
          data-testid="btn-ks-ok"
        >
          {isFiring ? 'Starte…' : 'OK — Train starten'}
        </button>
        <button
          type="button"
          style={styles.btnSecondary}
          onClick={() => setSubStep('describe')}
          data-testid="btn-ks-back"
        >
          Zurück
        </button>
      </div>
    </div>
  );
}

/**
 * Parst eine suggestedPackId und setzt Name/Typ/Version-State.
 * Heuristik: framework→@, build→build/, migration→migration/
 * @param {string} packId
 * @param {string} suggestedType
 * @param {Function} setName
 * @param {Function} setType
 * @param {Function} setVersion
 */
function parsePackId(packId, suggestedType, setName, setType, setVersion) {
  if (!packId) return;
  // build/<name>
  if (packId.startsWith('build/')) {
    setName(packId.slice('build/'.length));
    setType('build');
    setVersion('');
    return;
  }
  // migration/<name>[@<major>] or migration/<name>
  if (packId.startsWith('migration/')) {
    const rest = packId.slice('migration/'.length);
    const atIdx = rest.indexOf('@');
    if (atIdx > 0) {
      setName(rest.slice(0, atIdx));
      setVersion(rest.slice(atIdx + 1));
    } else {
      setName(rest);
      setVersion('');
    }
    setType('migration');
    return;
  }
  // framework → <name>@<major>
  const atIdx = packId.indexOf('@');
  if (atIdx > 0) {
    setName(packId.slice(0, atIdx));
    setVersion(packId.slice(atIdx + 1));
    setType('framework');
    return;
  }
  // Fallback: language/security/other = <name>
  setName(packId);
  setVersion('');
  setType(suggestedType ?? 'language');
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

  // ── Step: 'select' | 'confirm' | 'sending' | 'add-knowledge'
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

            {/* ── „Neuen Knowledge Space anlegen"-Button (team-knowledge-add AC1) ── */}
            <div style={styles.addKsRow}>
              <button
                type="button"
                style={styles.btnAddKs}
                onClick={() => setStep('add-knowledge')}
                data-testid="btn-add-knowledge"
                aria-label="Neuen Knowledge Space anlegen"
              >
                + Neuen Knowledge Space anlegen
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

        {/* ── Step: Neuen Knowledge Space anlegen (team-knowledge-add AC1–AC9) ── */}
        {step === 'add-knowledge' && (
          <KnowledgeAddStep
            existingKnowledgeIds={knowledge.map((k) => k.id)}
            onBack={() => setStep('select')}
            onFire={(command) => {
              // Wechsle in den Sende-Status und feuere den einen --bootstrap-Befehl (AC7)
              const items = [{ command, status: 'pending', msg: '' }];
              setSendItems(items);
              setIsSending(true);
              setStep('sending');

              // Befehl senden (AC7, AC8 — Doppel-Feuer-Schutz via isSending)
              (async () => {
                let res;
                try {
                  res = await fetch_('/api/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command }),
                  });
                } catch {
                  setSendItems([{ command, status: 'error', msg: 'Netzwerkfehler.' }]);
                  setIsSending(false);
                  return;
                }

                if (res.status === 202) {
                  setSendItems([{ command, status: 'sent', msg: 'gestartet' }]);
                } else if (res.status === 409) {
                  setSendItems([{ command, status: 'busy', msg: 'Session belegt — bitte später erneut versuchen.' }]);
                } else if (res.status === 400) {
                  let detail = 'Ungültiger Befehl.';
                  try {
                    const json = await res.json();
                    if (json?.reason) detail = `Abgelehnt: ${json.reason}`;
                    else if (json?.error) detail = `Abgelehnt: ${json.error}`;
                  } catch { /* ignore */ }
                  setSendItems([{ command, status: 'rejected', msg: detail }]);
                } else {
                  setSendItems([{ command, status: 'error', msg: 'Serverfehler.' }]);
                }
                setIsSending(false);
              })();
            }}
            fetchFn={fetch_}
          />
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

  // ── „Neuen Knowledge Space anlegen"-Button-Zeile (team-knowledge-add AC1)
  addKsRow: {
    marginTop: 14,
    paddingTop: 12,
    borderTop: '1px solid #2a2a2a',
    textAlign: 'center',
  },

  btnAddKs: {
    minHeight: 36,
    padding: '7px 16px',
    background: 'transparent',
    color: '#60a5fa',
    border: '1px dashed #374151',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    // Fokusring erhalten — kein outline:none (A11y)
  },

  // ── Knowledge-Add-Sub-View (team-knowledge-add)
  addSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },

  addHeading: {
    margin: '0 0 4px',
    fontSize: 15,
    fontWeight: 700,
    color: '#f0f9ff',
  },

  addHint: {
    margin: 0,
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },

  addLabel: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  addTextarea: {
    width: '100%',
    minHeight: 80,
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '8px 10px',
    resize: 'vertical',
    fontFamily: 'system-ui, sans-serif',
    boxSizing: 'border-box',
  },

  addFieldRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },

  addField: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 100,
  },

  addInput: {
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '7px 10px',
    fontFamily: 'system-ui, sans-serif',
    minHeight: 34,
  },

  addSelect: {
    background: '#111',
    border: '1px solid #374151',
    borderRadius: 6,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '7px 10px',
    minHeight: 34,
  },

  addPackIdRow: {
    fontSize: 12,
    color: '#9ca3af',
  },

  addExistsHint: {
    color: '#f87171',
    fontSize: 12,
  },

  addSourcesSection: {
    marginTop: 4,
  },

  addSourcesLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 6,
  },

  addSourcesList: {
    maxHeight: 200,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '8px 10px',
    background: '#111',
  },

  addSourceItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    cursor: 'pointer',
    padding: '4px 0',
  },

  addSourceInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },

  addSourceTitle: {
    fontSize: 13,
    color: '#e5e7eb',
    fontWeight: 500,
  },

  addSourceUrl: {
    fontSize: 11,
    color: '#6b7280',
    wordBreak: 'break-all',
  },

  addSourceUrlText: {
    fontFamily: 'monospace',
  },

  addSourceWhy: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },

  addManualRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },

  addManualInputRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },

  addError: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 10px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
  },

  addFieldError: {
    color: '#f87171',
    fontSize: 12,
  },

  searchingBox: {
    color: '#9ca3af',
    fontSize: 13,
    padding: '16px 0',
    fontStyle: 'italic',
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
