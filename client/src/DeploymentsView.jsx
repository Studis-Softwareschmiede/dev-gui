/**
 * DeploymentsView.jsx — Deployments-Panel (Capability B, ADR-012).
 *
 * Spec: deploy-lifecycle.md AC3–AC9 (Frontend-Seite)
 *       stack-deploy-orchestration.md AC12 (Modus-Umschalter)
 *
 * Responsibilities:
 *   - Mode toggle: "Single-Image" | "Compose-Stack aus Repo" (AC12)
 *   - Single-Image mode (unchanged, deploy-lifecycle.md):
 *       List live deployments (Container↔Route as unit) — GET /api/deployments
 *       Deploy form: image + vps + hostname + tunnelId → POST /api/deployments
 *       Undeploy with type-to-confirm → DELETE /api/deployments/:vps/:hostname (AC5/AC6)
 *       Show 422/protected-resource / 422/confirmation-required clearly (no secrets) (AC7)
 *   - Compose-Stack mode (AC12):
 *       List stacks from registry — GET /api/deployments/stacks
 *       Deploy stack — POST /api/deployments/stacks/{stackName}/deploy
 *       Undeploy stack with type-to-confirm — DELETE /api/deployments/stacks/{stackName}/undeploy
 *       Stack status with drift flags — GET /api/deployments/stacks/{stackName}/status
 *   - No Cloudflare token or SSH key in frontend bundle (AC9/AC11/security)
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

const INITIAL_DEPLOY_FORM = {
  image: '',
  vps: '',
  hostname: '',
  tunnelId: '',
  // zoneId is NOT in the form — resolved server-side from hostname (Spec-Gap-Resolution)
};

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

// ── DeploymentsView ───────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function DeploymentsView({ onNavigate }) {
  // ── Mode toggle (AC12)
  const [mode, setMode] = useState(MODE_SINGLE); // 'single' | 'stack'

  // ── Single-Image state (unchanged)
  const [deployments, setDeployments] = useState([]);
  const [loadErrors, setLoadErrors] = useState([]);
  const [loadState, setLoadState] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'

  // Query params for listing
  const [listVps, setListVps] = useState('');
  const [listTunnelId, setListTunnelId] = useState('');

  // Deploy form
  const [deployForm, setDeployForm] = useState(INITIAL_DEPLOY_FORM);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null); // { ok, message }

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

  // ── Deploy handler
  async function handleDeploy(e) {
    e.preventDefault();
    setDeploying(true);
    setDeployResult(null);
    try {
      const res = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployForm),
      });
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        setDeployResult({ ok: true, message: `Deployed: ${deployForm.hostname}` });
        setDeployForm(INITIAL_DEPLOY_FORM);
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

        {/* ── Deploy form ──────────────────────────────────────────────── */}
        <section style={styles.section} aria-label="Neues Deployment">
          <h2 style={styles.sectionTitle}>Neues Deployment</h2>
          <form onSubmit={handleDeploy} noValidate aria-label="Deploy-Formular">
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-image">Image</label>
              <input
                id="deploy-image"
                type="text"
                style={styles.input}
                value={deployForm.image}
                onChange={(e) => setDeployForm((f) => ({ ...f, image: e.target.value }))}
                placeholder="ghcr.io/org/app:v1"
                required
                aria-label="Docker-Image (ghcr)"
              />
            </div>
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-vps">VPS-ID</label>
              <input
                id="deploy-vps"
                type="text"
                style={styles.input}
                value={deployForm.vps}
                onChange={(e) => setDeployForm((f) => ({ ...f, vps: e.target.value }))}
                placeholder="vps-id"
                required
                aria-label="VPS-ID"
              />
            </div>
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-hostname">Hostname</label>
              <input
                id="deploy-hostname"
                type="text"
                style={styles.input}
                value={deployForm.hostname}
                onChange={(e) => setDeployForm((f) => ({ ...f, hostname: e.target.value }))}
                placeholder="app.example.com"
                required
                aria-label="Ziel-Hostname"
              />
            </div>
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-tunnel">Tunnel-ID</label>
              <input
                id="deploy-tunnel"
                type="text"
                style={styles.input}
                value={deployForm.tunnelId}
                onChange={(e) => setDeployForm((f) => ({ ...f, tunnelId: e.target.value }))}
                placeholder="Cloudflare Tunnel-ID"
                required
                aria-label="Cloudflare Tunnel-ID"
              />
            </div>
            {/* Zone-ID is resolved server-side from hostname — not in the form */}

            {deployResult && (
              <div
                role="alert"
                aria-live="polite"
                style={deployResult.ok ? styles.successBox : styles.errorBox}
              >
                <p style={deployResult.ok ? styles.successText : styles.errorText}>
                  {deployResult.message}
                </p>
              </div>
            )}

            <button
              type="submit"
              style={styles.btnPrimary}
              disabled={
                deploying ||
                !deployForm.image.trim() ||
                !deployForm.vps.trim() ||
                !deployForm.hostname.trim() ||
                !deployForm.tunnelId.trim()
                // zoneId not required — resolved server-side
              }
              aria-busy={deploying}
            >
              {deploying ? 'Deploye…' : 'Deploy starten'}
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
