/**
 * VpsView.jsx — VPS-Ansicht mit Machine-Listing und Create-from-scratch-Formular.
 *
 * Implements: view-vps AC3–AC10 (Maschinen-Übersicht + Lifecycle-UI)
 *   AC3  — GET /api/vps/machines; liste Provider, Name, Status, IPv4; Leer-Zustand.
 *   AC4  — Provider ohne Token → „nicht konfiguriert"-Hinweis; kein Lifecycle-Aufruf.
 *   AC5  — providerErrors → degradierende Anzeige; gestörter Provider markiert.
 *   AC6  — Start/Stop pro Maschine; Capability-Flag disabled; 403 klar gemeldet.
 *   AC7  — Create-Formular: Provider/Name/Region/Servertyp/Image + SSH-Key-Zuordnung.
 *   AC8  — Create gesperrt wenn root/alex kein gesetzter Public-Key zuordenbar.
 *   AC9  — Lade-/Erfolg-/Fehlerzustände für Mutationen; kein Token im Frontend.
 *   AC10 — 403 → „keine Berechtigung"-Meldung; kein UI-Crash.
 *
 * Implements: vps-ssh-key-assignment AC1/AC2 (UI-Auswahl)
 *   AC1 — Create-Formular bietet je Rolle (root, alex) eine Auswahl der SSH-Labels
 *          mit gesetztem Public-Key; Labels ohne Public-Key werden nicht angeboten.
 *   AC2 — Default-Vorbelegung: gleichnamiges Label → Rolle (Label "root" → root,
 *          Label "alex" → alex); übersteuerbar. Distinkte Keys möglich.
 *   AC5 — UI sperrt Create-Button wenn kein Label mit Public-Key vorhanden ist
 *          oder eine Rolle kein Label zugeordnet hat.
 *
 * Implements: vps-create-options AC6–AC12, AC18–AC20 (Server-Typ/Region/Image-Dropdowns mit Kosten + availability-Filter)
 *   AC6  — Bei Provider hetzner: Region + Server-Typ als Dropdowns aus Live-Listen.
 *   AC7  — Server-Typ-Dropdown zeigt Specs + Kosten; Preis folgt gewählter Region.
 *   AC8  — Fehlende Preise → „Preis unbekannt"; deprecated Typen nicht wählbar.
 *   AC9  — Graceful Degradation: Fehler/optionsAvailable:false → Freitext-Fallback.
 *   AC10 — Kein Hetzner-Token im Frontend-Bundle/Log; Create-Payload unverändert.
 *   AC11 — Bei Provider hetzner: Image-Feld als Dropdown aus System-Images; Default Ubuntu 26.04
 *          (falls vorhanden, sonst LTS-Fallback ubuntu-24.04). Auswahl setzt image=name.
 *   AC12 — Fehler/keine Quelle → Image-Feld bleibt Freitext mit Default-Hinweis Ubuntu 26.04.
 *   AC18 — Bei gewählter Region + vorhandenem availability[region]: Server-Typ-Dropdown zeigt
 *           nur bereitstellbare Typen (Region steuert die Typen-Liste, kein beidseitiges Filtern).
 *   AC19 — Bei Region-Wechsel: serverType zurücksetzen wenn Typ in neuer Region nicht verfügbar;
 *           Wahl bleibt erhalten wenn der Typ verfügbar bleibt.
 *   AC20 — Graceful Fallback: fehlt availability ganz oder fehlt Eintrag für die Region →
 *           ungefiltert rendern (heutiges AC6/AC8-Verhalten, alle nicht-deprecated Typen).
 *
 * Implements: vps-container-overview AC1–AC7 (Container-Übersicht)
 *   AC1 — Container-Button je VPS-Zeile; Klick öffnet Übersicht + Listing-Fetch.
 *   AC2 — Listet je Container: Name, Status, Image, Port; managed vs. unmanaged.
 *   AC3 — Leer-Zustand; SSH-Fehler degradiert nur diese Übersicht.
 *   AC4 — Start/Stop/Neustart/Logs/Entfernen-Buttons; nach Erfolg Re-Fetch; 403 → Hinweis.
 *   AC5 — Logs lesen: render Log-Zeilen; kein SSH-Key/Token im Frontend.
 *   AC6 — Managed-Remove: type-to-confirm (Hostname); voller Undeploy.
 *   AC7 — Unmanaged-Remove: type-to-confirm (ContainerId); nur docker rm.
 *
 * Security (Floor):
 *   - Nur Label-Referenzen werden an das Backend gesendet (sshKeyAssignment),
 *     niemals rohe Key-Material-Strings vom Client.
 *   - Public-Keys dürfen angezeigt werden (nicht geheim).
 *   - 403-Antworten werden als „keine Berechtigung" dargestellt; kein Token-Leak.
 *   - SSH-Private-Key, Cloudflare-Token und Hetzner-Token erscheinen NICHT im Frontend-Bundle.
 *   - Provider-Options-Endpunkt liefert nur abgeleitete Listen/Preise (kein Token an Client).
 *
 * A11y: WCAG 2.1 AA — Beschriftete select/input-Elemente, aria-required,
 *   aria-describedby für Fehlermeldungen, role=alert/status, Touch-Target ≥ 44 px,
 *   sichtbarer Fokus, managed/unmanaged für Screenreader erkennbar.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ── API-Helfer ────────────────────────────────────────────────────────────────

/** Lädt alle SSH-Benutzer mit Public-Key aus GET /api/settings/ssh-keys. */
async function fetchSshKeyLabels() {
  const res = await fetch('/api/settings/ssh-keys');
  if (!res.ok) throw new Error(`SSH-Keys laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/** Lädt alle VPS-Maschinen aus GET /api/vps/machines. */
async function fetchVpsMachines() {
  const res = await fetch('/api/vps/machines');
  if (!res.ok) throw new Error(`VPS-Maschinen laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/** Lädt alle konfigurierten Provider aus GET /api/vps/providers. */
async function fetchVpsProviders() {
  const res = await fetch('/api/vps/providers');
  if (!res.ok) throw new Error(`Provider laden fehlgeschlagen (${res.status})`);
  return res.json();
}

/**
 * Sendet eine Start/Stop-Aktion an POST /api/vps/machines/:provider/:serverId/start|stop.
 * Gibt { result, reason? } zurück; wirft bei HTTP-Fehler.
 *
 * @param {{ provider: string, serverId: string, action: 'start'|'stop' }} params
 */
async function postPowerAction({ provider, serverId, action }) {
  // ServerId kann Slashes enthalten (IONOS composite IDs) — direkt als Pfadsegmente
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/${action}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung für diese Aktion');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `${action} fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Sendet eine Delete-Aktion an DELETE /api/vps/machines/:provider/:serverId.
 * Gibt { result, reason?, cleanupError? } zurück; wirft bei HTTP-Fehler.
 *
 * @param {{ provider: string, serverId: string, vpsName: string }} params
 */
async function deleteVps({ provider, serverId, vpsName }) {
  // ServerId kann Slashes enthalten (IONOS composite IDs) — direkt als Pfadsegmente
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vpsName }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung für diese Aktion');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `Löschen fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Lädt die Container-Übersicht eines VPS.
 * GET /api/vps/machines/:provider/:serverId/containers
 *
 * @param {{ provider: string, serverId: string }} params
 * @returns {Promise<{ result: string, containers?: Array, errorClass?: string, reason?: string }>}
 */
async function fetchContainers({ provider, serverId }) {
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `Listing fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Führt eine Container-Aktion aus (start/stop/restart).
 * POST /api/vps/machines/:provider/:serverId/containers/:containerId/:action
 *
 * @param {{ provider: string, serverId: string, containerId: string, action: 'start'|'stop'|'restart' }} params
 * @returns {Promise<{ result: string, reason?: string }>}
 */
async function postContainerAction({ provider, serverId, containerId, action }) {
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}/${action}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung für diese Aktion');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `${action} fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Lädt die letzten N Zeilen Container-Logs.
 * GET /api/vps/machines/:provider/:serverId/containers/:containerId/logs?tail=N
 *
 * @param {{ provider: string, serverId: string, containerId: string, tail?: number }} params
 * @returns {Promise<{ result: string, lines?: string[] }>}
 */
async function fetchContainerLogs({ provider, serverId, containerId, tail = 100 }) {
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `Logs-Abruf fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Entfernt einen Container (managed → vollständiger Undeploy; unmanaged → docker rm).
 * DELETE /api/vps/machines/:provider/:serverId/containers/:containerId
 * Body: { confirm: "<hostname-oder-containerId>" }
 *
 * @param {{ provider: string, serverId: string, containerId: string, confirm: string }} params
 * @returns {Promise<{ result: string, reason?: string }>}
 */
async function deleteContainer({ provider, serverId, containerId, confirm }) {
  const url = `/api/vps/machines/${encodeURIComponent(provider)}/${serverId}/containers/${encodeURIComponent(containerId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const err = new Error(data.error ?? 'Keine Berechtigung für diese Aktion');
    err.is403 = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.reason ?? data.error ?? `Entfernen fehlgeschlagen (${res.status})`);
  }
  return data;
}

/**
 * Lädt die verfügbaren Create-Optionen (Server-Typen, Locations, Images) für einen Provider.
 * GET /api/vps/providers/:provider/options
 *
 * Liefert { optionsAvailable: true, serverTypes, locations, images } für Hetzner,
 * oder { optionsAvailable: false } bei Fehler / nicht-Hetzner / nicht konfiguriert.
 * Kein Hetzner-Token im Response (AC10) — nur abgeleitete Listen.
 *
 * @param {string} provider
 * @returns {Promise<{ optionsAvailable: boolean, serverTypes?: Array, locations?: Array, images?: Array }>}
 */
async function fetchProviderOptions(provider) {
  const res = await fetch(`/api/vps/providers/${encodeURIComponent(provider)}/options`);
  if (!res.ok) return { optionsAvailable: false };
  return res.json();
}

/**
 * Sendet einen Create-Request an POST /api/vps/machines/:provider.
 * Body enthält NUR fachliche Parameter + Label-Referenzen (keine rohen Keys).
 */
async function postCreateMachine({ provider, name, region, serverType, image, sshKeyAssignment }) {
  const body = { name, region, serverType };
  if (image) body.image = image;
  if (sshKeyAssignment) body.sshKeyAssignment = sshKeyAssignment;

  const res = await fetch(`/api/vps/machines/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? data.reason ?? `Create fehlgeschlagen (${res.status})`), { errorClass: data.errorClass });
  return data;
}

// ── ContainerRemoveConfirm ────────────────────────────────────────────────────

/**
 * type-to-confirm-Dialog für das Entfernen eines Containers (AC6/AC7).
 *
 * Managed: Hostname eintippen → voller Undeploy.
 * Unmanaged: ContainerId eintippen → nur docker rm.
 *
 * A11y: WCAG 2.1 AA — beschriftetes Feld mit aria-describedby für Fehler/Hinweis,
 *   role=alert für Warnung, Touch-Target ≥ 44 px.
 *
 * @param {{
 *   container: { containerId: string, hostname: string|null, managed: boolean },
 *   onConfirm: (confirm: string) => Promise<void>,
 *   onCancel: () => void,
 *   pending: boolean,
 * }} props
 */
function ContainerRemoveConfirm({ container, onConfirm, onCancel, pending }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  // Managed: Hostname eintippen; Unmanaged: ContainerId eintippen
  const expectedValue = container.managed ? (container.hostname ?? container.containerId) : container.containerId;
  const matches = input === expectedValue;

  const CONFIRM_INPUT_ID = `ctr-remove-confirm-${container.containerId}`.replace(/[^a-zA-Z0-9-]/g, '-');
  const CONFIRM_HINT_ID = `${CONFIRM_INPUT_ID}-hint`;

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!matches) return;
    await onConfirm(input);
  }, [matches, input, onConfirm]);

  return (
    <form
      onSubmit={handleSubmit}
      style={containerStyles.removeForm}
      aria-label={`Container ${container.containerId} entfernen bestätigen`}
    >
      <p style={containerStyles.removeWarning} role="alert">
        {container.managed
          ? <>Achtung: Managed-Container-Entfernen löscht Container <strong>und</strong> Cloudflare-Route unwiderruflich.</>
          : <>Achtung: Dieser Container wird unwiderruflich entfernt.</>
        }
      </p>
      <label htmlFor={CONFIRM_INPUT_ID} style={containerStyles.removeLabel}>
        {container.managed
          ? `Hostname zur Bestätigung eintippen: ${expectedValue}`
          : `Container-ID zur Bestätigung eintippen: ${expectedValue}`
        }
      </label>
      <input
        id={CONFIRM_INPUT_ID}
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={expectedValue}
        style={containerStyles.removeInput}
        aria-required="true"
        aria-describedby={CONFIRM_HINT_ID}
        autoComplete="off"
        disabled={pending}
      />
      <p id={CONFIRM_HINT_ID} style={containerStyles.removeHint}>
        {matches ? 'Wert stimmt überein.' : `Bitte genau "${expectedValue}" eintippen.`}
      </p>
      <div style={containerStyles.removeActions}>
        <button
          type="submit"
          style={(!matches || pending)
            ? { ...containerStyles.btnRemove, opacity: 0.5, cursor: 'not-allowed' }
            : containerStyles.btnRemove}
          disabled={!matches || pending}
          aria-busy={pending}
          aria-disabled={!matches}
          aria-label={`Container ${container.containerId} endgültig entfernen`}
        >
          {pending ? 'Entfernen…' : 'Endgültig entfernen'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          style={containerStyles.btnCancelRemove}
          aria-label="Entfernen abbrechen"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

// ── ContainerRow ──────────────────────────────────────────────────────────────

/**
 * Eine einzelne Container-Zeile mit Aktions-Buttons (AC4–AC7).
 *
 * A11y: WCAG 2.1 AA — Buttons mit aria-label, managed/unmanaged per aria-label,
 *   Lade-/Erfolg-/Fehlerzustände als role=status/alert, Touch-Target ≥ 44 px.
 *
 * @param {{
 *   container: { containerId: string, name: string, image: string, hostname: string|null,
 *                status: string, hostPort: number|null, managed: boolean },
 *   provider: string,
 *   serverId: string,
 *   onAction: (provider: string, serverId: string, containerId: string, action: string) => Promise<void>,
 *   onLogs: (container: object) => void,
 *   onRemove: (container: object) => void,
 * }} props
 */
function ContainerRow({ container: c, provider, serverId, onAction, onLogs, onRemove }) {
  const [actionState, setActionState] = useState(null); // null | 'pending' | 'ok' | 'error' | 'forbidden'
  const [actionMsg, setActionMsg] = useState(null);

  const isPending = actionState === 'pending';

  const handleAction = useCallback(async (action) => {
    setActionState('pending');
    setActionMsg(null);
    try {
      await onAction(provider, serverId, c.containerId, action);
      setActionState('ok');
      setActionMsg(null);
    } catch (err) {
      if (err.is403) {
        setActionState('forbidden');
        setActionMsg('Keine Berechtigung für diese Aktion');
      } else {
        setActionState('error');
        setActionMsg(err.message ?? 'Aktion fehlgeschlagen');
      }
    }
  }, [provider, serverId, c.containerId, onAction]);

  const ACTION_MSG_ID = `ctr-action-${c.containerId}`.replace(/[^a-zA-Z0-9-]/g, '-');

  return (
    <li style={containerStyles.containerItem}>
      <div style={containerStyles.containerInfo}>
        {/* managed/unmanaged Badge — AC2, A11y */}
        <span
          style={c.managed ? containerStyles.managedBadge : containerStyles.unmanagedBadge}
          aria-label={c.managed ? `Managed (Hostname: ${c.hostname})` : 'Unmanaged'}
          title={c.managed ? `Managed: ${c.hostname}` : 'Unmanaged (kein cloudflare.tunnel-hostname-Label)'}
        >
          {c.managed ? 'M' : 'U'}
        </span>
        <div style={containerStyles.containerMeta}>
          <span style={containerStyles.containerName}>{c.name}</span>
          {c.managed && c.hostname && (
            <span style={containerStyles.containerHostname}>{c.hostname}</span>
          )}
          <span style={containerStyles.containerImage}>{c.image}</span>
          <span style={containerStyles.containerStatus}>{c.status}</span>
          {c.hostPort !== null && (
            <span style={containerStyles.containerPort}>:{c.hostPort}</span>
          )}
        </div>
      </div>

      {/* Aktions-Buttons (AC4) */}
      <div style={containerStyles.containerActions}>
        <button
          type="button"
          style={isPending ? { ...containerStyles.actionSmall, opacity: 0.45, cursor: 'not-allowed' } : containerStyles.actionSmall}
          disabled={isPending}
          aria-label={`Container ${c.name} starten`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          aria-busy={isPending}
          onClick={() => handleAction('start')}
        >
          {isPending ? '…' : 'Start'}
        </button>
        <button
          type="button"
          style={isPending
            ? { ...containerStyles.actionSmall, ...containerStyles.actionStop, opacity: 0.45, cursor: 'not-allowed' }
            : { ...containerStyles.actionSmall, ...containerStyles.actionStop }}
          disabled={isPending}
          aria-label={`Container ${c.name} stoppen`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          aria-busy={isPending}
          onClick={() => handleAction('stop')}
        >
          Stop
        </button>
        <button
          type="button"
          style={isPending
            ? { ...containerStyles.actionSmall, ...containerStyles.actionRestart, opacity: 0.45, cursor: 'not-allowed' }
            : { ...containerStyles.actionSmall, ...containerStyles.actionRestart }}
          disabled={isPending}
          aria-label={`Container ${c.name} neu starten`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          aria-busy={isPending}
          onClick={() => handleAction('restart')}
        >
          Neustart
        </button>
        <button
          type="button"
          style={containerStyles.actionSmall}
          disabled={isPending}
          aria-label={`Logs von Container ${c.name} anzeigen`}
          onClick={() => onLogs(c)}
        >
          Logs
        </button>
        <button
          type="button"
          style={isPending
            ? { ...containerStyles.actionSmall, ...containerStyles.actionRemove, opacity: 0.45, cursor: 'not-allowed' }
            : { ...containerStyles.actionSmall, ...containerStyles.actionRemove }}
          disabled={isPending}
          aria-label={`Container ${c.name} entfernen`}
          onClick={() => onRemove(c)}
        >
          Entfernen
        </button>
      </div>

      {/* Aktions-Feedback (AC4) */}
      {actionMsg && (
        <span
          id={ACTION_MSG_ID}
          style={actionState === 'ok' ? containerStyles.feedbackOk
            : actionState === 'forbidden' ? containerStyles.feedbackForbidden
              : containerStyles.feedbackError}
          role={actionState === 'forbidden' || actionState === 'error' ? 'alert' : 'status'}
        >
          {actionMsg}
        </span>
      )}
      {actionState === 'ok' && (
        <span style={containerStyles.feedbackOk} role="status">OK</span>
      )}
    </li>
  );
}

// ── ContainerOverview ─────────────────────────────────────────────────────────

/**
 * Container-Übersicht für einen VPS (AC1–AC7, vps-container-overview).
 *
 * Listet alle laufenden Container (managed + unmanaged) mit Aktionen.
 * Degradiert je VPS — Fehler zeigt Fehlermarkierung ohne die übrige Liste zu zerstören.
 *
 * A11y: WCAG 2.1 AA — role=status für Lade-/Leer-Zustand, role=alert für Fehler.
 *
 * @param {{
 *   provider: string,
 *   serverId: string,
 *   machineName: string,
 *   onClose: () => void,
 * }} props
 */
function ContainerOverview({ provider, serverId, machineName, onClose }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [logsContainer, setLogsContainer] = useState(null);   // Container für Logs-Panel
  const [logsLines, setLogsLines] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [removeContainer, setRemoveContainer] = useState(null); // Container im Remove-Dialog
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchContainers({ provider, serverId });
      if (data.result === 'error') {
        setLoadError(data.reason ?? data.errorClass ?? 'Listing fehlgeschlagen');
        setContainers([]);
      } else {
        setContainers(data.containers ?? []);
      }
    } catch (err) {
      setLoadError(err.message ?? 'Listing fehlgeschlagen');
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, [provider, serverId]);

  useEffect(() => { load(); }, [load]);

  // AC4: Start/Stop/Neustart → Re-Fetch nach Erfolg
  const handleAction = useCallback(async (prov, srv, containerId, action) => {
    await postContainerAction({ provider: prov, serverId: srv, containerId, action });
    await load();
  }, [load]);

  // AC5: Logs anzeigen
  const handleLogs = useCallback(async (container) => {
    setLogsContainer(container);
    setLogsLines([]);
    setLogsError(null);
    setLogsLoading(true);
    try {
      const data = await fetchContainerLogs({ provider, serverId, containerId: container.containerId });
      if (data.result === 'error') {
        setLogsError(data.reason ?? 'Logs konnten nicht geladen werden');
      } else {
        setLogsLines(data.lines ?? []);
      }
    } catch (err) {
      setLogsError(err.message ?? 'Logs-Abruf fehlgeschlagen');
    } finally {
      setLogsLoading(false);
    }
  }, [provider, serverId]);

  // AC6/AC7: Entfernen mit type-to-confirm
  const handleRemoveRequest = useCallback((container) => {
    setRemoveContainer(container);
    setRemoveError(null);
  }, []);

  const handleRemoveConfirm = useCallback(async (confirm) => {
    if (!removeContainer) return;
    setRemovePending(true);
    setRemoveError(null);
    try {
      const result = await deleteContainer({
        provider,
        serverId,
        containerId: removeContainer.containerId,
        confirm,
      });
      if (result.result === 'ok') {
        setRemoveContainer(null);
        await load();
      } else {
        setRemoveError(result.reason ?? 'Entfernen fehlgeschlagen');
      }
    } catch (err) {
      setRemoveError(err.message ?? 'Entfernen fehlgeschlagen');
    } finally {
      setRemovePending(false);
    }
  }, [removeContainer, provider, serverId, load]);

  const OVERVIEW_ID = `ctr-overview-${provider}-${serverId}`.replace(/[^a-zA-Z0-9-]/g, '-');

  return (
    <div style={containerStyles.panel} aria-label={`Container-Übersicht: ${machineName}`}>
      <div style={containerStyles.panelHeader}>
        <h3 style={containerStyles.panelTitle}>Container: {machineName}</h3>
        <div style={containerStyles.panelHeaderActions}>
          <button
            type="button"
            onClick={load}
            style={containerStyles.btnRefresh}
            aria-label="Container-Übersicht aktualisieren"
            disabled={loading}
          >
            {loading ? '…' : 'Aktualisieren'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={containerStyles.btnClose}
            aria-label={`Container-Übersicht für ${machineName} schließen`}
          >
            Schließen
          </button>
        </div>
      </div>

      {/* Lade-Zustand (AC3) */}
      {loading && (
        <p style={containerStyles.loadingText} role="status" aria-live="polite">
          Lade Container…
        </p>
      )}

      {/* Fehler-Zustand — degradierend (AC3/AC8) */}
      {!loading && loadError && (
        <p style={containerStyles.errorText} role="alert" id={`${OVERVIEW_ID}-error`}>
          Fehler: {loadError}
        </p>
      )}

      {/* Leer-Zustand (AC3) */}
      {!loading && !loadError && containers.length === 0 && (
        <p style={containerStyles.emptyText} role="status">
          Keine Container laufend.
        </p>
      )}

      {/* Container-Liste (AC2) */}
      {!loading && !loadError && containers.length > 0 && (
        <ul style={containerStyles.containerList} aria-label="Laufende Container">
          {containers.map((c) => (
            <ContainerRow
              key={c.containerId}
              container={c}
              provider={provider}
              serverId={serverId}
              onAction={handleAction}
              onLogs={handleLogs}
              onRemove={handleRemoveRequest}
            />
          ))}
        </ul>
      )}

      {/* Logs-Panel (AC5) */}
      {logsContainer && (
        <div style={containerStyles.logsPanel} aria-label={`Logs: ${logsContainer.name}`}>
          <div style={containerStyles.logsPanelHeader}>
            <h4 style={containerStyles.logsPanelTitle}>Logs: {logsContainer.name}</h4>
            <button
              type="button"
              onClick={() => { setLogsContainer(null); setLogsLines([]); setLogsError(null); }}
              style={containerStyles.btnClose}
              aria-label="Logs schließen"
            >
              ✕
            </button>
          </div>
          {logsLoading && <p style={containerStyles.loadingText} role="status">Lade Logs…</p>}
          {logsError && <p style={containerStyles.errorText} role="alert">{logsError}</p>}
          {!logsLoading && !logsError && (
            <pre style={containerStyles.logsPre} aria-label="Log-Ausgabe">
              {logsLines.length > 0 ? logsLines.join('\n') : '(keine Log-Ausgabe)'}
            </pre>
          )}
        </div>
      )}

      {/* Remove-Dialog (AC6/AC7) */}
      {removeContainer && (
        <div style={containerStyles.removeDialogWrapper}>
          {removeError && (
            <p style={containerStyles.errorText} role="alert">{removeError}</p>
          )}
          <ContainerRemoveConfirm
            container={removeContainer}
            onConfirm={handleRemoveConfirm}
            onCancel={() => { setRemoveContainer(null); setRemoveError(null); }}
            pending={removePending}
          />
        </div>
      )}
    </div>
  );
}

// ── Preis-Helfer (vps-create-options AC7/AC8) ─────────────────────────────────

/**
 * Gibt den besten verfügbaren Preis-Eintrag für eine Location zurück.
 * Versucht zuerst die gewählte Region (locationName); fällt auf ersten Eintrag zurück.
 * Gibt { priceEntry, isFallback } zurück oder { priceEntry: null, isFallback: false }.
 *
 * @param {Array<{ location: string, priceMonthly?: object, priceHourly?: object }>} prices
 * @param {string} locationName - aktuell gewählte Region (z.B. "nbg1")
 * @returns {{ priceEntry: object|null, isFallback: boolean }}
 */
function resolvePriceEntry(prices, locationName) {
  if (!Array.isArray(prices) || prices.length === 0) {
    return { priceEntry: null, isFallback: false };
  }
  const exact = prices.find((p) => p.location === locationName);
  if (exact) return { priceEntry: exact, isFallback: false };
  // Kein Preis für diese Region → Fallback auf ersten Eintrag
  return { priceEntry: prices[0], isFallback: true };
}

/**
 * Formatiert einen Preis-Wert (gross bevorzugt, net als Fallback mit Kennzeichnung).
 * Gibt einen lesbaren String oder null zurück.
 *
 * @param {{ gross?: string|number|null, net?: string|number|null }|null|undefined} priceObj
 * @param {'monatlich'|'stündlich'} label
 * @returns {string|null}
 */
function formatPrice(priceObj, label) {
  if (!priceObj) return null;
  const gross = priceObj.gross;
  const net = priceObj.net;
  if (gross != null && gross !== '' && gross !== null) {
    const val = parseFloat(gross);
    return `~${isNaN(val) ? gross : val.toFixed(2)} € ${label} (brutto)`;
  }
  if (net != null && net !== '' && net !== null) {
    const val = parseFloat(net);
    return `~${isNaN(val) ? net : val.toFixed(2)} € ${label} (netto)`;
  }
  return null;
}

/**
 * Baut den Kosten-Text für eine Server-Typ-Option zusammen.
 * Zeigt monatlich + stündlich; brutto bevorzugt; "Preis unbekannt" wenn keine Preisdaten.
 *
 * @param {{ priceMonthly?: object, priceHourly?: object }|null} priceEntry
 * @param {boolean} isFallback
 * @returns {string}
 */
function buildCostText(priceEntry, isFallback) {
  if (!priceEntry) return 'Preis unbekannt';
  const monthly = formatPrice(priceEntry.priceMonthly, 'monatlich');
  const hourly = formatPrice(priceEntry.priceHourly, 'stündlich');
  const parts = [monthly, hourly].filter(Boolean);
  if (parts.length === 0) return 'Preis unbekannt';
  const suffix = isFallback ? ' (anderer Standort)' : '';
  return parts.join(' · ') + suffix;
}

// ── VpsCreateForm ─────────────────────────────────────────────────────────────

/**
 * Create-Formular — Pro Rolle (root, alex) ein Dropdown mit verfügbaren SSH-Labels.
 * Default-Vorbelegung: gleichnamiges Label → Rolle (AC2).
 * UI-Sperre wenn kein wählbares Label vorhanden (AC5).
 *
 * Bei Provider "hetzner" werden Region + Server-Typ als Dropdowns angezeigt (AC6/AC7).
 * Graceful Degradation: Fehler beim Options-Laden → Freitext-Fallback (AC9).
 * Kein Hetzner-Token im Frontend-Bundle (AC10).
 *
 * @param {{
 *   providers: Array<{ id: string, configured: boolean }>,
 *   sshLabels: Array<{ user: string, publicKey?: string }>,
 *   onCreated: () => void,
 *   onCancel: () => void,
 * }} props
 */
function VpsCreateForm({ providers, sshLabels, onCreated, onCancel }) {
  // Labels mit gesetztem Public-Key (AC1 — nur solche sind wählbar)
  const labelsWithKey = sshLabels.filter((e) => !!e.publicKey);

  // Default-Vorbelegung (AC2): Label "root" → root, "alex" → alex (falls vorhanden)
  const defaultForRole = useCallback((role) => {
    const exact = labelsWithKey.find((e) => e.user === role);
    if (exact) return exact.user;
    // kein gleichnamiges Label: leere Auswahl → Create gesperrt bis Nutzer wählt
    return '';
  }, [labelsWithKey]);

  const configuredProviders = providers.filter((p) => p.configured && p.capabilities?.create);

  const [provider, setProvider] = useState(configuredProviders[0]?.id ?? '');
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [serverType, setServerType] = useState('');
  const [image, setImage] = useState('');
  const [rootLabel, setRootLabel] = useState(() => defaultForRole('root'));
  const [alexLabel, setAlexLabel] = useState(() => defaultForRole('alex'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const nameInputRef = useRef(null);
  const ERROR_ID = 'vps-create-error';
  const OPTIONS_STATUS_ID = 'vps-create-options-status';

  // ── vps-create-options AC6–AC12, AC18–AC20: Options-State ──────────────────
  // 'idle' | 'loading' | 'ok' | 'fallback'
  const [optionsState, setOptionsState] = useState('idle');
  const [locations, setLocations] = useState([]);    // HetznerLocationOption[]
  const [serverTypes, setServerTypes] = useState([]); // HetznerServerTypeOption[] (alle aktiven, ungefiltert)
  const [images, setImages] = useState([]);           // HetznerImageOption[] (AC11)
  // AC18/AC20: availability-Map { [locationName]: string[] } — optional (S-177)
  const [availability, setAvailability] = useState(null); // null = nicht vorhanden → ungefiltert (AC20)

  // LTS-Fallback-Slug (UBUNTU_26_04_SLUG — analog hetzner.js Backend)
  // Wird als Default-Vorauswahl im Image-Dropdown genutzt wenn ubuntu-26.04 noch nicht verfügbar.
  const UBUNTU_26_04_SLUG = 'ubuntu-26.04';
  const UBUNTU_LTS_FALLBACK_SLUG = 'ubuntu-24.04';

  // Optionen laden wenn Provider "hetzner" gewählt (AC6/AC11)
  useEffect(() => {
    if (provider !== 'hetzner') {
      // Nicht-Hetzner: Freitext-Fallback (AC9/AC12)
      setOptionsState('idle');
      setLocations([]);
      setServerTypes([]);
      setImages([]);
      setAvailability(null);
      setRegion('');
      setServerType('');
      setImage('');
      return;
    }
    let cancelled = false;
    setOptionsState('loading');
    fetchProviderOptions('hetzner').then((data) => {
      if (cancelled) return;
      if (data?.optionsAvailable === true && Array.isArray(data.locations) && data.locations.length > 0) {
        setLocations(data.locations);
        // Deprecated Typen rausfiltern (AC8)
        const activeTypes = (data.serverTypes ?? []).filter((t) => !t.deprecated);
        // Wenn alle Typen deprecated sind → Freitext-Fallback (kein leeres Dropdown)
        if (activeTypes.length === 0) {
          setServerTypes([]);
          setImages([]);
          setAvailability(null);
          setRegion('');
          setServerType('');
          setImage('');
          setOptionsState('fallback');
        } else {
          setServerTypes(activeTypes);
          // AC18/AC20: availability-Map aus Response übernehmen (optional — S-177 Degradation möglich)
          const availMap = (data.availability && typeof data.availability === 'object')
            ? data.availability
            : null;
          setAvailability(availMap);

          // Vorauswahl: erste Location + erster Typ der in der ersten Region verfügbar ist
          const firstLocation = data.locations[0]?.name || '';
          setRegion((prev) => prev || firstLocation);
          // Erster verfügbarer Typ für die erste Region (AC18: availability-gefiltert)
          const firstRegionTypes = (availMap && firstLocation && Array.isArray(availMap[firstLocation]))
            ? activeTypes.filter((t) => availMap[firstLocation].includes(t.name))
            : activeTypes;
          const firstType = firstRegionTypes[0]?.name || activeTypes[0]?.name || '';
          setServerType((prev) => prev || firstType);

          // AC11: System-Images laden und Default-Vorauswahl Ubuntu 26.04 setzen
          const availableImages = Array.isArray(data.images) ? data.images : [];
          setImages(availableImages);
          if (availableImages.length > 0) {
            // Default-Vorauswahl: ubuntu-26.04 bevorzugt, sonst ubuntu-24.04, sonst erstes Image
            const ubuntu2604 = availableImages.find((img) => img.name === UBUNTU_26_04_SLUG);
            const ubuntuLts = availableImages.find((img) => img.name === UBUNTU_LTS_FALLBACK_SLUG);
            const defaultImg = ubuntu2604 ?? ubuntuLts ?? availableImages[0];
            setImage((prev) => prev || defaultImg?.name || '');
          } else {
            setImage('');
          }

          setOptionsState('ok');
        }
      } else {
        // optionsAvailable:false oder Fehler → Freitext-Fallback (AC9/AC12)
        setOptionsState('fallback');
        setLocations([]);
        setServerTypes([]);
        setImages([]);
        setAvailability(null);
        setRegion('');
        setServerType('');
        setImage('');
      }
    }).catch(() => {
      if (cancelled) return;
      setOptionsState('fallback');
      setLocations([]);
      setServerTypes([]);
      setImages([]);
      setAvailability(null);
      setRegion('');
      setServerType('');
      setImage('');
    });
    return () => { cancelled = true; };
  }, [provider]);

  // AC19: Bei Region-Wechsel serverType zurücksetzen wenn nicht mehr in availability[neueRegion]
  // Läuft nach dem Options-Load-Effect (useEffect-Reihenfolge: Options-Effect ändert region,
  // dieser Effect reagiert danach auf region-Änderungen durch den Nutzer).
  useEffect(() => {
    // Nur aktiv wenn Dropdowns sichtbar sind (useDropdowns) UND availability vorhanden
    if (optionsState !== 'ok' || !availability || !region) return;
    const regionList = availability[region];
    if (!Array.isArray(regionList)) {
      // Kein Eintrag für diese Region → ungefiltert (AC20): Wahl behalten
      return;
    }
    if (serverType && !regionList.includes(serverType)) {
      // Typ nicht mehr verfügbar → zurücksetzen auf ersten gültigen (AC19)
      const filtered = serverTypes.filter((t) => regionList.includes(t.name));
      setServerType(filtered[0]?.name || '');
    }
    // Typ noch verfügbar → Wahl behalten (AC19, letzter Satz)
  }, [region]); // eslint-disable-line react-hooks/exhaustive-deps
  // ^ bewusst nur auf region reagieren (nicht auf serverTypes/availability — diese ändern
  //   sich nur beim Options-Load, der den serverType selbst setzt).

  // AC18/AC20: gefilterte Typen-Liste für das Server-Typ-Dropdown
  // Wenn availability[region] vorhanden → filtern; sonst alle aktiven Typen (Fallback).
  const filteredServerTypes = (() => {
    if (!availability || !region) return serverTypes;
    const regionList = availability[region];
    if (!Array.isArray(regionList)) return serverTypes; // AC20: kein Eintrag → ungefiltert
    return serverTypes.filter((t) => regionList.includes(t.name));
  })();

  // Hinweis wenn beide Rollen dasselbe Label nutzen (non-distinkter Key)
  const nonDistinct = rootLabel && alexLabel && rootLabel === alexLabel;

  // AC5: Create gesperrt wenn kein Label mit Key vorhanden oder eine Rolle leer
  const noLabelsAvailable = labelsWithKey.length === 0;
  const missingAssignment = !rootLabel || !alexLabel;
  const createBlocked = noLabelsAvailable || missingAssignment || !provider || !name.trim() || !region.trim() || !serverType.trim();

  // Wir zeigen Dropdowns wenn Provider=hetzner und Options erfolgreich geladen (AC6)
  const useDropdowns = provider === 'hetzner' && optionsState === 'ok' && locations.length > 0;

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setError(null);

    // Frontend-Validierung (security/R02 — Pflichtfelder prüfen bevor Fetch)
    if (!name.trim()) { setError('Name ist ein Pflichtfeld.'); return; }
    if (!region.trim()) { setError('Region ist ein Pflichtfeld.'); return; }
    if (!serverType.trim()) { setError('Server-Typ ist ein Pflichtfeld.'); return; }
    if (!provider) { setError('Provider ist ein Pflichtfeld.'); return; }
    if (!rootLabel) { setError('SSH-Label für root muss gewählt werden.'); return; }
    if (!alexLabel) { setError('SSH-Label für alex muss gewählt werden.'); return; }

    setSubmitting(true);
    try {
      await postCreateMachine({
        provider,
        name: name.trim(),
        region: region.trim(),
        serverType: serverType.trim(),
        image: image.trim() || undefined,
        // AC3: nur Label-Referenzen, nie Key-Material vom Client
        sshKeyAssignment: { root: rootLabel, alex: alexLabel },
      });
      onCreated();
    } catch (err) {
      setError(err.message ?? 'Create fehlgeschlagen');
    } finally {
      setSubmitting(false);
    }
  }, [provider, name, region, serverType, image, rootLabel, alexLabel, onCreated]);

  useEffect(() => {
    if (nameInputRef.current) nameInputRef.current.focus();
  }, []);

  return (
    <form
      onSubmit={handleSubmit}
      style={createStyles.form}
      aria-label="Neuen VPS erstellen"
      noValidate
    >
      <h3 style={createStyles.heading}>Neuen Server erstellen</h3>

      {/* Kein Label mit Key → Hinweis + Sperre (AC5) */}
      {noLabelsAvailable && (
        <div style={createStyles.blockHint} role="alert">
          Kein SSH-Key hinterlegt. Bitte zuerst in{' '}
          <strong>Einstellungen › SSH-Keys</strong> einen Public-Key setzen.
        </div>
      )}

      {/* Provider */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-provider" style={createStyles.label}>
          Provider <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
        <select
          id="vps-create-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          style={createStyles.select}
          aria-required="true"
          disabled={submitting}
        >
          {configuredProviders.length === 0 && (
            <option value="">— kein Provider konfiguriert —</option>
          )}
          {configuredProviders.map((p) => (
            <option key={p.id} value={p.id}>{p.id}</option>
          ))}
        </select>
      </div>

      {/* Name */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-name" style={createStyles.label}>
          Name <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
        <input
          id="vps-create-name"
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z.B. my-server"
          style={createStyles.input}
          aria-required="true"
          aria-describedby={error ? ERROR_ID : undefined}
          autoComplete="off"
          disabled={submitting}
        />
      </div>

      {/* Region — Dropdown (hetzner+ok) oder Freitext (AC9 Fallback) */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-region" style={createStyles.label}>
          Region <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
        {optionsState === 'loading' ? (
          <p
            id={OPTIONS_STATUS_ID}
            style={createStyles.optionsLoading}
            aria-live="polite"
          >
            Lade verfügbare Regionen…
          </p>
        ) : useDropdowns ? (
          <select
            id="vps-create-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            style={createStyles.select}
            aria-required="true"
            aria-describedby={error ? ERROR_ID : undefined}
            disabled={submitting}
          >
            {locations.map((loc) => (
              <option key={loc.name} value={loc.name}>
                {loc.name}
                {loc.city ? ` — ${loc.city}` : ''}
                {loc.country ? ` (${loc.country})` : ''}
                {loc.networkZone ? ` [${loc.networkZone}]` : ''}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id="vps-create-region"
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="z.B. nbg1 oder fsn1"
              style={createStyles.input}
              aria-required="true"
              aria-describedby={error ? ERROR_ID : undefined}
              autoComplete="off"
              disabled={submitting}
            />
            {optionsState === 'fallback' && (
              <p style={createStyles.optionsFallbackHint} aria-live="polite">
                Live-Optionen nicht verfügbar — bitte Region manuell eingeben.
              </p>
            )}
          </>
        )}
      </div>

      {/* Server-Typ — Dropdown (hetzner+ok) oder Freitext (AC9 Fallback) */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-servertype" style={createStyles.label}>
          Server-Typ <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
        {optionsState === 'loading' ? (
          <p style={createStyles.optionsLoading} aria-live="polite">
            Lade verfügbare Server-Typen…
          </p>
        ) : useDropdowns ? (
          <select
            id="vps-create-servertype"
            value={serverType}
            onChange={(e) => setServerType(e.target.value)}
            style={createStyles.select}
            aria-required="true"
            aria-describedby={error ? ERROR_ID : undefined}
            disabled={submitting}
          >
            {filteredServerTypes.map((st) => {
              const { priceEntry, isFallback } = resolvePriceEntry(st.prices ?? [], region);
              const costText = buildCostText(priceEntry, isFallback);
              const specsText = `${st.name} — ${st.cores} vCPU, ${st.memory} GB RAM, ${st.disk} GB · ${costText}`;
              return (
                <option key={st.name} value={st.name}>
                  {specsText}
                </option>
              );
            })}
          </select>
        ) : (
          <>
            <input
              id="vps-create-servertype"
              type="text"
              value={serverType}
              onChange={(e) => setServerType(e.target.value)}
              placeholder="z.B. cx23 oder cpx21"
              style={createStyles.input}
              aria-required="true"
              aria-describedby={error ? ERROR_ID : undefined}
              autoComplete="off"
              disabled={submitting}
            />
            {optionsState === 'fallback' && (
              <p style={createStyles.optionsFallbackHint} aria-live="polite">
                Live-Optionen nicht verfügbar — bitte Server-Typ manuell eingeben.
              </p>
            )}
          </>
        )}
      </div>

      {/* Image — Dropdown (hetzner+ok+images) oder Freitext-Fallback (AC11/AC12) */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-image" style={createStyles.label}>
          Image <span style={createStyles.optional}>(optional)</span>
        </label>
        {optionsState === 'loading' ? (
          <p style={createStyles.optionsLoading} aria-live="polite">
            Lade verfügbare Images…
          </p>
        ) : useDropdowns && images.length > 0 ? (
          <select
            id="vps-create-image"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            style={createStyles.select}
            aria-required="false"
            disabled={submitting}
          >
            <option value="">— Default (Ubuntu 26.04 LTS) —</option>
            {images.map((img) => (
              <option key={img.name} value={img.name}>
                {img.description || img.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id="vps-create-image"
              type="text"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="Default: Ubuntu 26.04 LTS"
              style={createStyles.input}
              autoComplete="off"
              disabled={submitting}
            />
            {optionsState === 'fallback' && (
              <p style={createStyles.optionsFallbackHint} aria-live="polite">
                Live-Optionen nicht verfügbar — bitte Image manuell eingeben.
              </p>
            )}
          </>
        )}
      </div>

      {/* SSH-Key-Zuordnung — AC1/AC2 */}
      <fieldset style={createStyles.fieldset} disabled={submitting}>
        <legend style={createStyles.legend}>
          SSH-Key-Zuordnung{' '}
          <span aria-hidden="true" style={createStyles.required}>*</span>
        </legend>
        <p style={createStyles.sshHint}>
          Wähle je Benutzer-Rolle ein SSH-Label mit gesetztem Public-Key.
        </p>

        {/* root-Rolle */}
        <div style={createStyles.field}>
          <label htmlFor="vps-ssh-root" style={createStyles.label}>
            root
          </label>
          <select
            id="vps-ssh-root"
            value={rootLabel}
            onChange={(e) => setRootLabel(e.target.value)}
            style={createStyles.select}
            aria-required="true"
            aria-describedby={error ? ERROR_ID : undefined}
          >
            <option value="">— Label wählen —</option>
            {labelsWithKey.map((e) => (
              <option key={e.user} value={e.user}>{e.user}</option>
            ))}
          </select>
        </div>

        {/* alex-Rolle */}
        <div style={createStyles.field}>
          <label htmlFor="vps-ssh-alex" style={createStyles.label}>
            alex
          </label>
          <select
            id="vps-ssh-alex"
            value={alexLabel}
            onChange={(e) => setAlexLabel(e.target.value)}
            style={createStyles.select}
            aria-required="true"
            aria-describedby={error ? ERROR_ID : undefined}
          >
            <option value="">— Label wählen —</option>
            {labelsWithKey.map((e) => (
              <option key={e.user} value={e.user}>{e.user}</option>
            ))}
          </select>
        </div>

        {/* Nicht-distinkte Keys — Hinweis (Edge-Case Spec §44) */}
        {nonDistinct && (
          <p style={createStyles.nonDistinctHint} role="status">
            Hinweis: root und alex nutzen dasselbe Label — kein distinkter Key.
          </p>
        )}
      </fieldset>

      {/* Fehler */}
      {error && (
        <p id={ERROR_ID} style={createStyles.error} role="alert">
          {error}
        </p>
      )}

      {/* Aktionen */}
      <div style={createStyles.actions}>
        <button
          type="submit"
          style={createBlocked ? { ...createStyles.btnPrimary, opacity: 0.5, cursor: 'not-allowed' } : createStyles.btnPrimary}
          disabled={createBlocked || submitting}
          aria-busy={submitting}
          aria-disabled={createBlocked}
        >
          {submitting ? 'Erstelle…' : 'Erstellen'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={createStyles.btnSecondary}
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

// ── VpsMachineRow ─────────────────────────────────────────────────────────────

/**
 * type-to-confirm-Dialog für das Löschen eines VPS (AC9, vps-delete).
 *
 * Der Nutzer muss den VPS-Namen exakt eintippen, bevor der finale
 * Löschen-Button aktiv wird. Abbruch verwirft die Eingabe folgenlos.
 *
 * @param {{
 *   vpsName: string,
 *   onConfirm: () => Promise<void>,
 *   onCancel: () => void,
 *   pending: boolean,
 * }} props
 */
function VpsDeleteConfirm({ vpsName, onConfirm, onCancel, pending }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);
  const matches = input === vpsName;

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!matches) return;
    await onConfirm();
  }, [matches, onConfirm]);

  const CONFIRM_INPUT_ID = `vps-delete-confirm-${vpsName}`.replace(/[^a-zA-Z0-9-]/g, '-');
  const CONFIRM_HINT_ID = `${CONFIRM_INPUT_ID}-hint`;

  return (
    <form onSubmit={handleSubmit} style={deleteStyles.confirmForm} aria-label={`${vpsName} löschen bestätigen`}>
      <p style={deleteStyles.confirmWarning} role="alert">
        Achtung: Diese Aktion löscht den Server <strong>{vpsName}</strong> unwiderruflich.
      </p>
      <label htmlFor={CONFIRM_INPUT_ID} style={deleteStyles.confirmLabel}>
        Zur Bestätigung den VPS-Namen eintippen:
      </label>
      <input
        id={CONFIRM_INPUT_ID}
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={vpsName}
        style={deleteStyles.confirmInput}
        aria-required="true"
        aria-describedby={CONFIRM_HINT_ID}
        autoComplete="off"
        disabled={pending}
      />
      <p id={CONFIRM_HINT_ID} style={deleteStyles.confirmHint}>
        {matches ? 'Name stimmt überein.' : `Bitte genau "${vpsName}" eintippen.`}
      </p>
      <div style={deleteStyles.confirmActions}>
        <button
          type="submit"
          style={(!matches || pending)
            ? { ...deleteStyles.btnDelete, opacity: 0.5, cursor: 'not-allowed' }
            : deleteStyles.btnDelete}
          disabled={!matches || pending}
          aria-busy={pending}
          aria-disabled={!matches}
        >
          {pending ? 'Löschen…' : 'Endgültig löschen'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          style={deleteStyles.btnCancelDelete}
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

/**
 * Eine einzelne Maschinen-Zeile mit Start/Stop/Löschen/Container-Buttons (AC6/AC8–AC10, vps-container-overview AC1).
 *
 * @param {{
 *   machine: object,
 *   providerCapabilities: { start: boolean, stop: boolean, delete: boolean } | null,
 *   onAction: (provider: string, serverId: string, action: 'start'|'stop') => Promise<void>,
 *   onDelete: (provider: string, serverId: string, vpsName: string) => Promise<void>,
 * }} props
 */
function VpsMachineRow({ machine: m, providerCapabilities, onAction, onDelete }) {
  const [actionState, setActionState] = useState(null); // null | 'pending' | 'ok' | 'error' | 'unsupported' | 'forbidden' | 'deleted'
  const [actionMsg, setActionMsg] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  // AC1 (vps-container-overview): Container-Übersicht ein-/ausklappen
  const [showContainerOverview, setShowContainerOverview] = useState(false);

  const caps = providerCapabilities ?? { start: true, stop: true, delete: false };

  const startDisabled = !caps.start || actionState === 'pending' || deletePending;
  const stopDisabled = !caps.stop || actionState === 'pending' || deletePending;
  const deleteDisabled = !caps.delete || actionState === 'pending' || deletePending;

  const handleAction = useCallback(async (action) => {
    setActionState('pending');
    setActionMsg(null);
    try {
      const result = await onAction(m.provider, m.serverId, action);
      if (result?.result === 'unsupported') {
        setActionState('unsupported');
        setActionMsg(result.reason ?? 'Aktion nicht unterstützt');
      } else {
        setActionState('ok');
        setActionMsg(null);
      }
    } catch (err) {
      if (err.is403) {
        setActionState('forbidden');
        setActionMsg('Keine Berechtigung für diese Aktion');
      } else {
        setActionState('error');
        setActionMsg(err.message ?? 'Aktion fehlgeschlagen');
      }
    }
  }, [m.provider, m.serverId, onAction]);

  const handleDeleteConfirm = useCallback(async () => {
    setDeletePending(true);
    setActionMsg(null);
    try {
      const result = await onDelete(m.provider, m.serverId, m.name);
      if (result?.result === 'unsupported') {
        setActionState('unsupported');
        setActionMsg(result.reason ?? 'Löschen nicht unterstützt');
        setShowDeleteConfirm(false);
      } else if (result?.result === 'error') {
        setActionState('error');
        setActionMsg(result.reason ?? 'Löschen fehlgeschlagen');
        setShowDeleteConfirm(false);
      } else {
        // result: "ok" (mit möglichem cleanupError)
        setActionState('deleted');
        setActionMsg(result?.cleanupError
          ? `Gelöscht (Tunnel-Cleanup fehlgeschlagen: ${result.cleanupError})`
          : 'Gelöscht');
        setShowDeleteConfirm(false);
      }
    } catch (err) {
      if (err.is403) {
        setActionState('forbidden');
        setActionMsg('Keine Berechtigung für diese Aktion');
      } else {
        setActionState('error');
        setActionMsg(err.message ?? 'Löschen fehlgeschlagen');
      }
      setShowDeleteConfirm(false);
    } finally {
      setDeletePending(false);
    }
  }, [m.provider, m.serverId, m.name, onDelete]);

  const ACTION_MSG_ID = `vps-action-msg-${m.provider}-${m.serverId}`.replace(/[^a-zA-Z0-9-]/g, '-');

  // Nach erfolgreichem Löschen: Zeile ausblenden (AC10 — VPS verschwindet aus Übersicht)
  if (actionState === 'deleted') {
    return null;
  }

  return (
    <li style={listStyles.item}>
      <span style={listStyles.name}>{m.name}</span>
      <span style={listStyles.provider}>{m.provider}</span>
      <span
        style={listStyles.status(m.status)}
        aria-label={`Status: ${m.status}`}
      >
        {m.status}
      </span>
      {m.ipv4 && <span style={listStyles.ip}>{m.ipv4}</span>}

      {/* Start/Stop/Löschen/Container-Buttons (AC6/AC8, AC1-container-overview) */}
      <div style={listStyles.actions}>
        <button
          type="button"
          style={startDisabled
            ? { ...listStyles.actionBtn, opacity: 0.45, cursor: 'not-allowed' }
            : listStyles.actionBtn}
          disabled={startDisabled}
          aria-label={`${m.name} starten`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          title={!caps.start ? 'Start wird von diesem Provider nicht unterstützt' : undefined}
          onClick={() => handleAction('start')}
        >
          {actionState === 'pending' ? '…' : 'Start'}
        </button>
        <button
          type="button"
          style={stopDisabled
            ? { ...listStyles.actionBtn, ...listStyles.actionBtnStop, opacity: 0.45, cursor: 'not-allowed' }
            : { ...listStyles.actionBtn, ...listStyles.actionBtnStop }}
          disabled={stopDisabled}
          aria-label={`${m.name} stoppen`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          title={!caps.stop ? 'Stop wird von diesem Provider nicht unterstützt' : undefined}
          onClick={() => handleAction('stop')}
        >
          {actionState === 'pending' ? '…' : 'Stop'}
        </button>
        {/* AC8: Löschen-Button — disabled/als unsupported markiert wenn caps.delete=false */}
        <button
          type="button"
          style={deleteDisabled
            ? { ...listStyles.actionBtn, ...listStyles.actionBtnDelete, opacity: 0.45, cursor: 'not-allowed' }
            : { ...listStyles.actionBtn, ...listStyles.actionBtnDelete }}
          disabled={deleteDisabled}
          aria-label={`${m.name} löschen`}
          aria-describedby={actionMsg ? ACTION_MSG_ID : undefined}
          title={!caps.delete ? 'Löschen wird von diesem Provider nicht unterstützt' : 'Server löschen'}
          onClick={() => setShowDeleteConfirm(true)}
        >
          {deletePending ? '…' : 'Löschen'}
        </button>
        {/* AC1 (vps-container-overview): Container-Button */}
        <button
          type="button"
          style={showContainerOverview
            ? { ...listStyles.actionBtn, ...listStyles.actionBtnContainer, ...listStyles.actionBtnContainerActive }
            : { ...listStyles.actionBtn, ...listStyles.actionBtnContainer }}
          aria-label={`Container-Übersicht für ${m.name} ${showContainerOverview ? 'schließen' : 'öffnen'}`}
          aria-expanded={showContainerOverview}
          aria-controls={`ctr-overview-${m.provider}-${m.serverId}`.replace(/[^a-zA-Z0-9-]/g, '-')}
          onClick={() => setShowContainerOverview((v) => !v)}
        >
          Container
        </button>
      </div>

      {/* type-to-confirm-Dialog (AC9, vps-delete) */}
      {showDeleteConfirm && (
        <div style={listStyles.deleteConfirmContainer}>
          <VpsDeleteConfirm
            vpsName={m.name}
            onConfirm={handleDeleteConfirm}
            onCancel={() => setShowDeleteConfirm(false)}
            pending={deletePending}
          />
        </div>
      )}

      {/* Aktions-Feedback (AC9/AC10) */}
      {actionMsg && (
        <span
          id={ACTION_MSG_ID}
          style={actionState === 'ok' ? listStyles.actionSuccess
            : actionState === 'forbidden' ? listStyles.actionForbidden
              : actionState === 'unsupported' ? listStyles.actionUnsupported
                : listStyles.actionError}
          role={actionState === 'forbidden' || actionState === 'error' ? 'alert' : 'status'}
        >
          {actionMsg}
        </span>
      )}
      {actionState === 'ok' && (
        <span style={listStyles.actionSuccess} role="status">
          OK
        </span>
      )}

      {/* AC1/AC2/AC3 (vps-container-overview): Container-Übersicht — inline aufklappend */}
      {showContainerOverview && (
        <div style={listStyles.containerOverviewWrapper} id={`ctr-overview-${m.provider}-${m.serverId}`.replace(/[^a-zA-Z0-9-]/g, '-')}>
          <ContainerOverview
            provider={m.provider}
            serverId={m.serverId}
            machineName={m.name}
            onClose={() => setShowContainerOverview(false)}
          />
        </div>
      )}
    </li>
  );
}

// ── VpsMachineList ────────────────────────────────────────────────────────────

/**
 * Listet alle bekannten VPS-Maschinen auf inkl. Provider-Fehler (AC5) und
 * „nicht konfiguriert"-Hinweise (AC4). Start/Stop/Löschen-Buttons (AC6/AC8).
 *
 * @param {{
 *   machines: Array,
 *   providers: Array<{ id: string, configured: boolean, capabilities: object }>,
 *   providerErrors?: Array,
 *   onAction: (provider: string, serverId: string, action: 'start'|'stop') => Promise<void>,
 *   onDelete: (provider: string, serverId: string, vpsName: string) => Promise<void>,
 * }} props
 */
function VpsMachineList({ machines, providers, providerErrors, onAction, onDelete }) {
  const unconfiguredProviders = (providers ?? []).filter((p) => !p.configured);

  const hasContent = machines.length > 0
    || (providerErrors && providerErrors.length > 0)
    || unconfiguredProviders.length > 0;

  if (!hasContent) {
    return <p style={listStyles.empty}>Keine Maschinen vorhanden.</p>;
  }

  // Capabilities per Provider (für Buttons in Zeilen)
  // S2: unkonfigurierte Provider erhalten start/stop/delete=false (kein Lifecycle-Aufruf — AC4)
  const capsMap = {};
  for (const p of (providers ?? [])) {
    capsMap[p.id] = !p.configured
      ? { start: false, stop: false, delete: false }
      : (p.capabilities ?? { start: true, stop: true, delete: false });
  }

  return (
    <div>
      {/* Nicht konfigurierte Provider (AC4) */}
      {unconfiguredProviders.length > 0 && (
        <div style={listStyles.unconfiguredHint} role="note" aria-label="Nicht konfigurierte Provider">
          {unconfiguredProviders.map((p) => (
            <span key={p.id} style={listStyles.unconfiguredItem}>
              <strong>{p.id}</strong>: nicht konfiguriert —{' '}
              API-Token in <strong>Einstellungen › Credentials</strong> hinterlegen.
            </span>
          ))}
        </div>
      )}

      {/* Gestörte Provider (AC5) */}
      {providerErrors && providerErrors.length > 0 && (
        <div style={listStyles.providerErrors} role="status" aria-label="Gestörte Provider">
          {providerErrors.map((e) => (
            <span key={e.provider} style={listStyles.providerError}>
              {e.provider}: gestört ({e.errorClass})
            </span>
          ))}
        </div>
      )}

      {machines.length === 0 ? (
        <p style={listStyles.empty}>Keine Maschinen vorhanden.</p>
      ) : (
        <ul style={listStyles.list} aria-label="VPS-Maschinen">
          {machines.map((m) => (
            <VpsMachineRow
              key={`${m.provider}:${m.serverId}`}
              machine={m}
              providerCapabilities={capsMap[m.provider] ?? null}
              onAction={onAction}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── VpsView ───────────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function VpsView({ onNavigate }) {
  const [machines, setMachines] = useState([]);
  const [providerErrors, setProviderErrors] = useState([]);
  const [providers, setProviders] = useState([]);
  const [sshLabels, setSshLabels] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const [machinesRes, providersRes, sshRes] = await Promise.allSettled([
      fetchVpsMachines(),
      fetchVpsProviders(),
      fetchSshKeyLabels(),
    ]);
    if (machinesRes.status === 'fulfilled') {
      setMachines(machinesRes.value.machines ?? []);
      setProviderErrors(machinesRes.value.providerErrors ?? []);
    } else {
      setLoadError(machinesRes.reason?.message ?? 'Maschinen-Laden fehlgeschlagen');
    }
    if (providersRes.status === 'fulfilled') {
      setProviders(providersRes.value ?? []);
    }
    if (sshRes.status === 'fulfilled') {
      setSshLabels(sshRes.value ?? []);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = useCallback(async () => {
    setShowCreate(false);
    await load();
  }, [load]);

  /**
   * Start/Stop-Aktion pro Maschine (AC6/AC9/AC10).
   * Gibt das Backend-Ergebnis zurück; Fehler (inkl. 403) propagieren als Exception.
   * Nach Erfolg: Re-Fetch der Maschinenliste (AC9).
   *
   * @param {string} provider
   * @param {string} serverId
   * @param {'start'|'stop'} action
   * @returns {Promise<{ result: string, reason?: string }>}
   */
  const handlePowerAction = useCallback(async (provider, serverId, action) => {
    const result = await postPowerAction({ provider, serverId, action });
    // Re-Fetch nach Aktion (AC9) — auch bei "unsupported" aktualisieren wir nicht zwingend,
    // aber bei Erfolg soll die Übersicht aktuell sein.
    if (result?.result === 'ok') {
      await load();
    }
    return result;
  }, [load]);

  /**
   * Delete-Aktion pro Maschine (AC8–AC10, vps-delete).
   * Gibt das Backend-Ergebnis zurück; Fehler (inkl. 403) propagieren als Exception.
   * Nach Erfolg: Re-Fetch der Maschinenliste (AC10 — VPS verschwindet aus Übersicht).
   *
   * @param {string} provider
   * @param {string} serverId
   * @param {string} vpsName
   * @returns {Promise<{ result: string, reason?: string, cleanupError?: string }>}
   */
  const handleDelete = useCallback(async (provider, serverId, vpsName) => {
    const result = await deleteVps({ provider, serverId, vpsName });
    // Nach Erfolg: Liste neu laden (AC10 — VPS soll aus der Übersicht verschwinden)
    if (result?.result === 'ok') {
      await load();
    }
    return result;
  }, [load]);

  // Kein konfigurierter Provider → Onboarding-Hinweis
  const allUnconfigured = providers.length > 0 && providers.every((p) => !p.configured);

  return (
    <main style={styles.view} aria-label="VPS-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>VPS</h1>

        {loadError && (
          <p style={styles.loadError} role="alert" aria-live="polite">
            {loadError}
          </p>
        )}

        {/* Onboarding-Hinweis wenn kein Provider konfiguriert (AC4 Edge-Case) */}
        {allUnconfigured && !loadError && (
          <div style={styles.onboarding} role="note">
            Kein Provider konfiguriert. Bitte API-Token in{' '}
            <strong>Einstellungen › Credentials</strong> hinterlegen.
          </div>
        )}

        {showCreate ? (
          <VpsCreateForm
            providers={providers}
            sshLabels={sshLabels}
            onCreated={handleCreated}
            onCancel={() => setShowCreate(false)}
          />
        ) : (
          <>
            <div style={styles.toolbar}>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                style={styles.btnCreate}
                aria-label="Neuen VPS erstellen"
              >
                + Neuer Server
              </button>
              <button
                type="button"
                onClick={load}
                style={styles.btnRefresh}
                aria-label="Maschinen-Liste aktualisieren"
              >
                Aktualisieren
              </button>
            </div>

            <VpsMachineList
              machines={machines}
              providers={providers}
              providerErrors={providerErrors}
              onAction={handlePowerAction}
              onDelete={handleDelete}
            />
          </>
        )}

        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          ← Zurück zum Panel
        </button>
      </div>
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#d4d4d4',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px 24px',
  },
  inner: {
    width: '100%',
    maxWidth: 720,
  },
  title: {
    margin: '0 0 24px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  loadError: {
    padding: '10px 14px',
    background: '#2c1a1a',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: 14,
    marginBottom: 16,
  },
  toolbar: {
    display: 'flex',
    gap: 10,
    marginBottom: 20,
  },
  btnCreate: {
    padding: '10px 20px',
    background: '#1e40af',
    color: '#e5e7eb',
    border: '1px solid #2563eb',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnRefresh: {
    padding: '10px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  homeBtn: {
    marginTop: 32,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  onboarding: {
    padding: '12px 16px',
    background: '#1a1400',
    border: '1px solid #78350f',
    borderRadius: 6,
    color: '#fcd34d',
    fontSize: 14,
    marginBottom: 16,
  },
};

const createStyles = {
  form: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '24px',
    marginBottom: 24,
  },
  heading: {
    margin: '0 0 20px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  field: {
    marginBottom: 14,
  },
  label: {
    display: 'block',
    marginBottom: 4,
    fontSize: 13,
    color: '#9ca3af',
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    background: '#1a1a1a',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 4,
    fontSize: 14,
    boxSizing: 'border-box',
    minHeight: 36,
  },
  select: {
    width: '100%',
    padding: '8px 10px',
    background: '#1a1a1a',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 4,
    fontSize: 14,
    boxSizing: 'border-box',
    minHeight: 44,
  },
  fieldset: {
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '14px 16px',
    marginBottom: 14,
  },
  legend: {
    padding: '0 6px',
    fontSize: 13,
    color: '#9ca3af',
    fontWeight: 600,
  },
  sshHint: {
    margin: '0 0 12px',
    fontSize: 12,
    color: '#9ca3af',
  },
  nonDistinctHint: {
    margin: '8px 0 0',
    fontSize: 12,
    color: '#fbbf24',
  },
  blockHint: {
    padding: '10px 14px',
    background: '#2c1a0a',
    border: '1px solid #92400e',
    borderRadius: 6,
    color: '#fcd34d',
    fontSize: 13,
    marginBottom: 16,
  },
  error: {
    padding: '8px 12px',
    background: '#2c1a1a',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: 13,
    marginBottom: 12,
  },
  actions: {
    display: 'flex',
    gap: 10,
    marginTop: 16,
  },
  btnPrimary: {
    padding: '10px 20px',
    background: '#1e40af',
    color: '#e5e7eb',
    border: '1px solid #2563eb',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnSecondary: {
    padding: '10px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  required: {
    color: '#ef4444',
    marginLeft: 2,
  },
  optional: {
    color: '#9ca3af',
    fontSize: 11,
    marginLeft: 4,
  },
  // vps-create-options AC9: Lade- und Fallback-Hinweis
  optionsLoading: {
    margin: '4px 0',
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
  optionsFallbackHint: {
    margin: '4px 0 0',
    fontSize: 11,
    color: '#fbbf24',
  },
};

const deleteStyles = {
  confirmForm: {
    background: '#1a0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    padding: '16px',
    marginTop: 10,
    width: '100%',
  },
  confirmWarning: {
    color: '#fca5a5',
    fontSize: 13,
    margin: '0 0 12px',
  },
  confirmLabel: {
    display: 'block',
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 4,
  },
  confirmInput: {
    width: '100%',
    padding: '6px 8px',
    background: '#111',
    color: '#e5e7eb',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    fontSize: 13,
    boxSizing: 'border-box',
    minHeight: 32,
  },
  confirmHint: {
    fontSize: 11,
    color: '#9ca3af',
    margin: '4px 0 8px',
  },
  confirmActions: {
    display: 'flex',
    gap: 8,
  },
  btnDelete: {
    padding: '7px 14px',
    background: '#7f1d1d',
    color: '#fca5a5',
    border: '1px solid #991b1b',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
  },
  btnCancelDelete: {
    padding: '7px 14px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
  },
};

const listStyles = {
  empty: {
    color: '#9ca3af',
    fontSize: 14,
    fontStyle: 'italic',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  name: {
    fontWeight: 600,
    color: '#e5e7eb',
    minWidth: 120,
  },
  provider: {
    color: '#9ca3af',
    fontSize: 13,
  },
  status: (s) => ({
    fontSize: 12,
    padding: '2px 8px',
    borderRadius: 4,
    background: s === 'running' ? '#14532d' : s === 'provisioning' ? '#1e3a5f' : '#1a1a1a',
    color: s === 'running' ? '#86efac' : s === 'provisioning' ? '#93c5fd' : '#9ca3af',
  }),
  ip: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#94a3b8',
  },
  actions: {
    display: 'flex',
    gap: 6,
    marginLeft: 'auto',
  },
  actionBtn: {
    padding: '6px 12px',
    background: '#1e3a5f',
    color: '#93c5fd',
    border: '1px solid #1e40af',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 56,
  },
  actionBtnStop: {
    background: '#2c1a00',
    color: '#fbbf24',
    border: '1px solid #92400e',
  },
  actionBtnDelete: {
    background: '#2c0000',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
  },
  deleteConfirmContainer: {
    width: '100%',
    marginTop: 4,
  },
  actionError: {
    fontSize: 11,
    color: '#fca5a5',
    marginLeft: 4,
  },
  actionSuccess: {
    fontSize: 11,
    color: '#86efac',
    marginLeft: 4,
  },
  actionForbidden: {
    fontSize: 11,
    color: '#fbbf24',
    marginLeft: 4,
  },
  actionUnsupported: {
    fontSize: 11,
    color: '#fbbf24',
    marginLeft: 4,
  },
  providerErrors: {
    display: 'flex',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  providerError: {
    fontSize: 12,
    color: '#fbbf24',
    background: '#1c1000',
    border: '1px solid #92400e',
    borderRadius: 4,
    padding: '2px 8px',
  },
  unconfiguredHint: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 12,
    padding: '10px 14px',
    background: '#1a1400',
    border: '1px solid #78350f',
    borderRadius: 6,
  },
  unconfiguredItem: {
    fontSize: 13,
    color: '#fcd34d',
  },
  // AC1 (vps-container-overview): Container-Button Styles
  actionBtnContainer: {
    background: '#0f3460',
    color: '#93c5fd',
    border: '1px solid #1d4ed8',
  },
  // Active-Zustand (Übersicht offen)
  actionBtnContainerActive: {
    background: '#1e40af',
    color: '#bfdbfe',
    border: '1px solid #3b82f6',
  },
  // Container-Übersicht wrapper (inline, volle Breite der Zeile)
  containerOverviewWrapper: {
    width: '100%',
    marginTop: 8,
  },
};

// ── Container-Styles ──────────────────────────────────────────────────────────

const containerStyles = {
  panel: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '14px 16px',
    marginTop: 2,
    width: '100%',
    boxSizing: 'border-box',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    flexWrap: 'wrap',
    gap: 8,
  },
  panelTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 700,
    color: '#c9d1d9',
  },
  panelHeaderActions: {
    display: 'flex',
    gap: 6,
  },
  btnRefresh: {
    padding: '5px 10px',
    background: '#161b22',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnClose: {
    padding: '5px 10px',
    background: '#161b22',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  loadingText: {
    color: '#8b949e',
    fontSize: 13,
    margin: '8px 0',
  },
  errorText: {
    color: '#f85149',
    fontSize: 13,
    margin: '8px 0',
    padding: '6px 10px',
    background: '#1a0000',
    border: '1px solid #58131a',
    borderRadius: 4,
  },
  emptyText: {
    color: '#8b949e',
    fontSize: 13,
    fontStyle: 'italic',
    margin: '8px 0',
  },
  containerList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  containerItem: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '8px 10px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
  },
  containerInfo: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  managedBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 5px',
    background: '#0d3349',
    color: '#79c0ff',
    border: '1px solid #1f6feb',
    borderRadius: 3,
    flexShrink: 0,
    minHeight: 20,
    lineHeight: '18px',
    cursor: 'default',
  },
  unmanagedBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 5px',
    background: '#1a1a1a',
    color: '#8b949e',
    border: '1px solid #30363d',
    borderRadius: 3,
    flexShrink: 0,
    minHeight: 20,
    lineHeight: '18px',
    cursor: 'default',
  },
  containerMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    minWidth: 0,
  },
  containerName: {
    fontWeight: 600,
    fontSize: 12,
    color: '#c9d1d9',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
  containerHostname: {
    fontSize: 11,
    color: '#79c0ff',
    fontFamily: 'monospace',
  },
  containerImage: {
    fontSize: 11,
    color: '#8b949e',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
  containerStatus: {
    fontSize: 11,
    color: '#3fb950',
  },
  containerPort: {
    fontSize: 11,
    color: '#f0883e',
    fontFamily: 'monospace',
  },
  containerActions: {
    display: 'flex',
    gap: 4,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  actionSmall: {
    padding: '4px 8px',
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 44,
  },
  actionStop: {
    background: '#1a1000',
    color: '#e3b341',
    border: '1px solid #9e6a03',
  },
  actionRestart: {
    background: '#0f2022',
    color: '#56d364',
    border: '1px solid #1b4332',
  },
  actionRemove: {
    background: '#1a0000',
    color: '#f85149',
    border: '1px solid #58131a',
  },
  feedbackOk: {
    fontSize: 11,
    color: '#3fb950',
    marginLeft: 4,
  },
  feedbackError: {
    fontSize: 11,
    color: '#f85149',
    marginLeft: 4,
  },
  feedbackForbidden: {
    fontSize: 11,
    color: '#e3b341',
    marginLeft: 4,
  },
  // Logs-Panel (AC5)
  logsPanel: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '10px 12px',
    marginTop: 8,
    width: '100%',
    boxSizing: 'border-box',
  },
  logsPanelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  logsPanelTitle: {
    margin: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#c9d1d9',
  },
  logsPre: {
    margin: 0,
    fontSize: 11,
    color: '#8b949e',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 300,
    overflowY: 'auto',
    background: '#010409',
    padding: '8px',
    borderRadius: 3,
  },
  // Remove-Dialog (AC6/AC7)
  removeDialogWrapper: {
    width: '100%',
    marginTop: 6,
  },
  removeForm: {
    background: '#1a0000',
    border: '1px solid #58131a',
    borderRadius: 4,
    padding: '12px 14px',
    width: '100%',
    boxSizing: 'border-box',
  },
  removeWarning: {
    color: '#f85149',
    fontSize: 12,
    margin: '0 0 8px',
  },
  removeLabel: {
    display: 'block',
    fontSize: 11,
    color: '#8b949e',
    marginBottom: 4,
    wordBreak: 'break-all',
  },
  removeInput: {
    width: '100%',
    padding: '5px 8px',
    background: '#0d1117',
    color: '#c9d1d9',
    border: '1px solid #58131a',
    borderRadius: 3,
    fontSize: 12,
    boxSizing: 'border-box',
    minHeight: 32,
    fontFamily: 'monospace',
  },
  removeHint: {
    fontSize: 10,
    color: '#8b949e',
    margin: '3px 0 6px',
  },
  removeActions: {
    display: 'flex',
    gap: 6,
  },
  btnRemove: {
    padding: '6px 12px',
    background: '#58131a',
    color: '#f85149',
    border: '1px solid #b91c1c',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
  },
  btnCancelRemove: {
    padding: '6px 12px',
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
  },
};
