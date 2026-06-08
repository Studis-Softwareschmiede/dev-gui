/**
 * CloudflareView.jsx — Cloudflare-Inventar + Lösch-Werkzeug (view-cloudflare v2, Capability A).
 *
 * AC4  — Zones/Domänen auflisten; Zone anwählen → Tunnel + Routen laden.
 * AC5  — Hostname, Ziel-Service, protected-Flag anzeigen; protected Routen ohne Lösch-Affordance.
 * AC6  — type-to-confirm-Dialog (exakter Hostname); Löschung erst nach korrektem Confirm möglich.
 * AC7  — Degradierende Anzeige bei Zone/Tunnel-Fehler; übrige Bereiche sichtbar.
 * AC8  — Kein Cloudflare-Token im Frontend; nur Status/Meldungen aus Backend-Antworten.
 * AC9  — 403 → „keine Berechtigung"; 422 protected-resource → „geschützt"; 422 confirm → „Bestätigung".
 * AC3  — Nicht konfiguriert → Onboarding-Hinweis; kein API-Call.
 * A11y — Titel als <h1>; Listen/Tabellen mit Header; Buttons beschriftet; Fehler aria-zugeordnet;
 *         sichtbarer Fokus; Touch-Target ≥ 44px.
 * Security (Floor) — Kein Token im Frontend; Error-Messages ohne Secret-Leak.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ── API-Helfer ────────────────────────────────────────────────────────────────

/**
 * GET /api/cloudflare/zones
 * @returns {Promise<{ configured: boolean, zones: CfZone[], errors?: Array }>}
 */
async function fetchZones() {
  const res = await fetch('/api/cloudflare/zones');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Laden fehlgeschlagen (${res.status})`);
  }
  return res.json();
}

/**
 * GET /api/cloudflare/zones/:zoneId/tunnels
 * @returns {Promise<{ tunnels: CfTunnel[], routes: CfRoute[], errors?: Array }>}
 */
async function fetchZoneTunnels(zoneId) {
  const res = await fetch(`/api/cloudflare/zones/${encodeURIComponent(zoneId)}/tunnels`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Tunnel laden fehlgeschlagen (${res.status})`);
  }
  return res.json();
}

/**
 * DELETE /api/cloudflare/tunnels/:tunnelId/routes/:hostname
 * Body: { confirm: hostname }
 * @returns {Promise<{ result: string, reason?: string }>}
 */
