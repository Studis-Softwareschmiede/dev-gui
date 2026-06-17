/**
 * DeploymentsView.jsx — Deployments-Panel (Capability B, ADR-012).
 *
 * Spec: deploy-lifecycle.md AC3–AC9, AC10–AC14 (S-155), AC15
 *       stack-deploy-orchestration.md AC12 (Modus-Umschalter)
 *
 * Responsibilities:
 *   - Mode toggle: "Single-Image" | "Compose-Stack aus Repo" (AC12)
 *   - Single-Image mode (deploy-lifecycle.md AC10–AC14):
 *       List live deployments (Container↔Route as unit) — GET /api/deployments
 *       Deploy form — GUIDED DROPDOWNS (AC10):
 *         Image-Dropdown (GET /api/github/packages)
 *         Tag-Dropdown   (GET /api/github/packages/:name/tags, disabled until image chosen)
 *         VPS-Dropdown   (GET /api/deployments/vps-targets)
 *         Domain-Dropdown (GET /api/cloudflare/zones)
 *         Subdomain field: pre-filled from image name (AC11), editable; shows assembled hostname
 *         Deploy-Button: active only when Image+Tag+VPS+Domain+Subdomain non-empty (AC12)
 *         POST /api/deployments { image: "fullRef:tag", vps, hostname: "sub.domain", tunnelId }
 *         Auto-Port: resolved server-side via docker inspect after pull (AC13)
 *         Re-Deploy: existing deploy on same hostname is replaced; UI shows "replaces existing" (AC14)
 *       Undeploy with type-to-confirm → DELETE /api/deployments/:vps/:hostname (AC5/AC6)
 *       Show 422/protected-resource / 422/confirmation-required clearly (no secrets) (AC7)
 *   - Compose-Stack mode (AC12):
 *       List stacks from registry — GET /api/deployments/stacks
 *       Deploy stack — POST /api/deployments/stacks/{stackName}/deploy
 *       Undeploy stack with type-to-confirm — DELETE /api/deployments/stacks/{stackName}/undeploy
 *       Stack status with drift flags — GET /api/deployments/stacks/{stackName}/status
 *   - No Cloudflare token or SSH key in frontend bundle (AC9/AC15/security)
 *
 * A11y (WCAG 2.1 AA):
 *   - Semantic headings, landmarks (main, section, form)
 *   - Labels associated with inputs via htmlFor
 *   - Visible focus rings (no outline:none)
 *   - Touch-targets ≥ 44 px
 *   - aria-live region for status/error messages
 *   - aria-busy during loading
 *   - Meaning not conveyed by colour alone (text labels)
 *   - Mode toggle: role="group" + aria-label, keyboard-navigable buttons
 *
 * Security:
 *   - No token/key displayed or bundled
 *   - Error messages from backend are rendered as text (no innerHTML)
 */

import { useState, useEffect, useCallback } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default domain suffix when none selected. */
const DEFAULT_DOMAIN = '';

const INITIAL_UNDEPLOY_STATE = {
  hostname: '',
  vps: '',
  tunnelId: '',
  // zoneId is NOT in the undeploy form — resolved server-side from hostname
  confirm: '',
};

// Modes for the toggle (AC12)
const MODE_SINGLE = 'single';
const MODE_STACK  = 'stack';

/**
 * Derive a subdomain suggestion from an image name or fullImageRef.
 * e.g. "brew-assistent" → "brew-assistent"
 * e.g. "ghcr.io/org/brew-assistent" → "brew-assistent"
 * AC11
 *
 * @param {string} nameOrRef
 * @returns {string}
 */
function deriveSubdomain(nameOrRef) {
  if (!nameOrRef) return '';
  // Strip registry prefix if present (e.g. "ghcr.io/org/app" → "app")
  const parts = nameOrRef.split('/');
  return parts[parts.length - 1] ?? '';
}

