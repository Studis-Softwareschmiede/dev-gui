/**
 * NightWatchSettings.jsx — Abschnitt „Nachtwächter" (taktgeber-nachtwaechter AC17).
 *
 * Eigenständige, additive Komponente — SettingsView.jsx bindet sie nur mit einer
 * Zeile ein (kein Umbau bestehender Sektionen). Reduziert Merge-Konflikt-Risiko
 * mit parallelen Änderungen an SettingsView.jsx (Hot-Spot, siehe reconcile-trigger).
 *
 * AC17 — Schalter `enabled` + Felder für Fenster (`window.start/end/timezone`),
 *   `intervalMinutes`, `maxParallel` (Select 1–3), `staleInProgressHours`,
 *   `escalationAttempts`, `projects` ("all" | Auswahl). Liest via
 *   GET /api/settings/ticker, schreibt via PUT /api/settings/ticker (S-194, bereits live).
 *   Backend-Validierung (TickerSettingsStore.validate) bleibt maßgeblich — hier nur eine
 *   leichte Client-Vorabprüfung für window.start/end (24h "HH:MM"), keine Duplizierung
 *   der vollständigen Validierungslogik (z.B. IANA-Zeitzonen-Prüfung, Slug-Existenz).
 *   4xx-Antworten (`{ field, message }`) werden feldzugeordnet angezeigt (aria-describedby).
 *
 * `projects`-Auswahl: nutzt (best-effort) GET /api/workspace/repos (bereits live,
 * workspace-repos AC1) zur Anzeige bekannter Projekt-Slugs als Checkboxen. Schlägt der
 * Abruf fehl, bleibt der Auswahl-Modus nutzbar (Backend validiert Slugs ohnehin serverseitig),
 * es wird lediglich kein Vorschlag angezeigt (graceful degradation).
 *
 * Security (Floor): keine Secrets — Ticker-Settings sind reine Nachtfenster-/
 *   Parallelitäts-/Projekt-Konfiguration (kein Credential-Pfad).
 *
 * A11y: label/htmlFor, role=status/alert, aria-describedby, aria-busy,
 *   Touch-Target ≥ 44 px (Muster NotificationSection in SettingsView.jsx).
 *
 * retro-auto-trigger AC3 — zusätzlich (bei denselben Nachtwächter-Einstellungen) ein
 *   eigenständiger Schalter „Danach automatisch Retro durchführen" (an/aus), der
 *   GET /api/settings/retro-auto liest (Initialzustand) und bei Änderung sofort per
 *   PUT /api/settings/retro-auto schreibt (unabhängig vom Ticker-„Einstellungen speichern"-
 *   Knopf). Status textlich (an/aus); kurzer Hilfetext zum Wochen-Cooldown-Bypass. Der
 *   bestehende Nachtwächter-`enabled`-Schalter bleibt unverändert.
 *
 * @param {{ fetchFn?: typeof fetch }} props
 */

import { useState, useEffect, useCallback } from 'react';

/** 24h-Zeitformat "HH:MM" (Client-Vorabprüfung, sync mit TickerSettingsStore.TIME_RE). */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function fetchTickerSettings(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/ticker');
  if (!res.ok) throw new Error(`Nachtwächter-Einstellungen laden fehlgeschlagen (${res.status})`);
  return res.json();
}

async function putTickerSettings(settings, fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/ticker', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.message ?? `Speichern fehlgeschlagen (${res.status})`), { field: data.field });
  }
  return data;
}

/**
 * Liest den globalen Auto-Retro-Schalter (retro-auto-trigger AC3, GET /api/settings/retro-auto).
 *
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ enabled: boolean }>}
 */