async function deleteRoute(tunnelId, hostname) {
  const res = await fetch(
    `/api/cloudflare/tunnels/${encodeURIComponent(tunnelId)}/routes/${encodeURIComponent(hostname)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: hostname }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Löschen fehlgeschlagen (${res.status})`);
    err.errorClass = data.error;
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

/**
 * DELETE /api/cloudflare/tunnels/:tunnelId
 * Body: { confirm: tunnelNameOrHostname }
 * @returns {Promise<{ result: string, reason?: string }>}
 */
async function deleteTunnel(tunnelId, confirm) {
  const res = await fetch(
    `/api/cloudflare/tunnels/${encodeURIComponent(tunnelId)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Tunnel löschen fehlgeschlagen (${res.status})`);
    err.errorClass = data.error;
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

// ── Error-Messaging ───────────────────────────────────────────────────────────

/**
 * Maps an API error to a user-friendly message (no secret leak).
 * AC9: 403 → „keine Berechtigung"; protected-resource → „geschützt"; confirm → „Bestätigung".
 */
function mapErrorToMessage(err) {
  const cls = err?.errorClass ?? err?.message ?? '';
  if (err?.httpStatus === 403 || cls === 'forbidden') {
    return 'Keine Berechtigung für diese Aktion.';
  }
  if (cls === 'protected-resource') {
    return 'Geschützt: eigene Erreichbarkeit — diese Route kann nicht gelöscht werden.';
  }
  if (cls === 'confirmation-required') {
    return 'Bestätigung erforderlich: Hostname im Bestätigungsfeld muss exakt übereinstimmen.';
  }
  if (cls === 'cloudflare-not-configured') {
    return 'Cloudflare ist nicht konfiguriert.';
  }
  if (cls === 'cloudflare-auth-failed') {
    return 'Cloudflare-Authentifizierung fehlgeschlagen (Token prüfen).';
  }
  if (cls === 'not-found') {
    return 'Ressource nicht gefunden.';
  }
  if (cls === 'cloudflare-unavailable') {
    return 'Cloudflare-API nicht erreichbar.';
  }
  return 'Ein Fehler ist aufgetreten. Bitte erneut versuchen.';
}

// ── TypeToConfirmDialog ───────────────────────────────────────────────────────

/**
 * Modal-Dialog für type-to-confirm (AC6).
 * Der Nutzer muss den exakten Hostname eintippen um die Löschung freizuschalten.
 *
 * @param {{
 *   hostname: string,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 *   deleting: boolean,
 *   deleteError: string|null,
 * }} props
 */
function TypeToConfirmDialog({ hostname, onConfirm, onCancel, deleting, deleteError }) {
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef(null);
  const errorId = 'confirm-dialog-error';

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const matched = inputVal === hostname;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      style={dialogStyles.overlay}
    >
      <div style={dialogStyles.box}>
        <h2 id="confirm-dialog-title" style={dialogStyles.title}>Route löschen</h2>
        <p style={dialogStyles.description}>
          Tippe den exakten Hostname zur Bestätigung:
        </p>
        <code style={dialogStyles.targetCode}>{hostname}</code>

        <label htmlFor="confirm-dialog-input" style={dialogStyles.fieldLabel}>
          Hostname zur Bestätigung
        </label>
        <input
          id="confirm-dialog-input"
          ref={inputRef}
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          placeholder={hostname}
          style={dialogStyles.input}
          aria-describedby={deleteError ? errorId : undefined}
          autoComplete="off"
          disabled={deleting}
        />

        {deleteError && (
          <p id={errorId} style={dialogStyles.error} role="alert">
            {deleteError}
          </p>
        )}

        <div style={dialogStyles.actionRow}>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matched || deleting}
            style={matched && !deleting ? dialogStyles.btnDanger : dialogStyles.btnDangerDisabled}
            aria-busy={deleting}
            aria-label={`Löschung bestätigen für ${hostname}`}
          >
            {deleting ? 'Löschen…' : 'Löschen bestätigen'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            style={dialogStyles.btnSecondary}
            aria-label="Abbrechen"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RouteRow ──────────────────────────────────────────────────────────────────

/**
 * Einzelne Route-Zeile (AC5/AC6).
 *
 * @param {{
 *   route: import('../../src/cloudflare/normalize.js').CfRoute,
 *   onDeleted: () => void,
 * }} props
 */
function RouteRow({ route, onDeleted }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const handleDeleteClick = useCallback(() => {
    setDeleteError(null);
    setShowConfirm(true);
  }, []);

  const handleConfirm = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRoute(route.tunnelId, route.hostname);
      setShowConfirm(false);
      onDeleted();
    } catch (err) {
      setDeleteError(mapErrorToMessage(err));
    } finally {
      setDeleting(false);
    }
  }, [route, onDeleted]);

  const handleCancel = useCallback(() => {
    setShowConfirm(false);
    setDeleteError(null);
  }, []);

  return (
    <>
      <tr style={route.protected ? tableStyles.protectedRow : tableStyles.normalRow}>
        <td style={tableStyles.cell}>
          <span style={tableStyles.hostname}>{route.hostname}</span>
          {route.protected && (
            <span
              style={tableStyles.protectedBadge}
              aria-label="geschützt"
              title="Diese Route ist geschützt und kann nicht gelöscht werden"
            >
              gesperrt
            </span>
          )}
        </td>
        <td style={tableStyles.cell}>
          <span style={tableStyles.service}>{route.service ?? '—'}</span>
        </td>
        <td style={tableStyles.cell}>
          {route.protected ? (
            <button
              type="button"
              disabled
              style={tableStyles.btnDeleteDisabled}
              aria-label={`Route ${route.hostname} ist geschützt und kann nicht gelöscht werden`}
              title="Geschützt: eigene Erreichbarkeit"
            >
              Löschen
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDeleteClick}
              style={tableStyles.btnDelete}
              aria-label={`Route ${route.hostname} löschen`}
            >
              Löschen
            </button>
          )}
        </td>
      </tr>
      {showConfirm && (
        <tr>
          <td colSpan={3} style={{ padding: 0 }}>
            <TypeToConfirmDialog
              hostname={route.hostname}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              deleting={deleting}
              deleteError={deleteError}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── TunnelSection ─────────────────────────────────────────────────────────────

/**
 * Zeigt einen Tunnel mit seinen Routen (AC4/AC5/AC6).
 *
 * @param {{
 *   tunnel: import('../../src/cloudflare/normalize.js').CfTunnel,
 *   routes: import('../../src/cloudflare/normalize.js').CfRoute[],
 *   tunnelError: string|null,
 *   onRouteDeleted: () => void,
 *   onTunnelDeleted: () => void,
 * }} props
 */
function TunnelSection({ tunnel, routes, tunnelError, onRouteDeleted, onTunnelDeleted }) {
  const tunnelRoutes = routes.filter((r) => r.tunnelId === tunnel.id);
  const [showTunnelConfirm, setShowTunnelConfirm] = useState(false);
  const [tunnelDeleting, setTunnelDeleting] = useState(false);
  const [tunnelDeleteError, setTunnelDeleteError] = useState(null);

  // A tunnel with any protected route cannot be deleted via this UI
  const hasProtectedRoute = tunnelRoutes.some((r) => r.protected);

  const handleTunnelDeleteClick = useCallback(() => {
    setTunnelDeleteError(null);
    setShowTunnelConfirm(true);
  }, []);

  const handleTunnelConfirm = useCallback(async () => {
    setTunnelDeleting(true);
    setTunnelDeleteError(null);
    try {
      await deleteTunnel(tunnel.id, tunnel.name);
      setShowTunnelConfirm(false);
      onTunnelDeleted();
    } catch (err) {
      setTunnelDeleteError(mapErrorToMessage(err));
    } finally {
      setTunnelDeleting(false);
    }
  }, [tunnel, onTunnelDeleted]);

  const handleTunnelCancel = useCallback(() => {
    setShowTunnelConfirm(false);
    setTunnelDeleteError(null);
  }, []);

  return (
    <section
      aria-labelledby={`tunnel-heading-${tunnel.id}`}
      style={sectionStyles.tunnel}
    >
      <div style={sectionStyles.tunnelHeader}>
        <h3 id={`tunnel-heading-${tunnel.id}`} style={sectionStyles.tunnelHeading}>
          {tunnel.name}
          <span style={sectionStyles.tunnelStatus}>{tunnel.status ?? 'unbekannt'}</span>
        </h3>
        {hasProtectedRoute ? (
          <button
            type="button"
            disabled
            style={tableStyles.btnDeleteDisabled}
            aria-label={`Tunnel ${tunnel.name} ist geschützt und kann nicht gelöscht werden`}
            title="Tunnel enthält geschützte Route"
          >
            Tunnel löschen
          </button>
        ) : (
          <button
            type="button"
            onClick={handleTunnelDeleteClick}
            style={tableStyles.btnDelete}
            aria-label={`Tunnel ${tunnel.name} löschen`}
          >
            Tunnel löschen
          </button>
        )}
      </div>

      {tunnelError && (
        <p style={sectionStyles.error} role="alert">
          Fehler beim Laden der Routen: {tunnelError}
        </p>
      )}

      {!tunnelError && tunnelRoutes.length === 0 && (
        <p style={sectionStyles.emptyState}>Keine Public-Hostname-Routen für diesen Tunnel.</p>
      )}

      {tunnelRoutes.length > 0 && (
        <table style={tableStyles.table} aria-label={`Routen für Tunnel ${tunnel.name}`}>
          <thead>
            <tr>
              <th scope="col" style={tableStyles.th}>Hostname</th>
              <th scope="col" style={tableStyles.th}>Ziel-Service</th>
              <th scope="col" style={tableStyles.th}>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {tunnelRoutes.map((route) => (
              <RouteRow
                key={route.hostname}
                route={route}
                onDeleted={onRouteDeleted}
              />
            ))}
          </tbody>
        </table>
      )}

      {showTunnelConfirm && (
        <TypeToConfirmDialog
          hostname={tunnel.name}
          onConfirm={handleTunnelConfirm}
          onCancel={handleTunnelCancel}
          deleting={tunnelDeleting}
          deleteError={tunnelDeleteError}
        />
      )}
    </section>
  );
}

// ── CloudflareView ────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function CloudflareView({ onNavigate }) {
  const [zonesData, setZonesData] = useState(null);         // { configured, zones, errors? }
  const [loadingZones, setLoadingZones] = useState(true);
  const [zonesError, setZonesError] = useState(null);

  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [tunnelsData, setTunnelsData] = useState(null);     // { tunnels, routes, errors? }
  const [loadingTunnels, setLoadingTunnels] = useState(false);
  const [tunnelsError, setTunnelsError] = useState(null);

  // Load zones on mount
  const loadZones = useCallback(async () => {
    setLoadingZones(true);
    setZonesError(null);
    try {
      const data = await fetchZones();
      setZonesData(data);
    } catch (err) {
      setZonesError(mapErrorToMessage(err));
    } finally {
      setLoadingZones(false);
    }
  }, []);

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  // Load tunnels when zone is selected
  const loadTunnels = useCallback(async (zoneId) => {
    if (!zoneId) return;
    setLoadingTunnels(true);
    setTunnelsError(null);
    setTunnelsData(null);
    try {
      const data = await fetchZoneTunnels(zoneId);
      setTunnelsData(data);
    } catch (err) {
      setTunnelsError(mapErrorToMessage(err));
    } finally {
      setLoadingTunnels(false);
    }
  }, []);

  const handleZoneSelect = useCallback((zoneId) => {
    setSelectedZoneId(zoneId);
    loadTunnels(zoneId);
  }, [loadTunnels]);

  const handleRouteDeleted = useCallback(() => {
    // Re-fetch tunnels after deletion (AC6: Liste aktualisieren)
    if (selectedZoneId) {
      loadTunnels(selectedZoneId);
    }
  }, [selectedZoneId, loadTunnels]);

  // Not configured: show onboarding hint (AC3)
  const notConfigured = zonesData && zonesData.configured === false;

  // Find errors for specific tunnels
  const getTunnelError = (tunnelId) => {
    if (!tunnelsData?.errors) return null;
    const e = tunnelsData.errors.find((err) => err.scope === `tunnel:${tunnelId}`);
    return e ? (e.errorClass ?? 'Fehler') : null;
  };

  const selectedZone = zonesData?.zones?.find((z) => z.id === selectedZoneId);

  return (
    <main style={styles.view} aria-label="Cloudflare-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Cloudflare</h1>

        {/* Navigation back */}
        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          ← Zurück zum Panel
        </button>

        {/* Loading zones */}
        {loadingZones && (
          <p style={styles.loading} aria-live="polite" aria-busy="true">
            Lade Zonen…
          </p>
        )}

        {/* Error loading zones */}
        {zonesError && !loadingZones && (
          <p style={styles.error} role="alert">
            Fehler beim Laden der Zonen: {zonesError}
          </p>
        )}

        {/* Not configured (AC3) */}
        {notConfigured && !loadingZones && (
          <div style={styles.onboarding} role="status">
            <p style={styles.onboardingText}>
              Cloudflare ist nicht konfiguriert. Bitte hinterlege den API-Token und die Account-ID
              in den{' '}
              <button
                type="button"
                style={styles.linkBtn}
                onClick={() => onNavigate('settings')}
                aria-label="Zu den Einstellungen navigieren"
              >
                Einstellungen
              </button>
              .
            </p>
          </div>
        )}

        {/* Zones list (AC4) */}
        {zonesData?.configured && !loadingZones && (
          <section aria-labelledby="zones-heading" style={styles.section}>
            <h2 id="zones-heading" style={styles.sectionHeading}>
              Verwaltete Zonen / Domänen
            </h2>

            {zonesData.errors && zonesData.errors.length > 0 && (
              <p style={styles.degradedWarning} role="status">
                Einige Zonen konnten nicht geladen werden (degradiert).
              </p>
            )}

            {zonesData.zones.length === 0 && (
              <p style={styles.emptyState}>Keine Zonen gefunden.</p>
            )}

            {zonesData.zones.length > 0 && (
              <ul style={styles.zoneList} role="list" aria-label="Zonen-Liste">
                {zonesData.zones.map((zone) => (
                  <li key={zone.id} style={styles.zoneItem}>
                    <button
                      type="button"
                      onClick={() => handleZoneSelect(zone.id)}
                      style={
                        zone.id === selectedZoneId
                          ? styles.zoneBtnSelected
                          : styles.zoneBtn
                      }
                      aria-pressed={zone.id === selectedZoneId}
                      aria-label={`Zone ${zone.name} auswählen`}
                    >
                      <span style={styles.zoneName}>{zone.name}</span>
                      <span style={styles.zoneStatus}>{zone.status ?? 'unbekannt'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Tunnels + Routes for selected zone (AC4/AC5) */}
        {selectedZoneId && (
          <section
            aria-labelledby="tunnels-heading"
            aria-live="polite"
            style={styles.section}
          >
            <h2 id="tunnels-heading" style={styles.sectionHeading}>
              Tunnel &amp; Routen
              {selectedZone && (
                <span style={styles.zoneSubtitle}> — {selectedZone.name}</span>
              )}
            </h2>

            {loadingTunnels && (
              <p style={styles.loading} aria-busy="true">Lade Tunnel…</p>
            )}

            {tunnelsError && !loadingTunnels && (
              <p style={styles.error} role="alert">
                Fehler beim Laden der Tunnel: {tunnelsError}
              </p>
            )}

            {/* Zone-level errors (AC7 — degraded) */}
            {tunnelsData?.errors?.some((e) => e.scope.startsWith('zone:')) && (
              <p style={styles.degradedWarning} role="status">
                Ein Fehler beim Laden dieser Zone — Daten möglicherweise unvollständig.
              </p>
            )}

            {!loadingTunnels && !tunnelsError && tunnelsData && (
              <>
                {tunnelsData.tunnels.length === 0 && (
                  <p style={styles.emptyState}>Keine Tunnel für diese Zone gefunden.</p>
                )}
                {tunnelsData.tunnels.map((tunnel) => (
                  <TunnelSection
                    key={tunnel.id}
                    tunnel={tunnel}
                    routes={tunnelsData.routes ?? []}
                    tunnelError={getTunnelError(tunnel.id)}
                    onRouteDeleted={handleRouteDeleted}
                    onTunnelDeleted={handleRouteDeleted}
                  />
                ))}
              </>
            )}
          </section>
        )}
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
    maxWidth: 860,
  },
  title: {
    margin: '0 0 24px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  homeBtn: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    marginBottom: 24,
  },
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: {
    margin: '0 0 16px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  zoneSubtitle: {
    fontWeight: 400,
    fontSize: 14,
    color: '#9ca3af',
  },
  zoneList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  zoneItem: {
    display: 'contents',
  },
  zoneBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '10px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 160,
  },
  zoneBtnSelected: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '10px 16px',
    background: '#1d4ed8',
    color: '#ffffff',
    border: '1px solid #2563eb',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 160,
  },
  zoneName: {
    fontWeight: 600,
  },
  zoneStatus: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
  },
  loading: {
    color: '#9ca3af',
    fontSize: 14,
  },
  error: {
    color: '#f87171',
    fontSize: 14,
    padding: '8px 12px',
    background: '#3b0f0f',
    borderRadius: 4,
    margin: '8px 0',
  },
  degradedWarning: {
    color: '#fbbf24',
    fontSize: 13,
    padding: '6px 10px',
    background: '#2a1f00',
    borderRadius: 4,
    marginBottom: 12,
  },
  emptyState: {
    color: '#9ca3af',
    fontSize: 14,
  },
  onboarding: {
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    marginBottom: 24,
  },
  onboardingText: {
    margin: 0,
    color: '#9ca3af',
    fontSize: 14,
    lineHeight: 1.6,
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#60a5fa',
    cursor: 'pointer',
    fontSize: 14,
    padding: 0,
    textDecoration: 'underline',
  },
};

const sectionStyles = {
  tunnel: {
    marginBottom: 20,
    paddingBottom: 16,
    borderBottom: '1px solid #2a2a2a',
  },
  tunnelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    flexWrap: 'wrap',
    gap: 8,
  },
  tunnelHeading: {
    margin: 0,
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  tunnelStatus: {
    fontSize: 11,
    fontWeight: 400,
    color: '#9ca3af',
    padding: '2px 8px',
    background: '#1e293b',
    borderRadius: 12,
  },
  emptyState: {
    color: '#9ca3af',
    fontSize: 13,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    padding: '6px 10px',
    background: '#3b0f0f',
    borderRadius: 4,
    marginBottom: 8,
  },
};

const tableStyles = {
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '1px solid #2a2a2a',
    color: '#9ca3af',
    fontWeight: 600,
    fontSize: 12,
  },
  cell: {
    padding: '8px 12px',
    borderBottom: '1px solid #1a1a1a',
    verticalAlign: 'middle',
  },
  normalRow: {
    background: 'transparent',
  },
  protectedRow: {
    background: '#1a1f2e',
    opacity: 0.85,
  },
  hostname: {
    fontFamily: 'monospace',
    color: '#e5e7eb',
    fontSize: 13,
  },
  service: {
    fontFamily: 'monospace',
    color: '#9ca3af',
    fontSize: 12,
  },
  protectedBadge: {
    display: 'inline-block',
    marginLeft: 8,
    padding: '1px 8px',
    background: '#422',
    color: '#f87171',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid #7f1d1d',
    verticalAlign: 'middle',
  },
  btnDelete: {
    padding: '6px 14px',
    background: '#7f1d1d',
    color: '#fca5a5',
    border: '1px solid #991b1b',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 72,
  },
  btnDeleteDisabled: {
    padding: '6px 14px',
    background: '#1e293b',
    color: '#475569',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'not-allowed',
    minHeight: 44,
    minWidth: 72,
  },
};

const dialogStyles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  box: {
    background: '#1a1a1a',
    border: '1px solid #334155',
    borderRadius: 8,
    padding: '28px 32px',
    maxWidth: 480,
    width: '90vw',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  description: {
    margin: 0,
    fontSize: 14,
    color: '#9ca3af',
  },
  targetCode: {
    display: 'block',
    padding: '8px 12px',
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#e5e7eb',
    wordBreak: 'break-all',
  },
  fieldLabel: {
    fontSize: 13,
    color: '#9ca3af',
    display: 'block',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    background: '#111',
    color: '#e5e7eb',
    border: '1px solid #334155',
    borderRadius: 4,
    fontSize: 14,
    fontFamily: 'monospace',
    boxSizing: 'border-box',
    minHeight: 44,
  },
  error: {
    margin: 0,
    color: '#f87171',
    fontSize: 13,
    padding: '6px 10px',
    background: '#3b0f0f',
    borderRadius: 4,
  },
  actionRow: {
    display: 'flex',
    gap: 10,
    marginTop: 4,
  },
  btnDanger: {
    padding: '10px 20px',
    background: '#991b1b',
    color: '#fca5a5',
    border: '1px solid #b91c1c',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    fontWeight: 600,
  },
  btnDangerDisabled: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#475569',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'not-allowed',
    minHeight: 44,
    fontWeight: 600,
  },
  btnSecondary: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
};