// ── DeploymentsView ───────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function DeploymentsView({ onNavigate }) {
  // ── Mode toggle (AC12)
  const [mode, setMode] = useState(MODE_SINGLE); // 'single' | 'stack'

  // ── Single-Image state
  const [deployments, setDeployments] = useState([]);
  const [loadErrors, setLoadErrors] = useState([]);
  const [loadState, setLoadState] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'

  // Query params for listing
  const [listVps, setListVps] = useState('');
  const [listTunnelId, setListTunnelId] = useState('');

  // ── AC10: Dropdown source data
  const [packages, setPackages] = useState([]);         // [{ name, fullImageRef, ... }]
  const [packagesState, setPackagesState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [tags, setTags] = useState([]);                 // [{ tag, digest, updatedAt }]
  const [tagsState, setTagsState] = useState('idle');   // 'idle'|'loading'|'ok'|'error'
  const [vpsIds, setVpsIds] = useState([]);             // string[]
  const [vpsIdsState, setVpsIdsState] = useState('idle');
  const [zones, setZones] = useState([]);               // [{ id, name }]
  const [zonesState, setZonesState] = useState('idle');

  // ── AC10–AC12: Guided deploy form state
  const [selectedPackage, setSelectedPackage] = useState(''); // package name (e.g. "brew-assistent")
  const [selectedTag, setSelectedTag] = useState('');          // tag string (e.g. "v1.2.0")
  const [selectedVps, setSelectedVps] = useState('');          // vps id
  const [selectedZone, setSelectedZone] = useState('');        // zone name (e.g. "alexstuder.cloud")
  const [selectedZoneTunnels, setSelectedZoneTunnels] = useState([]); // [{id, name}] tunnels for zone
  const [selectedTunnel, setSelectedTunnel] = useState('');    // tunnel id
  const [subdomain, setSubdomain] = useState('');              // AC11: editable subdomain
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null); // { ok, message, replaced? }

  // Undeploy
  const [undeployState, setUndeployState] = useState(null); // null | INITIAL_UNDEPLOY_STATE
  const [undeploying, setUndeploying] = useState(false);
  const [undeployResult, setUndeployResult] = useState(null); // { ok, message }

  // ── Stack-Modus state (AC12)
  const [stacks, setStacks] = useState([]);
  const [stacksLoadState, setStacksLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [stacksLoadError, setStacksLoadError] = useState(null);

  const [selectedStack, setSelectedStack] = useState(''); // stackName
  const [stackDeploying, setStackDeploying] = useState(false);
  const [stackDeployResult, setStackDeployResult] = useState(null); // { ok, message }

  // Stack undeploy (type-to-confirm)
  const [stackUndeployConfirm, setStackUndeployConfirm] = useState('');
  const [stackUndeploying, setStackUndeploying] = useState(false);
  const [stackUndeployResult, setStackUndeployResult] = useState(null); // { ok, message }

  // Stack status
  const [stackStatus, setStackStatus] = useState(null); // StackStatus | null
  const [stackStatusLoading, setStackStatusLoading] = useState(false);
  const [stackStatusError, setStackStatusError] = useState(null);

  // ── Load deployments
  const loadDeployments = useCallback(async () => {
    if (!listVps.trim() || !listTunnelId.trim()) return;
    setLoadState('loading');
    setLoadErrors([]);
    try {
      const res = await fetch(
        `/api/deployments?vps=${encodeURIComponent(listVps.trim())}&tunnelId=${encodeURIComponent(listTunnelId.trim())}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setLoadState('error');
        setLoadErrors([{ scope: 'list', errorClass: data?.error ?? 'fetch-failed' }]);
        return;
      }
      setDeployments(data.deployments ?? []);
      setLoadErrors(data.errors ?? []);
      setLoadState('ok');
    } catch {
      setLoadState('error');
      setLoadErrors([{ scope: 'list', errorClass: 'network-error' }]);
    }
  }, [listVps, listTunnelId]);

  // Auto-load when query params are filled
  useEffect(() => {
    if (listVps.trim() && listTunnelId.trim()) {
      loadDeployments();
    }
  }, [loadDeployments]);

  // ── AC10: Load dropdown sources on mount (single-image mode) ─────────────

  // Load packages list
  useEffect(() => {
    if (packagesState !== 'idle') return;
    setPackagesState('loading');
    fetch('/api/github/packages')
      .then((r) => r.json())
      .then((d) => {
        setPackages(d.packages ?? []);
        setPackagesState('ok');
      })
      .catch(() => setPackagesState('error'));
  }, [packagesState]);

  // Load VPS IDs
  useEffect(() => {
    if (vpsIdsState !== 'idle') return;
    setVpsIdsState('loading');
    fetch('/api/deployments/vps-targets')
      .then((r) => r.json())
      .then((d) => {
        setVpsIds(d.vpsIds ?? []);
        setVpsIdsState('ok');
      })
      .catch(() => setVpsIdsState('error'));
  }, [vpsIdsState]);

  // Load zones (domains)
  useEffect(() => {
    if (zonesState !== 'idle') return;
    setZonesState('loading');
    fetch('/api/cloudflare/zones')
      .then((r) => r.json())
      .then((d) => {
        setZones(d.zones ?? []);
        setZonesState('ok');
      })
      .catch(() => setZonesState('error'));
  }, [zonesState]);

  // ── AC10: Load tags when package selected ────────────────────────────────
  useEffect(() => {
    if (!selectedPackage) {
      setTags([]);
      setSelectedTag('');
      setTagsState('idle');
      return;
    }
    setTagsState('loading');
    setTags([]);
    setSelectedTag('');
    fetch(`/api/github/packages/${encodeURIComponent(selectedPackage)}/tags`)
      .then((r) => r.json())
      .then((d) => {
        setTags(d.tags ?? []);
        setTagsState('ok');
      })
      .catch(() => setTagsState('error'));
  }, [selectedPackage]);

  // ── AC10: Load tunnels when zone selected ────────────────────────────────
  useEffect(() => {
    if (!selectedZone) {
      setSelectedZoneTunnels([]);
      setSelectedTunnel('');
      return;
    }
    const zone = zones.find((z) => z.name === selectedZone);
    if (!zone) return;
    fetch(`/api/cloudflare/zones/${encodeURIComponent(zone.id)}/tunnels`)
      .then((r) => r.json())
      .then((d) => {
        const tunnels = d.tunnels ?? [];
        setSelectedZoneTunnels(tunnels);
        // Auto-select first tunnel if only one
        if (tunnels.length === 1) {
          setSelectedTunnel(tunnels[0].id);
        } else {
          setSelectedTunnel('');
        }
      })
      .catch(() => {
        setSelectedZoneTunnels([]);
        setSelectedTunnel('');
      });
  }, [selectedZone, zones]);

  // ── AC11: Pre-fill subdomain from selected image name ───────────────────
  useEffect(() => {
    if (selectedPackage) {
      setSubdomain(deriveSubdomain(selectedPackage));
    } else {
      setSubdomain('');
    }
  }, [selectedPackage]);

  // Compute assembled hostname (AC11)
  const assembledHostname = (subdomain.trim() && selectedZone)
    ? `${subdomain.trim()}.${selectedZone}`
    : '';

  // AC14: Check if there is an existing deployment on the assembled hostname
  const existingDeployOnHostname = assembledHostname
    ? deployments.find((d) => d.hostname === assembledHostname)
    : null;

  // Find fullImageRef for selected package
  const selectedPackageObj = packages.find((p) => p.name === selectedPackage);
  const fullImageRef = selectedPackageObj?.fullImageRef ?? '';

  // AC12: Deploy button active condition
  const canDeploy =
    !deploying &&
    selectedPackage !== '' &&
    selectedTag !== '' &&
    selectedVps !== '' &&
    selectedZone !== '' &&
    selectedTunnel !== '' &&
    subdomain.trim() !== '';

  // ── AC12: Deploy handler ─────────────────────────────────────────────────
  async function handleDeploy(e) {
    e.preventDefault();
    if (!canDeploy) return;
    setDeploying(true);
    setDeployResult(null);
    const hostname = assembledHostname;
    const imageWithTag = `${fullImageRef}:${selectedTag}`;
    try {
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageWithTag,
          vps: selectedVps,
          hostname,
          tunnelId: selectedTunnel,
          // zoneId resolved server-side
        }),
      });
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        const replaced = data.deployment?.replaced === true;
        setDeployResult({
          ok: true,
          message: replaced
            ? `Re-Deployed (ersetzt): ${hostname}`
            : `Deployed: ${hostname}`,
          replaced,
          portAmbiguous: data.deployment?.portAmbiguous ?? false,
          portFallback: data.deployment?.portFallback ?? false,
        });
        // Reset form selections
        setSelectedPackage('');
        setSelectedTag('');
        setSelectedVps('');
        setSelectedZone('');
        setSelectedTunnel('');
        setSubdomain('');
        // Refresh list
        loadDeployments();
      } else {
        const reason = data?.reason ?? data?.error ?? 'Deploy fehlgeschlagen';
        setDeployResult({ ok: false, message: formatReason(reason) });
      }
    } catch {
      setDeployResult({ ok: false, message: 'Netzwerkfehler beim Deploy' });
    } finally {
      setDeploying(false);
    }
  }

  // ── Undeploy handler
  async function handleUndeploy(e) {
    e.preventDefault();
    if (!undeployState) return;
    setUndeploying(true);
    setUndeployResult(null);
    const { vps, hostname, tunnelId, confirm } = undeployState;
    // zoneId is resolved server-side — not sent from the client
    try {
      const res = await fetch(
        `/api/deployments/${encodeURIComponent(vps)}/${encodeURIComponent(hostname)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm, tunnelId }),
        },
      );
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        setUndeployResult({ ok: true, message: `Entfernt: ${hostname}` });
        setUndeployState(null);
        loadDeployments();
      } else {
        const reason = data?.reason ?? data?.error ?? 'Undeploy fehlgeschlagen';
        setUndeployResult({ ok: false, message: formatReason(reason) });
      }
    } catch {
      setUndeployResult({ ok: false, message: 'Netzwerkfehler beim Undeploy' });
    } finally {
      setUndeploying(false);
    }
  }

  // ── Stack-Modus: Stacks laden (AC12)
  const loadStacks = useCallback(async () => {
    setStacksLoadState('loading');
    setStacksLoadError(null);
    try {
      const res = await fetch('/api/deployments/stacks');
      const data = await res.json();
      if (!res.ok) {
        setStacksLoadState('error');
        setStacksLoadError(data?.error ?? 'Laden fehlgeschlagen');
        return;
      }
      setStacks(data.stacks ?? []);
      setStacksLoadState('ok');
    } catch {
      setStacksLoadState('error');
      setStacksLoadError('Netzwerkfehler beim Laden der Stacks');
    }
  }, []);

  // Load stacks when switching to stack mode.
  // Cache-Guard: only load on first switch (stacksLoadState === 'idle').
  // Subsequent mode-switches reuse the cached list; manual refresh via the
  // "Stacks laden" button resets the state and re-triggers this effect.
  useEffect(() => {
    if (mode === MODE_STACK && stacksLoadState === 'idle') {
      loadStacks();
    }
  }, [mode, stacksLoadState, loadStacks]);

  // ── Stack-Deploy (AC12)
  async function handleStackDeploy(e) {
    e.preventDefault();
    if (!selectedStack) return;
    setStackDeploying(true);
    setStackDeployResult(null);
    try {
      const res = await fetch(
        `/api/deployments/stacks/${encodeURIComponent(selectedStack)}/deploy`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        setStackDeployResult({ ok: true, message: `Stack deployt: ${selectedStack}` });
        // Refresh status
        loadStackStatus(selectedStack);
      } else {
        const reason = data?.reason ?? data?.error ?? 'Deploy fehlgeschlagen';
        setStackDeployResult({ ok: false, message: formatReason(reason) });
      }
    } catch {
      setStackDeployResult({ ok: false, message: 'Netzwerkfehler beim Stack-Deploy' });
    } finally {
      setStackDeploying(false);
    }
  }

  // ── Stack-Undeploy (type-to-confirm, AC12)
  async function handleStackUndeploy(e) {
    e.preventDefault();
    if (!selectedStack) return;
    setStackUndeploying(true);
    setStackUndeployResult(null);
    try {
      const res = await fetch(
        `/api/deployments/stacks/${encodeURIComponent(selectedStack)}/undeploy`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: stackUndeployConfirm }),
        },
      );
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        setStackUndeployResult({ ok: true, message: `Stack entfernt: ${selectedStack}` });
        setStackUndeployConfirm('');
        setStackStatus(null);
      } else {
        const reason = data?.reason ?? data?.error ?? 'Undeploy fehlgeschlagen';
        setStackUndeployResult({ ok: false, message: formatReason(reason, 'stack') });
      }
    } catch {
      setStackUndeployResult({ ok: false, message: 'Netzwerkfehler beim Stack-Undeploy' });
    } finally {
      setStackUndeploying(false);
    }
  }

  // ── Stack-Status (AC12)
  const loadStackStatus = useCallback(async (stackName) => {
    if (!stackName) return;
    setStackStatusLoading(true);
    setStackStatusError(null);
    try {
      const res = await fetch(
        `/api/deployments/stacks/${encodeURIComponent(stackName)}/status`,
      );
      const data = await res.json();
      if (!res.ok) {
        setStackStatusError(data?.error ?? 'Status-Abruf fehlgeschlagen');
        setStackStatus(null);
        return;
      }
      setStackStatus(data);
    } catch {
      setStackStatusError('Netzwerkfehler beim Status-Abruf');
      setStackStatus(null);
    } finally {
      setStackStatusLoading(false);
    }
  }, []);

  // ── Render
  return (
    <main style={styles.view} aria-label="Deployments-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>Deployments</h1>

        {/* ── Mode toggle (AC12) ────────────────────────────────────────── */}
        <div
          role="group"
          aria-label="Deployment-Modus wählen"
          style={styles.modeToggle}
        >
          <button
            type="button"
            style={mode === MODE_SINGLE ? styles.modeActive : styles.modeInactive}
            aria-pressed={mode === MODE_SINGLE}
            onClick={() => setMode(MODE_SINGLE)}
          >
            Single-Image
          </button>
          <button
            type="button"
            style={mode === MODE_STACK ? styles.modeActive : styles.modeInactive}
            aria-pressed={mode === MODE_STACK}
            onClick={() => setMode(MODE_STACK)}
          >
            Compose-Stack aus Repo
          </button>
        </div>

        {/* ── Single-Image mode ─────────────────────────────────────────── */}
        {mode === MODE_SINGLE && (
          <>

        {/* ── Query panel ──────────────────────────────────────────────── */}
        <section style={styles.section} aria-label="Bestand laden">
          <h2 style={styles.sectionTitle}>Bestand anzeigen</h2>
          <div style={styles.row}>
            <label style={styles.label} htmlFor="list-vps">VPS-ID</label>
            <input
              id="list-vps"
              type="text"
              style={styles.input}
              value={listVps}
              onChange={(e) => setListVps(e.target.value)}
              placeholder="vps-id (z.B. vps-1)"
              aria-label="VPS-ID für Bestandsliste"
            />
          </div>
          <div style={styles.row}>
            <label style={styles.label} htmlFor="list-tunnel">Tunnel-ID</label>
            <input
              id="list-tunnel"
              type="text"
              style={styles.input}
              value={listTunnelId}
              onChange={(e) => setListTunnelId(e.target.value)}
              placeholder="Cloudflare Tunnel-ID"
              aria-label="Tunnel-ID für Bestandsliste"
            />
          </div>
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={loadDeployments}
            disabled={!listVps.trim() || !listTunnelId.trim() || loadState === 'loading'}
            aria-busy={loadState === 'loading'}
          >
            {loadState === 'loading' ? 'Lade…' : 'Aktualisieren'}
          </button>
        </section>

        {/* ── Deployments list ─────────────────────────────────────────── */}
        {loadErrors.length > 0 && (
          <div role="alert" style={styles.errorBox} aria-live="polite">
            {loadErrors.map((e, i) => (
              <p key={i} style={styles.errorText}>
                {`Fehler bei ${e.scope}: ${e.errorClass}`}
              </p>
            ))}
          </div>
        )}

        {loadState === 'ok' && deployments.length === 0 && (
          <p style={styles.hint}>Keine Deployments gefunden.</p>
        )}

        {deployments.length > 0 && (
          <section style={styles.section} aria-label="Laufende Deployments">
            <h2 style={styles.sectionTitle}>Laufende Deployments</h2>
            <div style={styles.tableWrapper} role="table" aria-label="Deployment-Liste">
              <div role="rowgroup">
                <div role="row" style={styles.tableHeader}>
                  <span role="columnheader" style={styles.cell}>Hostname</span>
                  <span role="columnheader" style={styles.cell}>Image</span>
                  <span role="columnheader" style={styles.cell}>Status</span>
                  <span role="columnheader" style={styles.cell}>Route</span>
                  <span role="columnheader" style={styles.cell}>Container</span>
                  <span role="columnheader" style={styles.cellAction}>Aktion</span>
                </div>
              </div>
              <div role="rowgroup">
                {deployments.map((d) => (
                  <div key={`${d.vps}:${d.hostname}`} role="row" style={styles.tableRow}>
                    <span role="cell" style={styles.cell}>{d.hostname}</span>
                    <span role="cell" style={styles.cell}>{d.image ?? '—'}</span>
                    <span role="cell" style={styles.cell}>{d.status ?? '—'}</span>
                    <span role="cell" style={styles.cell}>
                      {d.routePresent ? 'ja' : 'nein'}
                    </span>
                    <span role="cell" style={styles.cell}>
                      {d.containerPresent ? 'ja' : 'nein'}
                    </span>
                    <span role="cell" style={styles.cellAction}>
                      <button
                        type="button"
                        style={styles.btnDanger}
                        aria-label={`Deployment ${d.hostname} entfernen`}
                        onClick={() => {
                          setUndeployState({
                            hostname: d.hostname,
                            vps: d.vps ?? listVps,
                            tunnelId: listTunnelId,
                            // zoneId not needed — resolved server-side
                            confirm: '',
                          });
                          setUndeployResult(null);
                        }}
                      >
                        Entfernen
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── Undeploy confirmation dialog ──────────────────────────────── */}
        {undeployState && (
          <section style={styles.section} aria-label="Deployment entfernen">
            <h2 style={styles.sectionTitle}>Deployment entfernen: {undeployState.hostname}</h2>
            <p style={styles.hint}>
              Hostname zum Bestätigen eintippen (AC6 — type-to-confirm):
            </p>
            <form onSubmit={handleUndeploy} noValidate>
              {/* Zone-ID is resolved server-side from hostname — not required here */}
              <div style={styles.row}>
                <label style={styles.label} htmlFor="undeploy-confirm">Hostname bestätigen</label>
                <input
                  id="undeploy-confirm"
                  type="text"
                  style={styles.input}
                  value={undeployState.confirm}
                  onChange={(e) => setUndeployState((s) => ({ ...s, confirm: e.target.value }))}
                  placeholder={undeployState.hostname}
                  required
                  autoComplete="off"
                  aria-label={`Hostname ${undeployState.hostname} bestätigen`}
                  aria-describedby="undeploy-confirm-hint"
                />
                <span id="undeploy-confirm-hint" style={styles.inputHint}>
                  Tippe exakt: {undeployState.hostname}
                </span>
              </div>
              {undeployResult && (
                <div
                  role="alert"
                  aria-live="polite"
                  style={undeployResult.ok ? styles.successBox : styles.errorBox}
                >
                  <p style={undeployResult.ok ? styles.successText : styles.errorText}>
                    {undeployResult.message}
                  </p>
                </div>
              )}
              <div style={styles.btnRow}>
                <button
                  type="submit"
                  style={styles.btnDanger}
                  disabled={
                    undeploying ||
                    undeployState.confirm !== undeployState.hostname
                  }
                  aria-busy={undeploying}
                >
                  {undeploying ? 'Entferne…' : 'Entfernen bestätigen'}
                </button>
                <button
                  type="button"
                  style={styles.btnSecondary}
                  onClick={() => { setUndeployState(null); setUndeployResult(null); }}
                >
                  Abbrechen
                </button>
              </div>
            </form>
          </section>
        )}

        {/* ── Deploy form (AC10–AC14: guided dropdowns) ────────────────── */}
        <section style={styles.section} aria-label="Neues Deployment">
          <h2 style={styles.sectionTitle}>Neues Deployment</h2>
          <form onSubmit={handleDeploy} noValidate aria-label="Deploy-Formular">

            {/* AC10: Image-Dropdown */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-image-select">Image</label>
              {packagesState === 'loading' && (
                <p style={styles.hint} aria-live="polite">Lade Images…</p>
              )}
              <select
                id="deploy-image-select"
                style={styles.input}
                value={selectedPackage}
                onChange={(e) => setSelectedPackage(e.target.value)}
                aria-label="Docker-Image (ghcr) auswählen"
                disabled={packagesState === 'loading'}
              >
                <option value="">— Image wählen —</option>
                {packages.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* AC10: Tag-Dropdown (disabled until image selected) */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-tag-select">Tag / Version</label>
              {tagsState === 'loading' && (
                <p style={styles.hint} aria-live="polite">Lade Tags…</p>
              )}
              <select
                id="deploy-tag-select"
                style={styles.input}
                value={selectedTag}
                onChange={(e) => setSelectedTag(e.target.value)}
                aria-label="Image-Tag auswählen"
                disabled={!selectedPackage || tagsState === 'loading'}
              >
                <option value="">
                  {selectedPackage ? '— Tag wählen —' : '— zuerst Image wählen —'}
                </option>
                {tags.map((t) => (
                  <option key={t.tag} value={t.tag}>{t.tag}</option>
                ))}
              </select>
            </div>

            {/* AC10: VPS-Dropdown */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-vps-select">VPS</label>
              <select
                id="deploy-vps-select"
                style={styles.input}
                value={selectedVps}
                onChange={(e) => setSelectedVps(e.target.value)}
                aria-label="VPS auswählen"
                disabled={vpsIdsState === 'loading'}
              >
                <option value="">— VPS wählen —</option>
                {vpsIds.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>

            {/* AC10: Domänen-Dropdown */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-zone-select">Domäne</label>
              {zonesState === 'loading' && (
                <p style={styles.hint} aria-live="polite">Lade Domänen…</p>
              )}
              <select
                id="deploy-zone-select"
                style={styles.input}
                value={selectedZone}
                onChange={(e) => setSelectedZone(e.target.value)}
                aria-label="Domäne auswählen"
                disabled={zonesState === 'loading'}
              >
                <option value="">— Domäne wählen —</option>
                {zones.map((z) => (
                  <option key={z.id ?? z.name} value={z.name}>{z.name}</option>
                ))}
              </select>
            </div>

            {/* Tunnel-Dropdown (shown when zone selected + tunnels available) */}
            {selectedZone && (
              <div style={styles.row}>
                <label style={styles.label} htmlFor="deploy-tunnel-select">Tunnel</label>
                <select
                  id="deploy-tunnel-select"
                  style={styles.input}
                  value={selectedTunnel}
                  onChange={(e) => setSelectedTunnel(e.target.value)}
                  aria-label="Cloudflare Tunnel auswählen"
                >
                  <option value="">— Tunnel wählen —</option>
                  {selectedZoneTunnels.map((t) => (
                    <option key={t.id} value={t.id}>{t.name ?? t.id}</option>
                  ))}
                </select>
              </div>
            )}

            {/* AC11: Subdomain-Feld, vorausgefüllt + manuell editierbar */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-subdomain">Subdomain</label>
              <input
                id="deploy-subdomain"
                type="text"
                style={styles.input}
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="app-name"
                aria-label="Subdomain (editierbar)"
                aria-describedby="deploy-hostname-preview"
              />
              <span id="deploy-hostname-preview" style={styles.inputHint}>
                {assembledHostname
                  ? `Hostname: ${assembledHostname}`
                  : 'Hostname: (Domäne + Subdomain wählen)'}
              </span>
            </div>

            {/* AC14: Re-Deploy indicator */}
            {existingDeployOnHostname && (
              <div style={styles.warnBox} role="status" aria-live="polite">
                <p style={styles.warnText}>
                  Hinweis: Ein Deploy auf {assembledHostname} existiert bereits — dieser wird ersetzt.
                </p>
              </div>
            )}

            {deployResult && (
              <div
                role="alert"
                aria-live="polite"
                style={deployResult.ok ? styles.successBox : styles.errorBox}
              >
                <p style={deployResult.ok ? styles.successText : styles.errorText}>
                  {deployResult.message}
                </p>
                {/* AC13: Port-Hinweise */}
                {deployResult.ok && deployResult.portAmbiguous && (
                  <p style={styles.successText}>
                    Hinweis: Mehrere exponierte Ports gefunden — kleinster Port verwendet.
                  </p>
                )}
                {deployResult.ok && deployResult.portFallback && (
                  <p style={styles.successText}>
                    Hinweis: Kein exponierter Port gefunden — Standard-Port 8080 verwendet.
                  </p>
                )}
              </div>
            )}

            {/* AC12: Deploy-Button — aktiv nur bei vollständiger Auswahl */}
            <button
              type="submit"
              style={canDeploy ? styles.btnPrimary : { ...styles.btnPrimary, opacity: 0.5, cursor: 'not-allowed' }}
              disabled={!canDeploy}
              aria-busy={deploying}
            >
              {deploying
                ? 'Deploye…'
                : existingDeployOnHostname
                  ? 'Re-Deploy starten (ersetzt bestehenden Deploy)'
                  : 'Deploy starten'}
            </button>
          </form>
        </section>

          </>
        )} {/* end Single-Image mode */}

        {/* ── Compose-Stack mode (AC12) ─────────────────────────────────── */}
        {mode === MODE_STACK && (
          <>

        {/* ── Stack list ───────────────────────────────────────────────── */}
        <section style={styles.section} aria-label="Stack-Auswahl">
          <h2 style={styles.sectionTitle}>Stack auswählen</h2>
          {stacksLoadState === 'loading' && (
            <p style={styles.hint} aria-live="polite" aria-busy="true">Lade Stacks…</p>
          )}
          {stacksLoadState === 'error' && (
            <div role="alert" style={styles.errorBox} aria-live="polite">
              <p style={styles.errorText}>{stacksLoadError}</p>
            </div>
          )}
          {stacksLoadState === 'ok' && stacks.length === 0 && (
            <p style={styles.hint}>Keine Stacks in der Registry.</p>
          )}
          {stacksLoadState === 'ok' && stacks.length > 0 && (
            <div style={styles.row}>
              <label style={styles.label} htmlFor="stack-select">Stack</label>
              <select
                id="stack-select"
                style={styles.input}
                value={selectedStack}
                onChange={(e) => {
                  setSelectedStack(e.target.value);
                  setStackDeployResult(null);
                  setStackUndeployResult(null);
                  setStackUndeployConfirm('');
                  setStackStatus(null);
                  setStackStatusError(null);
                }}
                aria-label="Compose-Stack auswählen"
              >
                <option value="">— Stack wählen —</option>
                {stacks.map((s) => (
                  <option key={s.stackName} value={s.stackName}>
                    {s.stackName}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={loadStacks}
            disabled={stacksLoadState === 'loading'}
            aria-busy={stacksLoadState === 'loading'}
          >
            {stacksLoadState === 'loading' ? 'Lade…' : 'Aktualisieren'}
          </button>
        </section>

        {/* ── Stack-Deploy ─────────────────────────────────────────────── */}
        {selectedStack && (
          <section style={styles.section} aria-label="Stack deployen">
            <h2 style={styles.sectionTitle}>Stack deployen: {selectedStack}</h2>
            <form onSubmit={handleStackDeploy} noValidate aria-label="Stack-Deploy-Formular">
              {stackDeployResult && (
                <div
                  role="alert"
                  aria-live="polite"
                  style={stackDeployResult.ok ? styles.successBox : styles.errorBox}
                >
                  <p style={stackDeployResult.ok ? styles.successText : styles.errorText}>
                    {stackDeployResult.message}
                  </p>
                </div>
              )}
              <button
                type="submit"
                style={styles.btnPrimary}
                disabled={stackDeploying || !selectedStack}
                aria-busy={stackDeploying}
              >
                {stackDeploying ? 'Deploye…' : 'Stack deployen'}
              </button>
            </form>
          </section>
        )}

        {/* ── Stack-Status ─────────────────────────────────────────────── */}
        {selectedStack && (
          <section style={styles.section} aria-label="Stack-Status">
            <h2 style={styles.sectionTitle}>Status: {selectedStack}</h2>
            <button
              type="button"
              style={styles.btnSecondary}
              onClick={() => loadStackStatus(selectedStack)}
              disabled={stackStatusLoading || !selectedStack}
              aria-busy={stackStatusLoading}
            >
              {stackStatusLoading ? 'Lade Status…' : 'Status abrufen'}
            </button>
            {stackStatusError && (
              <div role="alert" style={styles.errorBox} aria-live="polite">
                <p style={styles.errorText}>{stackStatusError}</p>
              </div>
            )}
            {stackStatus && (
              <div style={styles.tableWrapper} role="table" aria-label="Stack-Service-Status">
                <div role="rowgroup">
                  <div role="row" style={styles.tableHeader}>
                    <span role="columnheader" style={styles.cell}>Service</span>
                    <span role="columnheader" style={styles.cell}>Hostname</span>
                    <span role="columnheader" style={styles.cell}>Status</span>
                    <span role="columnheader" style={styles.cell}>Container</span>
                    <span role="columnheader" style={styles.cell}>Route</span>
                    <span role="columnheader" style={styles.cell}>Drift</span>
                  </div>
                </div>
                <div role="rowgroup">
                  {(stackStatus.services ?? []).map((svc) => (
                    <div key={`${svc.service}:${svc.hostname}`} role="row" style={styles.tableRow}>
                      <span role="cell" style={styles.cell}>{svc.service}</span>
                      <span role="cell" style={styles.cell}>{svc.hostname ?? '—'}</span>
                      <span role="cell" style={styles.cell}>{svc.status ?? '—'}</span>
                      <span role="cell" style={styles.cell}>{svc.containerPresent ? 'ja' : 'nein'}</span>
                      <span role="cell" style={styles.cell}>{svc.routePresent ? 'ja' : 'nein'}</span>
                      <span
                        role="cell"
                        style={{ ...styles.cell, color: svc.drift ? '#fca5a5' : '#86efac' }}
                        aria-label={svc.drift ? `Drift erkannt für ${svc.service}` : `Kein Drift für ${svc.service}`}
                      >
                        {svc.drift ? 'Drift' : 'OK'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {stackStatus && (stackStatus.errors ?? []).length > 0 && (
              <div role="alert" style={styles.errorBox} aria-live="polite">
                {stackStatus.errors.map((err, i) => (
                  <p key={i} style={styles.errorText}>
                    {`Fehler bei ${err.scope}: ${err.errorClass}`}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── Stack-Undeploy (type-to-confirm) ─────────────────────────── */}
        {selectedStack && (
          <section style={styles.section} aria-label="Stack entfernen">
            <h2 style={styles.sectionTitle}>Stack entfernen: {selectedStack}</h2>
            <p style={styles.hint}>
              Stack-Name zum Bestätigen eintippen (type-to-confirm):
            </p>
            <form onSubmit={handleStackUndeploy} noValidate>
              <div style={styles.row}>
                <label style={styles.label} htmlFor="stack-undeploy-confirm">Stack-Name bestätigen</label>
                <input
                  id="stack-undeploy-confirm"
                  type="text"
                  style={styles.input}
                  value={stackUndeployConfirm}
                  onChange={(e) => setStackUndeployConfirm(e.target.value)}
                  placeholder={selectedStack}
                  required
                  autoComplete="off"
                  aria-label={`Stack-Name ${selectedStack} bestätigen`}
                  aria-describedby="stack-undeploy-confirm-hint"
                />
                <span id="stack-undeploy-confirm-hint" style={styles.inputHint}>
                  Tippe exakt: {selectedStack}
                </span>
              </div>
              {stackUndeployResult && (
                <div
                  role="alert"
                  aria-live="polite"
                  style={stackUndeployResult.ok ? styles.successBox : styles.errorBox}
                >
                  <p style={stackUndeployResult.ok ? styles.successText : styles.errorText}>
                    {stackUndeployResult.message}
                  </p>
                </div>
              )}
              <button
                type="submit"
                style={styles.btnDanger}
                disabled={stackUndeploying || stackUndeployConfirm !== selectedStack}
                aria-busy={stackUndeploying}
              >
                {stackUndeploying ? 'Entferne…' : 'Stack entfernen bestätigen'}
              </button>
            </form>
          </section>
        )}

          </>
        )} {/* end Compose-Stack mode */}

        {/* ── Back button ──────────────────────────────────────────────── */}
        <button
          type="button"
          style={styles.homeBtn}
          onClick={() => onNavigate('panel')}
          aria-label="Zurück zum Einstiegs-Panel"
        >
          Zurueck zum Panel
        </button>
      </div>
    </main>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a backend reason/errorClass to a user-friendly message.
 * Never display raw secret-like values.
 *
 * @param {string} reason
 * @param {'single'|'stack'} [context='single'] - determines context-specific messages
 * @returns {string}
 */
function formatReason(reason, context = 'single') {
  switch (reason) {
    case 'protected-resource':
      return 'Dieser Hostname ist geschuetzt und kann nicht veraendert werden.';
    case 'confirmation-required':
      if (context === 'stack') {
        return 'Bitte den Stack-Namen exakt eintippen, um das Entfernen zu bestaetigen.';
      }
      return 'Bitte den Hostname exakt eintippen, um das Entfernen zu bestaetigen.';
    default:
      // Strip anything that looks like a secret from the displayed message
      return String(reason)
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[...]')
        .slice(0, 200);
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#d4d4d4',
    fontFamily: 'system-ui, sans-serif',
  },
  inner: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '32px 24px 48px',
    width: '100%',
  },
  title: {
    margin: '0 0 24px',
    fontSize: 28,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  section: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '24px',
    marginBottom: 24,
  },
  sectionTitle: {
    margin: '0 0 16px',
    fontSize: 16,
    fontWeight: 600,
    color: '#e5e7eb',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    color: '#9ca3af',
    marginBottom: 2,
  },
  input: {
    padding: '8px 12px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    minHeight: 36,
    width: '100%',
    boxSizing: 'border-box',
  },
  inputHint: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
  btnRow: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  btnPrimary: {
    marginTop: 12,
    padding: '10px 20px',
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 120,
  },
  btnSecondary: {
    padding: '8px 16px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 100,
  },
  btnDanger: {
    padding: '8px 16px',
    background: '#7f1d1d',
    color: '#fca5a5',
    border: '1px solid #991b1b',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 100,
  },
  hint: {
    fontSize: 14,
    color: '#9ca3af',
    margin: '0 0 16px',
    lineHeight: 1.5,
  },
  errorBox: {
    background: '#1c0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
  },
  errorText: {
    margin: 0,
    fontSize: 13,
    color: '#fca5a5',
  },
  successBox: {
    background: '#0a1c0a',
    border: '1px solid #14532d',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
  },
  successText: {
    margin: 0,
    fontSize: 13,
    color: '#86efac',
  },
  warnBox: {
    background: '#1c1400',
    border: '1px solid #78350f',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
  },
  warnText: {
    margin: 0,
    fontSize: 13,
    color: '#fcd34d',
  },
  homeBtn: {
    marginTop: 8,
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
  },
  // Table
  tableWrapper: {
    overflowX: 'auto',
  },
  tableHeader: {
    display: 'flex',
    padding: '8px 0',
    borderBottom: '1px solid #334155',
    gap: 8,
  },
  tableRow: {
    display: 'flex',
    padding: '10px 0',
    borderBottom: '1px solid #1e293b',
    gap: 8,
    alignItems: 'center',
  },
  cell: {
    flex: 1,
    fontSize: 13,
    color: '#d4d4d4',
    minWidth: 80,
    wordBreak: 'break-all',
  },
  cellAction: {
    width: 110,
    flexShrink: 0,
  },
  // Mode toggle (AC12)
  modeToggle: {
    display: 'flex',
    gap: 8,
    marginBottom: 24,
    flexWrap: 'wrap',
  },
  modeActive: {
    padding: '10px 20px',
    background: '#1d4ed8',
    color: '#fff',
    border: '2px solid #3b82f6',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 120,
  },
  modeInactive: {
    padding: '10px 20px',
    background: '#1e293b',
    color: '#d4d4d4',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 120,
  },
};