async function fetchRetroAutoSettings(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/retro-auto');
  if (!res.ok) throw new Error(`Auto-Retro-Einstellung laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * Schreibt den globalen Auto-Retro-Schalter (retro-auto-trigger AC3, PUT /api/settings/retro-auto).
 *
 * @param {boolean} enabled
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ enabled: boolean }>}
 */
async function putRetroAutoSettings(enabled, fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fn('/api/settings/retro-auto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message ?? `Speichern fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Best-effort Ladung bekannter Projekt-Slugs (Muster `workspace-repos AC1`).
 * Gibt bei Fehler ein leeres Array zurück — der Aufrufer degradiert graceful
 * (Auswahl-Checkboxen bleiben leer, Speichern funktioniert weiterhin).
 *
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string[]>}
 */
async function fetchProjectSlugs(fetchFn) {
  const fn = fetchFn ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await fn('/api/workspace/repos');
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.repos ?? []);
    return list.map((r) => r?.name).filter((n) => typeof n === 'string');
  } catch {
    return []; // graceful degradation — Netzwerkfehler blockiert das Speichern im "all"-Modus nie
  }
}

export function NightWatchSettings({ fetchFn }) {
  const [enabled, setEnabled] = useState(false);
  const [windowStart, setWindowStart] = useState('23:00');
  const [windowEnd, setWindowEnd] = useState('07:00');
  const [timezone, setTimezone] = useState('Europe/Zurich');
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [maxParallel, setMaxParallel] = useState(3);
  const [staleInProgressHours, setStaleInProgressHours] = useState(4);
  const [escalationAttempts, setEscalationAttempts] = useState(3);
  const [projectsMode, setProjectsMode] = useState('all'); // 'all' | 'selection'
  const [selectedProjects, setSelectedProjects] = useState([]);
  const [availableProjects, setAvailableProjects] = useState([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveFieldError, setSaveFieldError] = useState(null); // { field, message }
  const [saved, setSaved] = useState(false);

  // Auto-Retro-Schalter (retro-auto-trigger AC3) — eigenständig, schreibt sofort bei Änderung.
  const [retroAutoEnabled, setRetroAutoEnabled] = useState(false);
  const [retroAutoSaving, setRetroAutoSaving] = useState(false);
  const [retroAutoError, setRetroAutoError] = useState(null);
  const [retroAutoSaved, setRetroAutoSaved] = useState(false);

  const SAVE_ERROR_ID = 'nightwatch-save-error';
  const RETRO_AUTO_HELP_ID = 'retro-auto-help';

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchTickerSettings(fetchFn);
      setEnabled(Boolean(data.enabled));
      setWindowStart(data.window?.start ?? '23:00');
      setWindowEnd(data.window?.end ?? '07:00');
      setTimezone(data.window?.timezone ?? 'Europe/Zurich');
      setIntervalMinutes(Number.isInteger(data.intervalMinutes) ? data.intervalMinutes : 15);
      setMaxParallel(Number.isInteger(data.maxParallel) ? data.maxParallel : 3);
      setStaleInProgressHours(Number.isInteger(data.staleInProgressHours) ? data.staleInProgressHours : 4);
      setEscalationAttempts(Number.isInteger(data.escalationAttempts) ? data.escalationAttempts : 3);
      if (Array.isArray(data.projects)) {
        setProjectsMode('selection');
        setSelectedProjects(data.projects);
      } else {
        setProjectsMode('all');
        setSelectedProjects([]);
      }
    } catch (err) {
      setLoadError(err.message ?? 'Laden fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  const loadProjectSlugs = useCallback(async () => {
    const slugs = await fetchProjectSlugs(fetchFn);
    setAvailableProjects(slugs);
  }, [fetchFn]);

  // Auto-Retro-Schalter (AC3) — best-effort laden; Fehler blockiert die Nachtwächter-Sektion nicht.
  const loadRetroAuto = useCallback(async () => {
    setRetroAutoError(null);
    try {
      const data = await fetchRetroAutoSettings(fetchFn);
      setRetroAutoEnabled(Boolean(data.enabled));
    } catch (err) {
      setRetroAutoError(err.message ?? 'Auto-Retro-Einstellung konnte nicht geladen werden');
    }
  }, [fetchFn]);

  useEffect(() => {
    loadSettings();
    loadProjectSlugs();
    loadRetroAuto();
  }, [loadSettings, loadProjectSlugs, loadRetroAuto]);

  // Sofort-Schreiben bei Änderung (unabhängig vom Ticker-Speichern-Knopf); Revert bei Fehler.
  const handleRetroAutoChange = useCallback(async (next) => {
    const previous = retroAutoEnabled;
    setRetroAutoEnabled(next);
    setRetroAutoError(null);
    setRetroAutoSaved(false);
    setRetroAutoSaving(true);
    try {
      const data = await putRetroAutoSettings(next, fetchFn);
      setRetroAutoEnabled(Boolean(data.enabled));
      setRetroAutoSaved(true);
    } catch (err) {
      setRetroAutoEnabled(previous); // Revert — Persistenz fehlgeschlagen
      setRetroAutoError(err.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setRetroAutoSaving(false);
    }
  }, [retroAutoEnabled, fetchFn]);

  const handleProjectToggle = useCallback((slug, checked) => {
    setSelectedProjects((prev) =>
      checked ? (prev.includes(slug) ? prev : [...prev, slug]) : prev.filter((s) => s !== slug),
    );
  }, []);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    setSaveFieldError(null);
    setSaved(false);

    // Leichte Client-Vorabprüfung (keine Duplizierung der vollständigen Backend-Validierung).
    if (!TIME_RE.test(windowStart)) {
      setSaveFieldError({ field: 'window.start', message: 'window.start muss im 24h-Format "HH:MM" sein.' });
      return;
    }
    if (!TIME_RE.test(windowEnd)) {
      setSaveFieldError({ field: 'window.end', message: 'window.end muss im 24h-Format "HH:MM" sein.' });
      return;
    }

    setSaving(true);
    try {
      await putTickerSettings({
        enabled,
        window: { start: windowStart, end: windowEnd, timezone: timezone.trim() },
        intervalMinutes: Number(intervalMinutes),
        maxParallel: Number(maxParallel),
        staleInProgressHours: Number(staleInProgressHours),
        escalationAttempts: Number(escalationAttempts),
        projects: projectsMode === 'all' ? 'all' : selectedProjects,
      }, fetchFn);
      setSaved(true);
    } catch (err) {
      if (err.field) {
        setSaveFieldError({ field: err.field, message: err.message });
      } else {
        setSaveError(err.message ?? 'Speichern fehlgeschlagen');
      }
    } finally {
      setSaving(false);
    }
  }, [enabled, windowStart, windowEnd, timezone, intervalMinutes, maxParallel, staleInProgressHours, escalationAttempts, projectsMode, selectedProjects, fetchFn]);

  if (loading) {
    return <p style={styles.hint} aria-busy="true">Einstellungen werden geladen…</p>;
  }

  if (loadError) {
    return (
      <p style={styles.errorBox} role="alert">
        Einstellungen konnten nicht geladen werden: {loadError}
      </p>
    );
  }

  return (
    <div>
      {/* enabled */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-enabled" style={styles.label}>Nachtwächter:</label>
        <select
          id="nightwatch-enabled"
          value={enabled ? 'true' : 'false'}
          onChange={(e) => { setEnabled(e.target.value === 'true'); setSaved(false); }}
          style={styles.select}
        >
          <option value="false">Deaktiviert</option>
          <option value="true">Aktiviert</option>
        </select>
      </div>

      {/* window.start */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-window-start" style={styles.label}>Fenster-Start:</label>
        <input
          id="nightwatch-window-start"
          type="text"
          value={windowStart}
          onChange={(e) => { setWindowStart(e.target.value); setSaved(false); }}
          placeholder="23:00"
          style={styles.input}
          autoComplete="off"
          aria-describedby={saveFieldError?.field === 'window.start' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'window.start' ? 'true' : undefined}
        />
      </div>

      {/* window.end */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-window-end" style={styles.label}>Fenster-Ende:</label>
        <input
          id="nightwatch-window-end"
          type="text"
          value={windowEnd}
          onChange={(e) => { setWindowEnd(e.target.value); setSaved(false); }}
          placeholder="07:00"
          style={styles.input}
          autoComplete="off"
          aria-describedby={saveFieldError?.field === 'window.end' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'window.end' ? 'true' : undefined}
        />
      </div>

      {/* window.timezone */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-timezone" style={styles.label}>Zeitzone:</label>
        <input
          id="nightwatch-timezone"
          type="text"
          value={timezone}
          onChange={(e) => { setTimezone(e.target.value); setSaved(false); }}
          placeholder="Europe/Zurich"
          style={styles.input}
          autoComplete="off"
          aria-describedby={saveFieldError?.field === 'window.timezone' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'window.timezone' ? 'true' : undefined}
        />
      </div>

      {/* intervalMinutes */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-interval" style={styles.label}>Polling-Intervall (Min.):</label>
        <input
          id="nightwatch-interval"
          type="number"
          min={1}
          value={intervalMinutes}
          onChange={(e) => { setIntervalMinutes(e.target.value); setSaved(false); }}
          style={{ ...styles.input, width: 90 }}
          aria-describedby={saveFieldError?.field === 'intervalMinutes' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'intervalMinutes' ? 'true' : undefined}
        />
      </div>

      {/* maxParallel — Select 1..3 (Story-Vorgabe) */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-max-parallel" style={styles.label}>Max. parallele Projekte:</label>
        <select
          id="nightwatch-max-parallel"
          value={String(maxParallel)}
          onChange={(e) => { setMaxParallel(Number(e.target.value)); setSaved(false); }}
          style={styles.select}
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>

      {/* staleInProgressHours */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-stale-hours" style={styles.label}>Verwaist ab (Std.):</label>
        <input
          id="nightwatch-stale-hours"
          type="number"
          min={1}
          value={staleInProgressHours}
          onChange={(e) => { setStaleInProgressHours(e.target.value); setSaved(false); }}
          style={{ ...styles.input, width: 90 }}
          aria-describedby={saveFieldError?.field === 'staleInProgressHours' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'staleInProgressHours' ? 'true' : undefined}
        />
      </div>

      {/* escalationAttempts */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-escalation" style={styles.label}>Eskalation nach (Läufen):</label>
        <input
          id="nightwatch-escalation"
          type="number"
          min={1}
          value={escalationAttempts}
          onChange={(e) => { setEscalationAttempts(e.target.value); setSaved(false); }}
          style={{ ...styles.input, width: 90 }}
          aria-describedby={saveFieldError?.field === 'escalationAttempts' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'escalationAttempts' ? 'true' : undefined}
        />
      </div>

      {/* projects: "all" | Auswahl */}
      <div style={styles.fieldRow}>
        <label htmlFor="nightwatch-projects-mode" style={styles.label}>Projekte:</label>
        <select
          id="nightwatch-projects-mode"
          value={projectsMode}
          onChange={(e) => { setProjectsMode(e.target.value); setSaved(false); }}
          style={styles.select}
          aria-describedby={saveFieldError?.field === 'projects' ? SAVE_ERROR_ID : undefined}
          aria-invalid={saveFieldError?.field === 'projects' ? 'true' : undefined}
        >
          <option value="all">Alle Projekte</option>
          <option value="selection">Auswahl</option>
        </select>
      </div>

      {projectsMode === 'selection' && (
        <fieldset style={styles.fieldset}>
          <legend style={styles.legend}>Projekt-Auswahl</legend>
          {availableProjects.length === 0 ? (
            <p style={styles.hint}>Keine Projektliste verfügbar — bereits ausgewählte Slugs bleiben erhalten.</p>
          ) : (
            availableProjects.map((slug) => (
              <div key={slug} style={styles.checkboxRow}>
                <label htmlFor={`nightwatch-project-${slug}`} style={styles.checkboxLabel}>
                  <input
                    id={`nightwatch-project-${slug}`}
                    type="checkbox"
                    checked={selectedProjects.includes(slug)}
                    onChange={(e) => { handleProjectToggle(slug, e.target.checked); setSaved(false); }}
                    style={styles.checkbox}
                  />
                  {' '}{slug}
                </label>
              </div>
            ))
          )}
        </fieldset>
      )}

      {/* Speichern-Fehler (feldzugeordnet oder allgemein) */}
      {(saveFieldError || saveError) && (
        <p id={SAVE_ERROR_ID} role="alert" style={styles.errorBox}>
          {saveFieldError ? `${saveFieldError.field}: ${saveFieldError.message}` : saveError}
        </p>
      )}

      {/* Erfolgs-Feedback */}
      {saved && !saveFieldError && !saveError && (
        <p role="status" style={styles.successMsg}>
          Einstellungen gespeichert.
        </p>
      )}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
          style={styles.btnPrimary}
        >
          {saving ? 'Wird gespeichert…' : 'Einstellungen speichern'}
        </button>
      </div>

      {/* Auto-Retro-Schalter (retro-auto-trigger AC3) — eigenständig, schreibt sofort. */}
      <div style={styles.retroAutoSection}>
        <div style={styles.fieldRow}>
          <label htmlFor="retro-auto-enabled" style={styles.label}>Danach automatisch Retro durchführen:</label>
          <select
            id="retro-auto-enabled"
            value={retroAutoEnabled ? 'true' : 'false'}
            onChange={(e) => handleRetroAutoChange(e.target.value === 'true')}
            disabled={retroAutoSaving}
            aria-busy={retroAutoSaving}
            aria-describedby={RETRO_AUTO_HELP_ID}
            style={styles.select}
          >
            <option value="false">Aus</option>
            <option value="true">An</option>
          </select>
          <span style={styles.retroAutoStatus} data-testid="retro-auto-status">
            {retroAutoSaving ? 'Wird gespeichert…' : (retroAutoEnabled ? 'An' : 'Aus')}
          </span>
        </div>
        <p id={RETRO_AUTO_HELP_ID} style={styles.hint}>
          Ist der Schalter <strong>an</strong>, läuft nach jedem abgeschlossenen Board-Lauf (Nachtwächter oder
          manuelles „Board abarbeiten") ggf. automatisch ein Retro — der Wochen-Cooldown wird dabei umgangen.
          Ist er <strong>aus</strong>, bleibt es beim manuellen „Retro starten"-Klick (Cooldown aktiv).
          Änderungen werden sofort gespeichert.
        </p>
        {retroAutoError && (
          <p role="alert" style={styles.errorBox}>
            Auto-Retro-Einstellung: {retroAutoError}
          </p>
        )}
        {retroAutoSaved && !retroAutoError && (
          <p role="status" style={styles.successMsg}>
            Auto-Retro-Einstellung gespeichert.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Styles (Muster NotificationSection, SettingsView.jsx) ───────────────────────

const styles = {
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  label: {
    color: '#9ca3af',
    fontSize: 13,
    minWidth: 180,
  },
  input: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '4px 8px',
    minHeight: 32,
    flex: 1,
    minWidth: 120,
    outline: 'none',
    fontFamily: 'monospace',
  },
  select: {
    background: '#1e293b',
    border: '1px solid #374151',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    padding: '4px 8px',
    minHeight: 32,
    outline: 'none',
  },
  fieldset: {
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
    marginTop: 4,
  },
  legend: {
    color: '#9ca3af',
    fontSize: 13,
    padding: '0 4px',
  },
  checkboxRow: {
    marginBottom: 6,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#e5e7eb',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1.4,
    minHeight: 32,
  },
  checkbox: {
    minWidth: 16,
    minHeight: 16,
    cursor: 'pointer',
  },
  hint: {
    color: '#9ca3af',
    fontSize: 13,
    margin: '8px 0',
  },
  errorBox: {
    padding: '8px 12px',
    marginBottom: 8,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 13,
  },
  successMsg: {
    color: '#86efac',
    fontSize: 13,
    margin: '8px 0',
  },
  btnPrimary: {
    background: '#166534',
    border: 'none',
    borderRadius: 4,
    color: '#bbf7d0',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    padding: '8px 16px',
  },
  retroAutoSection: {
    marginTop: 20,
    paddingTop: 16,
    borderTop: '1px solid #2a2a2a',
  },
  retroAutoStatus: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: 600,
  },
};
